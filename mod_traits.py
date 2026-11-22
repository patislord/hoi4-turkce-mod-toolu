"""Leader and advisor trait modifiers for the Characters page of the HOI4 Türkçe Mod Toolu.

Country leader and advisor traits live in `common/country_leader/*.txt` as
`leader_traits = { <trait> = { random = no  sprite = 13  political_power_gain = 0.1 ... } }`: the
modifiers are plain `key = value` lines of the trait block. The page edits them as a table.

Values written as file constants (`@NAME = -0.1` at the top of the file, as the mod's own trait
files do) stay constants: changing the number rewrites the constant's definition, a new modifier in
a file that uses constants gets its own `@TRAIT_KEY` constant, and removing a modifier also removes
its constant when nothing else uses it. Other entries (sprite, random, custom_modifier_tooltip,
blocks such as ai_will_do or targeted_modifier) are kept as they are and listed read-only.
A trait that only the game defines is copied into the mod with its file on the first save.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, Entry, file_version, read_script, unquote, write_script
from items import apply_ops

FOLDER = "common/country_leader"
# Trait entries that are not modifiers (wiki: Character modding, leader traits; game 00_traits.txt).
NOT_MODIFIERS = {"random", "sprite", "name", "custom_modifier_tooltip", "ai_strategy", "ai_will_do",
	"specialist_advisor_trait", "expert_advisor_trait", "genius_advisor_trait", "command_cap", "cost",
	"allowed", "visible", "available", "type", "mutually_exclusive", "parent", "gui_row", "gui_column"}
NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
VALUE = re.compile(r"^[A-Za-z0-9_.@\-]+$")
KEY = re.compile(r"^[a-z][a-z0-9_]*$")
TRAIT_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
TAG = re.compile(r"^[A-Z][A-Z0-9]{2}$")
LOC_FILE = "studio_characters_l_english.yml"  # where the Characters page writes new English names


class TraitModule:
	def __init__(self, ctx: core.Context, ideas) -> None:
		self.ctx = ctx
		self.ideas = ideas  # modifier names and labels come from the idea module

	# ------------------------------------------------------------ reading

	def traits_in(self, doc: Doc) -> List[Tuple[str, Entry]]:
		found = []
		for top in doc.entries():
			if top.key == "leader_traits" and top.is_block:
				found += [(t.key, t) for t in doc.entries(top.value_index) if t.is_block and t.key]
		return found

	def load(self, rel: str) -> Tuple[str, Doc, bool]:
		if not rel.startswith(FOLDER + "/"):
			raise ValueError(f"{rel} is not in {FOLDER}")
		path, vanilla = core.resolve(rel)
		text, _bom, _newline = read_script(path)
		return text, Doc(text), vanilla

	def where(self, trait_id: str) -> Optional[str]:
		"""The file that defines a trait: the mod's files first, then the game's (index cached per folder stamp)."""
		stamp = core.folder_stamp(core.ROOT / FOLDER, "*.txt")
		if getattr(self, "index_stamp", None) != stamp:
			index: Dict[str, str] = {}
			for item in core.list_files(FOLDER, "*.txt", include_vanilla=True):
				try:
					_text, doc, _v = self.load(item["file"])
				except ValueError:
					continue
				for found, _entry in self.traits_in(doc):
					index.setdefault(found, item["file"])
			self.index, self.index_stamp = index, stamp
		return self.index.get(trait_id)

	@staticmethod
	def constants(doc: Doc) -> Dict[str, Entry]:
		return {e.key: e for e in doc.entries() if e.key and e.key.startswith("@") and not e.is_block}

	def is_modifier(self, entry: Entry) -> bool:
		if entry.is_block or not entry.key or entry.key in NOT_MODIFIERS:
			return False
		value = unquote(entry.value)
		return entry.key in set(self.ideas.modifiers()) or bool(NUMBER.match(value)) or value.startswith("@")

	def detail(self, trait_id: str) -> dict:
		rel = self.where(trait_id)
		if rel is None:
			raise ValueError(f"no trait {trait_id} in {FOLDER}")
		self.ctx.fresh_loc()
		text, doc, vanilla = self.load(rel)
		entry = dict(self.traits_in(doc))[trait_id]
		consts = self.constants(doc)
		modifiers, other = [], []
		for sub in core.sub_entries(doc, entry):
			if not sub.key:
				continue
			if self.is_modifier(sub):
				raw = unquote(sub.value)
				row = {"key": sub.key, "raw": raw, "value": raw, "constant": None, "shared": False,
					"label": self.ideas.modifier_label(sub.key)}
				if raw.startswith("@") and raw in consts:
					row.update({"constant": raw, "value": unquote(consts[raw].value),
						"shared": len(re.findall(re.escape(raw) + r"\b", text)) > 2})
				modifiers.append(row)
			else:
				other.append(sub.key if sub.is_block else f"{sub.key} = {unquote(sub.value)}")
		return {"id": trait_id, "file": rel, "vanilla": vanilla, "version": file_version(text),
			"name": self.ctx.display(trait_id), "modifiers": modifiers, "other": other, "usesConstants": bool(consts)}

	# ------------------------------------------------------------ writing

	def save(self, payload: dict) -> dict:
		trait_id = str(payload.get("id", ""))
		rel = core.check_rel(str(payload.get("file", "")))
		wanted: List[Tuple[str, str]] = []
		for row in payload.get("modifiers") or []:
			key, value = str(row.get("key", "")).strip(), str(row.get("value", "")).strip()
			if not key and not value:
				continue
			if not KEY.match(key):
				raise ValueError(f"invalid modifier name '{key}'")
			if not VALUE.match(value):
				raise ValueError(f"{key}: a single number is expected")
			if key in NOT_MODIFIERS:
				raise ValueError(f"{key} is not a modifier")
			if any(k == key for k, _v in wanted):
				raise ValueError(f"{key} is written twice")
			wanted.append((key, value))
		with self.ctx.lock:
			path, vanilla = core.resolve(rel)
			text, had_bom, newline = read_script(path)
			if payload.get("version") and file_version(text) != payload["version"]:
				raise ValueError("The trait file changed on disk after it was loaded. Reload and redo the edit.")
			new_text = self.apply(text, trait_id, wanted)
			if new_text == text:
				return {**self.detail(trait_id), "written": []}
			if not Doc(new_text).balanced:
				raise ValueError("the result has unbalanced braces; nothing was saved")
			backup = core.Backup()
			if vanilla:
				path, _copied = core.writable_copy(rel)
			else:
				backup.keep(path)
			write_script(path, new_text, had_bom, newline)
		return {**self.detail(trait_id), "written": [rel], "backup": backup.where(), "copiedFromGame": vanilla}

	def create(self, payload: dict) -> dict:
		"""A new country leader or advisor trait in `common/country_leader/<TAG>_traits.txt` (the file is
		created when the country has none), with its English name and optional first modifiers.
		The block follows the mod's own modifier-only traits: `random = no` and the modifier lines
		(SYR_warrior_sheikh in SYR_traits.txt; vanilla leader traits in 00_traits.txt)."""
		trait_id = str(payload.get("id", "")).strip()
		name = str(payload.get("name", "")).strip()
		tag = str(payload.get("tag", "")).strip().upper()
		if not TRAIT_ID.match(trait_id):
			raise ValueError("the trait id may hold only letters, digits and _ and must start with a letter")
		if not name or "\n" in name or '"' in name:
			raise ValueError("the trait needs an English name on one line, without double quotes")
		if not TAG.match(tag):
			raise ValueError(f"'{tag}' is not a country tag")
		if self.where(trait_id) is not None:
			raise ValueError(f"a trait named {trait_id} already exists ({self.where(trait_id)})")
		wanted = [(str(r.get("key", "")).strip(), str(r.get("value", "")).strip()) for r in payload.get("modifiers") or []]
		wanted = [(k, v) for k, v in wanted if k or v]
		for key, value in wanted:
			if not KEY.match(key) or key in NOT_MODIFIERS:
				raise ValueError(f"invalid modifier name '{key}'")
			if not NUMBER.match(value):
				raise ValueError(f"{key}: a number is expected")
		rel = f"{FOLDER}/{tag}_traits.txt"
		with self.ctx.lock:
			path = core.ROOT / rel
			if path.is_file():
				text, had_bom, newline = read_script(path)
			else:
				text, had_bom, newline = f"# {tag}: country leader and advisor traits.\n\nleader_traits = {{\n}}\n", False, "\n"
			text = self.insert_block(text, trait_id)
			if wanted:
				text = self.apply(text, trait_id, wanted)
			if not Doc(text).balanced:
				raise ValueError("the result has unbalanced braces; nothing was saved")
			backup = core.Backup()
			if path.is_file():
				backup.keep(path)
			path.parent.mkdir(parents=True, exist_ok=True)
			write_script(path, text, had_bom, newline)
			written = [rel] + self.ctx.save_loc({trait_id: name}, [trait_id], LOC_FILE, backup)
		self.index_stamp = None  # the trait index is rebuilt on the next lookup
		return {**self.detail(trait_id), "written": written, "backup": backup.where()}

	def insert_block(self, text: str, trait_id: str) -> str:
		"""`text` with an empty trait block added at the end of its `leader_traits = { }`."""
		block = f"\t{trait_id} = {{\n\t\trandom = no\n\t}}\n"
		doc = Doc(text)
		outer = next((e for e in doc.entries() if e.key == "leader_traits" and e.is_block), None)
		if outer is None:
			return text.rstrip("\n") + f"\n\nleader_traits = {{\n{block}}}\n"
		close = text.rfind("}", outer.start, outer.value_end)
		before = text[:close].rstrip(" \t")
		if not before.endswith("\n"):
			before += "\n"
		spacer = "\n" if before.rstrip().endswith("}") else ""
		return before + spacer + block + text[close:]

	def apply(self, text: str, trait_id: str, wanted: List[Tuple[str, str]]) -> str:
		doc = Doc(text)
		entry = dict(self.traits_in(doc)).get(trait_id)
		if entry is None:
			raise ValueError(f"{trait_id} was not found in the file")
		consts = self.constants(doc)
		uses_constants = bool(consts)
		current = {s.key: unquote(s.value) for s in core.sub_entries(doc, entry) if self.is_modifier(s)}
		wanted_map = dict(wanted)
		ops: List[dict] = []
		const_values: Dict[str, str] = {}
		new_consts: List[Tuple[str, str]] = []
		dropped: List[str] = []
		for key, raw in current.items():
			if key not in wanted_map:
				ops.append({"op": "remove", "key": key})
				if raw.startswith("@"):
					dropped.append(raw)
		for key, value in wanted:
			raw = current.get(key)
			if value.startswith("@"):
				if value not in consts:
					raise ValueError(f"{key}: no constant {value} in this file")
				if raw != value:
					ops.append({"op": "set", "key": key, "value": value})
				continue
			if not NUMBER.match(value) and value not in ("yes", "no"):
				raise ValueError(f"{key}: a number is expected")
			if raw is not None and raw.startswith("@") and raw in consts:
				if unquote(consts[raw].value) != value:
					const_values[raw] = value
			elif raw is None and uses_constants and NUMBER.match(value):
				name = self.const_name(trait_id, key, consts, new_consts)
				new_consts.append((name, value))
				ops.append({"op": "set", "key": key, "value": name})
			elif raw != value:
				ops.append({"op": "set", "key": key, "value": value})
		if ops:
			block = text[entry.start:entry.value_end]
			text = text[:entry.start] + apply_ops(block, ops) + text[entry.value_end:]
		if const_values or new_consts or dropped:
			text = self.edit_constants(text, const_values, new_consts, dropped)
		return text

	@staticmethod
	def const_name(trait_id: str, key: str, consts: Dict[str, Entry], taken: List[Tuple[str, str]]) -> str:
		base = "@" + re.sub(r"[^A-Z0-9_]", "_", f"{trait_id}_{key}".upper())
		name, n = base, 2
		while name in consts or any(name == t for t, _v in taken):
			name, n = f"{base}_{n}", n + 1
		return name

	def edit_constants(self, text: str, values: Dict[str, str], new: List[Tuple[str, str]], dropped: List[str]) -> str:
		doc = Doc(text)
		consts = self.constants(doc)
		edits: List[Tuple[int, int, str]] = []
		for name, value in values.items():
			entry = consts[name]
			edits.append((entry.value_start, entry.value_end, value))
		for name in dropped:
			# the modifier line is gone already; the definition is the only use left
			if name in consts and len(re.findall(re.escape(name) + r"\b", text)) == 1:
				start, end = core.line_span(text, consts[name].start, consts[name].value_end)
				edits.append((start, end, ""))
		if new:
			lines = "".join(f"{name} = {value}\n" for name, value in new)
			if consts:
				last = max(consts.values(), key=lambda e: e.value_end)
				newline = text.find("\n", last.value_end)
				position = len(text) if newline < 0 else newline + 1
			else:
				position = 0
			edits.append((position, position, lines))
		for start, end, value in sorted(edits, key=lambda e: (e[0], e[1]), reverse=True):
			text = text[:start] + value + text[end:]
		return text
