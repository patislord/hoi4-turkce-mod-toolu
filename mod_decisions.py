"""Decision module of the HOI4 Türkçe Mod Toolu (page: web/decisions.html).

Decisions live in `common/decisions/*.txt` inside category blocks (`<category> = { <decision> = {
... } }`); the categories themselves (icon, picture, priority, visibility) are defined in
`common/decisions/categories/*.txt`. `DecisionModule` edits decisions and missions,
`CategoryModule` edits category definitions, and `add_container` opens an empty category block in
a decisions file so decisions can be added to a new category.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import core
from core import Doc, Entry
from items import ItemModule, sprite_name


class DecisionModule(ItemModule):
	kind = "decision"
	folder = "common/decisions"
	page = "decisions.html"
	loc_default = "studio_decisions_l_english.yml"

	def items_in(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		found = []
		for category in doc.entries():
			if category.is_block and category.key:
				for decision in doc.entries(category.value_index):
					if decision.is_block and decision.key:
						found.append((decision.key, decision, {"category": category.key}))
		return found

	def items_in_block(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		return [(entry.key, entry, {}) for entry in doc.entries() if entry.is_block and entry.key]

	def icon(self, doc: Doc, entry: Entry) -> str:
		return sprite_name(core.scalar(doc, entry, "icon"), "GFX_decision_")

	def summary(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		return {
			"sprite": self.icon(doc, entry),
			"cost": core.scalar(doc, entry, "cost") or "",
			"mission": core.scalar(doc, entry, "days_mission_timeout") is not None,
		}

	def extra(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		return {
			**self.summary(doc, item_id, entry, meta),
			"categoryName": self.ctx.text(meta.get("category", "")),
			"daysRemove": core.scalar(doc, entry, "days_remove") or "",
			"daysMission": core.scalar(doc, entry, "days_mission_timeout") or "",
		}

	categories_module: Optional["CategoryModule"] = None

	def file_extra(self, doc: Doc) -> dict:
		"""The category blocks of the file, with where each category is defined and its icon."""
		definitions = {}
		if self.categories_module is not None:
			definitions = {row["id"]: row for row in self.categories_module.build_index()}
		categories = []
		for block in doc.entries():
			if block.is_block and block.key:
				definition = definitions.get(block.key)
				icon = (definition or {}).get("meta", {}).get("icon")
				categories.append({"id": block.key, "name": self.ctx.text(block.key), "def": definition["file"] if definition else None,
					"sprite": self.categories_module.sprite(icon) if self.categories_module and icon else ""})
		return {"categories": categories}

	def container_for(self, doc: Doc, meta: dict) -> Optional[Entry]:
		wanted = meta.get("category")
		for category in doc.entries():
			if category.is_block and category.key == wanted:
				return category
		raise ValueError(f"this file has no '{wanted}' category block")

	def template(self, item_id: str, meta: dict, indent: str) -> str:
		i = indent + "\t"
		return (f"{item_id} = {{\n{i}icon = GFX_decision_generic_political_discourse\n"
			f"{i}allowed = {{ always = yes }}\n{i}visible = {{ always = yes }}\n{i}available = {{ always = yes }}\n"
			f"{i}cost = 25\n{i}fire_only_once = yes\n{i}ai_will_do = {{ base = 1 }}\n"
			f"{i}complete_effect = {{\n{i}\tadd_political_power = 50\n{i}}}\n{indent}}}")

	def add_container(self, payload: dict) -> dict:
		"""Add an empty `<category> = { }` block to a decisions file."""
		rel, category = payload["file"], str(payload.get("category", "")).strip()
		if not core.SAFE_ID.match(category):
			raise ValueError("invalid category id")
		with self.ctx.lock:
			def change(text: str, doc: Doc) -> str:
				if any(c.key == category for c in doc.entries() if c.is_block):
					raise ValueError(f"{category} already has a block in this file")
				return text.rstrip("\n") + f"\n\n{category} = {{\n}}\n"
			written, backup, copied = self.write(rel, payload.get("version"), change)
			return {"written": written, "backup": backup.where(), "copiedFromGame": copied, **self.list(rel)}


class CategoryModule(ItemModule):
	kind = "category"
	folder = "common/decisions/categories"
	page = "decisions.html"
	loc_default = "studio_decisions_l_english.yml"

	def items_in(self, doc: Doc) -> List[Tuple[str, Entry, dict]]:
		return [(entry.key, entry, {"icon": core.scalar(doc, entry, "icon") or ""}) for entry in doc.entries() if entry.is_block and entry.key]

	def sprite(self, icon: Optional[str]) -> str:
		"""Category icons are full GFX names or short names under GFX_decision_category_."""
		sprite = sprite_name(icon, "GFX_decision_category_")
		if icon and not icon.startswith("GFX_") and not self.ctx.sprites.exists(sprite):
			sprite = sprite_name(icon, "GFX_decision_")
		return sprite

	def summary(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		return {"sprite": self.sprite(core.scalar(doc, entry, "icon")), "priority": core.scalar(doc, entry, "priority") or ""}

	def extra(self, doc: Doc, item_id: str, entry: Entry, meta: dict) -> dict:
		return {**self.summary(doc, item_id, entry, meta), "picture": core.scalar(doc, entry, "picture") or ""}

	def template(self, item_id: str, meta: dict, indent: str) -> str:
		i = indent + "\t"
		return (f"{item_id} = {{\n{i}icon = GFX_decision_category_generic_political_actions\n{i}priority = 50\n"
			f"{i}allowed = {{ always = yes }}\n{i}visible = {{ always = yes }}\n{indent}}}")

	def search(self, query: str, limit: int) -> List[dict]:
		results = super().search(query, limit)
		for row in results:
			row["url"] = f"/decisions.html?catfile={row['file']}&cat={row['id']}"
		return results
