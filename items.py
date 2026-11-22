"""Generic "item" module for block-shaped script content (ideas, decisions, decision categories, events).

An item is one `key = { ... }` block that a module can find by id in a file. The page edits the
item's top-level entries; the server receives a list of operations on the original entries
(`set` a scalar, replace a `block` body, `add_block`, `remove`) and applies them with
`core.BlockEditor`, so untouched entries, comments and formatting stay as they were. A raw edit
replaces the whole block after checking that it still is one balanced block with the same id.

Subclasses describe where items live (`items_in`), what the page needs to draw them (`summary`,
`extra`), how a new one looks (`template`) and where it goes (`container_for`).
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, Entry, block_body, file_version, read_script, unquote, write_script

OPS = ("set", "block", "add_block", "remove")


def entries_model(doc: Doc, entry: Entry) -> List[dict]:
	"""Top-level entries of a block as the page edits them."""
	seen: Dict[str, int] = {}
	found: List[dict] = []
	for sub in core.sub_entries(doc, entry):
		line = doc.line_of(sub.start)
		if sub.key is None:
			found.append({"key": None, "occ": 0, "type": "bare", "value": sub.value, "line": line})
			continue
		occ = seen.get(sub.key, 0)
		seen[sub.key] = occ + 1
		if sub.is_block:
			found.append({"key": sub.key, "occ": occ, "type": "block", "body": block_body(doc.text, doc, sub), "line": line})
		else:
			found.append({"key": sub.key, "occ": occ, "type": "scalar", "value": sub.value, "line": line})
	return found


def apply_ops(block: str, ops: List[dict]) -> str:
	editor = core.BlockEditor(block)
	touched = set()
	for op in ops:
		kind = op.get("op")
		key = str(op.get("key", ""))
		if kind not in OPS or not core.SAFE_ID.match(key):
			raise ValueError(f"invalid operation {op}")
		occ = int(op.get("occ", 0))
		if kind != "add_block":
			mark = (key, occ)
			if mark in touched:
				raise ValueError(f"two edits for {key} #{occ + 1}")
			touched.add(mark)
		if kind == "set":
			value = str(op.get("value", "")).strip()
			if not value or any(c in value for c in "{}\n"):
				raise ValueError(f"{key}: a single value is expected")
			editor.set_scalar(key, value, occ)
		elif kind == "block":
			editor.set_block(key, str(op.get("body", "")), occ)
		elif kind == "add_block":
			editor.add_block(key, str(op.get("body", "")))
		else:
			editor.remove(key, occ)
	return editor.result()


ROOT_KEY = "__studio_root__"
ROOT_PREFIX = f"{ROOT_KEY} = {{\n"


def root_doc(text: str) -> Tuple[Doc, Entry]:
	"""A whole file seen as one block, so the block tools can edit its top-level statements."""
	doc = Doc(f"{ROOT_PREFIX}{text}\n}}")
	return doc, doc.entries()[0]


def root_entries_model(text: str) -> List[dict]:
	doc, top = root_doc(text)
	found = entries_model(doc, top)
	for row in found:
		row["line"] -= 1  # the wrapper adds one line at the top
	return found


def apply_root_ops(text: str, ops: List[dict]) -> str:
	"""Apply entry operations to the top level of a file (history files are not wrapped in a block)."""
	result = apply_ops(f"{ROOT_PREFIX}{text}\n}}", ops)
	if not result.startswith(ROOT_PREFIX) or not result.endswith("\n}"):
		raise ValueError("internal error while editing the file")
	return result[len(ROOT_PREFIX):-2]


def sprite_name(value: Optional[str], prefix: str, fallback_id: str = "") -> str:
	"""A picture/icon value as a sprite name: full GFX names stay, short names get the prefix."""
	value = unquote(value) if value else ""
	if not value:
		return prefix + fallback_id if fallback_id else ""
	return value if value.startswith("GFX_") else prefix + value


class ItemModule:
	kind = "item"
	folder = ""
	page = ""
	pattern = "*.txt"
	loc_default = "studio_l_english.yml"

	def __init__(self, ctx: core.Context) -> None:
		self.ctx = ctx
		self.index: Optional[List[dict]] = None
		self.index_stamp: Tuple[int, int] = (0, 0)

	# ------------------------------------------------------------ hooks

	def items_in(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		"""(id, entry, meta) for every item of the file."""
		raise NotImplementedError

	def summary(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		"""Fields for the list on the left of the page."""
		return {}

	def extra(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		"""Module-specific fields for the editor and the preview."""
		return {}

	def loc_keys(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> List[str]:
		"""Localisation keys the page edits for this item."""
		return [item_id, item_id + "_desc"]

	def template(self, item_id: str, meta: dict, indent: str) -> str:
		raise NotImplementedError

	def container_for(self, doc: Doc, meta: dict) -> Optional[Entry]:
		"""The block new items go into, or None for the end of the file."""
		return None

	def new_loc(self, item_id: str, meta: dict, name: str) -> Dict[str, str]:
		return {item_id: name or item_id, item_id + "_desc": ""}

	# ------------------------------------------------------------ reading

	def files(self, include_vanilla: bool) -> List[dict]:
		return core.list_files(self.folder, self.pattern, include_vanilla)

	def load(self, rel: str) -> Tuple[Path, bool, str, Doc]:
		path, vanilla = core.resolve(rel)
		if not rel.startswith(self.folder + "/"):
			raise ValueError(f"{rel} is not in {self.folder}")
		text, _bom, _newline = read_script(path)
		return path, vanilla, text, Doc(text)

	def find(self, doc: Doc, item_id: str) -> Tuple[Entry, dict]:
		for found_id, entry, meta in self.items_in(doc):
			if found_id == item_id:
				return entry, meta
		raise ValueError(f"{item_id} was not found in the file")

	def list(self, rel: str) -> dict:
		self.ctx.fresh_loc()
		_path, vanilla, text, doc = self.load(rel)
		items = []
		for item_id, entry, meta in self.items_in(doc):
			row = {"id": item_id, "line": doc.line_of(entry.start), "name": self.ctx.display(item_id), **meta}
			row.update(self.summary(doc, item_id, entry, meta))
			items.append(row)
		return {"file": rel, "vanilla": vanilla, "version": file_version(text), "locStamp": self.ctx.stamp_text(),
			"items": items, **self.file_extra(doc)}

	def file_extra(self, doc: Doc) -> dict:
		return {}

	def item(self, rel: str, item_id: str) -> dict:
		self.ctx.fresh_loc()
		_path, vanilla, text, doc = self.load(rel)
		entry, meta = self.find(doc, item_id)
		keys = self.loc_keys(doc, item_id, entry, meta)
		return {
			"file": rel, "vanilla": vanilla, "version": file_version(text), "locStamp": self.ctx.stamp_text(),
			"id": item_id, "meta": meta, "line": doc.line_of(entry.start), "raw": text[entry.start:entry.value_end],
			"entries": entries_model(doc, entry),
			"loc": {key: self.ctx.text(key).replace("\\n", "\n") for key in keys},
			"locInMod": {key: self.ctx.has_mod_text(key) for key in keys},
			**self.extra(doc, item_id, entry, meta),
		}

	# ------------------------------------------------------------ writing

	def write(self, rel: str, version: Optional[str], change) -> Tuple[List[str], core.Backup, bool]:
		"""Apply `change(text, doc) -> new_text` to the file under the lock, with backup and checks."""
		path, vanilla = core.resolve(rel)
		text, had_bom, newline = read_script(path)
		if version is not None and file_version(text) != version:
			raise ValueError("The file changed on disk after it was loaded. Reload and redo the edit.")
		new_text = change(text, Doc(text))
		result = Doc(new_text)
		if not result.balanced:
			raise ValueError("the result has unbalanced braces; nothing was saved")
		backup = core.Backup()
		copied = False
		if vanilla:
			path, copied = core.writable_copy(rel)
		else:
			backup.keep(path)
		write_script(path, new_text, had_bom, newline)
		return [rel], backup, copied

	def save(self, payload: dict) -> dict:
		rel, item_id = payload["file"], payload["id"]
		with self.ctx.lock:
			written: List[str] = []
			backup = core.Backup()
			copied = False
			if payload.get("raw") is not None or payload.get("ops"):
				def change(text: str, doc: Doc) -> str:
					entry, _meta = self.find(doc, item_id)
					block = text[entry.start:entry.value_end]
					if payload.get("raw") is not None:
						new_block = str(payload["raw"]).replace("\r\n", "\n").strip()
						check = core.check_block(new_block)
						found = [i for i, _e, _m in self.items_in_block(check)]
						if found != [item_id]:
							raise ValueError("the edited block must stay one item with the same id")
					else:
						new_block = apply_ops(block, payload["ops"])
					return text[:entry.start] + new_block + text[entry.value_end:]
				written, backup, copied = self.write(rel, payload.get("version"), change)
			if payload.get("loc"):
				written += self.ctx.save_loc(payload["loc"], list(payload["loc"]), self.loc_default, backup)
			result = self.item(rel, item_id)
			result.update({"written": written, "backup": backup.where(), "copiedFromGame": copied})
			return result

	def items_in_block(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		"""Items of a lone block (used to check raw edits); top-level items by default."""
		return self.items_in(doc)

	def create(self, payload: dict) -> dict:
		rel, item_id = payload["file"], str(payload.get("id", "")).strip()
		if not core.SAFE_ID.match(item_id):
			raise ValueError("invalid id")
		meta = payload.get("meta") or {}
		with self.ctx.lock:
			def change(text: str, doc: Doc) -> str:
				if any(i == item_id for i, _e, _m in self.items_in(doc)):
					raise ValueError(f"{item_id} already exists in this file")
				container = self.container_for(doc, meta)
				if container is not None:
					inner = doc.entries(container.value_index)
					indent = core.indent_of(text, inner[0].start) if inner else core.indent_of(text, container.start, "") + "\t"
					position = doc.close_start(container.value_index)
					line_start = text.rfind("\n", 0, position) + 1
					block = self.template(item_id, meta, indent)
					if text[line_start:position].strip():
						return text[:position] + "\n" + indent + block + "\n" + text[position:]
					return text[:line_start] + "\n" + indent + block + "\n" + text[line_start:]
				block = self.template(item_id, meta, "")
				return text.rstrip("\n") + "\n\n" + block + "\n"
			written, backup, copied = self.write(rel, payload.get("version"), change)
			loc = {k: v for k, v in self.new_loc(item_id, meta, str(payload.get("name", ""))).items() if v or k == item_id}
			loc = {k: v for k, v in loc.items() if not self.ctx.has_mod_text(k)}
			written += self.ctx.save_loc(loc, list(loc), self.loc_default, backup)
			result = self.item(rel, item_id)
			result.update({"written": written, "backup": backup.where(), "copiedFromGame": copied})
			return result

	def delete(self, payload: dict) -> dict:
		rel, item_id = payload["file"], payload["id"]
		with self.ctx.lock:
			def change(text: str, doc: Doc) -> str:
				entry, _meta = self.find(doc, item_id)
				start, end = core.line_span(text, entry.start, entry.value_end)
				return text[:start] + text[end:]
			written, backup, copied = self.write(rel, payload.get("version"), change)
			return {"written": written, "backup": backup.where(), "copiedFromGame": copied, **self.list(rel)}

	# ------------------------------------------------------------ Claude, search, health links

	def claude_items(self, rel: str, ids: List[str], context: dict) -> List[dict]:
		_path, _vanilla, text, doc = self.load(rel)
		items = []
		for item_id in ids:
			entry, _meta = self.find(doc, item_id)
			items.append({"id": item_id, "name": self.ctx.display(item_id), "line": doc.line_of(entry.start),
				"raw": text[entry.start:entry.value_end]})
		return items

	def build_index(self) -> List[dict]:
		stamp = core.folder_stamp(core.ROOT / self.folder, self.pattern)
		if self.index is None or stamp != self.index_stamp:
			found: List[dict] = []
			for item in self.files(False):
				try:
					_path, _vanilla, _text, doc = self.load(item["file"])
				except ValueError:
					continue
				for item_id, entry, meta in self.items_in(doc):
					found.append({"id": item_id, "file": item["file"], "line": doc.line_of(entry.start),
						"end": doc.line_of(entry.value_end), "meta": meta})
			self.index, self.index_stamp = found, stamp
		return self.index

	def search(self, query: str, limit: int) -> List[dict]:
		query = query.lower()
		results = []
		for row in self.build_index():
			name = self.ctx.display(row["id"])
			if query in row["id"].lower() or query in name.lower():
				results.append({"module": self.kind, "id": row["id"], "name": name, "file": row["file"], "line": row["line"],
					"url": f"/{self.page}?file={row['file']}&id={row['id']}"})
				if len(results) >= limit:
					break
		return results

	def locate(self, rel: str, line: int) -> Optional[str]:
		for row in self.build_index():
			if row["file"] == rel and row["line"] <= line <= row["end"]:
				return row["id"]
		return None
