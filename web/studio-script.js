/* HOI4 Türkçe Mod Toolu: the visual script builder and its pickers.
 *
 * - Script: a small reader and writer for Clausewitz script text (the same tokens as
 *   lib/clausewitz.py). parse() keeps comments, blank lines and whether a block was written on one
 *   line, so stringify() gives back the same statements in the file's own style.
 * - Catalog: the lists of mod_catalog.py (countries, states, spirits, events, ...), loaded once per page.
 * - Picker: a searchable window to choose one catalog entry instead of typing its id.
 * - Palette: the window that lists every effect or trigger that can be added, in Turkish.
 * - ScriptBuilder: draws a block of effects or triggers as cards with form fields (studio-schema.js
 *   says how each statement looks), and writes the text back after every change. A statement the
 *   schema does not know stays editable as a key/value row or a small code box, and the whole block
 *   can always be switched to code. A block the reader cannot give back token for token is shown as
 *   code only, so the builder never rewrites what it did not understand.
 * - modTable, picks: the modifier table and the chip list the pages share.
 */
"use strict";

/* ===================================================================== */
/* Script: read and write script text                                    */
/* ===================================================================== */
const Script = (() => {
	const TOKEN = /"(?:[^"\\\n]|\\.)*"|#[^\n]*|[{}]|<=|>=|!=|[=<>]|[^\s{}=<>"#]+|\n/g;
	const OPS = new Set(["=", "<", ">", "<=", ">=", "!="]);
	const MAX_LINE = 120;
	const AUTO_INLINE_ITEMS = 4;
	const isBlock = (n) => Array.isArray(n.children);
	const isComment = (n) => n.comment !== undefined;
	const isBare = (n) => !isBlock(n) && !isComment(n) && n.key == null;
	const isPair = (n) => !isBlock(n) && !isComment(n) && n.key != null;
	const tokens = (text) => String(text ?? "").replace(/\r\n?/g, "\n").match(TOKEN) || [];
	const unq = (v) => { v = String(v ?? ""); return v.length > 1 && v[0] === '"' && v[v.length - 1] === '"' ? v.slice(1, -1) : v; };
	const quote = (v, force = false) => {
		v = String(v ?? "");
		return force || v === "" || /[\s{}=<>#"]/.test(v) ? `"${v.replace(/\\?"/g, (m) => (m.length === 2 ? m : '\\"'))}"` : v;
	};

	/* Nodes: { key, op, value } a pair, { key, op, children, inline, head } a block (key null when it
	 * has no name), { value } a bare word, { comment } a full-line comment. Any node may carry `tail`
	 * (a comment after it on the same line) and `gap` (a blank line before it). */
	function read(text) {
		const toks = tokens(text);
		let i = 0, broken = false;
		const skip = (from) => { let j = from; while (toks[j] === "\n") j++; return j; };
		function block(top) {
			const nodes = [];
			let newlines = 0, last = null, head, inline = true, atOpen = !top;
			while (i < toks.length) {
				const t = toks[i];
				if (t === "\n") { i++; newlines++; last = null; inline = false; atOpen = false; continue; }
				if (t[0] === "#") {
					i++;
					if (atOpen) head = t;
					else if (last) last.tail = t;
					else { nodes.push({ comment: t, ...(newlines > 1 && nodes.length ? { gap: true } : {}) }); newlines = 0; }
					continue;
				}
				atOpen = false;
				if (t === "}") {
					i++;
					if (top) { broken = true; continue; }
					return { nodes, head, inline };
				}
				let node;
				const gap = newlines > 1 && nodes.length > 0;
				if (t === "{") {
					i++;
					const b = block(false);
					node = { key: null, op: null, children: b.nodes, inline: b.inline, head: b.head };
				} else {
					const j = skip(i + 1), k = skip(j + 1);
					if (OPS.has(toks[j]) && !OPS.has(t) && k < toks.length && toks[k] !== "}" && toks[k][0] !== "#" && !OPS.has(toks[k])) {
						if (toks[k] === "{") {
							i = k + 1;
							const b = block(false);
							node = { key: t, op: toks[j], children: b.nodes, inline: b.inline, head: b.head };
						} else { node = { key: t, op: toks[j], value: toks[k] }; i = k + 1; }
					} else { node = { value: t }; i++; }
				}
				if (gap) node.gap = true;
				nodes.push(node); newlines = 0; last = node;
			}
			if (!top) broken = true;  /* the text ended inside a block */
			return { nodes, head, inline };
		}
		const result = block(true);
		return { nodes: result.nodes, broken };
	}
	const parse = (text) => read(text).nodes;

	const autoInline = (n) => n.children.length <= AUTO_INLINE_ITEMS && n.children.every((c) => !isBlock(c) && !isComment(c) && !c.tail);
	function inlineText(n, top) {
		if (isComment(n) || (!top && n.tail)) return null;
		if (isBare(n)) return n.value;
		if (isPair(n)) return `${n.key} ${n.op} ${n.value}`;
		if (n.head || n.inline === false || (n.inline === undefined && !autoInline(n))) return null;
		const parts = [];
		for (const c of n.children) {
			const s = inlineText(c, false);
			if (s === null) return null;
			parts.push(s);
		}
		const body = parts.length ? `{ ${parts.join(" ")} }` : "{ }";
		return n.key != null ? `${n.key} ${n.op} ${body}` : body;
	}
	function write(nodes, indent, out) {
		nodes.forEach((n, index) => {
			if (n.gap && index > 0) out.push("");
			if (isComment(n)) { out.push(indent + n.comment); return; }
			const tail = n.tail ? " " + n.tail : "";
			const one = inlineText(n, true);
			if (one !== null && (!isBlock(n) || indent.length * 4 + one.length <= MAX_LINE)) { out.push(indent + one + tail); return; }
			out.push(indent + (n.key != null ? `${n.key} ${n.op} {` : "{") + (n.head ? " " + n.head : ""));
			write(n.children, indent + "\t", out);
			out.push(indent + "}" + tail);
		});
	}
	function stringify(nodes, indent = "") { const out = []; write(nodes, indent, out); return out.join("\n"); }

	const signature = (text) => tokens(text).filter((t) => t !== "\n").join("\u0001");
	const sameTokens = (a, b) => signature(a) === signature(b);
	function balanced(text) {
		let depth = 0;
		for (const t of tokens(text)) {
			if (t === "{") depth++;
			else if (t === "}" && --depth < 0) return false;
		}
		return depth === 0;
	}
	/* true when the text can be read and written back token for token */
	function safe(text) {
		const { nodes, broken } = read(text);
		return !broken && sameTokens(text, stringify(nodes));
	}

	const pair = (key, value, op = "=") => ({ key, op, value });
	const blockNode = (key, children = [], inline) => ({ key, op: "=", children, ...(inline === undefined ? {} : { inline }) });
	const word = (value) => ({ value });
	const find = (nodes, key) => nodes.find((n) => !isComment(n) && n.key === key) || null;
	const all = (nodes, key) => nodes.filter((n) => !isComment(n) && n.key === key);
	const val = (nodes, key) => { const n = find(nodes, key); return n && isPair(n) ? unq(n.value) : ""; };
	const words = (node) => (node && isBlock(node) ? node.children.filter(isBare).map((c) => unq(c.value)) : []);
	const clone = (node) => JSON.parse(JSON.stringify(node));
	/* set `key = value` among nodes (appended when missing, removed when value is null or "") */
	function set(nodes, key, value) {
		const index = nodes.findIndex((n) => !isComment(n) && n.key === key);
		if (value === null || value === "") { if (index >= 0) nodes.splice(index, 1); return; }
		if (index >= 0 && isPair(nodes[index])) nodes[index].value = value;
		else if (index >= 0) nodes[index] = pair(key, value);
		else nodes.push(pair(key, value));
	}
	/* replace the words of `key = { a b c }` (created when missing, removed when the list is empty and `keep` is false) */
	function setWords(nodes, key, list, keep = true) {
		const index = nodes.findIndex((n) => !isComment(n) && n.key === key && isBlock(n));
		if (!list.length && !keep) { if (index >= 0) nodes.splice(index, 1); return; }
		const children = list.map((v) => word(quote(v)));
		if (index >= 0) nodes[index].children = [...nodes[index].children.filter((c) => !isBare(c)), ...children];
		else nodes.push(blockNode(key, children, list.length <= AUTO_INLINE_ITEMS ? undefined : false));
	}

	return { parse, read, stringify, tokens, sameTokens, balanced, safe, unq, quote, isBlock, isComment, isBare, isPair,
		pair, blockNode, word, find, all, val, words, clone, set, setWords, OPS: [...OPS] };
})();

if (typeof module !== "undefined") module.exports = { Script };

/* everything below needs a browser page with studio.js loaded */
const StudioScript = typeof document === "undefined" ? null : (() => {
	const esc = Studio.esc;
	const fold = (s) => String(s ?? "").toLowerCase().replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c").replace(/i̇/g, "i");
	function h(tag, props, ...kids) {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (v === false || v == null) continue;
			if (k === "class") el.className = v;
			else if (k === "html") el.innerHTML = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (k === "value") el.value = v;
			else el.setAttribute(k, v === true ? "" : v);
		}
		for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
		return el;
	}

	/* ===================================================================== */
	/* Catalog                                                                */
	/* ===================================================================== */
	const Catalog = (() => {
		const pending = new Map(), ready = new Map();
		function load(type) {
			if (!pending.has(type)) {
				pending.set(type, Studio.api("/api/catalog?type=" + encodeURIComponent(type)).then(({ items }) => {
					const byId = new Map();
					for (const r of items) {
						r._s = fold(`${r.id} ${r.name || ""} ${r.group || ""}`);
						if (!byId.has(r.id)) byId.set(r.id, r);
					}
					ready.set(type, { rows: items, byId });
					return items;
				}).catch((e) => { pending.delete(type); throw e; }));
			}
			return pending.get(type);
		}
		const row = (type, id) => { const c = ready.get(type); return (c && c.byId.get(id)) || null; };
		const drop = (type) => { pending.delete(type); ready.delete(type); };
		return { load, row, drop };
	})();

	const TYPE_LABELS = {
		country: "Ülke", state: "Eyalet", idea: "Milli ruh", tech: "Teknoloji", tech_category: "Araştırma kategorisi", focus: "Odak", event: "Olay",
		decision: "Karar", decision_category: "Karar kategorisi", character: "Karakter", leader_trait: "Lider / danışman özelliği", unit_trait: "Komutan özelliği",
		ideology: "İdeoloji", sub_ideology: "Alt ideoloji", modifier: "Modifier", equipment: "Teçhizat", sub_unit: "Birlik türü", building: "Bina", resource: "Kaynak",
		opinion_modifier: "İlişki değiştirici", dynamic_modifier: "Dinamik modifier", scripted_effect: "Hazır etki", scripted_trigger: "Hazır koşul", wargoal: "Savaş hedefi",
		state_category: "Eyalet türü", autonomy: "Özerklik düzeyi", oob: "Birlik dosyası (OOB)", focus_filter: "Odak filtresi", country_flag: "Ülke işareti",
		global_flag: "Dünya işareti", state_flag: "Eyalet işareti",
	};
	/* choices that are not in a list: the script's own way of saying "this country" */
	const EXTRAS = {
		country: [{ id: "ROOT", name: "Bu ülke (ROOT)", sub: "odağı, kararı ya da olayı alan ülke" }, { id: "FROM", name: "Gönderen (FROM)", sub: "olayı gönderen ya da hedef alan ülke" },
			{ id: "PREV", name: "Bir önceki kapsam (PREV)" }, { id: "THIS", name: "Şu anki kapsam (THIS)" }],
	};
	/* lists where a new name is normal (a flag is created by using it) */
	const FREE_TYPES = new Set(["country_flag", "global_flag", "state_flag"]);
	const PICK_LIMIT = 250;

	/* ===================================================================== */
	/* Picker: choose one catalog entry                                       */
	/* ===================================================================== */
	const Picker = (() => {
		let modal = null, done = null, S = null;
		function build() {
			modal = h("div", { class: "modal", id: "pickModal" }, h("div", { class: "box pick-box" },
				h("div", { class: "top" }, h("b", { class: "pk-title" }), h("input", { class: "pk-q", placeholder: "Ara: isim ya da id…", autocomplete: "off", spellcheck: "false" }),
					h("select", { class: "pk-group fixed" }), h("button", { class: "pk-reload fixed", title: "Listeyi yeniden yükle" }, "↻"), h("button", { class: "pk-close fixed" }, "Kapat")),
				h("div", { class: "pk-list" }),
				h("div", { class: "pk-foot" }, h("span", { class: "small pk-count" }), h("span", { class: "spacer" }),
					h("span", { class: "small pk-customLabel" }, "Listede yoksa elle yaz:"), h("input", { class: "pk-custom", spellcheck: "false" }), h("button", { class: "pk-use fixed" }, "Kullan"))));
			document.body.append(modal);
			const q = modal.querySelector(".pk-q");
			q.addEventListener("input", () => { S.hl = 0; draw(); });
			modal.querySelector(".pk-group").addEventListener("change", () => { S.hl = 0; draw(); });
			modal.querySelector(".pk-close").onclick = () => close(null);
			modal.querySelector(".pk-reload").onclick = () => { Catalog.drop(S.type); fill(); };
			modal.querySelector(".pk-use").onclick = useCustom;
			modal.querySelector(".pk-custom").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); useCustom(); } });
			modal.querySelector(".pk-list").addEventListener("click", (ev) => {
				const link = ev.target.closest("a"); if (link) return;
				const rowEl = ev.target.closest(".pk-row"); if (rowEl) close(rowEl.dataset.id);
			});
			modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) close(null); });
			document.addEventListener("keydown", (ev) => {
				if (!modal || modal.style.display !== "flex") return;
				if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); close(null); return; }
				if (ev.target.classList && ev.target.classList.contains("pk-custom")) return;
				if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
					ev.preventDefault();
					S.hl = Math.max(0, Math.min(S.shown.length - 1, S.hl + (ev.key === "ArrowDown" ? 1 : -1)));
					mark();
				} else if (ev.key === "Enter") {
					ev.preventDefault(); ev.stopImmediatePropagation();
					if (S.shown[S.hl]) close(S.shown[S.hl].id);
				}
			}, true);
		}
		function useCustom() {
			const v = modal.querySelector(".pk-custom").value.trim();
			if (!/^[A-Za-z0-9_.@:\-]+$/.test(v)) { Studio.toast("Geçerli bir kimlik yaz: harf, rakam, _ ve . (boşluk olmaz).", true); return; }
			close(v);
		}
		function close(value) {
			modal.style.display = "none";
			const fn = done; done = null;
			if (fn) fn(value);
		}
		function mark() {
			const list = modal.querySelector(".pk-list");
			list.querySelectorAll(".pk-row").forEach((el, i) => el.classList.toggle("hl", i === S.hl));
			const el = list.querySelectorAll(".pk-row")[S.hl]; if (el) el.scrollIntoView({ block: "nearest" });
		}
		function draw() {
			const q = fold(modal.querySelector(".pk-q").value.trim()), wordsQ = q.split(/\s+/).filter(Boolean);
			const group = modal.querySelector(".pk-group").value;
			const prefer = S.prefer || "";
			let rows = S.rows.filter((r) => (!group || (r.group || "") === group) && wordsQ.every((w) => r._s.includes(w)));
			const rank = (r) => (q && r.id.toLowerCase() === q ? 0 : r.id === S.value ? 1 : r.extra ? 2 : prefer && r.id.startsWith(prefer) ? 3 : r.mod ? 4 : 5);
			rows = rows.map((r, i) => [rank(r), i, r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
			S.shown = rows.slice(0, PICK_LIMIT);
			const list = modal.querySelector(".pk-list");
			list.innerHTML = S.shown.map((r) => `<div class="pk-row${r.id === S.value ? " cur" : ""}" data-id="${esc(r.id)}">
				${r.icon ? `<img loading="lazy" src="${Studio.imageUrl(r.icon)}" onerror="this.style.visibility='hidden'">` : ""}
				<div class="pk-t"><div class="pk-n">${esc(r.name || r.id)}</div><div class="pk-i">${esc(r.id)}${r.sub ? " · " + esc(String(r.sub).slice(0, 90)) : ""}${r.group && !group ? " · " + esc(r.group) : ""}</div></div>
				${r.mod ? `<span class="badge">mod</span>` : ""}${r.url ? `<a href="${esc(r.url)}" target="_blank" title="Kendi editöründe aç (yeni sekme)">↗</a>` : ""}</div>`).join("")
				|| `<div class="small" style="padding:14px">Sonuç yok.${S.custom ? " Aşağıya elle yazabilirsin." : ""}</div>`;
			modal.querySelector(".pk-count").textContent = rows.length > PICK_LIMIT ? `${rows.length} sonuçtan ilk ${PICK_LIMIT} gösteriliyor; aramayı daralt.` : `${rows.length} sonuç`;
			S.hl = Math.min(S.hl, Math.max(0, S.shown.length - 1));
			mark();
		}
		async function fill() {
			const list = modal.querySelector(".pk-list");
			list.innerHTML = `<div class="small" style="padding:14px">Liste yükleniyor…</div>`;
			let rows = [];
			try { rows = await Catalog.load(S.type); }
			catch (e) { list.innerHTML = `<div class="warn" style="padding:14px">Liste yüklenemedi: ${esc(e.message)}</div>`; return; }
			if (!S || modal.style.display !== "flex") return;
			const extras = (S.extras || []).map((r) => ({ ...r, extra: true, _s: fold(`${r.id} ${r.name || ""}`) }));
			S.rows = [...extras, ...rows];
			const groups = [...new Set(rows.map((r) => r.group || "").filter(Boolean))].sort();
			const sel = modal.querySelector(".pk-group");
			sel.innerHTML = `<option value="">Tüm gruplar</option>` + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
			sel.style.display = groups.length > 1 && groups.length < 400 ? "" : "none";
			draw();
		}
		/* open({ type, title, value, prefer, extras, custom }) resolves to the chosen id, or null */
		function open(opts) {
			if (!modal) build();
			if (done) close(null);
			S = { type: opts.type, value: opts.value || "", prefer: opts.prefer || "", extras: opts.extras || EXTRAS[opts.type], rows: [], shown: [], hl: 0,
				custom: opts.custom !== false };
			modal.querySelector(".pk-title").textContent = opts.title || (TYPE_LABELS[opts.type] || opts.type) + " seç";
			const q = modal.querySelector(".pk-q");
			q.value = "";
			const custom = modal.querySelector(".pk-custom");
			custom.value = S.value && FREE_TYPES.has(S.type) ? S.value : "";
			for (const el of modal.querySelectorAll(".pk-custom, .pk-use, .pk-customLabel")) el.style.display = S.custom ? "" : "none";
			modal.querySelector(".pk-customLabel").textContent = FREE_TYPES.has(S.type) ? "Yeni bir ad yaz:" : "Listede yoksa elle yaz:";
			modal.style.display = "flex";
			q.focus();
			fill();
			return new Promise((resolve) => (done = resolve));
		}
		return { open };
	})();

	/* a button that shows a catalog entry by name and opens the picker; `set(id)` is called after a choice */
	function pickButton(def, value, set, ctx = {}) {
		let current = value || "";
		const btn = h("button", { type: "button", class: "sb-pick" });
		const link = h("a", { class: "sb-open", target: "_blank", title: "Kendi editöründe aç (yeni sekme)" }, "↗");
		const wrap = h("span", { class: "sb-pickWrap" }, btn, link);
		const paint = () => {
			const r = current ? Catalog.row(def.of, current) : null;
			const extra = (EXTRAS[def.of] || []).find((x) => x.id === current);
			const name = r && r.name ? r.name : extra ? extra.name : "";
			btn.className = "sb-pick" + (current ? "" : " empty");
			btn.innerHTML = current ? `${r && r.icon ? `<img src="${Studio.imageUrl(r.icon)}" onerror="this.style.display='none'">` : ""}<span class="n">${esc(name || current)}</span>${name && name !== current ? `<span class="i">${esc(current)}</span>` : ""}`
				: `<span class="n">${esc((TYPE_LABELS[def.of] || "").toLowerCase() || "değer")} seç…</span>`;
			btn.title = current ? `${current}${name ? " · " + name : ""} — değiştirmek için tıkla` : "Seçmek için tıkla";
			link.style.display = r && r.url ? "" : "none";
			if (r && r.url) link.href = r.url;
		};
		paint();
		Catalog.load(def.of).then(paint).catch(() => {});
		btn.onclick = async () => {
			const picked = await Picker.open({ type: def.of, value: current, prefer: ctx.prefer });
			if (picked == null) return;
			current = picked; paint(); set(picked);
		};
		return wrap;
	}

	/* ===================================================================== */
	/* Documentation of the installed game: scopes and descriptions           */
	/* ===================================================================== */
	const DOCS = { effect: new Map(), trigger: new Map(), ready: null };
	const SCOPE_NAMES = { country: "COUNTRY", state: "STATE", character: "CHARACTER" };
	const SCOPE_TR = { COUNTRY: "ülke", STATE: "eyalet", CHARACTER: "karakter", any: "her yer", INDUSTRIAL_ORG: "askeri sanayi kuruluşu", OPERATION: "operasyon",
		SPECIAL_PROJECT: "özel proje", STRATEGIC_REGION: "stratejik bölge", RAID_INSTANCE: "baskın", PURCHASE_CONTRACT: "satın alma sözleşmesi", UNIT_LEADER: "komutan", COMBATANT: "muharip", DIVISION: "tümen", ACE: "as pilot" };
	function loadDocs() {
		if (!DOCS.ready) {
			DOCS.ready = Promise.all([Catalog.load("effect_doc"), Catalog.load("trigger_doc")]).then(([effects, triggers]) => {
				for (const r of effects) DOCS.effect.set(r.id, r);
				for (const r of triggers) DOCS.trigger.set(r.id, r);
			}).catch(() => { DOCS.ready = null; });
		}
		return DOCS.ready;
	}
	/* the scopes a statement supports, or null when unknown or unrestricted */
	function scopesOf(mode, key) {
		const row = DOCS[mode].get(key);
		return row && row.scopes.length && !row.scopes.includes("any") ? row.scopes : null;
	}
	function scopeProblem(mode, key, scope) {
		const scopes = scope && SCOPE_NAMES[scope] ? scopesOf(mode, key) : null;
		if (!scopes || scopes.includes(SCOPE_NAMES[scope])) return "";
		return `Bu ${mode === "effect" ? "etki" : "koşul"} ${scopes.map((s) => SCOPE_TR[s] || s).join(" / ")} kapsamında çalışır; burası ${SCOPE_TR[SCOPE_NAMES[scope]]} kapsamı.`;
	}

	/* ===================================================================== */
	/* Palette: choose what to add                                            */
	/* ===================================================================== */
	const Palette = (() => {
		let modal = null, done = null, S = null;
		const RECENT_KEY = (mode) => `studio.palette.recent.${mode}`;
		const RECENT_MAX = 8;
		function recent(mode) { try { return JSON.parse(localStorage.getItem(RECENT_KEY(mode)) || "[]"); } catch (e) { return []; } }
		function remember(mode, id) {
			try { localStorage.setItem(RECENT_KEY(mode), JSON.stringify([id, ...recent(mode).filter((x) => x !== id)].slice(0, RECENT_MAX))); } catch (e) { /* private mode */ }
		}
		function build() {
			modal = h("div", { class: "modal", id: "palModal" }, h("div", { class: "box pal-box" },
				h("div", { class: "top" }, h("b", { class: "pal-title" }), h("input", { class: "pal-q", placeholder: "Ne eklemek istiyorsun? Örn: fabrika, ruh, savaş, olay…", autocomplete: "off", spellcheck: "false" }),
					h("button", { class: "pal-close fixed" }, "Kapat")),
				h("div", { class: "pal-main" }, h("div", { class: "pal-cats" }), h("div", { class: "pal-list" })),
				h("div", { class: "pk-foot small" }, "Yazmaya başla, ↑ ↓ ile gez, Enter ile ekle. Listede olmayan her şey sonradan \"Kod\" görünümünde yazılabilir.")));
			document.body.append(modal);
			modal.querySelector(".pal-q").addEventListener("input", () => { S.hl = 0; draw(); });
			modal.querySelector(".pal-close").onclick = () => close(null);
			modal.querySelector(".pal-cats").addEventListener("click", (ev) => {
				const b = ev.target.closest("[data-c]"); if (!b) return;
				S.cat = b.dataset.c; S.hl = 0; draw(); modal.querySelector(".pal-q").focus();
			});
			modal.querySelector(".pal-list").addEventListener("click", (ev) => {
				const rowEl = ev.target.closest(".pal-row"); if (rowEl) choose(S.shown[+rowEl.dataset.i]);
			});
			modal.addEventListener("mousedown", (ev) => { if (ev.target === modal) close(null); });
			document.addEventListener("keydown", (ev) => {
				if (!modal || modal.style.display !== "flex") return;
				if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); close(null); }
				else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
					ev.preventDefault();
					S.hl = Math.max(0, Math.min(S.shown.length - 1, S.hl + (ev.key === "ArrowDown" ? 1 : -1)));
					mark();
				} else if (ev.key === "Enter") { ev.preventDefault(); ev.stopImmediatePropagation(); if (S.shown[S.hl]) choose(S.shown[S.hl]); }
			}, true);
		}
		function close(value) {
			modal.style.display = "none";
			const fn = done; done = null;
			if (fn) fn(value);
		}
		function choose(item) {
			remember(S.mode, item.id);
			close(item.entry ? { entry: item.entry } : { key: item.id });
		}
		function mark() {
			const rows = modal.querySelectorAll(".pal-row");
			rows.forEach((el, i) => el.classList.toggle("hl", i === S.hl));
			if (rows[S.hl]) rows[S.hl].scrollIntoView({ block: "nearest" });
		}
		function items() {
			const mode = S.mode, schema = mode === "effect" ? ScriptSchema.EFFECTS : ScriptSchema.TRIGGERS;
			const out = [];
			for (const e of S.extra || []) if (!e.hidden) out.push({ id: e.k, entry: e, label: e.l, cat: "part", help: e.h || "" });
			for (const e of schema) {
				if (!!e.ai !== S.ai) continue;  /* base, factor, add and modifier only exist in an AI weight block */
				out.push({ id: e.k || e.id, entry: e, label: e.l, cat: e.c, help: e.h || "", key: e.k || "" });
			}
			if (S.ai) return out;
			const known = new Set(schema.filter((e) => e.k).map((e) => e.k));
			for (const r of S.scripted) out.push({ id: r.id, label: r.id, cat: "scripted", help: r.mod ? "modun hazır komutu" : "oyunun hazır komutu", key: r.id, mod: r.mod });
			for (const r of DOCS[mode].values()) if (!known.has(r.id)) out.push({ id: r.id, label: r.id, cat: "doc", help: r.sub.split("\n")[0].slice(0, 160), key: r.id });
			return out;
		}
		function draw() {
			const mode = S.mode;
			const all = items();
			const cats = [["", "Tümü"], ...(S.extra && S.extra.some((e) => !e.hidden) ? [["part", "Bu bloğa özel"]] : []), ...ScriptSchema.CATEGORIES[mode].filter(([c]) => (c === "ai") === S.ai),
				...(S.ai ? [] : [["scripted", "Hazır komutlar (scripted)"], ["doc", "Oyunun diğer komutları"]])];
			modal.querySelector(".pal-cats").innerHTML = cats.map(([c, l]) => `<button data-c="${c}" class="${c === S.cat ? "on" : ""}">${esc(l)}<span>${all.filter((x) => !c || x.cat === c).length}</span></button>`).join("");
			const q = fold(modal.querySelector(".pal-q").value.trim()), wordsQ = q.split(/\s+/).filter(Boolean);
			let rows = all.filter((x) => (!S.cat || x.cat === S.cat) && wordsQ.every((w) => fold(`${x.label} ${x.key || ""} ${x.help}`).includes(w)));
			if (!q && !S.cat) {
				const order = recent(mode);
				const first = order.map((id) => rows.find((x) => x.id === id)).filter(Boolean).map((x) => ({ ...x, recent: true }));
				rows = [...first, ...rows.filter((x) => x.cat !== "scripted" && x.cat !== "doc")];
			} else if (q) {
				/* an exact or starting match of the key or label first, the schema before the raw lists */
				const score = (x) => (fold(x.label).startsWith(q) || (x.key || "").startsWith(q) ? 0 : 1) + (x.entry ? 0 : 2) + (S.prefer && x.id.startsWith(S.prefer) ? -1 : 0);
				rows = rows.map((x, i) => [score(x), i, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((r) => r[2]);
			}
			S.shown = rows.slice(0, PICK_LIMIT);
			modal.querySelector(".pal-list").innerHTML = S.shown.map((x, i) => {
				const problem = x.key ? scopeProblem(mode, x.key, S.scope) : "";
				const scopes = x.key ? scopesOf(mode, x.key) : null;
				return `<div class="pal-row${problem ? " off" : ""}" data-i="${i}">
					<div class="pal-l">${esc(x.label)}${x.recent ? ` <span class="badge">son kullanılan</span>` : ""}${x.mod ? ` <span class="badge">mod</span>` : ""}</div>
					<div class="pal-k">${x.entry && x.key ? `<code>${esc(x.key)}</code>` : ""}${scopes ? ` <span class="pal-s">${esc(scopes.map((s) => SCOPE_TR[s] || s).join(" / "))}</span>` : ""}</div>
					${x.help ? `<div class="pal-h">${esc(x.help)}</div>` : ""}${problem ? `<div class="pal-h warn">${esc(problem)}${scopes && scopes.includes("STATE") && S.scope === "country" ? " Seçince hangi eyalette çalışacağı sorulur." : ""}</div>` : ""}</div>`;
			}).join("") || `<div class="small" style="padding:14px">Sonuç yok. Aradığın şey listede yoksa bloğu "Kod" görünümüne alıp elle yazabilirsin.</div>`;
			S.hl = Math.min(S.hl, Math.max(0, S.shown.length - 1));
			mark();
		}
		/* open({ mode, scope, ai, prefer, extra }) resolves to { entry } or { key } or null */
		function open(opts) {
			if (!modal) build();
			if (done) close(null);
			S = { mode: opts.mode, scope: opts.scope || null, ai: !!opts.ai, prefer: opts.prefer || "", extra: opts.extra || null, cat: "", hl: 0, shown: [], scripted: [] };
			modal.querySelector(".pal-title").textContent = S.ai ? "Ağırlık ekle" : S.mode === "effect" ? "Etki ekle" : "Koşul ekle";
			const q = modal.querySelector(".pal-q");
			q.value = "";
			modal.style.display = "flex";
			q.focus();
			draw();
			const type = S.mode === "effect" ? "scripted_effect" : "scripted_trigger", mine = S;
			Promise.all([Catalog.load(type), loadDocs()]).then(([rows]) => {
				if (S !== mine || modal.style.display !== "flex") return;
				S.scripted = [...rows].sort((a, b) => (S.prefer && b.id.startsWith(S.prefer) ? 1 : 0) - (S.prefer && a.id.startsWith(S.prefer) ? 1 : 0) || (b.mod ? 1 : 0) - (a.mod ? 1 : 0));
				draw();
			}).catch(() => {});
			return new Promise((resolve) => (done = resolve));
		}
		return { open };
	})();

	/* ===================================================================== */
	/* ScriptBuilder                                                          */
	/* ===================================================================== */
	const NUMBER = /^-?\d+(\.\d+)?$/;
	const KEY_CHARS = /[^A-Za-z0-9_.@:\-^?\[\]]/g;
	const STATE_WRAPS = [
		["@state", "Belirli bir eyalette", "Listeden bir eyalet seçersin."],
		["capital_scope", "Başkentte", "Ülkenin başkent eyaletinde."],
		["random_owned_controlled_state", "Rastgele bir eyalette", "Sahip olunan ve kontrol edilen eyaletlerden biri; koşulla daraltılabilir."],
		["every_owned_state", "Her eyalette", "Sahip olunan bütün eyaletlerde; koşulla daraltılabilir."],
		["@none", "Olduğu gibi ekle", "Kapsamı sonra kendim ayarlarım."],
	];
	const percent = (value) => { const n = parseFloat(value); return NUMBER.test(String(value)) ? `%${Math.round(n * 1000) / 10}` : ""; };

	class ScriptBuilder {
		/* opts: { mode: "effect" | "trigger" | "ai", scope: "country" | "state" | "character" | null, text,
		 *   onChange(text), onBefore() (before a change, for undo), prefer (id prefix shown first in pickers),
		 *   idBase (start of new tooltip keys), loc: { get(key), set(key, text), seed(key, text) }, extra (entries
		 *   known at the top level of this block), empty (text shown when there is nothing) } */
		constructor(el, opts) {
			this.el = el;
			this.o = { mode: "effect", scope: null, text: "", onChange: () => {}, onBefore: null, prefer: "", idBase: "", loc: null, extra: null, empty: "", disabled: false, ...opts };
			this.original = this.o.text || "";
			this.view = "visual";
			this.focusNode = null;
			this.load(this.original);
			loadDocs().then(() => { if (this.el.isConnected && this.view === "visual" && !this.el.contains(document.activeElement)) this.render(); });
		}
		load(text) {
			this.text = text || "";
			this.safe = Script.safe(this.text);
			this.nodes = this.safe ? Script.parse(this.text) : [];
			if (!this.safe) this.view = "code";
			this.render();
		}
		rootCtx() {
			const ai = this.o.mode === "ai";
			return { mode: ai ? "trigger" : this.o.mode, scope: this.o.scope, parent: ai ? ScriptSchema.AI_ROOT : null, root: true };
		}
		before() { if (this.o.onBefore) this.o.onBefore(); }
		/* write the model back; `redraw` after a change of structure */
		commit(redraw = false) {
			const out = Script.stringify(this.nodes);
			this.text = Script.sameTokens(out, this.original) ? this.original : out;
			this.o.onChange(this.text);
			if (redraw) this.render();
		}
		entryFor(n, ctx) {
			if (Script.isComment(n) || n.key == null || ctx.plain) return null;
			if (ctx.root && this.o.extra) {
				const own = this.o.extra.find((e) => e.k === n.key && (Script.isBlock(n) ? e.body || e.f || e.code : e.v));
				if (own) return own;
			}
			return ScriptSchema.find(ctx.mode, n.key, ctx.parent, Script.isBlock(n));
		}

		/* ---------------- drawing ---------------- */
		render() {
			const el = this.el;
			el.innerHTML = "";
			el.classList.add("sb");
			this.els = new WeakMap();
			const tab = (id, label, title) => h("button", { type: "button", class: "small" + (this.view === id ? " on" : ""), title, onclick: () => this.show(id) }, label);
			el.append(h("div", { class: "sb-bar" }, h("span", { class: "sb-views" }, tab("visual", "Görsel", "Kartlarla düzenle"), tab("code", "Kod", "Metin olarak düzenle")),
				!this.safe ? h("span", { class: "warn", style: "margin:0" }, "Bu blok alışılmadık biçimde yazılmış; yalnızca kod olarak düzenlenir.") : null));
			if (this.view === "code") { el.append(this.codeView()); return; }
			el.append(this.list(this.nodes, this.rootCtx()));
			if (this.focusNode) {
				const card = this.els.get(this.focusNode);
				this.focusNode = null;
				const target = card && card.querySelector("input:not([type=checkbox]), select, textarea, button.sb-pick");
				if (target) { target.focus(); if (target.select && target.tagName === "INPUT") target.select(); }
				if (card) card.scrollIntoView({ block: "nearest" });
			}
		}
		show(view) {
			if (view === this.view) return;
			if (view === "visual") {
				if (!Script.safe(this.text)) { Studio.toast("Kod şu an okunamıyor (süslü parantezler dengesiz olabilir). Önce kodu düzelt.", true, 6000); return; }
				this.safe = true; this.nodes = Script.parse(this.text);
			}
			this.view = view;
			this.render();
		}
		codeView() {
			const ta = h("textarea", { class: "code", spellcheck: "false", rows: Math.min(22, Math.max(4, (this.text.match(/\n/g) || []).length + 2)) });
			ta.value = this.text;
			ta.disabled = this.o.disabled;
			Studio.codeArea(ta);
			let armed = true;
			ta.addEventListener("focus", () => (armed = true));
			ta.addEventListener("input", () => {
				if (armed) { this.before(); armed = false; }
				this.text = ta.value;
				ta.classList.toggle("bad", !Script.balanced(ta.value));
				this.o.onChange(this.text);
			});
			return ta;
		}
		list(nodes, ctx, used) {
			const box = h("div", { class: "sb-list" });
			const shown = nodes.filter((n) => !(used && used.has(n)) && !((this.entryFor(n, ctx) || {}).hidden));
			for (const n of shown) box.append(this.card(n, nodes, ctx, shown));
			if (!shown.length && ctx.root) box.append(h("div", { class: "sb-empty small" }, this.o.empty || (ctx.mode === "effect" ? "Henüz etki yok." : ctx.parent && ctx.parent.aiRoot ? "Ağırlık yazılmamış." : "Koşul yok: her zaman geçerli.")));
			if (!this.o.disabled) box.append(this.adder(nodes, ctx));
			return box;
		}
		tools(n, siblings, shown) {
			const at = shown.indexOf(n);
			const swap = (other) => {
				const a = siblings.indexOf(n), b = siblings.indexOf(other);
				this.before(); siblings[a] = other; siblings[b] = n; this.commit(true);
			};
			const btn = (text, title, fn, off) => h("button", { type: "button", class: "sb-tool", title, disabled: off || this.o.disabled, onclick: fn }, text);
			return h("span", { class: "sb-tools" },
				btn("▲", "Yukarı taşı", () => swap(shown[at - 1]), at <= 0),
				btn("▼", "Aşağı taşı", () => swap(shown[at + 1]), at < 0 || at >= shown.length - 1),
				btn("⧉", "Kopyasını ekle", () => { this.before(); siblings.splice(siblings.indexOf(n) + 1, 0, Script.clone(n)); this.commit(true); }),
				btn("✕", "Kaldır", () => { this.before(); siblings.splice(siblings.indexOf(n), 1); this.commit(true); }));
		}
		card(n, siblings, ctx, shown) {
			const tools = this.tools(n, siblings, shown);
			if (Script.isComment(n)) {
				const card = h("div", { class: "sb-node sb-comment" }, h("div", { class: "sb-head" }, h("span", { class: "sb-c" }, n.comment), h("span", { class: "sb-sp" }), tools));
				this.els.set(n, card);
				return card;
			}
			const entry = this.entryFor(n, ctx);
			const block = Script.isBlock(n);
			const head = h("div", { class: "sb-head" });
			const card = h("div", { class: "sb-node" }, head);
			this.els.set(n, card);
			const problem = n.key != null && !ctx.plain && !(entry && (entry.match || entry.weight)) ? scopeProblem(ctx.mode, n.key, ctx.scope) : "";
			if (problem) { card.classList.add("warned"); head.append(h("span", { class: "sb-warn", title: problem }, "⚠")); }
			const doc = n.key != null ? DOCS[ctx.mode].get(n.key) : null;
			const title = [entry && entry.h, doc && doc.sub ? doc.sub.split("\n")[0] : ""].filter(Boolean).join("\n");
			if (entry) {
				head.append(h("span", { class: "sb-l", title }, entry.l));
				if (entry.match || entry.weight) head.append(this.keyWidget(n, entry, ctx));
				else head.append(h("code", { class: "sb-k", title: n.key }, n.key));
			}
			let body = null;
			if (!entry) body = this.plain(n, head, ctx, title);
			else if (!block) this.scalar(n, entry, head, ctx);
			else if (entry.body || entry.weights) { body = this.container(n, entry, ctx); card.classList.add("sb-scope"); }
			else if (entry.list && n.children.every((c) => Script.isBare(c) || Script.isComment(c))) body = this.chips(n, entry.list, ctx);
			else if (entry.map && !(entry.f && entry.f.some((d) => !d.opt))) body = this.map(n, entry, ctx);
			else if (entry.f && (!entry.loose || entry.f.some((d) => Script.find(n.children, d.k)))) {
				const r = this.fields(n, entry.f, ctx);
				body = h("div", {}, r.box, this.rest(n, r.used, ctx));
			} else body = this.code(n);
			head.append(h("span", { class: "sb-sp" }));
			if (n.tail) head.append(h("span", { class: "sb-c", title: "Satır sonu yorumu" }, n.tail));
			head.append(tools);
			if (body) card.append(h("div", { class: "sb-body" }, body));
			if (problem) card.append(h("div", { class: "sb-problem" }, problem));
			return card;
		}

		/* ---------------- value widgets ---------------- */
		clean(raw) { return String(raw ?? "").replace(/[{}#\r\n]/g, " ").trim(); }
		format(def, raw, old) {
			const v = this.clean(raw);
			if (def && (def.t === "str" || def.quoted)) return Script.quote(v, true);
			if (v === "") return def && (def.t === "num" || def.t === "int") ? "0" : '""';
			return Script.quote(v, /^"/.test(old || ""));
		}
		/* an input for one value; `set(raw text)` stores it */
		widget(def, value, set, ctx) {
			const t = def.t;
			let armed = true;
			const change = (v) => { if (armed) { this.before(); armed = false; } set(v); };
			if (t === "pick") return pickButton(def, value, (v) => { this.before(); set(v); }, { prefer: this.o.prefer });
			if (t === "loc") return this.locWidget(value, change);
			if (t === "bool" || t === "enum") {
				const options = t === "bool" ? [["yes", "evet"], ["no", "hayır"]] : def.o;
				const sel = h("select", { class: "sb-in" }, !value ? h("option", { value: "" }, "—") : null,
					options.map(([v, l]) => h("option", { value: v }, l || v)), value && !options.some(([v]) => v === value) ? h("option", { value }, value) : null);
				sel.value = value || "";
				sel.disabled = this.o.disabled;
				sel.addEventListener("change", () => { armed = true; if (sel.value) change(sel.value); });
				return sel;
			}
			const input = h("input", { class: `sb-in ${t}${def.pct ? " pct" : ""}`, value, placeholder: def.def || "", spellcheck: "false", autocomplete: "off" });
			input.disabled = this.o.disabled;
			const hint = def.pct ? h("span", { class: "sb-pct" }, percent(value)) : null;
			input.addEventListener("focus", () => (armed = true));
			input.addEventListener("input", () => {
				change(input.value);
				if (hint) hint.textContent = percent(input.value.trim());
				input.classList.toggle("bad", (t === "num" || t === "int") && input.value.trim() !== "" && !NUMBER.test(input.value.trim()) && !/^[@A-Za-z?^]/.test(input.value.trim()));
			});
			return hint ? h("span", { class: "sb-inWrap" }, input, hint) : input;
		}
		opSelect(n, fallback) {
			const sel = h("select", { class: "sb-op", title: "Karşılaştırma" }, [["=", "="], [">", ">"], ["<", "<"]].map(([v, l]) => h("option", { value: v }, l)),
				!["=", ">", "<"].includes(n.op) ? h("option", { value: n.op }, n.op) : null);
			sel.value = n.op || fallback || "=";
			sel.disabled = this.o.disabled;
			sel.addEventListener("change", () => { this.before(); n.op = sel.value; this.commit(); });
			return sel;
		}
		/* a localisation key with the English text the player reads */
		locWidget(key, change) {
			const loc = this.o.loc;
			const keyIn = h("input", { class: "sb-in lockey", value: key, placeholder: "metin anahtarı", spellcheck: "false", title: "Metnin yerelleştirme anahtarı" });
			const text = h("textarea", { class: "sb-loc", rows: 1, placeholder: loc ? "Oyuncunun göreceği metin (İngilizce)…" : "", spellcheck: "false" });
			const grow = () => { text.style.height = "auto"; text.style.height = Math.min(160, text.scrollHeight + 2) + "px"; };
			keyIn.disabled = text.disabled = this.o.disabled;
			let current = key;
			const fill = () => {
				if (!loc || !current) { text.value = ""; return; }
				const known = loc.get(current);
				if (known !== undefined) { text.value = known; grow(); return; }
				const asked = current;
				Studio.api("/api/loc?keys=" + encodeURIComponent(asked)).then(({ texts }) => {
					loc.seed(asked, texts[asked] || "");
					if (asked === current && document.activeElement !== text) { text.value = loc.get(asked) ?? ""; grow(); }
				}).catch(() => {});
			};
			keyIn.addEventListener("input", () => { current = keyIn.value.trim().replace(KEY_CHARS, ""); change(current); });
			keyIn.addEventListener("change", fill);
			text.addEventListener("input", () => {
				grow();
				if (!current) { Studio.toast("Önce metin anahtarını yaz (ör. SYR_my_tooltip_tt).", true); return; }
				loc.set(current, text.value);
			});
			if (!loc) text.style.display = "none";
			fill();
			return h("span", { class: "sb-locWrap" }, text, keyIn);
		}
		keyWidget(n, entry, ctx) {
			const setKey = (key) => { this.before(); n.key = key; this.commit(true); };
			if (entry.keyPick && !entry.pairOnly) return pickButton({ of: entry.keyPick }, n.key, setKey, { prefer: this.o.prefer });
			if (entry.keyPick) return pickButton({ of: entry.keyPick }, n.key, (key) => { this.before(); n.key = key; this.commit(); }, { prefer: this.o.prefer });
			if (entry.keyEnum) {
				const options = entry.keyEnum.includes(n.key) ? entry.keyEnum : [n.key, ...entry.keyEnum];
				const sel = h("select", { class: "sb-in" }, options.map((v) => h("option", { value: v }, v)));
				sel.value = n.key;
				sel.addEventListener("change", () => setKey(sel.value));
				return sel;
			}
			const input = h("input", { class: "sb-in " + (entry.weight ? "int" : "text"), value: n.key, spellcheck: "false", title: entry.weight ? "Ağırlık: büyük sayı daha olası" : "" });
			let armed = true;
			input.addEventListener("focus", () => (armed = true));
			input.addEventListener("input", () => {
				const key = input.value.trim().replace(KEY_CHARS, "");
				if (!key) return;
				if (armed) { this.before(); armed = false; }
				n.key = key; this.commit();
			});
			return input;
		}
		scalar(n, entry, head, ctx) {
			const def = entry.v;
			if (entry.cmp) head.append(this.opSelect(n, entry.op));
			head.append(this.widget(def, Script.unq(n.value), (raw) => { n.value = this.format(def, raw, n.value); this.commit(); }, ctx));
			/* the block form of the same statement adds fields: `country_event = x` becomes `{ id = x days = 2 }` */
			const more = (entry.f || []).slice(1).filter((d) => d.opt);
			if (more.length && !this.o.disabled) {
				head.append(h("span", { class: "sb-opt" }, more.map((d) => h("button", { type: "button", class: "small", title: d.k, onclick: async () => {
					const child = await this.fieldNode(d);
					if (!child) return;
					this.before();
					const value = n.value;
					delete n.value;
					n.children = [Script.pair(entry.f[0].k, value), child];
					this.focusNode = n;
					this.commit(true);
				} }, "＋ " + d.l))));
			}
		}
		/* a statement the schema does not describe */
		plain(n, head, ctx, title) {
			const keyInput = (node) => {
				const input = h("input", { class: "sb-in key", value: node.key, spellcheck: "false", title: title || "Komutun adı" });
				input.disabled = this.o.disabled;
				let armed = true;
				input.addEventListener("focus", () => (armed = true));
				input.addEventListener("input", () => {
					const key = input.value.trim().replace(KEY_CHARS, "");
					if (!key) return;
					if (armed) { this.before(); armed = false; }
					node.key = key; this.commit();
				});
				return input;
			};
			if (Script.isBare(n)) {
				head.append(this.widget({ t: "text" }, Script.unq(n.value), (raw) => { n.value = this.format(null, raw, n.value); this.commit(); }, ctx));
				return null;
			}
			if (Script.isPair(n)) {
				head.append(keyInput(n), this.opSelect(n), this.widget({ t: "text" }, Script.unq(n.value), (raw) => { n.value = this.format(null, raw, n.value); this.commit(); }, ctx),
					h("button", { type: "button", class: "sb-tool always", title: "Bloğa çevir: değer yerine { ... } yazılır", disabled: this.o.disabled, onclick: () => {
						this.before(); delete n.value; n.children = []; n.inline = false; this.focusNode = n; this.commit(true);
					} }, "{ }"));
				return null;
			}
			if (n.key != null) head.append(keyInput(n), h("span", { class: "small" }, "= { … }"));
			else head.append(h("span", { class: "small" }, "{ … }"));
			return this.code(n);
		}
		/* a block edited as text */
		code(n) {
			const text = Script.stringify(n.children);
			const ta = h("textarea", { class: "code sb-code", spellcheck: "false", rows: Math.min(14, Math.max(2, (text.match(/\n/g) || []).length + 1)) });
			ta.value = text;
			ta.disabled = this.o.disabled;
			Studio.codeArea(ta);
			let armed = true;
			ta.addEventListener("focus", () => (armed = true));
			ta.addEventListener("input", () => {
				const ok = Script.safe(ta.value);
				ta.classList.toggle("bad", !ok);
				if (!ok) return;
				if (armed) { this.before(); armed = false; }
				n.children = Script.parse(ta.value);
				if (ta.value.includes("\n")) n.inline = false; else delete n.inline;
				this.commit();
			});
			return ta;
		}
		/* `key = { a b c }` as chips */
		chips(n, def, ctx) {
			const box = h("div", { class: "sb-chips" });
			const items = n.children.filter(Script.isBare);
			for (const c of items) {
				box.append(h("span", { class: "sb-chip" }, pickButton(def, Script.unq(c.value), (v) => { this.before(); c.value = Script.quote(v, /^"/.test(c.value)); this.commit(); }, { prefer: this.o.prefer }),
					h("button", { type: "button", class: "sb-tool", title: "Kaldır", onclick: () => { this.before(); n.children.splice(n.children.indexOf(c), 1); this.commit(true); } }, "✕")));
			}
			if (!this.o.disabled) box.append(h("button", { type: "button", class: "small sb-add", onclick: async () => {
				const picked = await Picker.open({ type: def.of, prefer: this.o.prefer });
				if (picked == null) return;
				this.before(); n.children.push(Script.word(Script.quote(picked))); this.commit(true);
			} }, "＋ " + (TYPE_LABELS[def.of] || "ekle")));
			return box;
		}
		/* `key = { <picked> = value ... }` as rows */
		map(n, entry, ctx) {
			const fieldKeys = new Set((entry.f || []).map((d) => d.k));
			const box = h("div", { class: "sb-fields" });
			const used = new Set();
			for (const c of n.children.filter((x) => Script.isPair(x) && !fieldKeys.has(x.key))) {
				used.add(c);
				box.append(h("div", { class: "sb-field" },
					pickButton(entry.map.key, c.key, (key) => { this.before(); c.key = key; this.commit(); }, { prefer: this.o.prefer }),
					entry.map.cmp ? this.opSelect(c, entry.map.op) : null,
					this.widget(entry.map.value, Script.unq(c.value), (raw) => { c.value = this.format(entry.map.value, raw, c.value); this.commit(); }, ctx),
					h("button", { type: "button", class: "sb-tool", title: "Kaldır", onclick: () => { this.before(); n.children.splice(n.children.indexOf(c), 1); this.commit(true); } }, "✕")));
			}
			if (!this.o.disabled) box.append(h("div", {}, h("button", { type: "button", class: "small sb-add", onclick: async () => {
				const picked = await Picker.open({ type: entry.map.key.of, prefer: this.o.prefer });
				if (picked == null) return;
				this.before();
				const at = n.children.findIndex((x) => fieldKeys.has(x.key));
				n.children.splice(at < 0 ? n.children.length : at, 0, Script.pair(picked, entry.map.value.def || "1", entry.map.cmp ? entry.map.op || ">" : "="));
				this.commit(true);
			} }, "＋ " + (entry.map.l || "Ekle"))));
			if (entry.f) { const r = this.fields(n, entry.f, ctx); box.append(r.box); r.used.forEach((u) => used.add(u)); }
			return h("div", {}, box, this.rest(n, used, ctx));
		}
		/* the node of a field with its starting value, or null when it has none yet */
		async fieldNode(d, forced) {
			if (d.t === "picks") return Script.blockNode(d.k, []);
			if (d.t === "code") return Script.blockNode(d.k, Script.parse(d.def || ""));
			let value = forced !== undefined ? forced : d.def;
			if (d.t === "loc" && !value) value = await this.freeLocKey();
			if (d.t === "pick" && !value) {
				value = await Picker.open({ type: d.of, prefer: this.o.prefer, title: d.l + " seç" });
				if (value == null) return null;
			}
			if (value === undefined || value === "") return null;
			return Script.pair(d.k, this.format(d, value, ""), d.cmp ? d.op || ">" : "=");
		}
		insertField(n, defs, d, child) {
			const order = defs.map((x) => x.k), mine = order.indexOf(d.k);
			let at = -1;
			n.children.forEach((c, i) => { const o = order.indexOf(c.key); if (o >= 0 && o <= mine) at = i; });
			if (at < 0) at = n.children.findIndex((c) => c.key === "limit");
			n.children.splice(at + 1, 0, child);
		}
		/* the known fields of a block; returns the nodes it drew so the caller can draw the rest */
		fields(n, defs, ctx) {
			const box = h("div", { class: "sb-fields" }), used = new Set(), offer = [];
			for (const d of defs) {
				const found = n.children.filter((c) => !Script.isComment(c) && c.key === d.k);
				if (!found.length) {
					if (d.opt) offer.push(d);
					else box.append(this.fieldRow(n, defs, d, null, ctx));
					continue;
				}
				const drawn = d.rep ? found : found.slice(0, 1);
				drawn.forEach((c) => { used.add(c); box.append(this.fieldRow(n, defs, d, c, ctx, d.opt || drawn.length > 1)); });
				if (d.rep) offer.push(d);
			}
			if (offer.length && !this.o.disabled) {
				box.append(h("div", { class: "sb-opt" }, offer.map((d) => h("button", { type: "button", class: "small", title: d.k, onclick: async () => {
					const child = await this.fieldNode(d) || (d.t === "pick" ? null : Script.pair(d.k, this.format(d, d.def || "", "")));
					if (!child) return;
					this.before(); this.insertField(n, defs, d, child); this.focusNode = n; this.commit(true);
				} }, "＋ " + d.l))));
			}
			return { box, used };
		}
		fieldRow(n, defs, d, child, ctx, removable) {
			const row = h("div", { class: "sb-field" + (child ? "" : " missing") }, h("label", { title: d.k }, d.l));
			if ((d.t === "picks" || d.t === "code") && !child) {
				row.append(h("button", { type: "button", class: "small sb-add", onclick: async () => {
					this.before(); this.insertField(n, defs, d, await this.fieldNode(d)); this.focusNode = n; this.commit(true);
				} }, "＋ ekle"));
			} else if (d.t === "picks" && Script.isBlock(child)) row.append(this.chips(child, d, ctx));
			else if (child && Script.isBlock(child)) row.append(this.code(child));
			else {
				if (d.cmp && child) row.append(this.opSelect(child, d.op));
				row.append(this.widget(d, child ? Script.unq(child.value) : "", (raw) => {
					if (child) { child.value = this.format(d, raw, child.value); this.commit(); return; }
					if (this.clean(raw) === "") return;
					this.insertField(n, defs, d, Script.pair(d.k, this.format(d, raw, ""), d.cmp ? d.op || ">" : "="));
					this.focusNode = n;
					this.commit(true);
				}, ctx));
			}
			if (removable && child && !this.o.disabled) row.append(h("button", { type: "button", class: "sb-tool", title: "Bu alanı kaldır", onclick: () => { this.before(); n.children.splice(n.children.indexOf(child), 1); this.commit(true); } }, "✕"));
			return row;
		}
		/* children of a form block that the form did not draw */
		rest(n, used, ctx) {
			const left = n.children.filter((c) => !used.has(c));
			if (!left.length) return null;
			const box = h("div", { class: "sb-rest" });
			for (const c of left) box.append(this.card(c, n.children, { ...ctx, plain: true }, left));
			return box;
		}
		container(n, entry, ctx) {
			const inner = {
				mode: entry.body === "triggers" ? "trigger" : entry.body === "effects" ? "effect" : ctx.mode,
				scope: entry.same || entry.weights ? ctx.scope : entry.scope !== undefined ? entry.scope : null, parent: entry,
			};
			const body = h("div", { class: "sb-inner" });
			const used = new Set();
			if (entry.f) { const r = this.fields(n, entry.f, inner); body.append(r.box); r.used.forEach((u) => used.add(u)); }
			if (entry.limit) {
				const limit = n.children.find((c) => c.key === "limit" && Script.isBlock(c));
				if (limit) {
					used.add(limit);
					body.append(h("div", { class: "sb-limit" }, h("div", { class: "sb-limitHead" }, h("b", {}, entry.k === "if" || entry.k === "else_if" ? "Koşul" : "Yalnızca şunlarda (koşul)"), h("code", { class: "sb-k" }, "limit"), h("span", { class: "sb-sp" }),
						h("button", { type: "button", class: "sb-tool", title: "Koşulu kaldır", disabled: this.o.disabled, onclick: () => { this.before(); n.children.splice(n.children.indexOf(limit), 1); this.commit(true); } }, "✕")),
						this.list(limit.children, { mode: "trigger", scope: inner.scope, parent: null })));
				} else if (!this.o.disabled) {
					body.append(h("button", { type: "button", class: "small sb-add", onclick: () => { this.before(); n.children.unshift(Script.blockNode("limit", [], false)); this.commit(true); } }, "＋ Koşul ekle (limit)"));
				}
			}
			body.append(this.list(n.children, inner, used));
			return body;
		}

		/* ---------------- adding ---------------- */
		adder(nodes, ctx) {
			const ai = !!(ctx.parent && ctx.parent.aiRoot);
			const label = ai ? "＋ Ağırlık ekle" : ctx.parent && ctx.parent.weights ? "＋ Seçenek ekle" : ctx.mode === "effect" ? "＋ Etki ekle" : "＋ Koşul ekle";
			return h("div", { class: "sb-adder" }, h("button", { type: "button", class: "sb-add", onclick: async () => {
				if (ctx.parent && ctx.parent.weights) { this.before(); const node = Script.blockNode("50", [], false); nodes.push(node); this.focusNode = node; this.commit(true); return; }
				const choice = await Palette.open({ mode: ctx.mode, scope: ctx.scope, ai, prefer: this.o.prefer, extra: ctx.root ? this.o.extra : null });
				if (!choice) return;
				let node = await this.make(choice, ctx);
				if (!node) return;
				node = await this.wrapForScope(node, choice, ctx);
				if (!node) return;
				this.before(); nodes.push(node); this.focusNode = node; this.commit(true);
			} }, label));
		}
		async freeLocKey() {
			const base = (this.o.idBase || "studio").replace(/[^A-Za-z0-9_]/g, "_") + "_tt";
			const candidates = [base, ...Array.from({ length: 30 }, (_, i) => `${base}_${i + 2}`)];
			let texts = {};
			try { ({ texts } = await Studio.api("/api/loc?keys=" + encodeURIComponent(candidates.join(",")))); } catch (e) { /* the first free name of this block is used */ }
			const here = Script.stringify(this.nodes);
			return candidates.find((k) => !texts[k] && !new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(here) && !(this.o.loc && this.o.loc.get(k))) || `${base}_${Date.now() % 100000}`;
		}
		/* a new statement from a palette choice, with its starting values */
		async make(choice, ctx) {
			const e = choice.entry;
			if (!e) return Script.pair(choice.key, "yes");
			let key = e.k;
			if (e.match) {
				if (e.keyPick) {
					key = await Picker.open({ type: e.keyPick, prefer: this.o.prefer, title: e.l + ": " + (TYPE_LABELS[e.keyPick] || "").toLowerCase() + " seç", custom: !e.pairOnly });
					if (key == null) return null;
				} else if (e.keyEnum) key = e.keyEnum[0];
				else key = e.keyText + "name";
			}
			if (e.body || e.weights) {
				const children = [];
				if (e.limit && e.limitFirst) children.push(Script.blockNode("limit", [], false));
				for (const d of e.f || []) {
					if (d.opt && !(e.tplFields || []).includes(d.k)) continue;
					const child = await this.fieldNode(d);
					if (child) children.push(child);
				}
				if (e.weights) children.push(Script.blockNode("50", [], false), Script.blockNode("50", [], false));
				return Script.blockNode(key, children, false);
			}
			if (e.v) {
				let value = e.v.def;
				if (e.v.t === "loc") value = await this.freeLocKey();
				if (e.v.t === "pick" && !value) {
					value = await Picker.open({ type: e.v.of, prefer: this.o.prefer, title: e.l });
					if (value == null) return null;
				}
				return Script.pair(key, this.format(e.v, value === undefined ? "" : value, ""), e.cmp ? e.op || ">" : "=");
			}
			if (e.code) return Script.blockNode(key, Script.parse(e.tpl || ""), false);
			if (e.list) {
				const first = await Picker.open({ type: e.list.of, prefer: this.o.prefer, title: e.l });
				return first == null ? null : Script.blockNode(key, [Script.word(Script.quote(first))]);
			}
			const children = [];
			for (const d of e.f || []) {
				if (d.opt) continue;
				const child = await this.fieldNode(d);
				if (child === null && d.t === "pick") return null;  /* the picker was closed */
				if (child) children.push(child);
			}
			return Script.blockNode(key, children);
		}
		/* an effect that needs a state, added where the scope is a country: ask which state */
		async wrapForScope(node, choice, ctx) {
			const e = choice.entry;
			const key = e ? e.k : choice.key;
			if (!key || ctx.scope !== "country" || (e && (e.body || e.match))) return node;
			const scopes = scopesOf(ctx.mode, key);
			if (!scopes || scopes.includes("COUNTRY") || !scopes.includes("STATE")) return node;
			const wraps = ctx.mode === "effect" ? STATE_WRAPS : [STATE_WRAPS[0], STATE_WRAPS[1], ["any_owned_state", "Eyaletlerden herhangi birinde", "Sahip olunan eyaletlerden en az biri için doğruysa."], ["all_owned_state", "Eyaletlerin hepsinde", "Sahip olunan her eyalet için doğruysa."], STATE_WRAPS[4]];
			const answer = await Studio.ask({ title: "Hangi eyalette?", ok: "Ekle", intro: `<b>${esc(e ? e.l : key)}</b> bir eyalet üzerinde çalışır. Nerede çalışsın?`,
				fields: [{ key: "where", type: "choice", label: "Eyalet", value: "@state", options: wraps }] });
			if (!answer) return null;
			if (answer.where === "@none") return node;
			let outer = answer.where;
			if (outer === "@state") {
				outer = await Picker.open({ type: "state", title: "Eyalet seç" });
				if (outer == null) return null;
			}
			return Script.blockNode(outer, [node], false);
		}
	}

	/* ===================================================================== */
	/* Shared widgets for the pages                                           */
	/* ===================================================================== */
	function fmtMod(key, value) {
		const n = parseFloat(value);
		if (!NUMBER.test(String(value))) return esc(value);
		const pct = /factor/.test(key);
		const shown = pct ? Math.round(n * 1000) / 10 + "%" : String(Math.round(n * 1000) / 1000);
		return (n > 0 ? "+" : "") + shown;
	}
	/* modTable(el, { rows: [{ key, value }], onChange(rows), info(row) -> html, disabled, of, add })
	 * A table of `name = number` lines whose names are chosen from a catalog: the game's modifiers with
	 * their tooltip names by default, or `of: "tech_category"` for a research bonus. */
	function modTable(el, opts) {
		const rows = opts.rows, of = opts.of || "modifier";
		const noun = of === "modifier" ? "Modifier" : TYPE_LABELS[of] || "Satır";
		const changed = () => opts.onChange && opts.onChange(rows);
		function draw() {
			el.innerHTML = "";
			const table = h("div", { class: "sb-mods" });
			rows.forEach((r, i) => {
				const preview = h("span", { class: "sb-pct" }, r.key && r.value ? fmtMod(r.key, r.value) : "");
				const value = h("input", { class: "sb-in num", value: r.value, placeholder: "0.05", spellcheck: "false" });
				value.disabled = !!opts.disabled;
				value.addEventListener("input", () => { r.value = value.value.trim(); preview.textContent = r.key && r.value ? fmtMod(r.key, r.value) : ""; changed(); });
				const row = h("div", { class: "sb-mod" },
					pickButton({ of }, r.key, (key) => { r.key = key; changed(); draw(); }),
					value, preview,
					h("button", { type: "button", class: "sb-tool", title: "Kaldır", disabled: !!opts.disabled, onclick: () => { rows.splice(i, 1); changed(); draw(); } }, "✕"));
				table.append(row);
				const info = opts.info ? opts.info(r) : "";
				if (info) table.append(h("div", { class: "small sb-modInfo", html: info }));
			});
			if (!rows.length) table.append(h("div", { class: "small" }, noun + " yok."));
			el.append(table);
			if (!opts.disabled) el.append(h("button", { type: "button", class: "small sb-add", onclick: async () => {
				const picked = await Picker.open({ type: of, title: noun + " seç" });
				if (picked == null) return;
				if (rows.some((r) => r.key === picked)) { Studio.toast("Bu zaten tabloda."); return; }
				rows.push({ key: picked, value: "0.05" }); changed(); draw();
				const inputs = el.querySelectorAll("input.num"); if (inputs.length) { inputs[inputs.length - 1].focus(); inputs[inputs.length - 1].select(); }
			} }, "＋ " + (opts.add || noun + " ekle")), h("span", { class: "small" }, " Değerler ondalık: 0.1 = %10, -0.25 = %25 azalma"));
		}
		draw();
		return { draw };
	}
	/* pairBlock(el, { body, onChange(text), of, add, disabled }): the body of a block of `name = number`
	 * lines (modifier, research_bonus) as a modTable; a body with anything else in it stays text. */
	function pairBlock(el, opts) {
		const text = opts.body || "";
		const nodes = Script.safe(text) ? Script.parse(text) : null;
		if (!nodes || !nodes.every((n) => Script.isPair(n) && n.op === "=" && !n.tail)) {
			const ta = h("textarea", { class: "code", spellcheck: "false", rows: Math.min(14, Math.max(3, (text.match(/\n/g) || []).length + 2)) });
			ta.value = text;
			ta.disabled = !!opts.disabled;
			Studio.codeArea(ta);
			ta.addEventListener("input", () => opts.onChange(ta.value));
			el.innerHTML = "";
			el.append(h("div", { class: "small", style: "margin-bottom:3px" }, "Bu blok iç içe yapı ya da yorum içeriyor; metin olarak düzenlenir."), ta);
			return;
		}
		const rows = nodes.map((n) => ({ key: n.key, value: Script.unq(n.value) }));
		modTable(el, { rows, of: opts.of === true ? "modifier" : opts.of, add: opts.add, disabled: opts.disabled, info: opts.info,
			onChange: () => opts.onChange(rows.filter((r) => r.key && r.value !== "").map((r) => `${r.key} = ${r.value}`).join("\n")) });
	}
	/* picks(el, { of, values, onChange(list), prefer, add }): a list of catalog entries as chips */
	function picks(el, opts) {
		let values = [...(opts.values || [])];
		function draw() {
			el.innerHTML = "";
			const box = h("div", { class: "sb-chips" });
			values.forEach((v, i) => box.append(h("span", { class: "sb-chip" },
				pickButton({ of: opts.of }, v, (id) => { values[i] = id; opts.onChange([...values]); }, { prefer: opts.prefer }),
				h("button", { type: "button", class: "sb-tool", title: "Kaldır", disabled: !!opts.disabled, onclick: () => { values.splice(i, 1); opts.onChange([...values]); draw(); } }, "✕"))));
			if (!values.length && opts.empty) box.append(h("span", { class: "small" }, opts.empty));
			if (!opts.disabled) box.append(h("button", { type: "button", class: "small sb-add", onclick: async () => {
				const picked = await Picker.open({ type: opts.of, prefer: opts.prefer });
				if (picked == null) return;
				if (values.includes(picked)) { Studio.toast("Bu zaten listede."); return; }
				values.push(picked); opts.onChange([...values]); draw();
			} }, "＋ " + (opts.add || TYPE_LABELS[opts.of] || "Ekle")));
			el.append(box);
		}
		draw();
		return { get: () => [...values], set: (list) => { values = [...list]; draw(); } };
	}

	return { h, Catalog, Picker, Palette, ScriptBuilder, pickButton, modTable, pairBlock, picks, fmtMod, loadDocs, TYPE_LABELS, builder: (el, opts) => new ScriptBuilder(el, opts) };
})();
