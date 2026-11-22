"""National spirit (idea) module of the HOI4 Türkçe Mod Toolu (page: web/ideas.html).

Ideas live in `common/ideas/*.txt` as `ideas = { <category> = { <idea> = { ... } } }`. The page edits
the picture, the English name and description, the `modifier` block as a table, and every other
entry (allowed, cancel, on_add, research_bonus, ...) as text. The preview needs the display names
of the modifiers, which come from the `MODIFIER_<NAME>` localisation keys of the mod or the game.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, Entry, unquote
from items import ItemModule, sprite_name

MODIFIER_HEADING = re.compile(r"^## ([a-z0-9_]+)\s*$", re.MULTILINE)
DEFAULT_PICTURE = "generic_agrarian_reform"


class IdeaModule(ItemModule):
	kind = "idea"
	folder = "common/ideas"
	page = "ideas.html"
	loc_default = "studio_ideas_l_english.yml"

	def __init__(self, ctx: core.Context) -> None:
		super().__init__(ctx)
		self.modifier_names: Optional[List[str]] = None

	def items_in(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		found = []
		for top in doc.entries():
			if top.key == "ideas" and top.is_block:
				for category in doc.entries(top.value_index):
					if category.is_block and category.key:
						for idea in doc.entries(category.value_index):
							if idea.is_block and idea.key:
								found.append((idea.key, idea, {"category": category.key}))
		return found

	def items_in_block(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		return [(entry.key, entry, {}) for entry in doc.entries() if entry.is_block and entry.key]

	def picture(self, doc: Doc, item_id: str, entry: Entry) -> str:
		return sprite_name(core.scalar(doc, entry, "picture"), "GFX_idea_", item_id)

	def summary(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		return {"sprite": self.picture(doc, item_id, entry)}

	def modifier_label(self, key: str) -> str:
		text = self.ctx.text("MODIFIER_" + key.upper()) or self.ctx.text(key) or key
		return re.sub(r"£\S+\s*", "", text).strip() or key  # drop the inline icon codes

	def extra(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		modifiers = []
		for block in core.sub_entries(doc, entry, "modifier"):
			for sub in core.sub_entries(doc, block):
				if sub.key and not sub.is_block:
					modifiers.append({"key": sub.key, "value": unquote(sub.value), "label": self.modifier_label(sub.key)})
		return {"sprite": self.picture(doc, item_id, entry), "modifiers": modifiers}

	def file_extra(self, doc: Doc) -> dict:
		categories: List[str] = []
		for top in doc.entries():
			if top.key == "ideas" and top.is_block:
				categories += [c.key for c in doc.entries(top.value_index) if c.is_block and c.key]
		return {"categories": categories}

	def container_for(self, doc: Doc, meta: dict) -> Optional[Entry]:
		wanted = meta.get("category") or "country"
		for top in doc.entries():
			if top.key == "ideas" and top.is_block:
				for category in doc.entries(top.value_index):
					if category.is_block and category.key == wanted:
						return category
		raise ValueError(f"this file has no '{wanted}' idea category")

	def template(self, item_id: str, meta: dict, indent: str) -> str:
		inner = indent + "\t"
		return (f"{item_id} = {{\n{inner}picture = {DEFAULT_PICTURE}\n{inner}removal_cost = -1\n"
			f"{inner}modifier = {{\n{inner}\tstability_factor = 0.05\n{inner}}}\n{indent}}}")

	def modifiers(self) -> List[str]:
		"""Every modifier the installed game documents, for autocompletion."""
		if self.modifier_names is None:
			names: List[str] = []
			game = core.game_root()
			doc_file = game / "documentation" / "modifiers_documentation.md" if game else None
			if doc_file is not None and doc_file.is_file():
				names = sorted(set(MODIFIER_HEADING.findall(core.read_text(doc_file))))
			self.modifier_names = names
		return self.modifier_names

	def labels(self, keys: List[str]) -> Dict[str, str]:
		return {key: self.modifier_label(key) for key in keys if core.SAFE_ID.match(key)}
