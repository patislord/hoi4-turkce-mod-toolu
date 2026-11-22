"""Shared core of the HOI4 Türkçe Mod Toolu (see studio.py).

- `Doc` is an offset-aware view of Clausewitz text built on the repository tokenizer
  (`lib/clausewitz.py`), so edits can replace exact spans and leave everything else untouched.
- `BlockEditor` applies surgical edits to one `key = { ... }` block: set or insert a scalar,
  replace, insert or remove a sub-block, remove entries. Only the touched entries change.
- `Localisation` reads and writes the mod's English localisation; `VanillaLocalisation` reads
  the game's English text for display (modifier names, vanilla content).
- `Sprites` resolves GFX sprite names to textures (mod first, then the game) and serves PNGs.
- `Backup` copies every file once per save into `.tmp/mod_studio/backups/<timestamp>/`.
- Paths are repository-relative POSIX strings. `resolve` finds a file in the mod or the game;
  `writable_copy` copies a game file into the mod before its first edit.
"""

from __future__ import annotations

import datetime
import hashlib
import io
import re
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
	sys.path.insert(0, str(TOOLS))

from lib import game as game_lib  # noqa: E402
from lib.clausewitz import TOKEN  # noqa: E402
from lib.localisation import BOM, LOC_LINE, read_text  # noqa: E402

ROOT = game_lib.mod_root()
WORK_DIR = TOOLS.parent / ".tmp" / "mod_studio"  # tool-side, never inside the mod
BACKUP_DIR = WORK_DIR / "backups"
ICON_CACHE = WORK_DIR / "icons"
LOC_DIR = ROOT / "localisation" / "english"
OPERATORS = {"=", "<", ">", "<=", ">=", "!="}
SAFE_ID = re.compile(r"^[A-Za-z0-9_\-.@:]+$")
SPRITE = re.compile(r'(?is)\bname\s*=\s*"?(GFX_[A-Za-z0-9_\-.]+)"?(.*?)(?=\bname\s*=|\Z)')
TEXTURE = re.compile(r'(?i)\btexturefile\s*=\s*(?:"([^"]+)"|([^\s"{}#]+))')  # quoted, or unquoted as in _leader_portraits.gfx
LOCAL_HOSTS = ("127.0.0.1", "localhost")
EDITABLE_ROOTS = ("common/", "events/", "history/", "map/", "interface/", "localisation/")
NESTED_KEY = re.compile(r"\$([A-Za-z0-9_.\-]+)\$")  # `$key$` inside a localisation value
NESTING_DEPTH = 4


def game_root() -> Optional[Path]:
	folder = game_lib.game_dir()
	return folder if game_lib.is_game_dir(folder) else None


# ---------------------------------------------------------------- parsing


@dataclass
class Entry:
	"""One `key = value` (or bare value) inside a block, with text offsets."""

	key: Optional[str]
	start: int
	value_start: int
	value_end: int
	is_block: bool
	value_index: int
	value: Optional[str]


class Doc:
	"""Offset-aware view of Clausewitz text built on the shared tokenizer."""

	def __init__(self, text: str) -> None:
		self.text = text
		self.tokens: List[Tuple[str, int, int]] = [
			(m.group(0), m.start(), m.end())
			for m in TOKEN.finditer(text)
			if m.group(0) != "\n" and not m.group(0).startswith("#")
		]
		self.match: Dict[int, int] = {}
		stack: List[int] = []
		self.balanced = True
		for index, (token, _start, _end) in enumerate(self.tokens):
			if token == "{":
				stack.append(index)
			elif token == "}":
				if stack:
					self.match[stack.pop()] = index
				else:
					self.balanced = False
		if stack:
			self.balanced = False

	def entries(self, open_index: int = -1) -> List[Entry]:
		"""Entries directly inside the block opened at token `open_index` (-1 is the file)."""
		close = len(self.tokens) if open_index < 0 else self.match.get(open_index, len(self.tokens))
		found: List[Entry] = []
		index = open_index + 1
		while index < close:
			token, start, end = self.tokens[index]
			if token == "{":
				index = self.match.get(index, close) + 1
				continue
			if token == "}":
				index += 1
				continue
			if index + 1 < close and self.tokens[index + 1][0] in OPERATORS:
				value_index = index + 2
				if value_index >= close:
					break
				value, value_start, value_end = self.tokens[value_index]
				if value == "{":
					end_index = self.match.get(value_index, close)
					found.append(Entry(token, start, value_start, self.tokens[end_index][2], True, value_index, None))
					index = end_index + 1
				else:
					found.append(Entry(token, start, value_start, value_end, False, value_index, value))
					index = value_index + 1
			else:
				found.append(Entry(None, start, start, end, False, index, token))
				index += 1
		return found

	def close_start(self, open_index: int) -> int:
		"""Offset of the closing brace of the block opened at `open_index`."""
		return self.tokens[self.match[open_index]][1]

	def line_of(self, offset: int) -> int:
		return self.text.count("\n", 0, offset) + 1


def unquote(value: Optional[str]) -> str:
	if value is None:
		return ""
	return value[1:-1] if len(value) > 1 and value.startswith('"') and value.endswith('"') else value


def line_span(text: str, start: int, end: int) -> Tuple[int, int]:
	"""Grow [start, end) to whole lines when nothing else shares them."""
	line_start = text.rfind("\n", 0, start) + 1
	if text[line_start:start].strip():
		line_start = start
	newline = text.find("\n", end)
	rest = text[end:] if newline < 0 else text[end:newline]
	if not rest.strip() or rest.strip().startswith("#"):
		end = len(text) if newline < 0 else newline + 1
	return line_start, end


def indent_of(text: str, offset: int, fallback: str = "\t\t") -> str:
	line_start = text.rfind("\n", 0, offset) + 1
	return text[line_start:offset] if not text[line_start:offset].strip() else fallback


def file_version(text: str) -> str:
	return hashlib.sha1(text.encode("utf-8")).hexdigest()


def sub_entries(doc: Doc, entry: Entry, key: Optional[str] = None) -> List[Entry]:
	subs = doc.entries(entry.value_index) if entry.is_block else []
	return [s for s in subs if key is None or s.key == key]


def scalar(doc: Doc, entry: Entry, key: str) -> Optional[str]:
	for sub in sub_entries(doc, entry, key):
		if not sub.is_block:
			return unquote(sub.value)
	return None


def block_body(text: str, doc: Doc, entry: Entry) -> str:
	"""Inner text of a block entry without its braces, dedented and trimmed."""
	if not entry.is_block:
		return ""
	open_end = doc.tokens[entry.value_index][2]
	close_start = doc.tokens[doc.match.get(entry.value_index, entry.value_index)][1]
	inner = text[open_end:close_start]
	first_newline = inner.find("\n")
	if first_newline >= 0 and inner[:first_newline].strip():
		# Text on the opening line (often a comment) must not decide the indentation of the rest.
		head, rest = inner[:first_newline].strip(), dedent(inner[first_newline + 1:])
		return f"{head}\n{rest}" if rest else head
	return dedent(inner)


def dedent(body: str) -> str:
	lines = body.replace("\r\n", "\n").split("\n")
	while lines and not lines[0].strip():
		lines.pop(0)
	while lines and not lines[-1].strip():
		lines.pop()
	if not lines:
		return ""
	if len(lines) == 1:
		return lines[0].strip()
	widths = [len(line) - len(line.lstrip(" \t")) for line in lines if line.strip()]
	cut = min(widths) if widths else 0
	return "\n".join(line[cut:] if line.strip() else "" for line in lines)


def format_block(key: str, body: str, indent: str) -> str:
	"""`key = { ... }` with the body re-indented one level below `indent`."""
	body = dedent(body)
	if not body:
		return f"{key} = {{ }}"
	if "\n" not in body and len(body) < 60 and "{" not in body:
		return f"{key} = {{ {body} }}"
	inner = "\n".join((indent + "\t" + line) if line.strip() else "" for line in body.split("\n"))
	return f"{key} = {{\n{inner}\n{indent}}}"


# ---------------------------------------------------------------- block editing


class BlockEditor:
	"""Collects surgical edits to the text of one `key = { ... }` block and applies them."""

	def __init__(self, block: str) -> None:
		self.block = block
		self.doc = Doc(block)
		top = [entry for entry in self.doc.entries() if entry.is_block]
		if not top:
			raise ValueError("not a block")
		self.top = top[0]
		self.subs = self.doc.entries(self.top.value_index)
		self.edits: List[Tuple[int, int, str]] = []
		self.inserts_top: List[str] = []
		self.inserts_after: List[Tuple[int, str, str]] = []
		self.inserts_end: List[str] = []
		first = next((s for s in self.subs if s.key), None)
		self.inner_indent = indent_of(block, first.start) if first else indent_of(block, self.top.start, "") + "\t"

	def occurrences(self, key: str) -> List[Entry]:
		return [s for s in self.subs if s.key == key]

	def set_scalar(self, key: str, value: str, occurrence: int = 0) -> None:
		found = self.occurrences(key)
		if occurrence < len(found):
			entry = found[occurrence]
			if entry.is_block:
				start, end = entry.start, entry.value_end
				self.edits.append((start, end, f"{key} = {value}"))
			else:
				self.edits.append((entry.value_start, entry.value_end, value))
		elif found:
			# another occurrence of a repeated key (recruit_character, add_ideas ...) goes after the last one
			last = found[-1]
			self.inserts_after.append((last.value_end, indent_of(self.block, last.start, self.inner_indent), f"{key} = {value}"))
		else:
			self.inserts_top.append(f"{self.inner_indent}{key} = {value}\n")

	def set_block(self, key: str, body: str, occurrence: int = 0) -> None:
		found = self.occurrences(key)
		if occurrence < len(found):
			entry = found[occurrence]
			indent = indent_of(self.block, entry.start, self.inner_indent)
			self.edits.append((entry.start, entry.value_end, format_block(key, body, indent)))
		else:
			self.add_block(key, body)

	def add_block(self, key: str, body: str) -> None:
		self.inserts_end.append(f"{self.inner_indent}{format_block(key, body, self.inner_indent)}\n")

	def remove(self, key: str, occurrence: Optional[int] = None) -> None:
		found = self.occurrences(key)
		chosen = found if occurrence is None else found[occurrence:occurrence + 1]
		for entry in chosen:
			start, end = line_span(self.block, entry.start, entry.value_end)
			self.edits.append((start, end, ""))

	def after_line(self, end: int) -> Tuple[int, bool]:
		"""Insert position just after the line holding offset `end`, and whether that line is the
		block's own last line (a one-line block), where the text has to go inline instead."""
		newline = self.block.find("\n", end)
		if newline < 0 or newline >= self.doc.close_start(self.top.value_index):
			return end, True
		return newline + 1, False

	def result(self) -> str:
		block = self.block
		edits = list(self.edits)
		inserts: Dict[int, List[str]] = {}
		if self.inserts_top:
			anchor = next((s for s in self.subs if s.key == "id"), None) or next((s for s in self.subs if s.key), None)
			if anchor is not None:
				position, inline = self.after_line(anchor.value_end)
				lines = [(" " + line.strip()) if inline else line for line in self.inserts_top]
			else:
				position = self.doc.tokens[self.top.value_index][2]
				lines = ["\n" + self.inserts_top[0]] + self.inserts_top[1:]
			inserts.setdefault(position, []).extend(lines)
		for end, indent, text in self.inserts_after:
			position, inline = self.after_line(end)
			inserts.setdefault(position, []).append(f" {text}" if inline else f"{indent}{text}\n")
		for position, lines in inserts.items():
			edits.append((position, position, "".join(lines)))
		if self.inserts_end:
			close = self.doc.close_start(self.top.value_index)
			line_start = block.rfind("\n", 0, close) + 1
			if block[line_start:close].strip():
				edits.append((close, close, "\n" + "".join(self.inserts_end)))
			else:
				edits.append((line_start, line_start, "".join(self.inserts_end)))
		for start, end, text in sorted(edits, key=lambda item: (item[0], item[1]), reverse=True):
			block = block[:start] + text + block[end:]
		if not Doc(block).balanced:
			raise ValueError("the edit would leave unbalanced braces")
		return block


def check_block(text: str, expect_key: Optional[str] = None) -> Doc:
	"""Validate a raw block edited by the user: balanced braces and exactly one block."""
	doc = Doc(text)
	if not doc.balanced:
		raise ValueError("unbalanced braces")
	blocks = [e for e in doc.entries() if e.is_block]
	if len(blocks) != 1 or (expect_key and blocks[0].key != expect_key):
		raise ValueError(f"the text must be exactly one `{expect_key or 'key'} = {{ ... }}` block")
	return doc


# ---------------------------------------------------------------- files


def rel_path(path: Path) -> str:
	return path.resolve().relative_to(ROOT.resolve()).as_posix()


def check_rel(rel: str) -> str:
	rel = rel.replace("\\", "/").lstrip("/")
	if ".." in rel.split("/") or not rel.startswith(EDITABLE_ROOTS):
		raise ValueError(f"not an editable mod path: {rel}")
	return rel


def resolve(rel: str) -> Tuple[Path, bool]:
	"""(path, is_vanilla) for a repository-relative path, mod first."""
	rel = check_rel(rel)
	mod = ROOT / rel
	if mod.is_file():
		return mod, False
	game = game_root()
	if game is not None and (game / rel).is_file():
		return game / rel, True
	raise ValueError(f"no such file: {rel}")


def writable_copy(rel: str) -> Tuple[Path, bool]:
	"""The mod copy of `rel`, copying the game file into the mod first if needed."""
	path, is_vanilla = resolve(rel)
	if not is_vanilla:
		return path, False
	target = ROOT / check_rel(rel)
	target.parent.mkdir(parents=True, exist_ok=True)
	shutil.copy2(path, target)
	return target, True


def read_script(path: Path) -> Tuple[str, bool, str]:
	"""The text without BOM, whether it had one, and its newline style."""
	raw = path.read_bytes()
	had_bom = raw.startswith(BOM)
	text = (raw[3:] if had_bom else raw).decode("utf-8", errors="replace")
	newline = "\r\n" if "\r\n" in text else "\n"
	return text.replace("\r\n", "\n"), had_bom, newline


def write_script(path: Path, text: str, had_bom: bool, newline: str) -> None:
	data = text.replace("\n", newline).encode("utf-8")
	path.write_bytes((BOM if had_bom else b"") + data)


def list_files(folder: str, pattern: str = "*.txt", include_vanilla: bool = False) -> List[dict]:
	"""Script files of a folder: the mod's, then the game's that the mod does not override."""
	found: Dict[str, dict] = {}
	mod_folder = ROOT / folder
	if mod_folder.is_dir():
		for path in sorted(mod_folder.glob(pattern)):
			found[path.name] = {"file": f"{folder}/{path.name}", "vanilla": False}
	game = game_root()
	if include_vanilla and game is not None and (game / folder).is_dir():
		for path in sorted((game / folder).glob(pattern)):
			found.setdefault(path.name, {"file": f"{folder}/{path.name}", "vanilla": True})
	return sorted(found.values(), key=lambda f: (f["vanilla"], f["file"].lower()))


class Backup:
	"""Copies each file once per save into a timestamped backup folder."""

	def __init__(self) -> None:
		stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
		self.folder = BACKUP_DIR / stamp
		self.kept: set = set()

	def keep(self, path: Path) -> None:
		if path in self.kept or not path.exists():
			return
		target = self.folder / path.resolve().relative_to(ROOT.resolve())
		target.parent.mkdir(parents=True, exist_ok=True)
		shutil.copy2(path, target)
		self.kept.add(path)

	def where(self) -> Optional[str]:
		# The backup folder lives beside the tools, outside the mod, so report its full path.
		return self.folder.resolve().as_posix() if self.kept else None


def folder_stamp(folder: Path, pattern: str) -> Tuple[int, int]:
	"""(file count, newest modification time) of the matching files, to notice edits on disk."""
	files = list(folder.rglob(pattern)) if folder.is_dir() else []
	newest = 0
	for path in files:
		try:
			newest = max(newest, path.stat().st_mtime_ns)
		except OSError:
			continue
	return len(files), newest


def host_is_local(host_header: Optional[str]) -> bool:
	"""True when the Host header names this machine (blocks DNS rebinding)."""
	host = (host_header or "").strip()
	if host.startswith("["):
		return False
	return host.rsplit(":", 1)[0].lower() in LOCAL_HOSTS


# ---------------------------------------------------------------- localisation


def in_replace_folder(path: Path) -> bool:
	"""True for a localisation file inside a `replace` folder (its keys override the game's)."""
	try:
		return "replace" in path.resolve().relative_to(LOC_DIR.resolve()).parts[:-1]
	except ValueError:
		return False


class Localisation:
	"""English localisation of the mod, keyed by name, with the file and line of each key."""

	def __init__(self) -> None:
		self.where: Dict[str, Tuple[Path, int]] = {}
		self.values: Dict[str, str] = {}
		# A key in a `replace` folder wins in the game, so it is read first (wiki: localisation, Replacing).
		for path in sorted(LOC_DIR.rglob("*.yml"), key=lambda p: (not in_replace_folder(p), str(p))):
			for number, line in enumerate(read_text(path).splitlines(), start=1):
				match = LOC_LINE.match(line.strip())
				if match and match.group("key") not in self.where:
					self.where[match.group("key")] = (path, number)
					self.values[match.group("key")] = match.group("value")

	def get(self, key: str) -> Optional[str]:
		return self.values.get(key)

	def save(self, changes: Dict[str, str], fallback: Path, backup: Backup, force: bool = False) -> List[str]:
		"""Write changed values; new keys (every key when `force`) go to `fallback`. Returns the files written."""
		by_file: Dict[Path, Dict[str, str]] = {}
		for key, value in changes.items():
			if not SAFE_ID.match(key):
				raise ValueError(f"invalid localisation key {key}")
			value = value.replace("\r\n", "\n").replace("\n", "\\n")
			path = self.where[key][0] if key in self.where and not force else fallback
			by_file.setdefault(path, {})[key] = value
		written = []
		for path, values in by_file.items():
			if path.exists():
				backup.keep(path)
				raw = path.read_bytes()
				text = (raw[3:] if raw.startswith(BOM) else raw).decode("utf-8", errors="replace")
			else:
				text = "l_english:\n"
			newline = "\r\n" if "\r\n" in text else "\n"
			lines = text.replace("\r\n", "\n").split("\n")
			pending = dict(values)
			for index, line in enumerate(lines):
				match = LOC_LINE.match(line.strip())
				if match and match.group("key") in pending:
					prefix = line[: line.index('"')]
					lines[index] = f'{prefix}"{pending.pop(match.group("key"))}"'
			if pending:
				while lines and not lines[-1].strip():
					lines.pop()
				lines += [f'{key}: "{value}"' for key, value in pending.items()]
				lines.append("")
			path.parent.mkdir(parents=True, exist_ok=True)
			path.write_bytes(BOM + newline.join(lines).encode("utf-8"))
			written.append(rel_path(path))
		return written

	def fallback_for(self, keys: Iterable[str], default_name: str) -> Path:
		"""The file that already holds most of `keys`, else `localisation/english/<default_name>`."""
		counts: Dict[Path, int] = {}
		for key in keys:
			where = self.where.get(key)
			if where:
				counts[where[0]] = counts.get(where[0], 0) + 1
		if counts:
			return max(counts, key=lambda p: counts[p])
		return LOC_DIR / default_name


class VanillaLocalisation:
	"""The game's English text, loaded on first use, for display only."""

	def __init__(self) -> None:
		self.values: Optional[Dict[str, str]] = None
		self.lock = threading.Lock()

	def get(self, key: str) -> Optional[str]:
		with self.lock:
			if self.values is None:
				self.values = {}
				game = game_root()
				folder = game / "localisation" / "english" if game else None
				if folder is not None and folder.is_dir():
					for path in folder.rglob("*.yml"):
						for line in read_text(path).splitlines():
							match = LOC_LINE.match(line.strip())
							if match:
								self.values.setdefault(match.group("key"), match.group("value"))
		return self.values.get(key)


# ---------------------------------------------------------------- sprites


def asset_roots() -> List[Path]:
	"""Folders that hold art, highest priority first: the mod, the game, then the game's DLC folders.
	DLC art is loose under `integrated_dlc/<name>/` (older DLCs merged into the base game) and
	`dlc/<name>/` (`interface/*.gfx`, `gfx/...`), with texture paths relative to that folder, e.g. the
	Graveyard of Empires portraits in `dlc/dlc046_graveyard_of_empires/`."""
	roots = [ROOT]
	game = game_root()
	if game is not None:
		roots.append(game)
		for folder in ("integrated_dlc", "dlc"):
			if (game / folder).is_dir():
				roots += sorted(path for path in (game / folder).iterdir() if path.is_dir())
	return roots


class Sprites:
	"""GFX sprite name -> texture path, from the mod first, then the game and its DLC folders."""

	def __init__(self) -> None:
		self.textures: Dict[str, Path] = {}
		self.lock = threading.Lock()
		self.roots = asset_roots()
		self.stamp: Tuple[int, int] = (0, 0)
		self.build()

	def build(self) -> None:
		textures: Dict[str, Path] = {}
		for root in reversed(self.roots):
			for gfx in (root / "interface").rglob("*.gfx"):
				text = read_text(gfx)
				for match in SPRITE.finditer(text):
					texture = TEXTURE.search(match.group(2)[:600])
					if texture:
						textures[match.group(1)] = Path((texture.group(1) or texture.group(2)).replace("\\", "/"))
		self.textures = textures
		self.stamp = folder_stamp(ROOT / "interface", "*.gfx")

	def refresh_if_changed(self) -> None:
		"""Pick up sprites that were added to the mod after the studio started."""
		if folder_stamp(ROOT / "interface", "*.gfx") != self.stamp:
			self.build()

	def has_shine(self, name: str) -> bool:
		"""Focus icons come with a `<name>_shine` sprite; idea and decision pictures do not."""
		return f"{name}_shine" in self.textures

	def exists(self, name: str) -> bool:
		if name not in self.textures:
			self.refresh_if_changed()
		return name in self.textures

	def info(self, name: str) -> Dict[str, bool]:
		return {"exists": self.exists(name), "shine": self.has_shine(name)}

	def search(self, query: str, limit: int, prefix: str = "") -> List[str]:
		self.refresh_if_changed()  # sprites registered after the studio started (generated art)
		words = query.lower().split()  # every word must appear: "portrait syr"
		prefix = prefix.lower()
		names = [n for n in self.textures if all(w in n.lower() for w in words) and n.lower().startswith(prefix) and not n.lower().endswith("_shine")]
		names.sort(key=lambda n: (not (n.startswith("GFX_focus") or n.startswith("GFX_goal")), n.lower()))
		return names[:limit]

	def source(self, name: str) -> Optional[Path]:
		relative = self.textures.get(name)
		if relative is None:
			self.refresh_if_changed()
			relative = self.textures.get(name)
			if relative is None:
				return None
		# The engine also loads a texture whose extension differs from the sprite entry.
		candidates = [relative] + [relative.with_suffix(s) for s in (".dds", ".tga", ".png") if s != relative.suffix.lower()]
		return next((root / c for c in candidates for root in self.roots if (root / c).is_file()), None)

	def png(self, name: str) -> Optional[Tuple[bytes, str]]:
		"""PNG bytes of a sprite's texture and an ETag that changes with the texture file."""
		source = self.source(name)
		if source is None:
			return None
		return png_of_file(source, re.sub(r"[^A-Za-z0-9_.\-]", "_", name), self.lock)


def texture_png(rel: str, lock: threading.Lock) -> Optional[Tuple[bytes, str]]:
	"""PNG of a texture given by its `gfx/...` path (flags, portraits): the mod, the game, then its DLC folders."""
	rel = rel.replace("\\", "/").lstrip("/")
	if ".." in rel.split("/") or not rel.lower().startswith("gfx/") or not rel.lower().endswith((".dds", ".tga", ".png")):
		raise ValueError("not a texture path")
	relative = Path(rel)
	candidates = [relative] + [relative.with_suffix(s) for s in (".dds", ".tga", ".png") if s != relative.suffix.lower()]
	for root in asset_roots():
		for candidate in candidates:
			if (root / candidate).is_file():
				return png_of_file(root / candidate, re.sub(r"[^A-Za-z0-9_.\-]", "_", candidate.as_posix()), lock)
	return None


def png_of_file(source: Path, cache_name: str, lock: threading.Lock) -> Optional[Tuple[bytes, str]]:
	stat = source.stat()
	etag = f'"{stat.st_mtime_ns}-{stat.st_size}"'
	cache = ICON_CACHE / f"{cache_name}_{stat.st_mtime_ns}_{stat.st_size}.png"
	if cache.exists():
		return cache.read_bytes(), etag
	try:
		from PIL import Image

		with lock, Image.open(source) as image:
			image = image.convert("RGBA")
			buffer = io.BytesIO()
			image.save(buffer, "PNG")
	except Exception:  # noqa: BLE001 - an undecodable texture shows as a placeholder
		return None
	ICON_CACHE.mkdir(parents=True, exist_ok=True)
	cache.write_bytes(buffer.getvalue())
	return buffer.getvalue(), etag


# ---------------------------------------------------------------- references


class TextCache:
	"""Mod script text kept in memory (refreshed by modification time) for reference searches."""

	FOLDERS = ("common", "events", "history")

	def __init__(self) -> None:
		self.files: Dict[Path, Tuple[int, List[str]]] = {}
		self.lock = threading.Lock()

	def lines(self) -> Iterable[Tuple[Path, List[str]]]:
		with self.lock:
			for folder in self.FOLDERS:
				for path in (ROOT / folder).rglob("*.txt"):
					try:
						mtime = path.stat().st_mtime_ns
					except OSError:
						continue
					cached = self.files.get(path)
					if cached is None or cached[0] != mtime:
						cached = (mtime, read_text(path).splitlines())
						self.files[path] = cached
					yield path, cached[1]

	def find(self, identifier: str, limit: int = 300, skip: Optional[Callable[[Path, int], bool]] = None) -> List[dict]:
		if not SAFE_ID.match(identifier):
			raise ValueError("invalid identifier")
		pattern = re.compile(r"(?<![A-Za-z0-9_.@])" + re.escape(identifier) + r"(?![A-Za-z0-9_])")
		found: List[dict] = []
		for path, lines in self.lines():
			for number, line in enumerate(lines, start=1):
				code = line.split("#", 1)[0]
				if identifier in code and pattern.search(code):
					if skip and skip(path, number):
						continue
					found.append({"file": rel_path(path), "line": number, "text": line.strip()[:200]})
					if len(found) >= limit:
						return found
		return found


def wait_stamp(interval: float, last: List[float]) -> bool:
	"""True at most once per `interval` seconds (last[0] holds the previous time)."""
	now = time.time()
	if now - last[0] < interval:
		return False
	last[0] = now
	return True


# ---------------------------------------------------------------- shared context


class Context:
	"""State shared by every studio module: localisation, sprites, text cache, file versions."""

	STAMP_INTERVAL = 1.5

	def __init__(self) -> None:
		self.loc = Localisation()
		self.loc_stamp = folder_stamp(LOC_DIR, "*.yml")
		self.loc_checked = [time.time()]
		self.vloc = VanillaLocalisation()
		self.sprites = Sprites()
		self.texts = TextCache()
		self.lock = threading.RLock()
		self.versions: Dict[str, Tuple[int, int, str]] = {}

	def fresh_loc(self, force: bool = False) -> None:
		"""Reload the localisation index when an English file changed on disk."""
		if not force and not wait_stamp(self.STAMP_INTERVAL, self.loc_checked):
			return
		stamp = folder_stamp(LOC_DIR, "*.yml")
		if force or stamp != self.loc_stamp:
			self.loc = Localisation()
			self.loc_stamp = stamp

	def stamp_text(self) -> str:
		return f"{self.loc_stamp[0]}-{self.loc_stamp[1]}"

	def text(self, key: str) -> str:
		"""English text of a key: the mod's, else the game's, else empty."""
		value = self.loc.get(key)
		if value is None:
			value = self.vloc.get(key)
		return value or ""

	def display(self, key: str, depth: int = 0) -> str:
		"""Text of a key as the game shows it: a nested `$other_key$` is replaced by that key's text
		(wiki: localisation, Nesting strings); internal variables such as `$FOCUS_NAME$` stay as written.
		For lists and previews only; editors show and save the raw value."""
		value = self.text(key)
		if "$" not in value or depth >= NESTING_DEPTH:
			return value
		return NESTED_KEY.sub(lambda m: self.display(m.group(1), depth + 1) or m.group(0), value)

	def has_mod_text(self, key: str) -> bool:
		return self.loc.get(key) is not None

	def version_of(self, rel: str) -> Optional[str]:
		try:
			path, _vanilla = resolve(rel)
		except ValueError:
			return None
		stat = path.stat()
		cached = self.versions.get(rel)
		if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
			return cached[2]
		text, _bom, _newline = read_script(path)
		version = file_version(text)
		self.versions[rel] = (stat.st_mtime_ns, stat.st_size, version)
		return version

	def save_loc(self, changes: Dict[str, str], related_keys: Iterable[str], default_name: str, backup: Backup) -> List[str]:
		"""Write English text. The game prefers its own text over a mod duplicate unless the mod's line
		is in a `replace` folder (wiki: localisation, Replacing), so a key the game also defines goes to
		`localisation/english/replace/<default_name>` unless the mod already overrides it there."""
		if not changes:
			return []
		plain: Dict[str, str] = {}
		override: Dict[str, str] = {}
		for key, value in changes.items():
			where = self.loc.where.get(key)
			if not (where and in_replace_folder(where[0])) and self.vloc.get(key) is not None:
				override[key] = value
			else:
				plain[key] = value
		written: List[str] = []
		if plain:
			written += self.loc.save(plain, self.loc.fallback_for(related_keys, default_name), backup)
		if override:
			written += [w for w in self.loc.save(override, LOC_DIR / "replace" / default_name, backup, force=True) if w not in written]
		self.fresh_loc(force=True)
		return written
