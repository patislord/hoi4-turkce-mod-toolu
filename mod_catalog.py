"""Catalog of the things script refers to, for the pickers of the HOI4 Türkçe Mod Toolu.

The visual effect and trigger builder (web/studio-script.js) never asks the user to type an id: a
country, state, national spirit, event, decision, focus, character, trait, technology, building,
resource, equipment, opinion modifier and so on is chosen from a searchable list. `Catalog.get(kind)`
returns that list as rows `{id, name, icon?, group?, sub?, mod?, url?}`:

- `name` is the English text the game shows, `icon` a sprite name or a `gfx/...` texture path,
  `group` a heading to filter by, `sub` a short note, `mod` is true when the mod defines it, and
  `url` opens it in its own editor page.
- Lists come from the mod first and then the installed game, and are cached until the mod folder
  they come from changes.
- `effect_doc`, `trigger_doc` and `modifier` read the game's own `documentation/*.md`, so the
  builder knows every effect and trigger of the installed version, the scopes each one supports and
  its description.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import core
from core import Doc

DOC_SECTION = re.compile(r"^## ([A-Za-z0-9_]+)[ \t]*\n(.*?)(?=^## |\Z)", re.DOTALL | re.MULTILINE)
DOC_SCOPES = re.compile(r"\* Supported Scopes:[ \t]*([^\n]*)")
DOC_TARGETS = re.compile(r"\* Supported Targets:[ \t]*([^\n]*)")
DOC_CATEGORIES = re.compile(r"\*\*Categories\*\*:[ \t]*([^\n]*)")
FOCUS_FILTER = re.compile(r"\bFOCUS_FILTER_[A-Z0-9_]+")
AUTONOMY_ID = re.compile(r"\bautonomy_state\s*=\s*\{[^{}]*?\bid\s*=\s*([A-Za-z0-9_]+)")
FLAG_PATTERNS = {
	"country_flag": re.compile(r"\b(?:set_country_flag|has_country_flag|clr_country_flag)\s*=\s*(?:\{[^{}]*?\bflag\s*=\s*)?([A-Za-z0-9_.\-]+)"),
	"global_flag": re.compile(r"\b(?:set_global_flag|has_global_flag|clr_global_flag)\s*=\s*(?:\{[^{}]*?\bflag\s*=\s*)?([A-Za-z0-9_.\-]+)"),
	"state_flag": re.compile(r"\b(?:set_state_flag|has_state_flag|clr_state_flag)\s*=\s*(?:\{[^{}]*?\bflag\s*=\s*)?([A-Za-z0-9_.\-]+)"),
}
FLAG_SECONDS = 60.0  # the flag lists scan every script file of the mod, so they are refreshed at most this often
DOC_TEXT_LIMIT = 600
NOT_FLAGS = {"yes", "no", "flag"}
LOC_CODES = re.compile(r"£\S+\s*|§.")  # inline icons (£name) and colour switches (§Y ... §!)


class Catalog:
	def __init__(self, ctx: core.Context, modules: Dict[str, object]) -> None:
		self.ctx = ctx
		self.modules = modules
		self.lock = threading.Lock()
		self.cache: Dict[str, Tuple[object, object]] = {}
		self.flags: Optional[Tuple[float, Dict[str, List[str]]]] = None
		self.kinds: Dict[str, Callable[[], List[dict]]] = {
			"country": self.countries, "state": self.states, "idea": self.ideas, "tech": self.technologies,
			"tech_category": self.tech_categories, "focus": self.focuses, "event": self.events,
			"decision": self.decisions, "decision_category": self.decision_categories, "character": self.characters,
			"leader_trait": lambda: self.traits("country"), "unit_trait": lambda: self.traits("unit"),
			"ideology": self.ideologies, "sub_ideology": self.sub_ideologies, "modifier": self.modifiers,
			"equipment": lambda: self.named_blocks("equipment", "common/units/equipment", "equipments"),
			"sub_unit": lambda: self.named_blocks("sub_unit", "common/units", "sub_units"),
			"building": lambda: self.named_blocks("building", "common/buildings", "buildings"),
			"resource": lambda: self.named_blocks("resource", "common/resources", "resources", name_prefix="state_resource_"),
			"opinion_modifier": lambda: self.named_blocks("opinion_modifier", "common/opinion_modifiers", "opinion_modifiers"),
			"dynamic_modifier": lambda: self.named_blocks("dynamic_modifier", "common/dynamic_modifiers", None),
			"scripted_effect": lambda: self.named_blocks("scripted_effect", "common/scripted_effects", None),
			"scripted_trigger": lambda: self.named_blocks("scripted_trigger", "common/scripted_triggers", None),
			"wargoal": lambda: self.named_blocks("wargoal", "common/wargoals", "wargoal_types"),
			"state_category": lambda: self.named_blocks("state_category", "common/state_category", "state_categories"),
			"autonomy": self.autonomy_states, "oob": self.oobs, "focus_filter": self.focus_filters,
			"country_flag": lambda: self.flag_rows("country_flag"), "global_flag": lambda: self.flag_rows("global_flag"),
			"state_flag": lambda: self.flag_rows("state_flag"),
			"effect_doc": lambda: self.documented("effects"), "trigger_doc": lambda: self.documented("triggers"),
		}

	def get(self, kind: str) -> List[dict]:
		build = self.kinds.get(kind)
		if build is None:
			raise ValueError(f"unknown catalog {kind}")
		self.ctx.fresh_loc()
		return build()

	# ------------------------------------------------------------ helpers

	def cached(self, name: str, stamp: object, build):
		with self.lock:
			old = self.cache.get(name)
			if old is not None and old[0] == stamp:
				return old[1]
		value = build()
		with self.lock:
			self.cache[name] = (stamp, value)
		return value

	def name(self, key: str, fallback: str = "") -> str:
		"""The English text of a key as a plain label: no colour codes, icon codes or line breaks."""
		text = self.ctx.display(key)
		if not text:
			return fallback
		return self.plain(text) or fallback

	@staticmethod
	def plain(text: str) -> str:
		return re.sub(r"\s+", " ", LOC_CODES.sub("", text).replace("\\n", " ")).strip()

	def game_doc(self, name: str) -> str:
		game = core.game_root()
		doc_file = game / "documentation" / name if game else None
		return core.read_text(doc_file).replace("\r\n", "\n") if doc_file is not None and doc_file.is_file() else ""

	def block_ids(self, folder: str, wrapper: Optional[str]) -> List[Tuple[str, bool]]:
		"""(id, defined by the mod) of the blocks inside `wrapper = { }` (or at the top level) of every
		file of a folder, the mod's files before the game's; a bare word inside the wrapper also counts."""
		found: Dict[str, bool] = {}
		for item in core.list_files(folder, "*.txt", include_vanilla=True):
			try:
				path, vanilla = core.resolve(item["file"])
			except ValueError:
				continue
			doc = Doc(core.read_text(path))
			holders = [-1] if wrapper is None else [e.value_index for e in doc.entries() if e.key == wrapper and e.is_block]
			for holder in holders:
				for entry in doc.entries(holder):
					if entry.key and entry.is_block and not entry.key.startswith("@"):
						found.setdefault(entry.key, not vanilla)
					elif entry.key is None and wrapper is not None and entry.value and core.SAFE_ID.match(entry.value):
						found.setdefault(entry.value, not vanilla)
		return sorted(found.items())

	def named_blocks(self, kind: str, folder: str, wrapper: Optional[str], name_prefix: str = "") -> List[dict]:
		ids = self.cached(kind, core.folder_stamp(core.ROOT / folder, "*.txt"), lambda: self.block_ids(folder, wrapper))
		return [{"id": i, "name": self.name(name_prefix + i) or self.name(i), "mod": mod} for i, mod in ids]

	# ------------------------------------------------------------ lists

	def countries(self) -> List[dict]:
		rows = self.modules["country"].list()["countries"]
		return [{"id": r["tag"], "name": r["name"], "icon": r["flag"] or "", "url": f"/countries.html?tag={r['tag']}"} for r in rows]

	def states(self) -> List[dict]:
		return [{"id": str(r["id"]), "name": r["name"] or f"State {r['id']}", "sub": r["owner"], "group": r["owner"]}
			for r in self.modules["country"].states()]

	def ideas(self) -> List[dict]:
		ideas = self.modules["idea"]
		in_mod = {f["file"] for f in ideas.files(False)}
		return [{"id": r["id"], "name": r["name"], "icon": r["sprite"], "group": r["category"], "mod": r["file"] in in_mod,
			"url": f"/ideas.html?file={r['file']}&id={r['id']}"} for r in self.modules["country"].idea_list()]

	def technologies(self) -> List[dict]:
		return [{"id": r["id"], "name": r["name"]} for r in self.modules["country"].technologies()]

	def tech_categories(self) -> List[dict]:
		ids = self.cached("tech_category", core.folder_stamp(core.ROOT / "common" / "technology_tags", "*.txt"),
			lambda: self.block_ids("common/technology_tags", "technology_categories"))
		return [{"id": i, "name": self.name(i + "_research") or self.name(i), "mod": mod} for i, mod in ids]

	def focuses(self) -> List[dict]:
		return [{"id": focus_id, "name": self.ctx.text(focus_id), "sub": Path(rel).stem, "mod": True,
			"url": f"/focus.html?file={rel}&focus={focus_id}"} for focus_id, rel, _line in self.modules["focus"].build_index()]

	def events(self) -> List[dict]:
		return [{"id": r["id"], "name": self.ctx.text(r["meta"].get("title") or ""), "group": r["meta"].get("namespace", ""),
			"sub": r["meta"].get("type", ""), "mod": True, "url": f"/events.html?file={r['file']}&id={r['id']}"}
			for r in self.modules["event"].build_index()]

	def decisions(self) -> List[dict]:
		return [{"id": r["id"], "name": self.name(r["id"]), "group": r["meta"].get("category", ""), "mod": True,
			"url": f"/decisions.html?file={r['file']}&id={r['id']}"} for r in self.modules["decision"].build_index()]

	def decision_categories(self) -> List[dict]:
		return self.named_blocks("decision_category", "common/decisions/categories", None)

	def characters(self) -> List[dict]:
		rows = []
		for r in self.modules["character"].all_ids():
			tag = r["id"].split("_", 1)[0] if "_" in r["id"] else ""
			row = {"id": r["id"], "name": r["name"], "group": tag, "mod": r["mod"]}
			if r["mod"]:
				row["url"] = f"/characters.html?file={r['file']}&id={r['id']}"
			rows.append(row)
		return rows

	def traits(self, kind: str) -> List[dict]:
		return [{"id": t, "name": self.name(t)} for t in self.modules["country"].traits()[kind]]

	def ideologies(self) -> List[dict]:
		return [{"id": g["group"], "name": self.name(g["group"])} for g in self.modules["country"].ideologies()]

	def sub_ideologies(self) -> List[dict]:
		return [{"id": t, "name": self.name(t), "group": g["group"]} for g in self.modules["country"].ideologies() for t in g["types"]]

	def modifiers(self) -> List[dict]:
		"""Every modifier the game documents, with its tooltip name and the categories it applies to,
		then the modifiers the mod defines itself (common/modifier_definitions)."""
		ideas = self.modules["idea"]
		def build() -> List[Tuple[str, str]]:
			found: Dict[str, str] = {}
			for match in DOC_SECTION.finditer(self.game_doc("modifiers_documentation.md")):
				categories = DOC_CATEGORIES.search(match.group(2))
				found[match.group(1)] = categories.group(1).strip() if categories else ""
			for name in ideas.modifiers():
				found.setdefault(name, "")
			return sorted(found.items())
		documented = self.cached("modifier", "static", build)
		own = self.cached("modifier_definitions", core.folder_stamp(core.ROOT / "common" / "modifier_definitions", "*.txt"),
			lambda: [i for i, mod in self.block_ids("common/modifier_definitions", None) if mod])
		rows = [{"id": name, "name": self.plain(ideas.modifier_label(name)), "group": categories.split(",")[0].strip(), "sub": categories}
			for name, categories in documented]
		known = {r["id"] for r in rows}
		rows += [{"id": name, "name": self.plain(ideas.modifier_label(name)), "group": "mod", "mod": True} for name in own if name not in known]
		return rows

	def autonomy_states(self) -> List[dict]:
		def build() -> List[str]:
			found: List[str] = []
			for item in core.list_files("common/autonomous_states", "*.txt", include_vanilla=True):
				path, _vanilla = core.resolve(item["file"])
				found += [i for i in AUTONOMY_ID.findall(core.read_text(path)) if i not in found]
			return found
		ids = self.cached("autonomy", core.folder_stamp(core.ROOT / "common" / "autonomous_states", "*.txt"), build)
		return [{"id": i, "name": self.name(i)} for i in ids]

	def oobs(self) -> List[dict]:
		def build() -> List[Tuple[str, bool]]:
			return [(Path(item["file"]).stem, not item["vanilla"]) for item in core.list_files("history/units", "*.txt", include_vanilla=True)]
		rows = self.cached("oob", core.folder_stamp(core.ROOT / "history" / "units", "*.txt"), build)
		return [{"id": stem, "name": "", "group": stem.split("_", 1)[0], "mod": mod} for stem, mod in rows]

	def focus_filters(self) -> List[dict]:
		def build() -> List[str]:
			found: set = set()
			for item in core.list_files("common/national_focus", "*.txt", include_vanilla=True):
				path, _vanilla = core.resolve(item["file"])
				found.update(FOCUS_FILTER.findall(core.read_text(path)))
			return sorted(found)
		ids = self.cached("focus_filter", core.folder_stamp(core.ROOT / "common" / "national_focus", "*.txt"), build)
		return [{"id": i, "name": self.name(i)} for i in ids]

	def flag_rows(self, kind: str) -> List[dict]:
		"""Flags the mod's scripts set, check or clear (flags are not declared anywhere else)."""
		now = time.time()
		with self.lock:
			cached = self.flags
		if cached is None or now - cached[0] > FLAG_SECONDS:
			found: Dict[str, set] = {name: set() for name in FLAG_PATTERNS}
			for _path, lines in self.ctx.texts.lines():
				text = "\n".join(line for line in lines if "_flag" in line)
				if not text:
					continue
				for name, pattern in FLAG_PATTERNS.items():
					found[name].update(pattern.findall(text))
			cached = (now, {name: sorted(values - NOT_FLAGS) for name, values in found.items()})
			with self.lock:
				self.flags = cached
		return [{"id": flag, "name": self.name(flag), "mod": True} for flag in cached[1][kind]]

	def documented(self, which: str) -> List[dict]:
		"""Effects or triggers of the installed game: id, supported scopes and targets, description."""
		def build() -> List[dict]:
			rows: Dict[str, dict] = {}
			for match in DOC_SECTION.finditer(self.game_doc(f"{which}_documentation.md")):
				body = match.group(2)
				scopes = DOC_SCOPES.search(body)
				if scopes is None:
					continue  # a heading of the table of contents, not an effect
				targets = DOC_TARGETS.search(body)
				text = re.sub(r"\* Supported (?:Scopes|Targets):[^\n]*\n?", "", body).replace("```", "").strip()
				rows.setdefault(match.group(1), {"id": match.group(1), "name": "",
					"scopes": [s.strip() for s in scopes.group(1).split(",") if s.strip()],
					"targets": [t.strip() for t in targets.group(1).split(",") if t.strip()] if targets else [],
					"sub": text[:DOC_TEXT_LIMIT]})
			return sorted(rows.values(), key=lambda r: r["id"])
		return self.cached(which, "static", build)
