"""Character module of the HOI4 Türkçe Mod Toolu (page: web/characters.html).

Characters live in `common/characters/*.txt` as `characters = { <id> = { ... } }`. A character has a
name (a localisation key or literal text), portraits (`civilian` / `army`, each `large` / `small`,
given as a GFX sprite or a `gfx/...` texture path) and role blocks: `country_leader`, `advisor`,
`corps_commander`, `field_marshal`, `navy_leader`, `scientist`. DLC variants are written as several
`instance = { ... }` blocks; the page reads the first instance for the preview and edits the rest
as text.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, Entry, unquote
from items import ItemModule

ROLES = ("country_leader", "advisor", "corps_commander", "field_marshal", "navy_leader", "scientist", "operative")
# Portraits come in three categories (wiki: character modding, Portraits): civilian, army and navy.
PORTRAIT_ORDER = (("civilian", "large"), ("army", "large"), ("navy", "large"), ("civilian", "small"), ("army", "small"), ("navy", "small"))
# Advisor slots and ledgers as the game's character files use them (common/characters/GER.txt).
ADVISOR_SLOTS = ("political_advisor", "theorist", "army_chief", "navy_chief", "air_chief", "high_command")
SLOT_LEDGER = {"army_chief": "army", "navy_chief": "navy", "air_chief": "air"}
LEDGERS = ("army", "navy", "air")
DEFAULT_ADVISOR_COST = 150
MAX_ADVISOR_COST = 1000
TAG_FORMAT = re.compile(r"^[A-Z][A-Z0-9]{2}$")
CHARACTER_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
PORTRAIT_VALUE = re.compile(r"^[A-Za-z0-9_\-./ ]+$")
NEW_FILE_HEADER = "characters = {\n}\n"


def quoted(value: str) -> str:
	return f'"{value}"' if re.search(r"[\s/\\]", value) else value


def advisor_spec(raw: dict, tag: str) -> dict:
	"""A checked advisor role from the page: slot, traits, cost, ledger, and the country it serves."""
	slot = str(raw.get("slot", ""))
	if slot not in ADVISOR_SLOTS:
		raise ValueError(f"unknown advisor slot {slot}")
	if not TAG_FORMAT.match(tag):
		raise ValueError(f"invalid tag {tag}")
	traits = [str(t).strip() for t in raw.get("traits") or [] if str(t).strip()]
	if not traits or any(not core.SAFE_ID.match(t) for t in traits):
		raise ValueError("an advisor needs at least one valid trait")
	try:
		cost = int(raw.get("cost", DEFAULT_ADVISOR_COST))
	except (TypeError, ValueError) as error:
		raise ValueError("the cost must be a whole number") from error
	if cost < 1 or cost > MAX_ADVISOR_COST:
		raise ValueError(f"the cost must be from 1 to {MAX_ADVISOR_COST}")
	ledger = str(raw.get("ledger") or SLOT_LEDGER.get(slot, ""))
	if ledger and ledger not in LEDGERS:
		raise ValueError(f"unknown ledger {ledger}")
	return {"slot": slot, "traits": list(dict.fromkeys(traits)), "cost": cost, "ledger": ledger, "tag": tag}


def advisor_body(spec: dict, token: str) -> List[str]:
	"""Lines of an `advisor = { ... }` role, nested blocks one tab deeper (the game's layout)."""
	lines = [f"slot = {spec['slot']}", f"idea_token = {token}"]
	if spec["ledger"]:
		lines.append(f"ledger = {spec['ledger']}")
	lines += ["allowed = {", f"\toriginal_tag = {spec['tag']}", "}", "traits = {"] + [f"\t{t}" for t in spec["traits"]]
	lines += ["}", f"cost = {spec['cost']}", "ai_will_do = {", "\tfactor = 1", "}"]
	return lines


class CharacterModule(ItemModule):
	kind = "character"
	folder = "common/characters"
	page = "characters.html"
	loc_default = "studio_characters_l_english.yml"

	def items_in(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		found = []
		for top in doc.entries():
			if top.key == "characters" and top.is_block:
				for character in doc.entries(top.value_index):
					if character.is_block and character.key:
						found.append((character.key, character, {"tag": character.key.split("_", 1)[0] if "_" in character.key else ""}))
		return found

	def items_in_block(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		return [(entry.key, entry, {}) for entry in doc.entries() if entry.is_block and entry.key]

	def body_of(self, doc: Doc, entry: Entry) -> Entry:
		"""The block that holds the fields: the character itself, or its first `instance`."""
		if core.scalar(doc, entry, "name") is None:
			instances = core.sub_entries(doc, entry, "instance")
			if instances:
				return instances[0]
		return entry

	def name_of(self, doc: Doc, entry: Entry, item_id: str) -> Tuple[str, Optional[str]]:
		"""(display text, localisation key or None when the name is written literally)."""
		raw = core.scalar(doc, self.body_of(doc, entry), "name") or item_id
		text = self.ctx.display(raw)
		if text:
			return text, raw
		if core.SAFE_ID.match(raw) and raw == item_id:
			return "", raw
		return raw, None

	def portraits(self, doc: Doc, entry: Entry) -> Dict[str, Dict[str, str]]:
		found: Dict[str, Dict[str, str]] = {}
		for block in core.sub_entries(doc, self.body_of(doc, entry), "portraits"):
			for kind in core.sub_entries(doc, block):
				if kind.is_block and kind.key:
					for size in core.sub_entries(doc, kind):
						if size.key and not size.is_block:
							found.setdefault(kind.key, {})[size.key] = unquote(size.value)
		return found

	def roles(self, doc: Doc, entry: Entry) -> List[dict]:
		found = []
		for sub in core.sub_entries(doc, self.body_of(doc, entry)):
			if sub.key in ROLES and sub.is_block:
				role = {"role": sub.key}
				for key in ("ideology", "slot", "skill", "idea_token", "cost", "ledger"):
					value = core.scalar(doc, sub, key)
					if value is not None:
						role[key] = value
				traits = [t.value for block in core.sub_entries(doc, sub, "traits") for t in core.sub_entries(doc, block) if t.key is None and t.value]
				if traits:
					role["traits"] = traits
				found.append(role)
		return found

	def picture(self, portraits: Dict[str, Dict[str, str]]) -> Optional[str]:
		for kind, size in PORTRAIT_ORDER:
			value = portraits.get(kind, {}).get(size)
			if value:
				return value
		return None

	def summary(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		text, _key = self.name_of(doc, entry, item_id)
		roles = self.roles(doc, entry)
		return {"name": text or item_id, "portrait": self.picture(self.portraits(doc, entry)) or "",
			"roles": [r["role"] for r in roles]}

	def extra(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		text, key = self.name_of(doc, entry, item_id)
		return {
			"name": text or item_id, "nameKey": key, "portraits": self.portraits(doc, entry), "roles": self.roles(doc, entry),
			"instances": len(core.sub_entries(doc, entry, "instance")),
		}

	def loc_keys(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> List[str]:
		_text, key = self.name_of(doc, entry, item_id)
		return [key] if key else []

	def template(self, item_id: str, meta: dict, indent: str) -> str:
		i = indent + "\t"
		if meta.get("advisor"):
			return self.advisor_template(item_id, meta, indent)
		role = meta.get("role") or "country_leader"
		ideology = meta.get("ideology") or "liberalism"
		bodies = {
			"country_leader": [f"ideology = {ideology}", 'expire = "1965.1.1.1"', "id = -1"],
			"advisor": ["slot = political_advisor", f"idea_token = {item_id}", "cost = 150", "traits = { }"],
			"corps_commander": ["traits = { }", "skill = 2", "attack_skill = 2", "defense_skill = 2", "planning_skill = 2", "logistics_skill = 2", "legacy_id = -1"],
			"field_marshal": ["traits = { }", "skill = 3", "attack_skill = 3", "defense_skill = 3", "planning_skill = 3", "logistics_skill = 3", "legacy_id = -1"],
			"navy_leader": ["traits = { }", "skill = 2", "attack_skill = 2", "defense_skill = 2", "maneuvering_skill = 2", "coordination_skill = 2", "legacy_id = -1"],
		}
		lines = bodies.get(role, bodies["country_leader"])
		kind = {"corps_commander": "army", "field_marshal": "army", "navy_leader": "navy"}.get(role, "civilian")
		role_block = "\n".join(f"{i}\t{line}" for line in lines)
		return (f"{item_id} = {{\n{i}name = {item_id}\n{i}portraits = {{\n{i}\t{kind} = {{\n{i}\t\tlarge = GFX_portrait_unknown\n{i}\t}}\n{i}}}\n"
			f"{i}{role} = {{\n{role_block}\n{i}}}\n{indent}}}")

	def advisor_template(self, item_id: str, meta: dict, indent: str) -> str:
		"""A character that is only an advisor: a civilian portrait (the small one is the advisor card)."""
		i = indent + "\t"
		portraits = {size: str(meta.get(size) or "").strip() for size in ("large", "small")}
		if not any(portraits.values()):
			portraits["large"] = "GFX_portrait_unknown"
		for value in portraits.values():
			if value and not PORTRAIT_VALUE.match(value):
				raise ValueError(f"invalid portrait {value}")
		sizes = "".join(f"{i}\t\t{size} = {quoted(value)}\n" for size, value in portraits.items() if value)
		role = "".join(f"{i}\t{line}\n" for line in advisor_body(meta["advisor"], meta["token"]))
		return (f"{item_id} = {{\n{i}name = {item_id}\n{i}portraits = {{\n{i}\tcivilian = {{\n{sizes}{i}\t}}\n{i}}}\n"
			f"{i}advisor = {{\n{role}{i}}}\n{indent}}}")

	def container_for(self, doc: Doc, meta: dict) -> Optional[Entry]:
		for top in doc.entries():
			if top.key == "characters" and top.is_block:
				return top
		raise ValueError("this file has no characters block")

	def create(self, payload: dict) -> dict:
		"""The new-character form can describe a whole advisor role (slot, traits, cost)."""
		meta = dict(payload.get("meta") or {})
		if meta.get("role") == "advisor" and meta.get("slot") and not meta.get("advisor"):
			meta["advisor"] = advisor_spec(meta, str(meta.get("tag", "")))
			meta["token"] = str(payload.get("id", "")).strip()
		return super().create({**payload, "meta": meta})

	def new_loc(self, item_id: str, meta: dict, name: str) -> Dict[str, str]:
		return {item_id: name or item_id}

	def cards(self, ids: List[str]) -> List[dict]:
		"""Summaries of characters by id, from wherever the mod or the game defines them (each file parsed once)."""
		where = {row["id"]: row["file"] for row in self.build_index()}
		docs: Dict[str, Doc] = {}
		found = []
		for character_id in ids:
			rel = where.get(character_id) or self.game_ids().get(character_id)
			if rel is None:
				continue
			if rel not in docs:
				docs[rel] = self.load(rel)[3]
			doc = docs[rel]
			entry, meta = self.find(doc, character_id)
			found.append({"id": character_id, "file": rel, **self.summary(doc, character_id, entry, meta),
				"rolesDetail": self.roles(doc, entry), "portraits": self.portraits(doc, entry)})
		return found

	def cards_for_tag(self, tag: str) -> List[dict]:
		"""Cards of every character whose id starts with `TAG_` (the mod's and the game's), for pickers."""
		prefix = tag + "_"
		ids = sorted({row["id"] for row in self.build_index() if row["id"].startswith(prefix)} | {i for i in self.game_ids() if i.startswith(prefix)})
		self.ctx.fresh_loc()
		return self.cards(ids)

	def card(self, character_id: str) -> Optional[dict]:
		found = self.cards([character_id])
		return found[0] if found else None

	def game_ids(self) -> Dict[str, str]:
		"""id -> file of the characters that only the game defines (the mod does not override their file)."""
		if not hasattr(self, "game_index"):
			index: Dict[str, str] = {}
			for item in self.files(True):
				if not item["vanilla"]:
					continue
				try:
					_path, _vanilla, _text, doc = self.load(item["file"])
				except ValueError:
					continue
				for found_id, _entry, _meta in self.items_in(doc):
					index.setdefault(found_id, item["file"])
			self.game_index = index
		return self.game_index

	def all_ids(self) -> List[dict]:
		"""Every character of the mod and the game, for the recruit picker of the country page."""
		found = {row["id"]: row["file"] for row in self.build_index()}
		mod = set(found)
		for character_id, rel in self.game_ids().items():
			found.setdefault(character_id, rel)
		self.ctx.fresh_loc()
		return [{"id": cid, "file": rel, "name": self.ctx.display(cid), "mod": cid in mod} for cid, rel in sorted(found.items())]

	# ------------------------------------------------------------ advisors

	def advisor_traits(self) -> Dict[str, List[str]]:
		"""slot -> traits the mod's and the game's advisors use in that slot, most used first. Traits do
		not name their slot, so the characters that use them are the only record of what fits where."""
		stamp = core.folder_stamp(core.ROOT / self.folder, self.pattern)
		cached = getattr(self, "traits_cache", None)
		if cached is not None and cached[0] == stamp:
			return cached[1]
		counts: Dict[str, Counter] = {slot: Counter() for slot in ADVISOR_SLOTS}
		for item in self.files(True):
			try:
				_path, _vanilla, _text, doc = self.load(item["file"])
			except ValueError:
				continue
			for _id, entry, _meta in self.items_in(doc):
				for body in [entry] + core.sub_entries(doc, entry, "instance"):
					for role in core.sub_entries(doc, body, "advisor"):
						slot = core.scalar(doc, role, "slot")
						if slot in counts:
							counts[slot].update(t.value for block in core.sub_entries(doc, role, "traits")
								for t in core.sub_entries(doc, block) if t.key is None and t.value)
		found = {slot: [t for t, _n in used.most_common()] for slot, used in counts.items()}
		self.traits_cache = (stamp, found)
		return found

	def file_for_tag(self, tag: str) -> str:
		"""The file a new character of `tag` goes into: the mod file that already holds most of the
		country's characters, else `common/characters/<TAG>.txt` (the game's file is copied first)."""
		counts = Counter(row["file"] for row in self.build_index() if row["meta"].get("tag") == tag)
		return counts.most_common(1)[0][0] if counts else f"{self.folder}/{tag}.txt"

	def where(self, character_id: str) -> Optional[str]:
		for row in self.build_index():
			if row["id"] == character_id:
				return row["file"]
		return self.game_ids().get(character_id)

	def new_advisor(self, tag: str, character_id: str, name: str, spec: dict, portraits: Dict[str, str]) -> Tuple[str, dict]:
		"""Create a character whose only role is this advisor; its id is the idea token. Returns (token, result)."""
		if not CHARACTER_ID.match(character_id):
			raise ValueError("the id may use letters, digits and _ and starts with a letter")
		if self.where(character_id) is not None:
			raise ValueError(f"a character {character_id} already exists")
		rel = self.file_for_tag(tag)
		try:
			core.resolve(rel)
		except ValueError:
			(core.ROOT / rel).parent.mkdir(parents=True, exist_ok=True)
			(core.ROOT / rel).write_text(NEW_FILE_HEADER, encoding="utf-8")
		meta = {"advisor": spec, "token": character_id, "tag": tag, **{k: v for k, v in portraits.items() if k in ("large", "small")}}
		return character_id, self.create({"file": rel, "id": character_id, "name": name, "meta": meta})

	def add_advisor_role(self, character_id: str, spec: dict) -> Tuple[str, dict]:
		"""Give an existing character one more advisor role. Returns (token, save result)."""
		rel = self.where(character_id)
		if rel is None:
			raise ValueError(f"no character {character_id}")
		_path, _vanilla, _text, doc = self.load(rel)
		entry, _meta = self.find(doc, character_id)
		if core.scalar(doc, entry, "name") is None and core.sub_entries(doc, entry, "instance"):
			raise ValueError(f"{character_id} is written as DLC instance blocks; add the advisor role on the Characters page")
		roles = core.sub_entries(doc, entry, "advisor")
		if any(core.scalar(doc, role, "slot") == spec["slot"] for role in roles):
			raise ValueError(f"{character_id} already has an advisor role in the {spec['slot']} slot")
		token = character_id if not roles else f"{character_id}_{spec['slot']}"
		result = self.save({"file": rel, "id": character_id, "version": None,
			"ops": [{"op": "add_block", "key": "advisor", "body": "\n".join(advisor_body(spec, token))}]})
		return token, result
