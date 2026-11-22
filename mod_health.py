"""Mod Health module of the HOI4 Türkçe Mod Toolu (page: web/health.html).

Runs the repository checks (`.tools/check.py quick --paths ...` or `full`) in a background thread,
reads their JSON report, and links every finding to the studio page and element it belongs to
(the focus, event, decision, category or idea whose block holds the finding's line).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

import core

CHECK = core.TOOLS / "check.py"
REPORT = core.WORK_DIR / "health_report.json"
TIMEOUT_SECONDS = 1800
SUMMARY_LINE = re.compile(r"^([a-z\-]+: \d+ error|[a-z\-]+: skipped|quality: skipped)")


class Health:
	def __init__(self, ctx: core.Context, modules: Dict[str, object]) -> None:
		self.ctx = ctx
		self.modules = modules
		self.lock = threading.Lock()
		self.recent: List[str] = []
		self.state: Dict[str, object] = {"running": False, "mode": None, "paths": [], "started": None, "finished": None,
			"exit": None, "findings": [], "summary": "", "error": None}

	def remember(self, files: List[str]) -> None:
		"""Files saved through the studio, offered for a quick check."""
		for rel in files:
			if rel in self.recent:
				self.recent.remove(rel)
			self.recent.insert(0, rel)
		del self.recent[30:]

	def status(self) -> dict:
		with self.lock:
			return {**self.state, "recent": list(self.recent)}

	def start(self, mode: str, paths: List[str]) -> dict:
		if mode not in ("quick", "full"):
			raise ValueError("mode must be quick or full")
		if mode == "quick":
			paths = [core.check_rel(p) for p in paths]
			if not paths:
				raise ValueError("choose at least one file for a quick check")
		with self.lock:
			if self.state["running"]:
				raise ValueError("a check is already running")
			self.state.update({"running": True, "mode": mode, "paths": paths, "started": time.strftime("%H:%M:%S"),
				"finished": None, "exit": None, "findings": [], "summary": "", "error": None})
		threading.Thread(target=self.run, args=(mode, paths), daemon=True).start()
		return self.status()

	def run(self, mode: str, paths: List[str]) -> None:
		command = [sys.executable, "-B", str(CHECK), mode, "--json", str(REPORT)]
		if mode == "quick":
			command += ["--paths", *paths]
		REPORT.parent.mkdir(parents=True, exist_ok=True)
		if REPORT.exists():
			REPORT.unlink()
		error: Optional[str] = None
		output = ""
		code: Optional[int] = None
		try:
			done = subprocess.run(command, cwd=core.ROOT, capture_output=True, text=True, encoding="utf-8",
				errors="replace", timeout=TIMEOUT_SECONDS)
			code, output = done.returncode, (done.stdout or "") + (done.stderr or "")
		except subprocess.TimeoutExpired:
			error = "the check took longer than 30 minutes and was stopped"
		findings = self.read_report() if REPORT.exists() else []
		summary = "\n".join(line for line in output.splitlines() if SUMMARY_LINE.match(line))
		with self.lock:
			self.state.update({"running": False, "finished": time.strftime("%H:%M:%S"), "exit": code,
				"findings": findings, "summary": summary, "error": error})

	def read_report(self) -> List[dict]:
		try:
			data = json.loads(REPORT.read_text(encoding="utf-8"))
		except (OSError, ValueError):
			return []
		found = []
		for finding in data.get("findings", []):
			path = str(finding.get("path", "")).replace("\\", "/")
			line = int(finding.get("line") or 0)
			row = {"check": finding.get("check"), "level": finding.get("level"), "rule": finding.get("rule"),
				"path": path, "line": line, "message": finding.get("message")}
			row.update(self.link(path, line))
			found.append(row)
		order = {"error": 0, "warning": 1, "review": 2}
		found.sort(key=lambda f: (order.get(str(f["level"]), 3), f["path"], f["line"]))
		return found

	def link(self, rel: str, line: int) -> dict:
		"""The page and element a finding belongs to, when a module owns its file."""
		routes = (
			("common/national_focus/", "focus"), ("events/", "event"), ("common/decisions/categories/", "category"),
			("common/decisions/", "decision"), ("common/ideas/", "idea"), ("common/characters/", "character"),
		)
		if rel.startswith("history/countries/") and rel.count("/") == 2:
			tag = rel.split("/")[-1][:3]
			return {"url": f"/countries.html?tag={tag}", "element": tag}
		for prefix, kind in routes:
			if rel.startswith(prefix) and rel.count("/") == prefix.count("/"):
				module = self.modules.get(kind)
				element = module.locate(rel, line) if module and line else None  # type: ignore[attr-defined]
				if kind == "focus":
					url = f"/focus.html?file={rel}" + (f"&focus={element}" if element else "")
				elif kind == "category":
					url = f"/decisions.html?catfile={rel}" + (f"&cat={element}" if element else "")
				else:
					page = {"event": "events.html", "decision": "decisions.html", "idea": "ideas.html", "character": "characters.html"}[kind]
					url = f"/{page}?file={rel}" + (f"&id={element}" if element else "")
				return {"url": url, "element": element}
		return {"url": None, "element": None}


def report_path() -> Path:
	return REPORT
