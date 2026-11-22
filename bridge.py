"""File-based message bridge between the HOI4 Türkçe Mod Toolu pages and a Claude Code session.

A studio page writes one JSON file per request into `.tmp/mod_studio/claude/requests/` when the
user presses "Claude'a gönder" for the selected element (a focus, event, decision, idea, ...).
A Claude Code session listens by running, as a background command,

	python -B .tools/mod_studio/bridge.py wait

`wait` writes a heartbeat to `listener.json` every two seconds, so the pages can show that Claude is
listening, and exits as soon as a request is pending: it claims the request (status `working`),
prints it with the current text of the selected elements, and stops. The session is notified when
the command ends, does the work, and answers with

	python -B .tools/mod_studio/bridge.py reply <id> --status done --message "..." --files <paths>

after which the page shows the answer and reloads what changed. Then the session runs `wait` again.
A claim file per request (`<id>.claim`, created exclusively) keeps two listeners from taking the
same request. Other commands: `list` shows the queue and `show <id>` prints one request.

Requests only come from the studio pages, whose POST calls need the per-launch token the server
embeds in each page; another website open in the same browser cannot read it.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.game import mod_root  # noqa: E402

ROOT = mod_root()
BRIDGE_DIR = Path(__file__).resolve().parents[2] / ".tmp" / "mod_studio" / "claude"
REQUESTS = BRIDGE_DIR / "requests"
LISTENER = BRIDGE_DIR / "listener.json"
HEARTBEAT_SECONDS = 2.0
ALIVE_SECONDS = 8.0
REPLY_STATUSES = ("done", "needs_info", "failed")
MAX_TEXT = 8000
REPLACE_TRIES = 40  # x REPLACE_PAUSE: up to two seconds for a file another process holds open
REPLACE_PAUSE = 0.05
KIND_NAMES = {
	"focus": "focus", "event": "event", "decision": "decision", "category": "decision category",
	"idea": "national spirit / idea", "file": "file",
	"country": "country setup (history file, country file, names, flags)", "character": "character",
	"image": "icon picker (image generation)",
}


def now_iso() -> str:
	return datetime.datetime.now().isoformat(timespec="seconds")


def write_json(path: Path, data: dict) -> None:
	"""Write atomically so a page never reads half a file. On Windows the rename is refused while
	another process holds the target open (the studio reading it, OneDrive syncing the folder), so it
	is retried for a moment before giving up."""
	path.parent.mkdir(parents=True, exist_ok=True)
	temporary = path.with_name(f"{path.name}.{os.getpid()}.{secrets.token_hex(3)}.tmp")
	temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
	for attempt in range(REPLACE_TRIES):
		try:
			os.replace(temporary, path)
			return
		except PermissionError:
			if attempt == REPLACE_TRIES - 1:
				try:
					temporary.unlink()
				except OSError:
					pass
				raise
			time.sleep(REPLACE_PAUSE)


def read_json(path: Path) -> Optional[dict]:
	try:
		data = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, ValueError):
		return None
	return data if isinstance(data, dict) else None


def request_path(request_id: str) -> Path:
	if not request_id or any(c not in "0123456789abcdef-" for c in request_id):
		raise ValueError(f"not a request id: {request_id}")
	return REQUESTS / f"{request_id}.json"


def new_request(kind: str, file: str, items: List[dict], text: str, context: Optional[dict] = None) -> dict:
	text = text.strip()
	if not text:
		raise ValueError("the request text is empty")
	if len(text) > MAX_TEXT:
		raise ValueError(f"the request text is longer than {MAX_TEXT} characters")
	# Microseconds keep ids in creation order, so the oldest request is always answered first.
	request_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f-") + secrets.token_hex(2)
	data = {
		"id": request_id, "created": now_iso(), "status": "pending", "kind": kind, "file": file,
		"items": items, "context": context or {}, "text": text, "claimed": None, "finished": None, "reply": None,
	}
	write_json(request_path(request_id), data)
	return data


def all_requests() -> List[dict]:
	found = [read_json(path) for path in sorted(REQUESTS.glob("*.json"))] if REQUESTS.is_dir() else []
	return [r for r in found if r and r.get("id")]


def get_request(request_id: str) -> dict:
	data = read_json(request_path(request_id))
	if data is None:
		raise ValueError(f"no request {request_id}")
	return data


def update(request_id: str, **fields: object) -> dict:
	data = get_request(request_id)
	data.update(fields)
	write_json(request_path(request_id), data)
	return data


def claim(request_id: str) -> bool:
	"""Take a pending request; False when another listener already took it."""
	try:
		handle = os.open(str(REQUESTS / f"{request_id}.claim"), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
	except FileExistsError:
		return False
	os.close(handle)
	data = get_request(request_id)
	if data.get("status") != "pending":
		return False
	update(request_id, status="working", claimed=now_iso())
	return True


def cancel(request_id: str) -> dict:
	data = get_request(request_id)
	if data.get("status") != "pending":
		raise ValueError("only a request that is still waiting can be cancelled")
	return update(request_id, status="cancelled", finished=now_iso())


def reply(request_id: str, status: str, message: str, files: List[str], items: List[str]) -> dict:
	if status not in REPLY_STATUSES:
		raise ValueError(f"status must be one of {', '.join(REPLY_STATUSES)}")
	return update(request_id, status=status, finished=now_iso(),
		reply={"message": message.strip(), "files": files, "items": items})


def listener_state() -> Dict[str, object]:
	data = read_json(LISTENER) or {}
	beat = data.get("beat", 0)
	alive = isinstance(beat, (int, float)) and time.time() - beat < ALIVE_SECONDS
	return {"alive": alive, "since": data.get("since") if alive else None}


def format_request(data: dict) -> str:
	kind = data.get("kind", "file")
	lines = [
		f"MOD STUDIO REQUEST {data['id']}",
		f"Sent {data['created']} by the user from the HOI4 Türkçe Mod Toolu ({KIND_NAMES.get(kind, kind)} editor).",
		f"File: {data.get('file')}",
	]
	for key, value in (data.get("context") or {}).items():
		lines.append(f"{key}: {value}")
	items = data.get("items") or []
	if items:
		lines.append("Selected:")
		for item in items:
			where = f" (line {item.get('line')})" if item.get("line") else ""
			extra = f" {item.get('extra')}" if item.get("extra") else ""
			lines.append(f"  - {item.get('id')} \"{item.get('name', '')}\"{where}{extra}")
	else:
		lines.append("Nothing selected: the request is about the whole file.")
	lines += ["", "User request:", data.get("text", ""), ""]
	for item in items:
		if item.get("raw"):
			lines += [f"--- current block of {item.get('id')} ---", str(item["raw"]).rstrip(), ""]
	if kind == "image":
		family = (data.get("context") or {}).get("family", "?")
		lines += [
			f"Scope: make ONE new `{family}` image from the user's description with the hoi4-imagegen skill loop",
			"(status, families, plan; if the plan is not free, reply needs_info with the cost before generating;",
			"then generate, process, validate, preview, review, install), and register its sprite in the mod's",
			"interface .gfx (a focus icon also gets its _shine sprite). Do not edit the selected element:",
			"the user picks the new sprite in the studio's icon picker. Real people are not generated",
			"(hoi4-feature-assets): answer needs_info or failed instead.",
			"When finished, answer in Turkish:",
			f"  python -B .tools/mod_studio/bridge.py reply {data['id']} --status done --message \"...\" "
			"--files <written paths> --items <new sprite names>",
		]
	else:
		lines += [
			"Scope: change only the selected element unless the request says otherwise.",
			"When finished, answer in Turkish:",
			f"  python -B .tools/mod_studio/bridge.py reply {data['id']} --status done --message \"...\" "
			"--files <changed paths> --items <changed ids>",
		]
	lines += [
		"  (use --status needs_info to ask the user a question, --status failed when it cannot be done)",
		"Then listen again: python -B .tools/mod_studio/bridge.py wait   (as a background command)",
	]
	return "\n".join(lines)


def wait(timeout_minutes: float) -> int:
	"""Heartbeat until a request is pending, then claim and print it."""
	since = now_iso()
	deadline = time.time() + timeout_minutes * 60 if timeout_minutes > 0 else None
	try:
		while True:
			try:
				write_json(LISTENER, {"pid": os.getpid(), "since": since, "beat": time.time()})
			except OSError:
				pass  # a heartbeat file locked for longer only skips this beat; the listener keeps running
			waiting = [r for r in all_requests() if r.get("status") == "pending"]
			for data in waiting:
				if claim(data["id"]):
					print(format_request(get_request(data["id"])))
					others = len(waiting) - 1
					if others > 0:
						print(f"\n({others} more request(s) are waiting after this one.)")
					return 0
			if deadline is not None and time.time() > deadline:
				print("No studio request arrived before the timeout.")
				return 3
			time.sleep(HEARTBEAT_SECONDS)
	finally:
		data = read_json(LISTENER)
		if data and data.get("pid") == os.getpid():
			try:
				LISTENER.unlink()
			except OSError:
				pass


def main(argv: Optional[List[str]] = None) -> int:
	parser = argparse.ArgumentParser(description="HOI4 Türkçe Mod Toolu <-> Claude Code bridge")
	sub = parser.add_subparsers(dest="command", required=True)
	waiting = sub.add_parser("wait", help="listen until a request arrives, then print and claim it")
	waiting.add_argument("--timeout-min", type=float, default=0, help="give up after this many minutes (0 = never)")
	sub.add_parser("list", help="show the request queue")
	show = sub.add_parser("show", help="print one request")
	show.add_argument("id")
	answer = sub.add_parser("reply", help="answer a request")
	answer.add_argument("id")
	answer.add_argument("--status", default="done", choices=REPLY_STATUSES)
	answer.add_argument("--message", default="")
	answer.add_argument("--message-file", help="read the message from a UTF-8 file instead")
	answer.add_argument("--files", nargs="*", default=[])
	answer.add_argument("--items", nargs="*", default=[])
	args = parser.parse_args(argv)
	try:
		sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
	except (AttributeError, ValueError):
		pass
	if args.command == "wait":
		return wait(args.timeout_min)
	if args.command == "list":
		for data in all_requests():
			print(f"{data['id']}  {data.get('status', '?'):10}  {data.get('kind', ''):8}  {data.get('file', '')}  {data.get('text', '')[:60]!r}")
		state = listener_state()
		print(f"listener: {'listening since ' + str(state['since']) if state['alive'] else 'not listening'}")
		return 0
	if args.command == "show":
		print(format_request(get_request(args.id)))
		return 0
	message = Path(args.message_file).read_text(encoding="utf-8") if args.message_file else args.message
	data = reply(args.id, args.status, message, args.files, args.items)
	print(f"{data['id']} -> {data['status']}")
	return 0


if __name__ == "__main__":
	sys.exit(main())
