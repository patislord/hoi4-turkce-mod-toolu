"""HOI4 Türkçe Mod Toolu: a local visual editor for this mod.

Run `python -B .tools/mod_studio/studio.py` (or double-click `studio.bat`). It serves the pages in
`web/` on 127.0.0.1 and opens the browser. Modules:

- focus trees (`mod_focus.py`, web/focus.html)
- national spirits / ideas (`mod_ideas.py`, web/ideas.html)
- decisions and decision categories (`mod_decisions.py`, web/decisions.html)
- events with a window preview and chain graph (`mod_events.py`, web/events.html)
- leader and advisor trait modifiers on the Characters page (`mod_traits.py`)
- the visual effect and trigger builder that every page uses for rewards, conditions and option
  effects (`web/studio-script.js`, `web/studio-schema.js`), fed by the pickers' catalog
  (`mod_catalog.py`, `/api/catalog?type=...`)
- Mod Health: the repository checks with links into the editors (`mod_health.py`, web/health.html)

Every page can send the selected element to a Claude Code session through `bridge.py`, and every
page reloads what changed on disk. Saves rewrite only what changed, back up first into
`.tmp/mod_studio/backups/`, copy a game file into the mod before its first edit, and write
English localisation only. POST calls need the per-launch token written into each page, and every
call must name 127.0.0.1 or localhost as its host, so other websites in the same browser cannot
drive the studio.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
	sys.path.insert(0, str(HERE))

import bridge  # noqa: E402
import core  # noqa: E402
from mod_catalog import Catalog  # noqa: E402
from mod_characters import CharacterModule  # noqa: E402
from mod_countries import CountryModule  # noqa: E402
from mod_decisions import CategoryModule, DecisionModule  # noqa: E402
from mod_events import EventModule  # noqa: E402
from mod_focus import FocusModule  # noqa: E402
from mod_health import Health  # noqa: E402
from mod_ideas import IdeaModule  # noqa: E402
from mod_traits import TraitModule  # noqa: E402

WEB = HERE / "web"
PAGES = {"home", "focus", "ideas", "decisions", "events", "health", "countries", "characters"}
STATIC = {"studio.js": "application/javascript; charset=utf-8", "studio-script.js": "application/javascript; charset=utf-8",
	"studio-schema.js": "application/javascript; charset=utf-8", "studio.css": "text/css; charset=utf-8"}
MAX_LOC_KEYS = 200
TOKEN_PLACEHOLDER = b"__EDITOR_TOKEN__"
DEFAULT_PORT = 8765
ITEM_KINDS = ("idea", "decision", "category", "event", "character")
SEARCH_KINDS = ("country", "focus", "event", "decision", "category", "idea", "character")
# hoi4-imagegen families the icon pickers can ask Claude to generate
IMAGE_FAMILIES = {"focus", "idea_spirit", "decision", "decision_category_icon", "decision_category_picture",
	"report_event", "news_event", "leader_portrait", "commander_portrait", "advisor_card"}


class Studio:
	def __init__(self) -> None:
		self.ctx = core.Context()
		self.modules: Dict[str, object] = {
			"focus": FocusModule(self.ctx), "idea": IdeaModule(self.ctx), "decision": DecisionModule(self.ctx),
			"category": CategoryModule(self.ctx), "event": EventModule(self.ctx), "character": CharacterModule(self.ctx),
		}
		self.modules["country"] = CountryModule(self.ctx, self.modules["character"], self.modules["idea"])
		self.traits = TraitModule(self.ctx, self.modules["idea"])
		self.modules["decision"].categories_module = self.modules["category"]  # type: ignore[attr-defined]
		self.health = Health(self.ctx, self.modules)
		self.catalog = Catalog(self.ctx, self.modules)

	def module(self, kind: str):
		module = self.modules.get(kind)
		if module is None:
			raise ValueError(f"unknown module {kind}")
		return module

	def state(self, files: List[str]) -> dict:
		self.ctx.fresh_loc()
		return {
			"listener": bridge.listener_state(),
			"requests": list(reversed(bridge.all_requests()))[:40],
			"versions": {rel: self.ctx.version_of(rel) for rel in files if rel},
			"locStamp": self.ctx.stamp_text(),
		}

	def search(self, query: str, limit: int = 60) -> List[dict]:
		query = query.strip()
		if len(query) < 2:
			return []
		per_module = {kind: self.module(kind).search(query, limit) for kind in SEARCH_KINDS}
		exact = [r for rows in per_module.values() for r in rows if r["id"].lower() == query.lower()]
		# Take results from every module in turn so one large module cannot crowd out the others.
		mixed: List[dict] = []
		for position in range(limit):
			for rows in per_module.values():
				if position < len(rows) and rows[position] not in exact:
					mixed.append(rows[position])
		return (exact + mixed)[:limit]

	def claude_request(self, payload: dict) -> dict:
		kind = str(payload.get("kind", ""))
		rel = core.check_rel(str(payload.get("file", "")))
		ids = [str(i) for i in payload.get("ids") or []][:60]
		context = payload.get("context") or {}
		if kind == "image":
			# An icon picker asks for new art; the element it is for gives Claude the context.
			if context.get("family") not in IMAGE_FAMILIES:
				raise ValueError(f"no image generation for family {context.get('family')}")
			source = str(context.get("for", ""))
			items = []
			for item_id in ids:
				try:
					items += self.module(source).claude_items(rel, [item_id], context) if source in self.modules else [{"id": item_id, "name": item_id}]
				except ValueError:  # the element is new and not saved yet
					items.append({"id": item_id, "name": item_id})
		else:
			items = self.module(kind).claude_items(rel, ids, context) if ids else []
		return bridge.new_request(kind, rel, items, str(payload.get("text", "")), context)

	def post(self, path: str, payload: dict) -> dict:
		parts = path.strip("/").split("/")
		if parts[:2] == ["api", "claude"] and len(parts) == 3:
			if parts[2] == "request":
				return self.claude_request(payload)
			if parts[2] == "cancel":
				return bridge.cancel(str(payload.get("id", "")))
		if path in ("/api/trait/save", "/api/trait/create"):
			result = self.traits.save(payload) if path.endswith("save") else self.traits.create(payload)
			self.health.remember(result.get("written", []))
			return result
		if parts[:2] == ["api", "health"] and parts[2:] == ["run"]:
			return self.health.start(str(payload.get("mode", "quick")), [str(p) for p in payload.get("paths") or []])
		if len(parts) == 3 and parts[0] == "api":
			kind, action = parts[1], parts[2]
			module = self.module(kind)
			if kind == "focus" and action == "save":
				result = module.save(payload)
			elif kind == "country" and action in ("save", "create"):
				result = getattr(module, action)(payload)
			elif kind == "country" and action == "flag":
				result = module.write_flag(payload)
			elif kind == "country" and action == "advisor":
				result = module.add_advisor(payload)
			elif kind in ITEM_KINDS and action in ("save", "create", "delete"):
				result = getattr(module, action)(payload)
			elif kind == "decision" and action == "container":
				result = module.add_container(payload)
			else:
				raise ValueError(f"unknown action {path}")
			self.health.remember(result.get("written", []))
			return result
		raise ValueError(f"unknown action {path}")

	def get(self, path: str, query: Dict[str, str]):
		parts = path.strip("/").split("/")
		if path == "/api/files":
			return {"files": self.module(query.get("module", "")).files(query.get("vanilla") == "1")}
		if path == "/api/state":
			return self.state([f for f in query.get("files", "").split(",") if f])
		if path == "/api/search":
			return {"results": self.search(query.get("q", ""))}
		if path == "/api/catalog":
			return {"type": query.get("type", ""), "items": self.catalog.get(query.get("type", ""))}
		if path == "/api/loc":
			# English text of localisation keys, for tooltip texts edited inside the script builder
			self.ctx.fresh_loc()
			keys = [k for k in query.get("keys", "").split(",") if core.SAFE_ID.match(k)][:MAX_LOC_KEYS]
			return {"texts": {k: self.ctx.text(k).replace("\\n", "\n") for k in keys}, "inMod": {k: self.ctx.has_mod_text(k) for k in keys}}
		if path == "/api/refs":
			skip = None
			if query.get("skipfile") and query.get("from") and query.get("to"):
				skip_rel, start, end = query["skipfile"], int(query["from"]), int(query["to"])
				skip = lambda p, n: core.rel_path(p) == skip_rel and start <= n <= end  # noqa: E731
			return {"refs": self.ctx.texts.find(query.get("id", ""), 300, skip)}
		if path == "/api/icons":
			limit = min(int(query.get("limit", "240")), 1000)
			names = self.ctx.sprites.search(query.get("q", ""), limit, query.get("prefix", ""))
			# `extra`: sprites Claude generated for the picker, listed first when they exist
			extra = [n for n in query.get("extra", "").split(",")[:50] if n and self.ctx.sprites.exists(n)]
			shown = extra + [n for n in names if n not in extra]
			return {"names": names, "extra": extra, "noShine": [n for n in shown if not self.ctx.sprites.has_shine(n)]}
		if path == "/api/iconinfo":
			return self.ctx.sprites.info(query.get("name", ""))
		if path == "/api/health/status":
			return self.health.status()
		if path == "/api/focus/tree":
			return self.module("focus").tree(core.check_rel(query.get("file", "")), query.get("tree", ""))
		if path == "/api/event/graph":
			return self.module("event").graph(core.check_rel(query.get("file", "")))
		if path == "/api/event/nextid":
			return {"id": self.module("event").next_id(query.get("namespace", ""))}
		if path == "/api/country/list":
			return self.module("country").list()
		if path == "/api/country/detail":
			return self.module("country").detail(query.get("tag", ""))
		if path == "/api/country/states":
			return {"states": self.module("country").states()}
		if path == "/api/country/techs":
			return {"techs": self.module("country").technologies()}
		if path == "/api/country/traits":
			return self.module("country").traits()
		if path == "/api/country/advisortraits":
			return self.module("country").advisor_traits()
		if path == "/api/country/ideologies":
			return {"ideologies": self.module("country").ideologies(), "cultures": self.module("country").cultures()}
		if path == "/api/country/ideas":
			return {"ideas": self.module("country").idea_list()}
		if path == "/api/country/characters":
			return {"characters": self.module("character").all_ids()}
		if path == "/api/country/tagcharacters":
			return {"characters": self.module("character").cards_for_tag(query.get("tag", ""))}
		if path == "/api/country/character":
			card = self.module("character").card(query.get("id", ""))
			if card is None:
				raise ValueError(f"no character {query.get('id', '')}")
			return card
		if path == "/api/trait/detail":
			return self.traits.detail(query.get("id", ""))
		if path == "/api/idea/modifiers":
			return {"names": self.module("idea").modifiers()}
		if path == "/api/idea/labels":
			return {"labels": self.module("idea").labels([k for k in query.get("keys", "").split(",") if k])}
		if len(parts) == 3 and parts[0] == "api" and parts[1] in ITEM_KINDS:
			module = self.module(parts[1])
			rel = core.check_rel(query.get("file", ""))
			if parts[2] == "list":
				return module.list(rel)
			if parts[2] == "item":
				return module.item(rel, query.get("id", ""))
		raise ValueError(f"unknown path {path}")


def make_handler(studio: Studio, token: str) -> type:
	class Handler(BaseHTTPRequestHandler):
		def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
			return

		def send(self, status: int, body: bytes, content_type: str, cache: str = "no-store", etag: str = "") -> None:
			self.send_response(status)
			self.send_header("Content-Type", content_type)
			self.send_header("Content-Length", str(len(body)))
			self.send_header("Cache-Control", cache)
			if etag:
				self.send_header("ETag", etag)
			self.end_headers()
			if body:
				self.wfile.write(body)

		def json(self, status: int, data: object) -> None:
			self.send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

		def allowed(self, needs_token: bool) -> bool:
			if not core.host_is_local(self.headers.get("Host")):
				self.send(403, b"forbidden host", "text/plain")
				return False
			if needs_token and not secrets.compare_digest(self.headers.get("X-Editor-Token", ""), token):
				self.json(403, {"error": "Sayfa eski bir oturuma ait. Sayfayı yenile (F5)."})
				return False
			return True

		def do_GET(self) -> None:  # noqa: N802 - stdlib name
			if not self.allowed(needs_token=False):
				return
			url = urlparse(self.path)
			query = {k: v[0] for k, v in parse_qs(url.query).items()}
			path = url.path
			try:
				if path == "/" or (path.endswith(".html") and path[1:-5] in PAGES):
					name = "home" if path == "/" else path[1:-5]
					page = (WEB / f"{name}.html").read_bytes().replace(TOKEN_PLACEHOLDER, token.encode("ascii"))
					self.send(200, page, "text/html; charset=utf-8")
				elif path.startswith("/static/") and path[8:] in STATIC:
					self.send(200, (WEB / path[8:]).read_bytes(), STATIC[path[8:]])
				elif path in ("/api/icon", "/api/texture"):
					if path == "/api/icon":
						found = studio.ctx.sprites.png(query.get("name", ""))
					else:
						found = core.texture_png(query.get("path", ""), studio.ctx.sprites.lock)
					if found is None:
						self.send(404, b"", "image/png")
					elif self.headers.get("If-None-Match") == found[1]:
						self.send(304, b"", "image/png", cache="no-cache", etag=found[1])
					else:
						self.send(200, found[0], "image/png", cache="no-cache", etag=found[1])
				elif path.startswith("/api/"):
					self.json(200, studio.get(path, query))
				else:
					self.send(404, b"not found", "text/plain")
			except (ValueError, KeyError) as error:
				self.json(400, {"error": str(error)})

		def do_POST(self) -> None:  # noqa: N802 - stdlib name
			if not self.allowed(needs_token=True):
				return
			length = int(self.headers.get("Content-Length", "0"))
			try:
				payload = json.loads(self.rfile.read(length).decode("utf-8"))
				self.json(200, studio.post(urlparse(self.path).path, payload))
			except (ValueError, KeyError) as error:
				self.json(400, {"error": str(error)})

	return Handler


def main() -> int:
	parser = argparse.ArgumentParser(description="HOI4 Türkçe Mod Toolu")
	parser.add_argument("--port", type=int, default=DEFAULT_PORT)
	parser.add_argument("--page", default="", help="page to open first, e.g. focus.html?file=common/national_focus/SYR.txt")
	parser.add_argument("--no-browser", action="store_true")
	args = parser.parse_args()
	print("HOI4 Türkçe Mod Toolu yükleniyor (metinler ve ikonlar)...")
	studio = Studio()
	token = secrets.token_urlsafe(24)
	server = None
	for port in range(args.port, args.port + 20):
		try:
			server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(studio, token))
			break
		except OSError:
			continue
	if server is None:
		print("No free port found.", file=sys.stderr)
		return 1
	page = args.page or ""
	separator = "&" if "?" in page else "?"
	# A launch-specific query keeps the browser from reusing a page cached by an older launch.
	url = f"http://127.0.0.1:{server.server_address[1]}/{page}{separator}launch={token[:8]}"
	print(f"Stüdyo açık: {url}")
	print("Kapatmak için bu pencereyi kapat (veya Ctrl+C).")
	if not args.no_browser:
		webbrowser.open(url)
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass
	return 0


if __name__ == "__main__":
	sys.exit(main())
