"""Country module of the HOI4 Türkçe Mod Toolu (page: web/countries.html).

A country is spread over several files, which the page edits together:

- `common/country_tags/*.txt` maps the tag to its country file (`TAG = "countries/Name.txt"`);
  dynamic tag files (`dynamic_tags = yes`) are skipped.
- `common/countries/<Name>.txt` holds `graphical_culture`, `graphical_culture_2d` and `color`;
  `common/countries/colors*.txt` may override the map colour, so a colour edit updates both.
- `history/countries/<TAG> - <Name>.txt` is the start-of-game setup. Its top level is edited as a
  block (`items.apply_root_ops`): known statements get structured widgets on the page, everything
  else (`if` blocks, dated blocks, variables) stays text and is untouched unless edited.
- English names: `TAG`, `TAG_DEF`, `TAG_ADJ` and the per-ideology variants `TAG_<group>[_DEF|_ADJ]`.
- Flags: `gfx/flags[/medium|/small]/TAG[_<group>].tga`, 82x52, 41x26 and 10x7, 32-bit RGBA,
  uncompressed, bottom-left origin (measured on the game's flags).

New countries are registered in `common/country_tags/studio_countries.txt`.
"""

from __future__ import annotations

import base64
import io
import re
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import core
from core import Doc, file_version, read_script, unquote, write_script
from items import apply_root_ops, root_entries_model
from mod_characters import advisor_spec

TAG_LINE = re.compile(r'^[ \t]*([A-Z][A-Z0-9]{2})[ \t]*=[ \t]*"([^"]+)"', re.MULTILINE)
STATE_ID = re.compile(r"\bid\s*=\s*(\d+)")
STATE_NAME = re.compile(r'\bname\s*=\s*"?([A-Za-z0-9_\-.]+)"?')
STATE_OWNER = re.compile(r"\bowner\s*=\s*([A-Z][A-Z0-9]{2})\b")
STATE_CATEGORY = re.compile(r"\bstate_category\s*=\s*([a-z_]+)")
TEMPLATE_NAME = re.compile(r'division_template\s*=\s*\{[^{}]*?\bname\s*=\s*"([^"]+)"', re.DOTALL)
DIVISION = re.compile(r"\bdivision\s*=\s*\{")
TAG_FORMAT = re.compile(r"^[A-Z][A-Z0-9]{2}$")
RULING_PARTY = re.compile(r"^[ \t]*ruling_party[ \t]*=[ \t]*([A-Za-z0-9_]+)", re.MULTILINE)
CONDITION_BLOCKS = ("if", "IF", "else_if", "ELSE_IF", "else", "ELSE")
NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")
RESERVED_TAGS = {"AND", "NOT", "NOR", "XOR", "ANY", "ALL"}
STUDIO_TAGS_FILE = "common/country_tags/studio_countries.txt"
FLAG_SIZES = (("", (82, 52)), ("medium/", (41, 26)), ("small/", (10, 7)))
NAME_SUFFIXES = ("", "_DEF", "_ADJ")
FALLBACK_GROUPS = ("democratic", "communism", "fascism", "neutrality")
RULING_POPULARITY = 60
CLAUDE_LINES = 400
# `color = { r g b }`, `color = rgb { ... }` or `color = hsv { h s v }` (hsv in 0..1). The script parser
# reads `rgb {` as a value followed by a separate block, so colours are read and written with these.
COLOR_VALUE = r"(?:(rgb|hsv|RGB|HSV)[ \t]*)?\{[ \t]*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}"
COUNTRY_COLOR = re.compile(r"^([ \t]*)color[ \t]*=[ \t]*" + COLOR_VALUE, re.MULTILINE)
ENTRY_COLOR = re.compile(r"\b(color(?:_ui)?)[ \t]*=[ \t]*" + COLOR_VALUE)
UI_LIGHTEN = 0.35  # color_ui is the map colour moved this far towards white (vanilla UI colours are lighter)


def to_rgb(kind: Optional[str], values) -> List[int]:
	numbers = [float(v) for v in values]
	if (kind or "").lower() == "hsv":
		import colorsys
		return [round(c * 255) for c in colorsys.hsv_to_rgb(*numbers)]
	return [max(0, min(255, round(n))) for n in numbers]


class CountryModule:
	kind = "country"

	def __init__(self, ctx: core.Context, characters, ideas) -> None:
		self.ctx = ctx
		self.characters = characters
		self.ideas = ideas
		self.lock = threading.Lock()
		self.cache: Dict[str, Tuple[object, object]] = {}

	# ------------------------------------------------------------ cached indexes

	def cached(self, name: str, stamp: object, build):
		with self.lock:
			old = self.cache.get(name)
			if old is not None and old[0] == stamp:
				return old[1]
		value = build()
		with self.lock:
			self.cache[name] = (stamp, value)
		return value

	def tags(self) -> Dict[str, dict]:
		"""tag -> {countryFile, tagsFile, vanilla}, the mod's tag files first."""
		stamp = core.folder_stamp(core.ROOT / "common" / "country_tags", "*.txt")
		def build() -> Dict[str, dict]:
			found: Dict[str, dict] = {}
			for item in core.list_files("common/country_tags", "*.txt", include_vanilla=True):
				path, vanilla = core.resolve(item["file"])
				text = core.read_text(path)
				head = text.split("\n", 3)
				if any("dynamic_tags" in line.split("#", 1)[0] for line in head):
					continue
				for match in TAG_LINE.finditer(text):
					found.setdefault(match.group(1), {"tag": match.group(1), "countryFile": "common/" + match.group(2).replace("\\", "/"),
						"tagsFile": item["file"], "vanilla": vanilla})
			return found
		return self.cached("tags", stamp, build)

	def history_files(self) -> Dict[str, str]:
		"""tag -> history file (`TAG - Name.txt`), the mod's file before the game's."""
		def build() -> Dict[str, str]:
			found: Dict[str, str] = {}
			game = core.game_root()
			for root in [core.ROOT] + ([game] if game is not None else []):
				folder = root / "history" / "countries"
				if folder.is_dir():
					for path in sorted(folder.glob("*.txt")):
						tag = path.name[:3]
						if TAG_FORMAT.match(tag) and (len(path.name) == 7 or path.name[3] in " -_.") and tag not in found:
							found[tag] = f"history/countries/{path.name}"
			return found
		return self.cached("histories", core.folder_stamp(core.ROOT / "history" / "countries", "*.txt"), build)

	def history_file(self, tag: str) -> Optional[str]:
		return self.history_files().get(tag)

	def ruling_parties(self) -> Dict[str, str]:
		"""tag -> the first `ruling_party` of its history file (picks the flag variant in the list)."""
		def build() -> Dict[str, str]:
			found: Dict[str, str] = {}
			for tag, rel in self.history_files().items():
				path, _vanilla = core.resolve(rel)
				match = RULING_PARTY.search(core.read_text(path))
				if match:
					found[tag] = match.group(1)
			return found
		return self.cached("ruling", core.folder_stamp(core.ROOT / "history" / "countries", "*.txt"), build)

	def flag_stems(self) -> set:
		"""Names (without `.tga`) of the medium flags of the mod and the game."""
		def build() -> set:
			stems: set = set()
			for root in core.asset_roots():
				folder = root / "gfx" / "flags" / "medium"
				if folder.is_dir():
					stems.update(path.stem for path in folder.glob("*.tga"))
			return stems
		return self.cached("flagstems", core.folder_stamp(core.ROOT / "gfx" / "flags" / "medium", "*.tga"), build)

	def list_flag(self, tag: str, ruling: Optional[str], stems: set) -> Optional[str]:
		"""The flag the game shows: `TAG_<ruling party>`, else `TAG`, else any ideology variant."""
		candidates = ([f"{tag}_{ruling}"] if ruling else []) + [tag] + [f"{tag}_{g['group']}" for g in self.ideologies()]
		stem = next((c for c in candidates if c in stems), None)
		return f"gfx/flags/medium/{stem}.tga" if stem else None

	def states(self) -> List[dict]:
		"""Every state with its id, English name, owner and category (mod files replace the game's)."""
		stamp = core.folder_stamp(core.ROOT / "history" / "states", "*.txt")
		def build() -> List[dict]:
			files: Dict[str, Path] = {}
			game = core.game_root()
			if game is not None and (game / "history" / "states").is_dir():
				files.update({p.name: p for p in (game / "history" / "states").glob("*.txt")})
			files.update({p.name: p for p in (core.ROOT / "history" / "states").glob("*.txt")})
			rows = []
			for name, path in files.items():
				text = core.read_text(path)
				state_id = STATE_ID.search(text)
				if not state_id:
					continue
				name_key = STATE_NAME.search(text)
				owner = STATE_OWNER.search(text)
				category = STATE_CATEGORY.search(text)
				rows.append({"id": int(state_id.group(1)), "nameKey": name_key.group(1) if name_key else "",
					"owner": owner.group(1) if owner else "", "category": category.group(1) if category else "", "file": name})
			rows.sort(key=lambda r: r["id"])
			return rows
		rows = self.cached("states", stamp, build)
		self.ctx.fresh_loc()
		return [{**r, "name": self.ctx.display(r["nameKey"]) or r["nameKey"]} for r in rows]

	def ideologies(self) -> List[dict]:
		def build() -> List[dict]:
			groups: List[dict] = []
			for item in core.list_files("common/ideologies", "*.txt", include_vanilla=True):
				path, _vanilla = core.resolve(item["file"])
				doc = Doc(core.read_text(path))
				for top in doc.entries():
					if top.key == "ideologies" and top.is_block:
						for group in core.sub_entries(doc, top):
							if group.is_block and group.key and not any(g["group"] == group.key for g in groups):
								types = [t.key for block in core.sub_entries(doc, group, "types") for t in core.sub_entries(doc, block) if t.is_block and t.key]
								color = [int(n) for block in core.sub_entries(doc, group, "color")
									for n in re.findall(r"\d+", core.block_body(doc.text, doc, block))][:3]
								groups.append({"group": group.key, "types": types, "color": color if len(color) == 3 else None})
			return groups or [{"group": g, "types": [], "color": None} for g in FALLBACK_GROUPS]
		return self.cached("ideologies", core.folder_stamp(core.ROOT / "common" / "ideologies", "*.txt"), build)

	def traits(self) -> Dict[str, List[str]]:
		def build() -> Dict[str, List[str]]:
			found: Dict[str, List[str]] = {}
			for folder, kind in (("common/country_leader", "country"), ("common/unit_leader", "unit")):
				names: set = set()
				for item in core.list_files(folder, "*.txt", include_vanilla=True):
					path, _vanilla = core.resolve(item["file"])
					doc = Doc(core.read_text(path))
					for top in doc.entries():
						if top.key == "leader_traits" and top.is_block:
							names.update(t.key for t in core.sub_entries(doc, top) if t.is_block and t.key)
				found[kind] = sorted(names)
			return found
		# the mod's trait folders are the stamp, so a trait created in the studio is listed at once
		stamp = tuple(core.folder_stamp(core.ROOT / folder, "*.txt") for folder in ("common/country_leader", "common/unit_leader"))
		return self.cached("traits", stamp, build)

	def technologies(self) -> List[dict]:
		"""Every technology of the mod and the game with its English name, for the starting-technology picker."""
		def build() -> List[str]:
			names: set = set()
			for item in core.list_files("common/technologies", "*.txt", include_vanilla=True):
				path, _vanilla = core.resolve(item["file"])
				doc = Doc(core.read_text(path))
				for top in doc.entries():
					if top.key == "technologies" and top.is_block:
						names.update(t.key for t in core.sub_entries(doc, top) if t.is_block and t.key and not t.key.startswith("@"))
			return sorted(names)
		techs = self.cached("technologies", core.folder_stamp(core.ROOT / "common" / "technologies", "*.txt"), build)
		self.ctx.fresh_loc()
		return [{"id": t, "name": self.ctx.display(t)} for t in techs]

	def idea_list(self) -> List[dict]:
		"""Every idea of the mod and the game (id, category, picture), for the starting-idea picker."""
		def build() -> List[dict]:
			rows: Dict[str, dict] = {}
			for item in self.ideas.files(True):
				try:
					_path, _vanilla, _text, doc = self.ideas.load(item["file"])
				except ValueError:
					continue
				for idea_id, entry, meta in self.ideas.items_in(doc):
					rows.setdefault(idea_id, {"id": idea_id, "category": meta.get("category", ""), "file": item["file"],
						"sprite": self.ideas.picture(doc, idea_id, entry)})
			return sorted(rows.values(), key=lambda r: r["id"])
		rows = self.cached("ideas", core.folder_stamp(core.ROOT / "common" / "ideas", "*.txt"), build)
		self.ctx.fresh_loc()
		return [{**r, "name": self.ctx.display(r["id"])} for r in rows]

	def claude_items(self, rel: str, ids: List[str], context: dict) -> List[dict]:
		"""The history file of the selected country, cut to its first lines when it is long."""
		items = []
		for tag in ids:
			history = self.history_file(tag)
			raw = ""
			if history:
				path, _vanilla = core.resolve(history)
				lines = core.read_text(path).splitlines()
				raw = "\n".join(lines[:CLAUDE_LINES]) + (f"\n# ... {len(lines) - CLAUDE_LINES} more lines in the file" if len(lines) > CLAUDE_LINES else "")
			items.append({"id": tag, "name": self.ctx.display(tag) or tag, "line": 1, "raw": raw,
				"extra": f"history file {history or '(none)'}, country file {self.tags().get(tag, {}).get('countryFile')}"})
		return items

	def cultures(self) -> List[str]:
		def build() -> List[str]:
			names: List[str] = []
			for item in core.list_files("common", "graphicalculturetype.txt", include_vanilla=True):
				path, _vanilla = core.resolve(item["file"])
				for line in core.read_text(path).splitlines():
					token = line.split("#", 1)[0].strip()
					if token and re.match(r"^[a-z0-9_]+$", token) and token not in names:
						names.append(token)
			return names
		return self.cached("cultures", "static", build)

	# ------------------------------------------------------------ colours and flags

	def colors_entry(self, tag: str) -> Optional[dict]:
		"""The `colors*.txt` block that overrides the map colour of `tag` (the mod's files, then the
		game's files the mod does not replace): {rel, vanilla, text, bom, newline, match}."""
		pattern = re.compile(r"^" + tag + r"[ \t]*=[ \t]*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", re.MULTILINE)
		for item in core.list_files("common/countries", "colors*.txt", include_vanilla=True):
			path, vanilla = core.resolve(item["file"])
			text, had_bom, newline = read_script(path)
			match = pattern.search(text)
			if match:
				return {"rel": item["file"], "vanilla": vanilla, "text": text, "bom": had_bom, "newline": newline, "match": match}
		return None

	def color(self, tag: str, country_text: Optional[str]) -> Tuple[Optional[List[int]], Optional[str]]:
		"""Map colour of `tag` and the colours file it comes from (None: the country file)."""
		entry = self.colors_entry(tag)
		if entry is not None:
			for found in ENTRY_COLOR.finditer(entry["match"].group(0)):
				if found.group(1) == "color":
					return to_rgb(found.group(2), found.groups()[2:]), entry["rel"]
		if country_text:
			found = COUNTRY_COLOR.search(country_text)
			if found:
				return to_rgb(found.group(2), found.groups()[2:]), None
		return None, None

	def flags(self, tag: str) -> List[dict]:
		variants = [("", "Varsayılan")] + [("_" + g["group"], g["group"]) for g in self.ideologies()]
		others = core.asset_roots()[1:]  # the game and its DLC folders
		found = []
		for suffix, label in variants:
			row = {"variant": suffix.lstrip("_"), "label": label, "files": {}, "inMod": False}
			for folder, _size in FLAG_SIZES:
				rel = f"gfx/flags/{folder}{tag}{suffix}.tga"
				if (core.ROOT / rel).is_file():
					row["files"][folder or "large"] = rel
					row["inMod"] = True
				elif any((root / rel).is_file() for root in others):
					row["files"][folder or "large"] = rel
			found.append(row)
		return found

	def write_flag(self, payload: dict) -> dict:
		"""Turn an uploaded picture into the three flag sizes of one variant."""
		tag = str(payload.get("tag", ""))
		if tag not in self.tags():
			raise ValueError(f"unknown tag {tag}")
		variant = str(payload.get("variant", ""))
		if variant and variant not in [g["group"] for g in self.ideologies()]:
			raise ValueError("unknown flag variant")
		data = str(payload.get("image", ""))
		if "," in data:
			data = data.split(",", 1)[1]
		try:
			raw = base64.b64decode(data, validate=True)
		except ValueError as error:
			raise ValueError("the picture could not be read") from error
		from PIL import Image

		try:
			source = Image.open(io.BytesIO(raw)).convert("RGBA")
		except Exception as error:  # noqa: BLE001 - any decoding problem is a bad upload
			raise ValueError("the file is not a picture Pillow can read") from error
		backup = core.Backup()
		written = []
		suffix = f"_{variant}" if variant else ""
		for folder, size in FLAG_SIZES:
			rel = f"gfx/flags/{folder}{tag}{suffix}.tga"
			path = core.ROOT / rel
			backup.keep(path)
			path.parent.mkdir(parents=True, exist_ok=True)
			resample = Image.Resampling.BOX if size[0] <= 10 else Image.Resampling.LANCZOS
			source.resize(size, resample).save(path, format="TGA", rle=False, orientation=-1)
			written.append(rel)
		return {"written": written, "backup": backup.where(), "flags": self.flags(tag)}

	# ------------------------------------------------------------ reading

	def name_keys(self, tag: str) -> List[str]:
		keys = [tag + s for s in NAME_SUFFIXES]
		for group in self.ideologies():
			keys += [f"{tag}_{group['group']}{s}" for s in NAME_SUFFIXES]
		return keys

	def list(self) -> dict:
		self.ctx.fresh_loc()
		ruling, stems = self.ruling_parties(), self.flag_stems()
		rows = []
		for tag in sorted(self.tags()):
			history = self.history_file(tag)
			rows.append({"tag": tag, "name": self.ctx.display(tag) or tag, "history": history,
				"historyInMod": bool(history and (core.ROOT / history).is_file()),
				"flag": self.list_flag(tag, ruling.get(tag), stems)})
		return {"countries": rows}

	def detail(self, tag: str) -> dict:
		self.ctx.fresh_loc()
		info = self.tags().get(tag)
		if info is None:
			raise ValueError(f"unknown tag {tag}")
		result: dict = {"tag": tag, "name": self.ctx.display(tag) or tag, "tagsFile": info["tagsFile"],
			"ideologies": self.ideologies(), "cultures": self.cultures(), "locStamp": self.ctx.stamp_text()}
		# country file
		country_text = None
		try:
			path, vanilla = core.resolve(info["countryFile"])
			country_text, _bom, _newline = read_script(path)
			country_doc = Doc(country_text)
			result.update({"countryFile": info["countryFile"], "countryVanilla": vanilla, "countryVersion": file_version(country_text),
				"culture": self.top_scalar(country_doc, "graphical_culture"),
				"culture2d": self.top_scalar(country_doc, "graphical_culture_2d")})
		except ValueError:
			result.update({"countryFile": info["countryFile"], "countryMissing": True})
		rgb, source = self.color(tag, country_text)
		result.update({"color": rgb, "colorSource": source})
		# names (edited by the page itself, also for a country without a history file)
		keys = self.name_keys(tag)
		result.update({"names": {key: self.ctx.text(key) for key in keys}, "namesInMod": {k: self.ctx.has_mod_text(k) for k in keys}})
		result["characters"], result["ideaInfo"], result["oobs"], result["conditionalTechs"], result["conditionalSetup"] = [], {}, [], [], []
		# history
		history = self.history_file(tag)
		if history:
			path, vanilla = core.resolve(history)
			text, _bom, _newline = read_script(path)
			result["history"] = {
				"file": history, "id": tag, "vanilla": vanilla, "version": file_version(text), "line": 1,
				"raw": text, "entries": root_entries_model(text), "loc": {}, "locInMod": {}, "locStamp": self.ctx.stamp_text(),
			}
			doc = Doc(text)
			recruits = [unquote(e.value) for e in doc.entries() if e.key == "recruit_character" and not e.is_block]
			ideas = self.ideas_of(doc, doc.entries())
			branches = self.conditional_setup(doc)
			recruits = list(dict.fromkeys(recruits + [r for b in branches for r in b["recruits"]]))
			ideas = list(dict.fromkeys(ideas + [i for b in branches for i in b["ideas"]]))
			result.update({"characters": self.characters.cards(recruits), "conditionalSetup": branches,
				"ideaInfo": {idea: self.idea_info(idea) for idea in ideas},
				"oobs": [{**self.oob_summary(name), "conditional": conditional} for name, conditional in self.oob_names(doc)],
				"conditionalTechs": self.conditional_techs(doc)})
		else:
			result["history"] = None
		result["owned"] = [{"id": s["id"], "name": s["name"]} for s in self.states() if s["owner"] == tag]
		result["flags"] = self.flags(tag)
		return result

	@staticmethod
	def top_scalar(doc: Doc, key: str) -> Optional[str]:
		for entry in doc.entries():
			if entry.key == key and not entry.is_block:
				return unquote(entry.value)
		return None

	def conditional_techs(self, doc: Doc) -> List[str]:
		"""Technologies set inside `if` blocks (usually DLC checks); shown, not edited."""
		found: List[str] = []
		def walk(entry) -> None:
			for sub in core.sub_entries(doc, entry):
				if sub.key == "set_technology" and sub.is_block:
					found.extend(t.key for t in core.sub_entries(doc, sub) if t.key and t.key not in found)
				elif sub.is_block and sub.key in CONDITION_BLOCKS:
					walk(sub)
		for top in doc.entries():
			if top.is_block and top.key in CONDITION_BLOCKS:
				walk(top)
		return found

	@staticmethod
	def ideas_of(doc: Doc, entries) -> List[str]:
		"""Idea ids of the `add_ideas` statements among `entries` (`add_ideas = x` or a block of ids)."""
		found: List[str] = []
		for entry in entries:
			if entry.key == "add_ideas":
				found += [unquote(entry.value)] if not entry.is_block else [t.value for t in core.sub_entries(doc, entry) if t.key is None and t.value]
		return found

	def conditional_setup(self, doc: Doc) -> List[dict]:
		"""Start setups written inside top-level `if` / `else` blocks. Newer history files keep
		politics, popularities, recruits and ideas in one branch per DLC; the overview shows the first
		branch when the top level has none, and the page edits the branches as text."""
		branches = []
		for top in doc.entries():
			if not (top.is_block and top.key in CONDITION_BLOCKS):
				continue
			subs = core.sub_entries(doc, top)
			politics = next((s for s in subs if s.key == "set_politics" and s.is_block), None)
			recruits = [unquote(s.value) for s in subs if s.key == "recruit_character" and not s.is_block]
			if politics is None and not recruits:
				continue
			popularities = next((s for s in subs if s.key == "set_popularities" and s.is_block), None)
			limit = next((s for s in subs if s.key == "limit" and s.is_block), None)
			branches.append({
				"key": top.key, "line": doc.line_of(top.start),
				"limit": " ".join(core.block_body(doc.text, doc, limit).split()) if limit else "",
				"ruling": unquote(core.scalar(doc, politics, "ruling_party") or "") if politics else "",
				"popularities": {p.key: float(p.value) for p in core.sub_entries(doc, popularities)
					if p.key and not p.is_block and NUMBER.match(p.value or "")} if popularities else {},
				"recruits": recruits, "ideas": self.ideas_of(doc, subs),
			})
		return branches

	def oob_names(self, doc: Doc) -> List[Tuple[str, bool]]:
		"""(name, conditional) of the land OOBs the file loads: `oob` / `set_oob` at the top level, and
		inside `if` blocks (usually DLC checks such as No Step Back). Dated blocks are later starts."""
		found: List[Tuple[str, bool]] = []
		def walk(entries, conditional: bool) -> None:
			for sub in entries:
				if sub.key in ("oob", "set_oob") and not sub.is_block:
					name = unquote(sub.value)
					if all(name != known for known, _c in found):
						found.append((name, conditional))
				elif sub.is_block and sub.key in CONDITION_BLOCKS:
					walk(core.sub_entries(doc, sub), True)
		walk(doc.entries(), False)
		return sorted(found, key=lambda row: row[1])

	def idea_info(self, idea_id: str) -> dict:
		for row in self.ideas.build_index():
			if row["id"] == idea_id:
				_path, _vanilla, _text, doc = self.ideas.load(row["file"])
				entry, _meta = self.ideas.find(doc, idea_id)
				return {"name": self.ctx.display(idea_id) or idea_id, "sprite": self.ideas.picture(doc, idea_id, entry), "file": row["file"]}
		return {"name": self.ctx.display(idea_id) or idea_id, "sprite": "GFX_idea_" + idea_id, "file": None}

	def oob_summary(self, name: str) -> dict:
		rel = f"history/units/{name}.txt"
		try:
			path, vanilla = core.resolve(rel)
		except ValueError:
			return {"name": name, "file": None}
		text = core.read_text(path)
		return {"name": name, "file": rel, "vanilla": vanilla, "templates": TEMPLATE_NAME.findall(text), "divisions": len(DIVISION.findall(text))}

	def search(self, query: str, limit: int) -> List[dict]:
		query = query.lower()
		results = []
		for tag in sorted(self.tags()):
			name = self.ctx.display(tag)
			if query == tag.lower() or query in name.lower():
				results.append({"module": "country", "id": tag, "name": name or tag, "file": self.history_file(tag) or "",
					"url": f"/countries.html?tag={tag}"})
				if len(results) >= limit:
					break
		return results

	# ------------------------------------------------------------ writing

	def save(self, payload: dict) -> dict:
		tag = str(payload.get("tag", ""))
		info = self.tags().get(tag)
		if info is None:
			raise ValueError(f"unknown tag {tag}")
		with self.ctx.lock:
			backup = core.Backup()
			written: List[str] = []
			copied: List[str] = []
			history = payload.get("history") or {}
			if history.get("raw") is not None or history.get("ops"):
				rel = history["file"]
				path, vanilla = core.resolve(rel)
				text, had_bom, newline = read_script(path)
				if file_version(text) != history.get("version"):
					raise ValueError("The history file changed on disk after it was loaded. Reload and redo the edit.")
				if history.get("raw") is not None:
					new_text = str(history["raw"]).replace("\r\n", "\n")
				else:
					new_text = apply_root_ops(text, history["ops"])
				if not Doc(new_text).balanced:
					raise ValueError("the history file would have unbalanced braces; nothing was saved")
				self.write(rel, new_text, had_bom, newline, vanilla, backup, written, copied)
			country = payload.get("country") or {}
			ops = []
			for field, key in (("culture", "graphical_culture"), ("culture2d", "graphical_culture_2d")):
				if country.get(field):
					if not re.match(r"^[a-z0-9_]+$", str(country[field])):
						raise ValueError(f"invalid {key}")
					ops.append({"op": "set", "key": key, "occ": 0, "value": str(country[field])})
			rgb = country.get("color")
			if rgb is not None and (len(rgb) != 3 or not all(isinstance(v, int) and 0 <= v <= 255 for v in rgb)):
				raise ValueError("the colour must be three numbers from 0 to 255")
			if ops or rgb is not None:
				rel = info["countryFile"]
				path, vanilla = core.resolve(rel)
				text, had_bom, newline = read_script(path)
				if country.get("version") and file_version(text) != country["version"]:
					raise ValueError("The country file changed on disk after it was loaded. Reload and redo the edit.")
				new_text = apply_root_ops(text, ops) if ops else text
				if rgb is not None:
					found = COUNTRY_COLOR.search(new_text)
					line = f"color = {{ {rgb[0]} {rgb[1]} {rgb[2]} }}"
					new_text = (new_text[:found.start()] + found.group(1) + line + new_text[found.end():] if found
						else new_text.rstrip("\n") + "\n\n" + line + "\n")
				self.write(rel, new_text, had_bom, newline, vanilla, backup, written, copied)
			if rgb is not None:
				entry = self.colors_entry(tag)
				if entry is not None:
					ui = [round(c + (255 - c) * UI_LIGHTEN) for c in rgb]
					def recolour(found: re.Match) -> str:
						r, g, b = rgb if found.group(1) == "color" else ui
						return f"{found.group(1)} = rgb {{ {r} {g} {b} }}"
					match, text = entry["match"], entry["text"]
					block = ENTRY_COLOR.sub(recolour, match.group(0))
					self.write(entry["rel"], text[:match.start()] + block + text[match.end():], entry["bom"], entry["newline"],
						entry["vanilla"], backup, written, copied)
			keys = self.name_keys(tag)
			loc = {k: str(v) for k, v in (payload.get("loc") or {}).items() if k in keys}
			if loc:
				written += self.ctx.save_loc(loc, keys, "studio_countries_l_english.yml", backup)
			result = self.detail(tag)
			result.update({"written": written, "backup": backup.where(), "copiedFromGame": copied})
			return result

	def add_advisor(self, payload: dict) -> dict:
		"""One step for the page's advisor form: create the character (or give an existing one an advisor
		role), recruit it in the history file and, when asked, hire it at the start (`activate_advisor`)."""
		tag = str(payload.get("tag", ""))
		if tag not in self.tags():
			raise ValueError(f"unknown tag {tag}")
		history = self.history_file(tag)
		if history is None:
			raise ValueError("this country has no history file to recruit the advisor in")
		spec = advisor_spec(payload, tag)
		character_id = str(payload.get("id", "")).strip()
		with self.ctx.lock:
			path, vanilla = core.resolve(history)
			text, had_bom, newline = read_script(path)
			if payload.get("version") and file_version(text) != payload["version"]:
				raise ValueError("The history file changed on disk after it was loaded. Reload and redo the edit.")
			if payload.get("mode") == "existing":
				token, made = self.characters.add_advisor_role(character_id, spec)
			else:
				portraits = {k: str(payload.get(k) or "") for k in ("large", "small")}
				token, made = self.characters.new_advisor(tag, character_id, str(payload.get("name", "")).strip(), spec, portraits)
			doc = Doc(text)
			recruited = {unquote(e.value) for e in doc.entries() if e.key == "recruit_character" and not e.is_block}
			recruited.update(r for branch in self.conditional_setup(doc) for r in branch["recruits"])
			new_text = text
			if character_id not in recruited:
				count = sum(1 for e in doc.entries() if e.key == "recruit_character" and not e.is_block)
				new_text = apply_root_ops(new_text, [{"op": "set", "key": "recruit_character", "occ": count, "value": character_id}])
			if payload.get("activate"):
				new_text = self.add_activation(new_text, token)
			backup = core.Backup()
			written, copied = list(made.get("written", [])), [made["file"]] if made.get("copiedFromGame") else []
			if new_text != text:
				self.write(history, new_text, had_bom, newline, vanilla, backup, written, copied)
			result = self.detail(tag)
			result.update({"written": written, "backup": made.get("backup") or backup.where(), "copiedFromGame": copied,
				"advisor": {"id": character_id, "token": token, "file": made["file"]}})
			return result

	@staticmethod
	def add_activation(text: str, token: str) -> str:
		"""`activate_advisor = token` after the last one, else after the last top-level recruit line."""
		doc = Doc(text)
		active = [e for e in doc.entries() if e.key == "activate_advisor" and not e.is_block]
		if any(unquote(e.value) == token for e in active):
			return text
		if active:
			return apply_root_ops(text, [{"op": "set", "key": "activate_advisor", "occ": len(active), "value": token}])
		recruits = [e for e in doc.entries() if e.key == "recruit_character" and not e.is_block]
		if not recruits:
			return apply_root_ops(text, [{"op": "set", "key": "activate_advisor", "occ": 0, "value": token}])
		end = text.find("\n", recruits[-1].value_end)
		end = len(text) if end < 0 else end
		return text[:end] + f"\n\nactivate_advisor = {token}" + text[end:]

	def advisor_traits(self) -> dict:
		"""Traits for the advisor form: the ones each slot uses in the mod and the game, and every
		country-leader trait (advisor traits live there) with its English name."""
		self.ctx.fresh_loc()
		every = self.traits()["country"]
		by_slot = self.characters.advisor_traits()
		used = {t for traits in by_slot.values() for t in traits}
		return {"bySlot": by_slot, "all": every, "names": {t: self.ctx.display(t) for t in set(every) | used}}

	def write(self, rel: str, text: str, had_bom: bool, newline: str, vanilla: bool, backup: core.Backup,
			written: List[str], copied: List[str]) -> None:
		if vanilla:
			path, _copied = core.writable_copy(rel)
			copied.append(rel)
		else:
			path = core.ROOT / rel
			backup.keep(path)
		write_script(path, text, had_bom, newline)
		written.append(rel)

	def create(self, payload: dict) -> dict:
		tag = str(payload.get("tag", "")).strip().upper()
		name = str(payload.get("name", "")).strip()
		adjective = str(payload.get("adjective", "")).strip() or name
		if not TAG_FORMAT.match(tag) or tag in RESERVED_TAGS or re.match(r"^D\d\d$", tag):
			raise ValueError("a tag is three capital letters or digits, starts with a letter, and is not AND, NOT, D01...")
		if tag in self.tags():
			raise ValueError(f"{tag} is already used")
		if not name or not re.match(r"^[A-Za-z0-9 \-'().]+$", name):
			raise ValueError("the English name may use letters, digits, spaces and - ' ( ) .")
		groups = [g["group"] for g in self.ideologies()]
		ruling = str(payload.get("ruling") or groups[0])
		if ruling not in groups:
			raise ValueError("unknown ruling party")
		culture = str(payload.get("culture") or "western_european_gfx")
		culture2d = str(payload.get("culture2d") or culture.replace("_gfx", "_2d"))
		rgb = payload.get("color") or [120, 120, 120]
		capital = int(payload.get("capital") or 0)
		if capital and not any(s["id"] == capital for s in self.states()):
			raise ValueError("unknown capital state")
		file_name = f"{name}.txt"
		country_rel = f"common/countries/{file_name}"
		history_rel = f"history/countries/{tag} - {file_name}"
		for rel in (country_rel, history_rel):
			if (core.ROOT / rel).exists() or (core.game_root() and (core.game_root() / rel).exists()):
				raise ValueError(f"{rel} already exists")
		with self.ctx.lock:
			backup = core.Backup()
			tags_path = core.ROOT / STUDIO_TAGS_FILE
			backup.keep(tags_path)
			tags_path.parent.mkdir(parents=True, exist_ok=True)
			old = tags_path.read_text(encoding="utf-8") if tags_path.exists() else "# Countries added with the HOI4 Türkçe Mod Toolu\n"
			tags_path.write_text(old.rstrip("\n") + f'\n{tag} = "countries/{file_name}"\n', encoding="utf-8")
			(core.ROOT / country_rel).write_text(
				f"graphical_culture = {culture}\ngraphical_culture_2d = {culture2d}\n\ncolor = {{ {int(rgb[0])} {int(rgb[1])} {int(rgb[2])} }}\n", encoding="utf-8")
			others = [g for g in groups if g != ruling]
			each = (100 - RULING_POPULARITY) // len(others) if others else 0
			popularity = {ruling: 100 - each * len(others)}  # the ruling party takes the rounding remainder
			popularity.update({g: each for g in others})
			lines = [f"capital = {capital}" if capital else "# capital = <state id>", "", "set_research_slots = 3", "set_stability = 0.5",
				"set_war_support = 0.5", "", "set_politics = {", f"\truling_party = {ruling}", '\tlast_election = "1936.1.1"',
				"\telection_frequency = 48", f"\telections_allowed = {'yes' if ruling == 'democratic' else 'no'}", "}", "",
				"set_popularities = {"] + [f"\t{g} = {popularity[g]}" for g in groups] + ["}", ""]
			(core.ROOT / history_rel).write_text("\n".join(lines), encoding="utf-8")
			written = [STUDIO_TAGS_FILE, country_rel, history_rel]
			with self.lock:
				self.cache.pop("tags", None)
			written += self.ctx.save_loc({tag: name, tag + "_DEF": name, tag + "_ADJ": adjective}, [], "studio_countries_l_english.yml", backup)
			result = self.detail(tag)
			result.update({"written": written, "backup": backup.where()})
			return result
