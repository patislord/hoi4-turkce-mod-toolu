"""Event module of the HOI4 Türkçe Mod Toolu (page: web/events.html).

Events live in `events/*.txt` as `country_event`, `news_event`, `state_event`, ... blocks with an
`id` inside. The page edits the flags, picture, title and description texts, options (name text
and body), and every other entry as text, shows a window preview, and draws the chain of events
that fire each other. `fires` follows `country_event = x.1` and `country_event = { id = x.1 ... }`
(and the other event types) anywhere inside an event.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, Entry, unquote
from items import ItemModule, sprite_name

EVENT_TYPES = ("country_event", "news_event", "state_event", "unit_leader_event", "operative_leader_event")
FIRE = re.compile(r"\b(?:country_event|news_event|state_event|unit_leader_event|operative_leader_event)\s*=\s*"
	r"(?:\{[^{}]*?\bid\s*=\s*([A-Za-z0-9_.\-]+)|([A-Za-z0-9_.\-]+))")
EVENT_ID = re.compile(r"\bid\s*=\s*([A-Za-z0-9_\-]+)\.(\d+)\b")
DEFAULT_PICTURE = {"news_event": "GFX_news_event_generic_read_write", "country_event": "GFX_report_event_generic_sign_treaty1"}


def fires_in(text: str) -> List[str]:
	found: List[str] = []
	for match in FIRE.finditer(text):
		target = match.group(1) or match.group(2)
		if target and target not in found and target not in ("yes", "no"):
			found.append(target)
	return found


class EventModule(ItemModule):
	kind = "event"
	folder = "events"
	page = "events.html"
	loc_default = "studio_events_l_english.yml"

	def items_in(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		found = []
		for entry in doc.entries():
			if entry.key in EVENT_TYPES and entry.is_block:
				event_id = core.scalar(doc, entry, "id")
				if event_id:
					namespace = event_id.rsplit(".", 1)[0] if "." in event_id else ""
					title = core.scalar(doc, entry, "title") or ""
					found.append((event_id, entry, {"type": entry.key, "namespace": namespace, "title": title}))
		return found

	def search(self, query: str, limit: int) -> List[dict]:
		query = query.lower()
		results = []
		for row in self.build_index():
			name = self.ctx.text(row["meta"].get("title") or "")
			if query in row["id"].lower() or query in name.lower():
				results.append({"module": self.kind, "id": row["id"], "name": name, "file": row["file"], "line": row["line"],
					"url": f"/{self.page}?file={row['file']}&id={row['id']}"})
				if len(results) >= limit:
					break
		return results

	def text_keys(self, doc: Doc, entry: Entry, key: str) -> List[dict]:
		"""Title or description variants: a plain key, or a block with `text = key` and a trigger."""
		variants = []
		for occ, sub in enumerate(core.sub_entries(doc, entry, key)):
			if sub.is_block:
				text_key = core.scalar(doc, sub, "text")
				variants.append({"occ": occ, "key": text_key, "conditional": True})
			else:
				variants.append({"occ": occ, "key": unquote(sub.value), "conditional": False})
		return variants

	def options(self, doc: Doc, entry: Entry) -> List[dict]:
		found = []
		for occ, sub in enumerate(core.sub_entries(doc, entry, "option")):
			found.append({"occ": occ, "key": core.scalar(doc, sub, "name") or ""})
		return found

	def loc_keys(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> List[str]:
		keys = [v["key"] for v in self.text_keys(doc, entry, "title") + self.text_keys(doc, entry, "desc") if v["key"]]
		keys += [o["key"] for o in self.options(doc, entry) if o["key"]]
		return list(dict.fromkeys(keys))

	def picture(self, doc: Doc, entry: Entry) -> str:
		return sprite_name(core.scalar(doc, entry, "picture"), "")

	def summary(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		titles = self.text_keys(doc, entry, "title")
		title_key = titles[0]["key"] if titles else None
		return {
			"name": self.ctx.text(title_key) if title_key else "",
			"sprite": self.picture(doc, entry),
			"hidden": core.scalar(doc, entry, "hidden") == "yes",
			"triggered": core.scalar(doc, entry, "is_triggered_only") == "yes",
		}

	def extra(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		block = doc.text[entry.start:entry.value_end]
		return {
			**self.summary(doc, item_id, entry, meta),
			"titles": self.text_keys(doc, entry, "title"),
			"descs": self.text_keys(doc, entry, "desc"),
			"options": self.options(doc, entry),
			"fires": [target for target in fires_in(block) if target != item_id],
			"firedBy": self.fired_by(item_id),
		}

	def file_extra(self, doc: Doc) -> dict:
		spaces = [unquote(e.value) for e in doc.entries() if e.key == "add_namespace" and not e.is_block]
		return {"namespaces": spaces}

	def template(self, item_id: str, meta: dict, indent: str) -> str:
		kind = meta.get("type") if meta.get("type") in EVENT_TYPES else "country_event"
		picture = DEFAULT_PICTURE.get(kind, DEFAULT_PICTURE["country_event"])
		hidden = "\n\thidden = yes" if meta.get("hidden") else ""
		return (f"{kind} = {{\n\tid = {item_id}\n\ttitle = {item_id}.t\n\tdesc = {item_id}.d\n\tpicture = {picture}\n"
			f"\tis_triggered_only = yes{hidden}\n\n\toption = {{\n\t\tname = {item_id}.a\n\t}}\n}}")

	def new_loc(self, item_id: str, meta: dict, name: str) -> Dict[str, str]:
		return {f"{item_id}.t": name or item_id, f"{item_id}.d": "", f"{item_id}.a": "OK"}

	def next_id(self, namespace: str) -> str:
		"""The next free number in a namespace, across the mod and the game."""
		if not core.SAFE_ID.match(namespace):
			raise ValueError("invalid namespace")
		highest = 0
		folders = [core.ROOT / "events"]
		game = core.game_root()
		if game is not None:
			folders.append(game / "events")
		for folder in folders:
			for path in folder.glob("*.txt"):
				text = core.read_text(path)
				if namespace + "." not in text:
					continue
				for match in EVENT_ID.finditer(text):
					if match.group(1) == namespace:
						highest = max(highest, int(match.group(2)))
		return f"{namespace}.{highest + 1}"

	def build_fire_index(self) -> Dict[str, List[str]]:
		"""event id -> events in the mod that fire it."""
		reverse: Dict[str, List[str]] = {}
		for item in self.files(False):
			try:
				_path, _vanilla, text, doc = self.load(item["file"])
			except ValueError:
				continue
			for event_id, entry, _meta in self.items_in(doc):
				for target in fires_in(text[entry.start:entry.value_end]):
					if target != event_id:
						reverse.setdefault(target, []).append(event_id)
		return reverse

	def fired_by(self, event_id: str) -> List[str]:
		stamp = core.folder_stamp(core.ROOT / self.folder, self.pattern)
		if getattr(self, "fire_stamp", None) != stamp:
			self.fire_index = self.build_fire_index()
			self.fire_stamp = stamp
		return self.fire_index.get(event_id, [])

	def graph(self, rel: str) -> dict:
		"""Nodes and edges of the event chains of one file, with outside targets marked."""
		_path, _vanilla, text, doc = self.load(rel)
		nodes: Dict[str, dict] = {}
		edges: List[Tuple[str, str]] = []
		for event_id, entry, meta in self.items_in(doc):
			summary = self.summary(doc, event_id, entry, meta)
			nodes[event_id] = {"id": event_id, "name": summary["name"], "type": meta["type"], "hidden": summary["hidden"],
				"external": False, "sprite": summary["sprite"]}
			for target in fires_in(text[entry.start:entry.value_end]):
				if target != event_id:
					edges.append((event_id, target))
		index = {row["id"]: row for row in self.build_index()}
		for _source, target in edges:
			if target not in nodes:
				row = index.get(target)
				nodes[target] = {"id": target, "name": "", "type": "", "hidden": False, "external": True,
					"file": row["file"] if row else None, "sprite": ""}
		return {"file": rel, "nodes": list(nodes.values()), "edges": [{"from": a, "to": b} for a, b in edges]}

	def refs_skip(self, rel: str, line: int, end: int):
		"""A filter that hides references inside the event's own block."""
		def skip(path, number: int) -> bool:
			return core.rel_path(path) == rel and line <= number <= end
		return skip
