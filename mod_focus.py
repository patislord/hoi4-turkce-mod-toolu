"""Focus tree module of the HOI4 Türkçe Mod Toolu (page: web/focus.html).

Reads one `focus_tree` of a file in `common/national_focus/`, and saves surgical edits: only the
changed keys of the changed focuses (`x`, `y`, `cost`, `icon`, `prerequisite`,
`mutually_exclusive`, `relative_position_id` removal) are rewritten, a focus whose raw block was
edited is replaced as a whole, and added focuses are appended before the tree's closing brace.

The page's effect and trigger builder edits the script blocks of a focus one by one
(`SCRIPT_BLOCKS`: the reward, the conditions, the AI weight), its yes/no switches (`FLAGS`) and its
search filters; each arrives as its own change and only that block or line is rewritten.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, Entry, block_body, file_version, indent_of, line_span, read_script, unquote, write_script
from items import apply_ops

FOLDER = "common/national_focus"
# Blocks of a focus that hold script (wiki: National focus modding, Focus arguments).
SCRIPT_BLOCKS = ("completion_reward", "select_effect", "complete_tooltip", "available", "bypass", "cancel", "allow_branch", "ai_will_do")
FLAGS = ("cancel_if_invalid", "continue_if_invalid", "available_if_capitulated", "cancelable", "bypass_if_unavailable")
FILTERS = "search_filters"
FILTER_NAME = re.compile(r"^[A-Za-z0-9_]+$")
FOCUS_ID = re.compile(r"\b(?:focus|shared_focus)\s*=\s*\{\s*id\s*=\s*([A-Za-z0-9_.\-]+)")


def focus_ids_in(doc: Doc, entry: Entry) -> List[str]:
	return [unquote(sub.value) for sub in doc.entries(entry.value_index) if sub.key == "focus" and sub.value]


def trees_in(doc: Doc) -> List[Entry]:
	return [entry for entry in doc.entries() if entry.key == "focus_tree" and entry.is_block]


def tree_entry(doc: Doc, tree_id: str) -> Entry:
	for entry in trees_in(doc):
		for sub in doc.entries(entry.value_index):
			if sub.key == "id" and unquote(sub.value) == tree_id:
				return entry
	raise ValueError(f"focus tree {tree_id} not found")


def tree_ids(doc: Doc) -> List[str]:
	ids = []
	for entry in trees_in(doc):
		ids += [unquote(sub.value) for sub in doc.entries(entry.value_index) if sub.key == "id"]
	return ids


def focus_entries(doc: Doc, tree: Entry) -> List[Entry]:
	return [entry for entry in doc.entries(tree.value_index) if entry.key == "focus" and entry.is_block]


def focus_model(doc: Doc, entry: Entry) -> dict:
	"""The JSON model of one focus block."""
	model: dict = {
		"id": "", "x": 0, "y": 0, "rel": None, "icon": None, "iconDynamic": False, "cost": "",
		"prereq": [], "mex": [], "hasOffset": False, "line": doc.text.count("\n", 0, entry.start) + 1,
		"raw": doc.text[entry.start:entry.value_end], "blocks": {}, "flags": {}, "filters": None,
	}
	for sub in doc.entries(entry.value_index):
		if sub.key == "id":
			model["id"] = unquote(sub.value)
		elif sub.key in ("x", "y") and not sub.is_block:
			try:
				model[sub.key] = int(float(unquote(sub.value)))
			except ValueError:
				model[sub.key] = 0
		elif sub.key == "relative_position_id":
			model["rel"] = unquote(sub.value)
		elif sub.key == "icon":
			if sub.is_block:
				model["iconDynamic"] = True
				values = [unquote(v.value) for v in doc.entries(sub.value_index) if v.key == "value"]
				model["icon"] = values[0] if values else None
			else:
				model["icon"] = unquote(sub.value)
		elif sub.key == "cost":
			model["cost"] = unquote(sub.value)
		elif sub.key == "prerequisite" and sub.is_block:
			model["prereq"].append(focus_ids_in(doc, sub))
		elif sub.key == "mutually_exclusive" and sub.is_block:
			model["mex"] += focus_ids_in(doc, sub)
		elif sub.key == "offset":
			model["hasOffset"] = True
		elif sub.key in SCRIPT_BLOCKS and sub.is_block and sub.key not in model["blocks"]:
			model["blocks"][sub.key] = block_body(doc.text, doc, sub)
		elif sub.key in FLAGS and not sub.is_block:
			model["flags"][sub.key] = unquote(sub.value)
		elif sub.key == FILTERS and sub.is_block and model["filters"] is None:
			model["filters"] = [v.value for v in doc.entries(sub.value_index) if v.key is None and v.value]
	return model


def script_ops(change: dict) -> List[dict]:
	"""Block operations (items.apply_ops) for the script blocks, switches and search filters of a change."""
	ops: List[dict] = []
	for key, body in (change.get("blocks") or {}).items():
		if key not in SCRIPT_BLOCKS:
			raise ValueError(f"{key} is not a script block of a focus")
		ops.append({"op": "remove", "key": key} if body is None else {"op": "block", "key": key, "body": str(body)})
	for key, value in (change.get("flags") or {}).items():
		if key not in FLAGS:
			raise ValueError(f"{key} is not a focus switch")
		if value is None:
			ops.append({"op": "remove", "key": key})
		elif value in ("yes", "no"):
			ops.append({"op": "set", "key": key, "value": value})
		else:
			raise ValueError(f"{key} must be yes or no")
	if "filters" in change:
		filters = change["filters"]
		if not filters:
			ops.append({"op": "remove", "key": FILTERS})
		elif any(not FILTER_NAME.match(str(name)) for name in filters):
			raise ValueError("invalid search filter")
		else:
			ops.append({"op": "block", "key": FILTERS, "body": " ".join(dict.fromkeys(str(name) for name in filters))})
	return ops


def edit_script(block: str, change: dict) -> str:
	"""Apply the script-block part of a change to the text of one focus block."""
	doc = Doc(block)
	top = [entry for entry in doc.entries() if entry.key == "focus" and entry.is_block]
	present = {sub.key for sub in doc.entries(top[0].value_index)} if top else set()
	# removing something that is not there is not an edit
	ops = [op for op in script_ops(change) if op["op"] != "remove" or op["key"] in present]
	return apply_ops(block, ops) if ops else block


def format_group(key: str, ids: List[str]) -> str:
	return f"{key} = {{ " + " ".join(f"focus = {focus}" for focus in ids) + " }"


def edit_block(block: str, change: dict) -> str:
	"""Apply structured changes to the text of one `focus = { ... }` block."""
	doc = Doc(block)
	top = [entry for entry in doc.entries() if entry.key == "focus" and entry.is_block]
	if not top:
		raise ValueError("not a focus block")
	subs = doc.entries(top[0].value_index)
	by_key: Dict[str, Entry] = {}
	for sub in subs:
		if sub.key and sub.key not in by_key:
			by_key[sub.key] = sub
	id_entry = by_key.get("id")
	if id_entry is None:
		raise ValueError("focus block without id")
	indent = indent_of(block, id_entry.start)
	edits: List[Tuple[int, int, str]] = []
	inserts: List[str] = []

	if "id" in change and change["id"] != unquote(id_entry.value):
		edits.append((id_entry.value_start, id_entry.value_end, change["id"]))
	for key in ("x", "y", "cost", "icon"):
		if key not in change:
			continue
		value = str(change[key])
		existing = by_key.get(key)
		if existing is not None and existing.is_block:
			if key == "icon":
				continue  # a dynamic icon block is only edited as raw text
			raise ValueError(f"{key} is a block")
		if existing is not None:
			edits.append((existing.value_start, existing.value_end, value))
		else:
			inserts.append(f"{indent}{key} = {value}\n")
	if "rel" in change and not change["rel"]:
		for sub in subs:
			if sub.key == "relative_position_id":
				start, end = line_span(block, sub.start, sub.value_end)
				edits.append((start, end, ""))
	if "prereq" in change or "mex" in change:
		for sub in subs:
			if (sub.key == "prerequisite" and "prereq" in change) or (sub.key == "mutually_exclusive" and "mex" in change):
				start, end = line_span(block, sub.start, sub.value_end)
				edits.append((start, end, ""))
		for group in change.get("prereq") or []:
			if group:
				inserts.append(f"{indent}{format_group('prerequisite', group)}\n")
		if change.get("mex"):
			inserts.append(f"{indent}{format_group('mutually_exclusive', change['mex'])}\n")
	if inserts:
		anchor = by_key.get("icon") or id_entry
		newline = block.find("\n", anchor.value_end)
		position = len(block) if newline < 0 else newline + 1
		edits.append((position, position, "".join(inserts)))
	for start, end, text in sorted(edits, key=lambda item: (item[0], item[1]), reverse=True):
		block = block[:start] + text + block[end:]
	return block


def new_focus_block(focus_id: str, indent: str) -> str:
	inner = indent + "\t"
	return (
		f"focus = {{\n{inner}id = {focus_id}\n{inner}icon = GFX_goal_unknown\n{inner}x = 0\n{inner}y = 0\n"
		f"{inner}cost = 10\n{inner}search_filters = {{ FOCUS_FILTER_POLITICAL }}\n"
		f"{inner}ai_will_do = {{ base = 1 }}\n{inner}completion_reward = {{\n{inner}}}\n{indent}}}"
	)


def strip_relative(block: str) -> str:
	doc = Doc(block)
	top = [entry for entry in doc.entries() if entry.key == "focus" and entry.is_block][0]
	for sub in reversed(doc.entries(top.value_index)):
		if sub.key == "relative_position_id":
			start, end = line_span(block, sub.start, sub.value_end)
			block = block[:start] + block[end:]
	return block


def apply_changes(text: str, tree_id: str, payload: dict) -> str:
	"""Return the new focus file text, or raise ValueError with a reason."""
	doc = Doc(text)
	tree = tree_entry(doc, tree_id)
	entries = {focus_model(doc, entry)["id"]: entry for entry in focus_entries(doc, tree)}
	edits: List[Tuple[int, int, str]] = []
	for focus_id in payload.get("deleted", []):
		entry = entries.get(focus_id)
		if entry is None:
			raise ValueError(f"cannot delete unknown focus {focus_id}")
		start, end = line_span(text, entry.start, entry.value_end)
		edits.append((start, end, ""))
	for change in payload.get("changed", []):
		entry = entries.get(change.get("id", ""))
		if entry is None:
			raise ValueError(f"cannot edit unknown focus {change.get('id')}")
		if change["id"] in payload.get("deleted", []):
			continue
		block = text[entry.start:entry.value_end]
		if "raw" in change:
			new_block = change["raw"].replace("\r\n", "\n").strip()
			check = Doc(new_block)
			if not check.balanced:
				raise ValueError(f"{change['id']}: the edited block has unbalanced braces")
			models = [focus_model(check, e) for e in check.entries() if e.key == "focus" and e.is_block]
			if len(models) != 1 or models[0]["id"] != change["id"]:
				raise ValueError(f"{change['id']}: the edited block must be one focus with the same id")
		else:
			new_block = edit_script(edit_block(block, {k: v for k, v in change.items() if k != "id"}), change)
		edits.append((entry.start, entry.value_end, new_block))
	added = payload.get("added", [])
	if added:
		focus_list = list(entries.values())
		indent = indent_of(text, focus_list[0].start) if focus_list else "\t"
		pieces = []
		for item in added:
			focus_id = item.get("id", "")
			if not core.SAFE_ID.match(focus_id) or focus_id in entries:
				raise ValueError(f"invalid or duplicate new focus id: {focus_id}")
			source = entries.get(item.get("copyOf") or "")
			base = text[source.start:source.value_end] if source is not None else new_focus_block(focus_id, indent)
			fields = {k: v for k, v in item.items() if k in ("x", "y", "cost", "icon", "prereq", "mex")}
			fields["id"] = focus_id
			block = edit_script(edit_block(base, fields), item)
			if source is not None:
				block = strip_relative(block)  # the page sends absolute positions for copies
			pieces.append(f"\n{indent}{block}\n")
		position = doc.close_start(tree.value_index)
		line_start = text.rfind("\n", 0, position) + 1
		if not text[line_start:position].strip():
			position = line_start
		else:
			pieces[-1] += indent[:-1] if indent.endswith("\t") else ""
		edits.append((position, position, "".join(pieces)))
	for start, end, new in sorted(edits, key=lambda item: (item[0], item[1]), reverse=True):
		text = text[:start] + new + text[end:]
	result = Doc(text)
	if not result.balanced:
		raise ValueError("the result has unbalanced braces; nothing was saved")
	expected = len(entries) - len(payload.get("deleted", [])) + len(added)
	actual = len(focus_entries(result, tree_entry(result, tree_id)))
	if actual != expected:
		raise ValueError(f"expected {expected} focuses after the edit but found {actual}; nothing was saved")
	return text


def absolute_positions(focuses: List[dict]) -> Dict[str, Tuple[int, int]]:
	"""Absolute tree positions, following relative_position_id like the game does."""
	by_id = {focus["id"]: focus for focus in focuses}
	found: Dict[str, Tuple[int, int]] = {}

	def resolve_pos(focus_id: str, seen: set) -> Tuple[int, int]:
		if focus_id in found:
			return found[focus_id]
		focus = by_id[focus_id]
		x, y = focus["x"], focus["y"]
		anchor = focus.get("rel")
		if anchor in by_id and anchor not in seen:
			ax, ay = resolve_pos(anchor, seen | {focus_id})
			x, y = x + ax, y + ay
		found[focus_id] = (x, y)
		return x, y

	for focus_id in by_id:
		resolve_pos(focus_id, set())
	return found


class FocusModule:
	kind = "focus"

	def __init__(self, ctx: core.Context) -> None:
		self.ctx = ctx
		self.index: Optional[List[Tuple[str, str, int]]] = None
		self.index_stamp: Tuple[int, int] = (0, 0)

	def files(self, include_vanilla: bool) -> List[dict]:
		return core.list_files(FOLDER, "*.txt", include_vanilla)

	def tree(self, rel: str, tree_id: str) -> dict:
		self.ctx.fresh_loc()
		path, vanilla = core.resolve(rel)
		text, _bom, _newline = read_script(path)
		doc = Doc(text)
		ids = tree_ids(doc)
		if not ids:
			raise ValueError(f"{rel} has no focus_tree")
		tree_id = tree_id if tree_id in ids else ids[0]
		tree = tree_entry(doc, tree_id)
		focuses = []
		for entry in focus_entries(doc, tree):
			model = focus_model(doc, entry)
			model["name"] = self.ctx.text(model["id"])
			model["desc"] = self.ctx.text(model["id"] + "_desc").replace("\\n", "\n")
			icon = model["icon"]
			model["iconShine"] = not icon or model["iconDynamic"] or self.ctx.sprites.has_shine(icon)
			focuses.append(model)
		return {"file": rel, "vanilla": vanilla, "tree": tree_id, "trees": ids, "version": file_version(text),
			"locStamp": self.ctx.stamp_text(), "focuses": focuses}

	def save(self, payload: dict) -> dict:
		rel = payload["file"]
		with self.ctx.lock:
			path, vanilla = core.resolve(rel)
			text, had_bom, newline = read_script(path)
			if file_version(text) != payload.get("version"):
				raise ValueError("The file changed on disk after it was loaded. Reload and redo the edit.")
			backup = core.Backup()
			written: List[str] = []
			copied = False
			if any(payload.get(key) for key in ("changed", "added", "deleted")):
				new_text = apply_changes(text, payload["tree"], payload)
				if vanilla:
					path, copied = core.writable_copy(rel)
				else:
					backup.keep(path)
				write_script(path, new_text, had_bom, newline)
				written.append(rel)
			if payload.get("loc"):
				ids = [k[:-5] if k.endswith("_desc") else k for k in payload["loc"]]
				related = [focus["id"] for focus in self.tree(rel, payload["tree"])["focuses"]] + ids
				written += self.ctx.save_loc(payload["loc"], related, Path(rel).stem + "_focus_l_english.yml", backup)
			result = self.tree(rel, payload["tree"])
			result.update({"written": written, "backup": backup.where(), "copiedFromGame": copied})
			return result

	def claude_items(self, rel: str, ids: List[str], context: dict) -> List[dict]:
		model = self.tree(rel, str(context.get("tree", "")))
		by_id = {focus["id"]: focus for focus in model["focuses"]}
		positions = absolute_positions(model["focuses"])
		items = []
		for focus_id in ids:
			focus = by_id.get(focus_id)
			if focus is None:
				raise ValueError(f"{focus_id} is not in the saved file; save before sending it to Claude")
			x, y = positions[focus_id]
			items.append({"id": focus_id, "name": focus["name"], "line": focus["line"], "raw": focus["raw"],
				"extra": f"at x={x}, y={y}"})
		return items

	def build_index(self) -> List[Tuple[str, str, int]]:
		stamp = core.folder_stamp(core.ROOT / FOLDER, "*.txt")
		if self.index is None or stamp != self.index_stamp:
			found: List[Tuple[str, str, int]] = []
			for item in self.files(False):
				text = core.read_text(core.ROOT / item["file"])
				for match in FOCUS_ID.finditer(text):
					found.append((match.group(1), item["file"], text.count("\n", 0, match.start()) + 1))
			self.index, self.index_stamp = found, stamp
		return self.index

	def search(self, query: str, limit: int) -> List[dict]:
		query = query.lower()
		results = []
		for focus_id, rel, line in self.build_index():
			name = self.ctx.text(focus_id)
			if query in focus_id.lower() or query in name.lower():
				results.append({"module": "focus", "id": focus_id, "name": name, "file": rel, "line": line,
					"url": f"/focus.html?file={rel}&focus={focus_id}"})
				if len(results) >= limit:
					break
		return results

	def locate(self, rel: str, line: int) -> Optional[str]:
		"""The focus whose block starts closest above `line` in `rel`."""
		best: Optional[Tuple[str, int]] = None
		for focus_id, file, start in self.build_index():
			if file == rel and start <= line and (best is None or start > best[1]):
				best = (focus_id, start)
		return best[0] if best else None
