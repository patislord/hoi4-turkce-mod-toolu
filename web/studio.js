/* HOI4 Türkçe Mod Toolu: shared page code.
 * - navigation bar with global search and the Claude status pill
 * - Claude drawer (request history), "Claude'a gönder" box, disk-change watching
 * - icon picker, HOI4 text renderer, code text areas
 * - ItemEditor: the generic form for idea / decision / category / event blocks; it turns the
 *   user's edits into operations on the original entries so the server rewrites only those.
 */
"use strict";

const Studio = (() => {
	const meta = document.querySelector('meta[name="studio-token"]');
	const TOKEN = meta ? meta.content : "";
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	const clone = (o) => JSON.parse(JSON.stringify(o));
	const iconUrl = (name) => "/api/icon?name=" + encodeURIComponent(name || "");
	/* a texture file under gfx/ (portraits and flags are often given as paths, not sprites) */
	const textureUrl = (path) => "/api/texture?path=" + encodeURIComponent(path || "");
	const imageUrl = (value) => (/[\/\\]/.test(value || "") ? textureUrl(value) : iconUrl(value));
	const MODULES = [
		{ id: "home", label: "Ana sayfa", href: "/" },
		{ id: "focus", label: "Odak Ağaçları", href: "/focus.html" },
		{ id: "ideas", label: "Milli Ruhlar", href: "/ideas.html" },
		{ id: "decisions", label: "Kararlar", href: "/decisions.html" },
		{ id: "events", label: "Olaylar", href: "/events.html" },
		{ id: "countries", label: "Ülkeler", href: "/countries.html" },
		{ id: "characters", label: "Karakterler", href: "/characters.html" },
		{ id: "health", label: "Mod Sağlığı", href: "/health.html" },
	];
	const MODULE_LABELS = { focus: "Odak", event: "Olay", decision: "Karar", category: "Kategori", idea: "Ruh", country: "Ülke", character: "Karakter" };
	const STATUS_LABELS = { pending: "Sırada", working: "Claude çalışıyor…", done: "Tamamlandı", needs_info: "Claude soru soruyor", failed: "Yapılamadı", cancelled: "İptal edildi" };
	const QUICK = {
		focus: [["Altına odak ekle", "Bu odağın altına yeni bir odak ekle: "], ["Ödülü değiştir", "Bu odağın ödülünü şöyle değiştir: "], ["Metni yaz", "Bu odağın İngilizce adını ve açıklamasını daha iyi yaz."], ["Özel ikon üret", "Bu odak için özel bir ikon üret: "], ["AI ayarla", "Yapay zekânın bu odağı seçme ağırlığını ayarla: "], ["Kontrol et", "Bunu hata ve denge açısından kontrol et."]],
		idea: [["Modifier değiştir", "Bu ruhun modifier'larını şöyle değiştir: "], ["Metni yaz", "Bu ruhun İngilizce adını ve açıklamasını daha iyi yaz."], ["Özel resim üret", "Bu ruh için özel bir resim üret: "], ["Dengele", "Bu ruhu oyun dengesi açısından ayarla."], ["Kontrol et", "Bunu hata ve denge açısından kontrol et."]],
		decision: [["Etkiyi değiştir", "Bu kararın etkisini şöyle değiştir: "], ["Koşul ekle", "Bu karara şu koşulu ekle: "], ["Maliyet", "Bu kararın maliyetini şöyle ayarla: "], ["Metni yaz", "Bu kararın İngilizce adını ve açıklamasını daha iyi yaz."], ["AI ayarla", "Yapay zekânın bu kararı alma ağırlığını ayarla: "], ["Kontrol et", "Bunu hata ve denge açısından kontrol et."]],
		category: [["Metni yaz", "Bu kategorinin İngilizce adını ve açıklamasını daha iyi yaz."], ["Kontrol et", "Bunu hata açısından kontrol et."]],
		event: [["Seçenek ekle", "Bu olaya şu seçeneği ekle: "], ["Etkiyi değiştir", "Bu olayın şu seçeneğinin etkisini değiştir: "], ["Metni yaz", "Bu olayın İngilizce başlığını, metnini ve seçeneklerini daha iyi yaz."], ["Devam olayı", "Bu olaydan sonra gelecek yeni bir olay yaz: "], ["Kontrol et", "Bunu hata ve denge açısından kontrol et."]],
		country: [["Siyaset", "Bu ülkenin başlangıç siyasetini şöyle ayarla: "], ["Lider ekle", "Bu ülkeye şu lideri ekle (karakter, portre, metin): "], ["Teknolojiler", "Bu ülkenin başlangıç teknolojilerini şöyle ayarla: "], ["Başlangıç ruhları", "Bu ülkeye şu başlangıç ruhunu ekle: "], ["Ordu", "Bu ülkenin başlangıç ordusunu şöyle düzenle: "], ["Bayrak üret", "Bu ülke için bayrak üret: "], ["Kontrol et", "Bu ülkenin kurulumunu hata açısından kontrol et."]],
		character: [["Rol ekle", "Bu karaktere şu rolü ekle: "], ["Özellikler", "Bu karakterin özelliklerini şöyle ayarla: "], ["Portre", "Bu karakter için portre üret ya da uygun bir portre bul: "], ["Metni yaz", "Bu karakterin İngilizce adını yaz."], ["Kontrol et", "Bunu hata ve denge açısından kontrol et."]],
		file: [["Kontrol et", "Bu dosyayı hata açısından kontrol et."]],
	};
	const S = {
		watchFiles: () => [], onDiskChange: null, versions: {}, locStamp: "", claude: { listener: {}, requests: [] },
		lastStatuses: new Map(), drafts: {}, unsaved: () => false, onSelect: null, polling: false,
	};

	function toast(msg, err = false, ms = 3500) {
		const t = $("toast");
		t.textContent = msg; t.className = err ? "err" : ""; t.style.display = "block";
		clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.style.display = "none"), ms);
	}

	/* the server's English error texts, in Turkish for the toast (unknown ones stay as written) */
	const ERRORS = [
		[/changed on disk after it was loaded/, "Dosya sen açtıktan sonra diskte değişti. Sayfayı yeniden yükleyip değişikliği tekrar yap."],
		[/unbalanced braces/, "Süslü parantezler { } dengeli değil; hiçbir şey kaydedilmedi. Açtığın her { için bir } olmalı."],
		[/^(.+) already exists in this file$/, "$1 bu dosyada zaten var; başka bir kimlik (id) seç."],
		[/^a character (.+) already exists$/, "$1 kimliğiyle bir karakter zaten var; başka bir kimlik seç."],
		[/^(.+) is already used$/, "$1 etiketi zaten kullanılıyor."],
		[/^(.+) already exists$/, "$1 zaten var."],
		[/^(.+) was not found in the file$/, "$1 dosyada bulunamadı; dosya değişmiş olabilir, sayfayı yenile."],
		[/must stay one item with the same id|must be one focus with the same id/, "Ham kodda öğenin kimliği (id) değiştirilemez ve tek bir blok kalmalı."],
		[/^invalid id$|^invalid or duplicate new focus id.*$/, "Geçersiz ya da kullanılmış kimlik (id): yalnızca harf, rakam ve _ kullan."],
		[/^(.+): a single value is expected$/, "$1: tek bir değer yazılmalı (boşluk ya da { } olmadan)."],
		[/^unknown tag (.+)$/, "$1 adında bir ülke etiketi yok."],
		[/^unknown capital state$/, "Bu numarada bir eyalet yok."],
		[/^unknown ruling party$/, "Bilinmeyen yönetim partisi."],
		[/^the colour must be.*$/, "Renk 0 ile 255 arasında üç sayı olmalı."],
		[/^the English name may use.*$/, "İngilizce ad yalnızca harf, rakam, boşluk ve - ' ( ) . içerebilir."],
		[/^a tag is three capital letters.*$/, "Etiket 3 büyük harf ya da rakamdır, harfle başlar ve AND, NOT, D01 gibi ayrılmış bir ad olamaz."],
		[/^this file has no '(.+)' idea category$/, "Bu dosyada '$1' ruh kategorisi yok."],
		[/^this file has no '(.+)' category block$/, "Bu dosyada '$1' kategorisinin bloğu yok."],
		[/^this file has no characters block$/, "Bu dosyada characters = { } bloğu yok."],
		[/^(.+) already has a block in this file$/, "$1 kategorisinin bu dosyada zaten bir bloğu var."],
		[/^the picture could not be read$|^the file is not a picture.*$/, "Resim okunamadı; PNG ya da JPG gibi bir resim dosyası seç."],
		[/^no such file: (.+)$/, "Dosya bulunamadı: $1"],
		[/^not an editable mod path: (.+)$/, "Bu dosya stüdyodan düzenlenemez: $1"],
		[/^the request text is empty$/, "Önce ne istediğini yaz."],
		[/^the request text is longer than (\d+) characters$/, "İstek metni çok uzun (en fazla $1 karakter)."],
		[/^invalid namespace$/, "Geçersiz namespace: yalnızca harf, rakam ve _ kullan."],
		[/^Failed to fetch$|^NetworkError.*$/, "Stüdyoya ulaşılamıyor. Stüdyo penceresi (siyah konsol) kapanmış olabilir; studio.bat ile yeniden başlat."],
	];
	function turkish(message) {
		for (const [re, text] of ERRORS) {
			const found = String(message).match(re);
			if (found) return text.replace(/\$(\d)/g, (_, n) => found[+n] || "");
		}
		return message;
	}
	async function api(path, body) {
		let res;
		try { res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Editor-Token": TOKEN }, body: JSON.stringify(body) } : {}); }
		catch (e) { throw new Error(turkish(e.message)); }
		let data = {};
		try { data = await res.json(); } catch (e) { data = { error: res.statusText }; }
		if (!res.ok) throw new Error(turkish(data.error || res.statusText));
		return data;
	}

	/* ---------------- HOI4 text ---------------- */
	function locHtml(text) {
		let s = esc(text || "").replace(/\\n/g, "\n");
		s = s.replace(/£([A-Za-z0-9_]+)(\|[0-9]+)?/g, '<span class="loc-icon">◆</span>');
		s = s.replace(/\[([^\]\n]{1,80})\]/g, '<span class="loc-scope">[$1]</span>');
		let out = "", open = 0;
		const parts = s.split(/§/);
		out = parts[0];
		for (let i = 1; i < parts.length; i++) {
			const p = parts[i];
			if (p.startsWith("!")) { if (open) { out += "</span>"; open--; } out += p.slice(1); }
			else if (p.length) { out += `<span class="loc-${p[0]}">` + p.slice(1); open++; }
		}
		while (open-- > 0) out += "</span>";
		return out.replace(/\n/g, "<br>");
	}
	function codeArea(el) {
		el.addEventListener("keydown", (ev) => {
			if (ev.key === "Tab" && !ev.ctrlKey && !ev.altKey) {
				ev.preventDefault();
				const a = el.selectionStart, b = el.selectionEnd;
				el.value = el.value.slice(0, a) + "\t" + el.value.slice(b);
				el.selectionStart = el.selectionEnd = a + 1;
				el.dispatchEvent(new Event("input"));
			}
		});
	}

	/* ---------------- navigation, search, drawer ---------------- */
	function initNav(active) {
		const nav = document.createElement("div");
		nav.className = "nav";
		nav.innerHTML = `<span class="brand">HOI4 Türkçe Mod Toolu</span>
			${MODULES.map((m) => m.soon ? `<a class="mod soon" title="Yakında">${esc(m.label)}</a>`
				: `<a class="mod${m.id === active ? " active" : ""}" href="${m.href}">${esc(m.label)}</a>`).join("")}
			<div class="search"><input id="gSearch" placeholder="Tüm modda ara (id veya isim)…" autocomplete="off"><div class="results" id="gResults"></div></div>
			<span class="spacer"></span>
			<button id="helpBtn" class="fixed" title="Bu sayfa nasıl kullanılır? (F1)">? Yardım</button>
			<span id="claudePill" class="pill off" title="Claude ile bağlantı. Tıkla: istek geçmişi">Claude: bağlı değil</span>`;
		document.body.prepend(nav);
		for (const html of ['<div id="toast"></div>',
			'<div id="drawer"><div class="top"><b style="color:var(--claude)">Claude istekleri</b><span class="spacer"></span><button id="drawerClose">Kapat</button></div><div class="body" id="drawerBody"></div></div>',
			`<div class="modal" id="iconModal"><div class="box"><div class="top"><input id="iconSearch" placeholder="İkon ara…"><button id="iconGenToggle" class="genBtn" title="Açıklamadan yeni görsel üret (Claude + hoi4-imagegen)">✨ Yeni üret</button><button id="iconClose">Kapat</button></div>
				<div class="genPanel" id="iconGen" style="display:none">
					<div class="row"><select id="genFamily" class="fixed"></select><span class="small" id="genInfo"></span></div>
					<textarea id="genText" rows="3" placeholder="Ne çizilsin? Örn: kumlu bir tepede tüfekli milisler, sepya tonlu (yazı yazdırma)"></textarea>
					<div class="row"><span class="small" id="genStatus"></span><button class="primary fixed" id="genGo">Claude'a üret (Ctrl+Enter)</button></div>
					<div class="small">Claude görseli hoi4-imagegen ile üretir, kontrol eder ve moda kurar; sonra burada en üstte çıkar, seçmek sana kalır. Bir görsel birkaç dakika sürebilir; pencereyi kapatabilirsin. Gerçek kişilerin portresi üretilmez.</div>
				</div><div class="grid" id="iconGrid"></div></div></div>`]) {
			document.body.insertAdjacentHTML("beforeend", html);
		}
		document.body.insertAdjacentHTML("beforeend", `<div class="modal" id="askModal"><div class="box form-box"><div class="top"><b style="color:var(--gold)" id="askTitle"></b><span class="spacer"></span><button id="askClose">Vazgeç</button></div>
			<div class="body" id="askBody"></div></div></div>
			<div class="modal" id="helpModal"><div class="box form-box"><div class="top"><b style="color:var(--gold)">Yardım</b><span class="spacer"></span><button id="helpClose">Kapat</button></div>
			<div class="body" id="helpBody"></div></div></div>`);
		$("askClose").onclick = () => closeAsk(null);
		$("helpClose").onclick = () => ($("helpModal").style.display = "none");
		$("helpBtn").onclick = () => showHelp(active);
		document.addEventListener("keydown", (ev) => { if (ev.key === "F1") { ev.preventDefault(); showHelp(active); } });
		$("claudePill").onclick = () => { renderDrawer(); $("drawer").classList.add("open"); };
		$("drawerClose").onclick = () => $("drawer").classList.remove("open");
		nav.querySelectorAll("a.mod[href]").forEach((a) => a.addEventListener("click", (ev) => {
			if (S.unsaved() && !confirm("Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?")) ev.preventDefault();
		}));
		let timer = null, hl = -1;
		const box = $("gSearch"), res = $("gResults");
		box.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 250); });
		box.addEventListener("keydown", (ev) => {
			const links = [...res.querySelectorAll("a")];
			if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
				ev.preventDefault(); hl = Math.max(0, Math.min(links.length - 1, hl + (ev.key === "ArrowDown" ? 1 : -1)));
				links.forEach((a, i) => a.classList.toggle("hl", i === hl));
			} else if (ev.key === "Enter" && links.length) { (links[hl >= 0 ? hl : 0]).click(); }
			else if (ev.key === "Escape") { res.style.display = "none"; }
		});
		document.addEventListener("click", (ev) => { if (!ev.target.closest(".search")) res.style.display = "none"; });
		async function runSearch() {
			const q = box.value.trim(); hl = -1;
			if (q.length < 2) { res.style.display = "none"; return; }
			try {
				const { results } = await api("/api/search?q=" + encodeURIComponent(q));
				res.innerHTML = results.length ? results.map((r) => `<a href="${esc(r.url)}"><span class="mod">${esc(MODULE_LABELS[r.module] || r.module)}</span>
					<span style="min-width:0"><div>${esc(r.name || r.id)}</div><div class="rid">${esc(r.id)} · ${esc(r.file)}</div></span></a>`).join("")
					: `<div class="small" style="padding:8px">Sonuç yok.</div>`;
				res.style.display = "block";
				res.querySelectorAll("a").forEach((a) => a.addEventListener("click", (ev) => {
					if (S.unsaved() && !confirm("Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?")) ev.preventDefault();
				}));
			} catch (e) { toast("Arama başarısız: " + e.message, true); }
		}
		window.addEventListener("beforeunload", (ev) => { if (S.unsaved()) { ev.preventDefault(); ev.returnValue = ""; } });
		document.addEventListener("keydown", (ev) => {
			if (ev.key !== "Escape") return;
			if ($("iconModal").style.display === "flex") { ev.stopImmediatePropagation(); closePicker(null); }
			else if ($("askModal").style.display === "flex") { ev.stopImmediatePropagation(); closeAsk(null); }
			else if ($("helpModal").style.display === "flex") { ev.stopImmediatePropagation(); $("helpModal").style.display = "none"; }
			else if ($("drawer").classList.contains("open")) { ev.stopImmediatePropagation(); $("drawer").classList.remove("open"); }
		}, true);
		setInterval(poll, 2000);
		poll(true);
	}

	function requestCard(r) {
		const rep = r.reply || null;
		const items = (r.items || []).map((i) => `<span class="chip" data-sel="${esc(i.id)}" title="${esc(i.id)}">${esc(i.name || i.id)}</span>`).join("");
		return `<div class="req">
			<div class="row"><span class="st ${esc(r.status)} fixed">${esc(STATUS_LABELS[r.status] || r.status)}</span>
				<span class="small" style="text-align:right">${esc((r.created || "").replace("T", " "))}</span></div>
			<div class="small" style="margin-top:4px">${esc(MODULE_LABELS[r.kind] || r.kind || "")} · ${esc(r.file)}${items ? "" : " · tüm dosya"}</div>
			${items ? `<div class="chips" style="margin-top:4px">${items}</div>` : ""}
			<div class="user">${esc(r.text)}</div>
			${rep ? `<div class="msg"><b style="color:var(--claude)">Claude:</b> ${esc(rep.message || "")}</div>
				${(rep.files || []).length ? `<div class="small" style="margin-top:4px">Değişen dosyalar: ${rep.files.map(esc).join(", ")}</div>` : ""}` : ""}
			<div class="row" style="margin-top:6px">
				${r.status === "pending" ? `<button class="fixed" data-cancel="${esc(r.id)}">İptal et</button>` : ""}
				${["done", "needs_info", "failed"].includes(r.status) ? `<button class="fixed" data-follow="${esc(r.id)}">Devam / yanıtla</button>` : ""}
			</div></div>`;
	}
	function renderDrawer() {
		const L = S.claude.listener || {};
		const reqs = S.claude.requests || [];
		const working = reqs.some((r) => r.status === "working");
		$("drawerBody").innerHTML = `<div class="small" style="margin-bottom:8px">${working ? "Claude bir istek üzerinde çalışıyor." : L.alive
			? `Claude dinliyor (${esc((L.since || "").replace("T", " "))} saatinden beri).` : "Claude dinlemiyor. Terminalde Claude'a <b>editörü dinle</b> yaz; sıradaki istekler o zaman işlenir."}</div>
			${reqs.length ? reqs.map(requestCard).join("") : `<div class="small">Henüz istek yok.</div>`}`;
		$("drawerBody").querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
			try { await api("/api/claude/cancel", { id: b.dataset.cancel }); await poll(true); renderDrawer(); }
			catch (e) { toast("İptal edilemedi: " + e.message, true); }
		}));
		$("drawerBody").querySelectorAll("[data-follow]").forEach((b) => (b.onclick = () => {
			const r = reqs.find((x) => x.id === b.dataset.follow);
			$("drawer").classList.remove("open");
			if (r && S.onSelect) S.onSelect(r);
			const key = Object.keys(S.drafts)[0];
			const ta = document.querySelector(".sendBox textarea");
			if (ta) { ta.closest(".sendBox").classList.remove("folded"); ta.value = `(Önceki istek ${b.dataset.follow} hakkında) `; ta.dispatchEvent(new Event("input")); ta.focus(); }
			void key;
		}));
		$("drawerBody").querySelectorAll("[data-sel]").forEach((c) => (c.onclick = () => {
			const r = reqs.find((x) => (x.items || []).some((i) => i.id === c.dataset.sel));
			if (r && S.onSelect) { $("drawer").classList.remove("open"); S.onSelect(r, c.dataset.sel); }
		}));
	}
	function updatePill() {
		const L = S.claude.listener || {};
		const reqs = S.claude.requests || [];
		const working = reqs.some((r) => r.status === "working");
		const pending = reqs.filter((r) => r.status === "pending").length;
		const pill = $("claudePill");
		if (!pill) return;
		if (working) { pill.className = "pill busy"; pill.textContent = "Claude: çalışıyor…"; }
		else if (L.alive) { pill.className = "pill on"; pill.textContent = "Claude: dinliyor" + (pending ? ` (${pending} sırada)` : ""); }
		else { pill.className = "pill off"; pill.textContent = "Claude: bağlı değil" + (pending ? ` (${pending} sırada)` : ""); }
		document.querySelectorAll(".sendWarn").forEach((w) => (w.style.display = L.alive || working ? "none" : ""));
	}
	async function poll(quiet = false) {
		if (S.polling) return;
		S.polling = true;
		try {
			const files = (S.watchFiles() || []).filter(Boolean);
			const st = await api("/api/state?files=" + encodeURIComponent(files.join(",")));
			S.claude = st;
			for (const r of st.requests) {
				const old = S.lastStatuses.get(r.id);
				if (quiet !== true && old && old !== r.status) {
					if (r.status === "working") toast("Claude isteğin üzerinde çalışıyor…");
					else if (r.status === "done") toast("Claude isteği tamamladı:\n" + ((r.reply && r.reply.message) || "").slice(0, 400), false, 8000);
					else if (r.status === "needs_info") toast("Claude bir soru sordu; sağ üstteki Claude göstergesine tıkla.", false, 8000);
					else if (r.status === "failed") toast("Claude isteği yapamadı:\n" + ((r.reply && r.reply.message) || ""), true, 9000);
				}
				S.lastStatuses.set(r.id, r.status);
			}
			updatePill();
			if ($("drawer").classList.contains("open")) {
				const sig = JSON.stringify(st.requests.map((r) => [r.id, r.status]));
				if (sig !== S.drawerSig) { S.drawerSig = sig; renderDrawer(); }
			}
			const changed = files.filter((f) => S.versions[f] && st.versions[f] && st.versions[f] !== S.versions[f]);
			const locChanged = S.locStamp && st.locStamp && st.locStamp !== S.locStamp;
			if ((changed.length || locChanged) && S.onDiskChange) {
				changed.forEach((f) => (S.versions[f] = st.versions[f]));
				if (locChanged) S.locStamp = st.locStamp;
				await S.onDiskChange({ files: changed, loc: !!locChanged });
			}
		} catch (e) {
			const pill = $("claudePill");
			if (pill) { pill.className = "pill off"; pill.textContent = "Stüdyo sunucusu kapalı"; }
		} finally { S.polling = false; }
	}
	function watch(filesFn, onChange) { S.watchFiles = filesFn; S.onDiskChange = onChange; }
	function known(file, version, locStamp) { if (file) S.versions[file] = version; if (locStamp) S.locStamp = locStamp; }

	/* ---------------- Claude send box ---------------- */
	function sendBox(container, opts) {
		const box = document.createElement("div");
		box.className = "sendBox";
		const ids = opts.ids();
		const names = opts.names ? opts.names() : ids;
		const draftKey = opts.kind;
		const quick = QUICK[opts.kind] || QUICK.file;
		/* the box stays folded to one line until it is wanted, so it does not cover the form above it */
		const folded = () => { try { return localStorage.getItem("studio.claude.box") !== "open"; } catch (e) { return true; } };
		box.classList.toggle("folded", folded() && !(S.drafts[draftKey] || "").trim());
		box.innerHTML = `<h3 class="sendHead" title="Aç / kapat"><span>Claude'a gönder</span><span class="sendToggle"></span></h3>
			<div class="sendBody"><div class="small">${ids.length ? `Gönderilecek: ${names.slice(0, 6).map(esc).join(", ")}${names.length > 6 ? ` ve ${names.length - 6} öğe daha` : ""}` : "Öğe seçili değil: istek tüm dosya için gider."}</div>
			<div class="qchips">${quick.map((q, i) => `<button data-q="${i}">${esc(q[0])}</button>`).join("")}</div>
			<textarea rows="3" placeholder="Ne istiyorsun? Örn: buna 2 sivil fabrika ekle">${esc(S.drafts[draftKey] || "")}</textarea>
			<div class="row" style="margin-top:6px"><button class="primary sendBtn">Gönder (Ctrl+Enter)</button></div>
			<div class="warn sendWarn" style="display:${(S.claude.listener || {}).alive ? "none" : ""}">Claude şu an dinlemiyor. İstek sırada bekler; terminalde Claude'a <b>editörü dinle</b> yaz.</div></div>`;
		container.appendChild(box);
		box.querySelector(".sendHead").onclick = () => {
			const now = box.classList.toggle("folded");
			try { localStorage.setItem("studio.claude.box", now ? "folded" : "open"); } catch (e) { /* private mode */ }
			if (!now) box.querySelector("textarea").focus();
		};
		const ta = box.querySelector("textarea");
		ta.addEventListener("input", () => (S.drafts[draftKey] = ta.value));
		ta.addEventListener("keydown", (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); send(); } });
		box.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => {
			const q = quick[+b.dataset.q][1];
			S.drafts[draftKey] = (S.drafts[draftKey] || "").trim() ? S.drafts[draftKey].trimEnd() + "\n" + q : q;
			ta.value = S.drafts[draftKey]; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
		}));
		box.querySelector(".sendBtn").onclick = send;
		async function send() {
			const text = (S.drafts[draftKey] || "").trim();
			if (!text) { toast("Önce ne istediğini yaz."); return; }
			if (opts.unsaved && opts.unsaved()) {
				if (!confirm("Kaydedilmemiş değişikliklerin var. Claude diskteki dosyada çalıştığı için önce kaydedilecek. Devam edilsin mi?")) return;
				if (!(await opts.save())) return;
			}
			try {
				const r = await api("/api/claude/request", { kind: opts.kind, file: opts.file(), ids: opts.ids(), text, context: opts.context ? opts.context() : {} });
				S.drafts[draftKey] = ""; ta.value = "";
				S.lastStatuses.set(r.id, r.status);
				const listening = (S.claude.listener || {}).alive;
				toast("Claude'a gönderildi." + (listening ? "" : "\nClaude şu an dinlemiyor; terminalde Claude'a 'editörü dinle' yaz. İstek sırada bekliyor."), !listening, 6000);
				await poll(true);
			} catch (e) { toast("Gönderilemedi: " + e.message, true, 8000); }
		}
		return box;
	}

	/* ---------------- icon picker (with image generation through Claude) ----------------
	 * pickIcon({ prefix, query, focus, gen }) resolves to { name, shine } or null. With `gen`
	 * ({ family, families?, kind, file, id, context? }) the picker can queue an "image" request: Claude
	 * makes the art with hoi4-imagegen, registers the sprite and replies with its name, and the picker
	 * lists the sprites of finished requests of that family first. The element itself is not edited. */
	const FAMILY_LABELS = {
		focus: "Odak ikonu (100×88, parlama eşiyle)", idea_spirit: "Milli ruh resmi (60×68)", decision: "Karar ikonu (33×32)",
		decision_category_icon: "Karar kategorisi ikonu", decision_category_picture: "Karar kategorisi resmi",
		report_event: "Olay resmi (210×176)", news_event: "Haber olayı resmi (397×153, siyah-beyaz)",
		leader_portrait: "Lider portresi", commander_portrait: "Komutan portresi", advisor_card: "Danışman kartı (65×67)",
	};
	let pickResolve = null, iconTimer = null, pickPrefix = "", pickFocus = false, pickGen = null, genTimer = null;
	function pickIcon({ prefix = "", query = "", focus = false, gen = null } = {}) {
		pickPrefix = prefix; pickFocus = focus; pickGen = gen;
		$("iconModal").style.display = "flex";
		$("iconGenToggle").style.display = gen ? "" : "none";
		$("iconGen").style.display = "none";
		if (gen) setupGen(gen);
		const box = $("iconSearch");
		box.value = query; box.focus(); box.select();
		searchIcons();
		if (!pickIcon.bound) {
			pickIcon.bound = true;
			box.addEventListener("input", () => { clearTimeout(iconTimer); iconTimer = setTimeout(searchIcons, 250); });
			$("iconClose").onclick = () => closePicker(null);
			$("iconGrid").addEventListener("click", (ev) => {
				const c = ev.target.closest(".cell"); if (!c) return;
				closePicker({ name: c.dataset.n, shine: c.dataset.shine !== "0" });
			});
			$("iconGenToggle").onclick = () => {
				const panel = $("iconGen"), open = panel.style.display === "none";
				panel.style.display = open ? "" : "none";
				if (open) $("genText").focus();
			};
			$("genGo").onclick = startGen;
			$("genFamily").onchange = () => { showGenStatus(); searchIcons(); };
			$("genText").addEventListener("input", () => (S.genDraft = $("genText").value));
			$("genText").addEventListener("keydown", (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); startGen(); } });
		}
		return new Promise((resolve) => (pickResolve = resolve));
	}
	function closePicker(value) {
		$("iconModal").style.display = "none"; clearInterval(genTimer);
		if (pickResolve) { pickResolve(value); pickResolve = null; }
	}
	const genFamily = () => (pickGen ? $("genFamily").value || pickGen.family : null);
	function setupGen(gen) {
		const families = gen.families && gen.families.length ? gen.families : [gen.family];
		$("genFamily").innerHTML = families.map((f) => `<option value="${esc(f)}" ${f === gen.family ? "selected" : ""}>${esc(FAMILY_LABELS[f] || f)}</option>`).join("");
		$("genInfo").textContent = gen.id ? `${gen.id} için` : "";
		$("genText").value = S.genDraft || "";
		showGenStatus();
		clearInterval(genTimer); genTimer = setInterval(showGenStatus, 1500);
	}
	async function startGen() {
		const text = $("genText").value.trim();
		if (!text) { toast("Önce ne çizileceğini yaz."); return; }
		const last = (S.claude.requests || []).find((r) => r.id === S.genRequest);
		const follow = last && last.status === "needs_info" ? `(Önceki istek ${last.id} hakkında) ` : "";
		try {
			const r = await api("/api/claude/request", { kind: "image", file: pickGen.file, ids: pickGen.id ? [pickGen.id] : [], text: follow + text,
				context: { family: genFamily(), for: pickGen.kind || "", ...(pickGen.context || {}) } });
			S.genRequest = r.id; S.genDraft = ""; $("genText").value = "";
			S.lastStatuses.set(r.id, r.status);
			await poll(true);
			showGenStatus();
		} catch (e) { toast("Gönderilemedi: " + e.message, true, 8000); }
	}
	function showGenStatus() {
		if ($("iconModal").style.display !== "flex") { clearInterval(genTimer); return; }
		const el = $("genStatus"), listening = (S.claude.listener || {}).alive;
		const r = (S.claude.requests || []).find((x) => x.id === S.genRequest);
		const deaf = listening ? "" : ` <span class="warn">Claude şu an dinlemiyor; terminalde Claude'a <b>editörü dinle</b> yaz.</span>`;
		const msg = r && r.reply && r.reply.message ? esc(r.reply.message) : "";
		if (!r) el.innerHTML = listening ? "Claude dinliyor." : deaf;
		else if (r.status === "pending") el.innerHTML = "Sırada bekliyor…" + deaf;
		else if (r.status === "working") el.innerHTML = "Claude görseli üretiyor…";
		else if (r.status === "done") {
			el.innerHTML = `<b style="color:var(--ok)">Hazır.</b> ${msg}`;
			if (S.genShown !== r.id) { S.genShown = r.id; searchIcons(); }
		} else if (r.status === "needs_info") el.innerHTML = `<b style="color:var(--claude)">Claude soruyor:</b> ${msg} <span class="small">Cevabını yukarıya yazıp yeniden gönder.</span>`;
		else el.innerHTML = `${esc(STATUS_LABELS[r.status] || r.status)}${msg ? ": " + msg : ""}`;
	}
	/* sprites made by finished image requests of the picker's family, newest first */
	function generatedSprites() {
		const family = genFamily();
		if (!family) return [];
		const names = (S.claude.requests || []).filter((r) => r.kind === "image" && r.status === "done" && (r.context || {}).family === family)
			.flatMap((r) => (r.reply && r.reply.items) || []);
		return [...new Set(names)];
	}
	async function searchIcons() {
		const q = $("iconSearch").value.trim();
		const { names, noShine, extra } = await api(`/api/icons?limit=300&prefix=${encodeURIComponent(pickPrefix)}&q=${encodeURIComponent(q)}&extra=${encodeURIComponent(generatedSprites().join(","))}`);
		const bad = new Set(noShine || []), fresh = extra || [];
		const focusMode = pickFocus;
		const cell = (n, isFresh) => `<div class="cell${focusMode && bad.has(n) ? " noshine" : ""}${isFresh ? " fresh" : ""}" data-n="${esc(n)}" data-shine="${bad.has(n) ? 0 : 1}">
			<img loading="lazy" src="${iconUrl(n)}" onerror="this.style.opacity=.15"><div>${esc(n.replace(/^GFX_/, ""))}</div>
			${focusMode && bad.has(n) ? `<div class="ns">odak ikonu değil</div>` : ""}</div>`;
		const rest = names.filter((n) => !fresh.includes(n));
		$("iconGrid").innerHTML = (fresh.length ? `<div class="genHead">✨ Claude'un ürettikleri</div>${fresh.map((n) => cell(n, true)).join("")}<div class="genHead muted">Tüm ikonlar</div>` : "")
			+ (rest.map((n) => cell(n, false)).join("") || `<div class="small">Sonuç yok.</div>`);
	}

	/* ---------------- references ---------------- */
	async function refs(id, skip) {
		const q = new URLSearchParams({ id });
		if (skip) { q.set("skipfile", skip.file); q.set("from", skip.from); q.set("to", skip.to); }
		const { refs: rows } = await api("/api/refs?" + q.toString());
		return rows;
	}
	function pageFor(file) {
		if (file.startsWith("common/national_focus/")) return "/focus.html?file=" + encodeURIComponent(file);
		if (file.startsWith("events/")) return "/events.html?file=" + encodeURIComponent(file);
		if (file.startsWith("common/decisions/categories/")) return "/decisions.html?catfile=" + encodeURIComponent(file);
		if (file.startsWith("common/decisions/")) return "/decisions.html?file=" + encodeURIComponent(file);
		if (file.startsWith("common/ideas/")) return "/ideas.html?file=" + encodeURIComponent(file);
		if (file.startsWith("common/characters/")) return "/characters.html?file=" + encodeURIComponent(file);
		if (/^history\/countries\/[A-Z][A-Z0-9]{2}/.test(file)) return "/countries.html?tag=" + file.split("/").pop().slice(0, 3);
		return null;
	}
	function refsHtml(rows) {
		if (!rows.length) return `<div class="small">Başka bir yerde kullanılmıyor.</div>`;
		return rows.map((r) => {
			const page = pageFor(r.file);
			const where = `${esc(r.file)}:${r.line}`;
			return `<div style="margin-bottom:4px"><div class="small">${page ? `<a href="${esc(page)}&line=${r.line}">${where}</a>` : where}</div><code>${esc(r.text)}</code></div>`;
		}).join("");
	}

	/* ---------------- form dialog ----------------
	 * ask({ title, intro, ok, fields, onChange }) resolves to { key: value } or null. A field is
	 * { key, label, help, placeholder, value, optional, check(value, all) -> error text } with a type:
	 *   "text"    one line (auto: true lets onChange's set() fill it until the user types in it)
	 *   "id"      a script id built from field `from` as prefix + slug until the user types one (prefix: text or fn(all))
	 *   "select"  options: [[value, label]]
	 *   "choice"  options: [[value, label, help]] as large buttons
	 * onChange(all, set) runs after every edit; set(key, value) fills a field the user has not typed in. */
	const slug = (name) => String(name).replace(/ı/g, "i").replace(/İ/g, "I").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	let askDone = null;
	function closeAsk(value) { $("askModal").style.display = "none"; if (askDone) { askDone(value); askDone = null; } }
	function ask({ title, intro = "", ok = "Oluştur", fields, onChange = null }) {
		const V = {}, touched = new Set(), body = $("askBody");
		for (const f of fields) V[f.key] = f.value ?? (f.options ? (f.options[0] || [""])[0] : "");
		const box = (key) => body.querySelector(`[data-k="${key}"]`);
		const set = (key, value) => { if (touched.has(key)) return; V[key] = value; const el = box(key); if (el) el.value = value; };
		const autoIds = () => fields.filter((f) => f.type === "id" && f.from).forEach((f) => {
			const source = String(V[f.from] || "").trim();
			set(f.key, source ? (typeof f.prefix === "function" ? f.prefix(V) : f.prefix || "") + slug(source) : "");
		});
		$("askTitle").textContent = title;
		body.innerHTML = (intro ? `<div class="small" style="margin-bottom:8px">${intro}</div>` : "") + fields.map((f) => {
			const label = `<label>${esc(f.label)}${f.help ? ` <span class="small">${esc(f.help)}</span>` : ""}</label>`;
			if (f.type === "select") return `<div class="field">${label}<select data-k="${esc(f.key)}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === V[f.key] ? "selected" : ""}>${esc(l ?? v)}</option>`).join("")}</select></div>`;
			if (f.type === "choice") return `<div class="field">${label}<div class="slotPick">${f.options.map(([v, l, h]) => `<button type="button" data-c="${esc(f.key)}" data-v="${esc(v)}" class="${v === V[f.key] ? "on" : ""}"><b>${esc(l ?? v)}</b>${h ? `<span>${esc(h)}</span>` : ""}</button>`).join("")}</div></div>`;
			return `<div class="field">${label}<input data-k="${esc(f.key)}" value="${esc(V[f.key])}" placeholder="${esc(f.placeholder || "")}" autocomplete="off"></div>`;
		}).join("") + `<div class="row" style="margin-top:10px"><span class="small">Enter: ${esc(ok.toLowerCase())} · Esc: vazgeç</span><button class="primary fixed" id="askOk">${esc(ok)}</button></div>`;
		autoIds();
		const edited = () => { autoIds(); if (onChange) onChange(V, set); };
		body.querySelectorAll("[data-k]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
			const f = fields.find((x) => x.key === el.dataset.k);
			V[f.key] = el.value;
			if (f.type === "id" || f.auto) { if (el.value.trim()) touched.add(f.key); else touched.delete(f.key); }
			edited();
		}));
		body.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
			V[b.dataset.c] = b.dataset.v;
			body.querySelectorAll(`[data-c="${b.dataset.c}"]`).forEach((x) => x.classList.toggle("on", x === b));
			edited();
		}));
		const submit = () => {
			for (const f of fields) {
				const value = String(V[f.key] ?? "").trim();
				let problem = !value && !f.optional ? `${f.label} boş bırakılamaz.` : "";
				if (!problem && value && f.type === "id" && !/^[A-Za-z0-9_.\-]+$/.test(value)) problem = "Kimlik (id) yalnızca harf, rakam, _ ve . içerebilir; boşluk ve Türkçe harf olmaz.";
				if (!problem && f.check) problem = f.check(value, V) || "";
				if (problem) { toast(problem, true, 5000); const el = box(f.key); if (el) el.focus(); return; }
				V[f.key] = value;
			}
			closeAsk({ ...V });
		};
		$("askOk").onclick = submit;
		body.onkeydown = (ev) => { if (ev.key === "Enter" && ev.target.tagName !== "BUTTON") { ev.preventDefault(); submit(); } };
		$("askModal").style.display = "flex";
		const first = body.querySelector("input, select"); if (first) { first.focus(); if (first.select) first.select(); }
		return new Promise((resolve) => (askDone = resolve));
	}

	/* ---------------- help ---------------- */
	const HELP = {
		home: ["Bir kartı tıklayıp ilgili editörü aç.", "Üstteki arama kutusu modun tamamında id ya da isim arar; sonucu tıklayınca doğru sayfada açılır."],
		focus: ["Odağı sürükleyerek taşı; tıklayınca sağda ödülü, önkoşulları, ikonu ve metni açılır.", "＋ Odak ekle seçili odağın altına yeni bir odak koyar; isim yazman yeterli, kimlik (id) kendiliğinden oluşur.", "Ctrl+Z son işlemi geri alır."],
		ideas: ["Soldan bir ruh seç; ortada oyundaki ipucu kartını, sağda resmini, metnini ve modifier tablosunu görürsün.", "＋ Yeni ile isim yazman yeterli; kimlik (id) kendiliğinden oluşur."],
		decisions: ["Kararlar kategorilerine göre listelenir. Kategori başlığına tıklayınca kategorinin kendisi düzenlenir.", "Önce kategori, sonra içine karar oluştur."],
		events: ["Ortada olayın oyundaki penceresi görünür; Zincir sekmesi bu olayın hangi olayları tetiklediğini gösterir.", "＋ Yeni sıradaki boş olay numarasını kendisi önerir."],
		countries: ["Soldan ülke seç. Sağda başkent, siyaset, popülerlik, ruhlar, teknolojiler, danışmanlar ve karakterler düzenlenir.", "＋ Danışman ekle kişiyi oluşturur, ülkeye işe alır ve istersen göreve başlatır.", "Bayrak kutusundaki Resim yükle bir resmi oyunun üç bayrak boyutuna çevirir."],
		characters: ["Üstteki dosya seçicisinden ülkenin karakter dosyasını seç.", "Portre kutusuna tıklayınca portre seçici açılır. Danışmanlık bölümünde görev, maliyet ve özellikler form olarak düzenlenir."],
		health: ["Hızlı kontrol yalnızca son kaydettiğin dosyalara bakar; tam kontrol tüm modu tarar.", "Bir bulguya tıklayınca ilgili öğe kendi editöründe açılır."],
	};
	function showHelp(page) {
		const tips = HELP[page] || [];
		$("helpBody").innerHTML = `${tips.length ? `<div class="step"><div class="t">Bu sayfa</div><ul class="helpList">${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
			<div class="step"><div class="t">Her sayfada</div><ul class="helpList">
				<li><b>Kaydet</b> (Ctrl+S) yalnızca değiştirdiğin satırları yazar ve önce yedek alır. Kaydetmeden sayfadan çıkarsan uyarılırsın.</li>
				<li>Renkli çerçeveler: <span style="color:#d9b56a">sarı</span> değiştirilmiş, <span style="color:#6ccf7d">yeşil</span> yeni eklenmiş, soluk ve üstü çizili kaldırılmış demektir. Kaldırılanı <b>Geri al</b> ile geri getirebilirsin.</li>
				<li><b>Ham kod</b> bölümü öğenin oyun dosyasındaki tam hâlidir; formda olmayan bir şeyi buradan düzenleyebilirsin.</li>
				<li>“oyunun dosyası” yazan bir öğeyi düzenlersen dosya önce moda kopyalanır; oyunun kendi dosyasına dokunulmaz.</li>
				<li>Bir şey yanlış giderse eski hâli <code>.tmp/mod_studio/backups/</code> klasöründe tarih sırasıyla durur.</li></ul></div>
			<div class="step"><div class="t">Claude'a iş verme</div><ul class="helpList">
				<li>Bir öğe seç, sağ alttaki <b>Claude'a gönder</b> kutusuna ne istediğini yaz. Hazır düğmeler cümleyi senin yerine başlatır.</li>
				<li>Sağ üstte “Claude: dinliyor” yazmıyorsa terminalde Claude'a <b>editörü dinle</b> yaz.</li>
				<li>Claude bitirince sayfa kendiliğinden yenilenir; değişen öğeler mor ✦ ile işaretlenir.</li></ul></div>`;
		$("helpModal").style.display = "flex";
	}

	/* ---------------- script text helpers (block bodies edited as text) ---------------- */
	const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const unq = (v) => String(v ?? "").replace(/^"|"$/g, "");
	function splitComment(line) { const i = line.indexOf("#"); return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i)]; }
	const stripComments = (body) => body.split("\n").map((l) => splitComment(l)[0]).join("\n");
	/* value of `key = value` inside a block body (comments ignored) */
	function kvGet(body, key) {
		const m = stripComments(body).match(new RegExp("(?:^|\\s)" + reEsc(key) + "\\s*=\\s*(\"[^\"]*\"|[^\\s{}]+)"));
		return m ? unq(m[1]) : "";
	}
	/* set `key = value` inside a block body, keeping everything else; appended when missing, removed when value is empty */
	function kvSet(body, key, value) {
		const re = new RegExp("(^|\\s)(" + reEsc(key) + "\\s*=\\s*)(\"[^\"]*\"|[^\\s{}#]+)");
		const lines = body.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const [code, rest] = splitComment(lines[i]);
			if (!re.test(code)) continue;
			if (value === "" || value === null) {
				const left = code.replace(re, "$1").replace(/\s+$/, "");
				if (!left.trim() && !rest) lines.splice(i, 1); else lines[i] = left + rest;
			} else lines[i] = code.replace(re, (_, a, b) => a + b + value) + rest;
			return lines.join("\n");
		}
		if (value === "" || value === null) return body;
		return (body.trim() ? body.replace(/\s*$/, "") + "\n" : "") + `${key} = ${value}`;
	}
	/* the word list of `key = { a b c }` inside a block body */
	function listGet(body, key) {
		const m = stripComments(body).match(new RegExp("(?:^|\\s)" + reEsc(key) + "\\s*=\\s*\\{([^{}]*)\\}"));
		return m ? m[1].split(/\s+/).filter(Boolean) : [];
	}
	/* replace (or append) `key = { ... }` with one word per line; inner `{}` blocks are not expected */
	function listSet(body, key, words) {
		const text = `${key} = {\n${words.map((w) => "\t" + w).join("\n")}\n}`;
		const re = new RegExp("(^|\\n)([ \\t]*)" + reEsc(key) + "\\s*=\\s*\\{[^{}]*\\}");
		if (re.test(body)) return body.replace(re, (_, a, ind) => a + ind + text.split("\n").join("\n" + ind));
		return (body.trim() ? body.replace(/\s*$/, "") + "\n" : "") + text;
	}

	/* ---------------- advisors: slots and the trait chooser ---------------- */
	const ADVISOR_SLOTS = [
		{ id: "political_advisor", label: "Siyasi danışman", help: "Siyaset sekmesindeki 3 siyasi danışman yuvasından birine oturur." },
		{ id: "theorist", label: "Teorisyen", help: "Tek yuva; genellikle bir doktrin dalının araştırmasını hızlandırır." },
		{ id: "army_chief", label: "Kara kuvvetleri komutanı", help: "Tek yuva; kara ordusuna bonus verir." },
		{ id: "navy_chief", label: "Deniz kuvvetleri komutanı", help: "Tek yuva; donanmaya bonus verir." },
		{ id: "air_chief", label: "Hava kuvvetleri komutanı", help: "Tek yuva; hava kuvvetlerine bonus verir." },
		{ id: "high_command", label: "Yüksek komuta", help: "3 yüksek komuta yuvasından birine oturur; belli birlik türlerine bonus verir." },
	];
	const SLOT_LABELS = Object.fromEntries(ADVISOR_SLOTS.map((s) => [s.id, s.label]));
	const SLOT_LEDGER = { army_chief: "army", navy_chief: "navy", air_chief: "air" };
	const LEDGERS = [["", "Yok"], ["army", "Kara"], ["navy", "Deniz"], ["air", "Hava"]];
	let traitData = null;
	function advisorTraits() {
		if (!traitData) traitData = api("/api/country/advisortraits").catch((e) => { traitData = null; throw e; });
		return traitData;
	}
	const traitLabel = (data, t) => { const n = data && data.names ? data.names[t] : ""; return n && n !== t ? n : t; };
	/* traitChooser(el, { slot, selected: [ids], tag, onChange(list) }): chips of the chosen traits, the traits
	 * the game's and the mod's advisors use in that slot as one-click buttons, and a search over all. */
	let chooserCount = 0;
	function traitChooser(el, opts) {
		const id = "trAll" + ++chooserCount;
		let slot = opts.slot, selected = [...(opts.selected || [])], filter = "";
		async function draw() {
			let data = null;
			try { data = await advisorTraits(); } catch (e) { /* the search box still works with ids */ }
			const label = (t) => traitLabel(data, t);
			/* the country's own traits (TAG_...) first, then the most used ones */
			const own = opts.tag ? (t) => t.startsWith(opts.tag + "_") : () => false;
			const pool = data ? data.bySlot[slot] || [] : [];
			const used = [...pool.filter(own), ...pool.filter((t) => !own(t))].filter((t) => !selected.includes(t));
			const q = filter.toLowerCase();
			const shown = used.filter((t) => !q || t.toLowerCase().includes(q) || label(t).toLowerCase().includes(q));
			el.innerHTML = `<div class="chips">${selected.map((t, i) => `<span class="chip chipx sel" title="${esc(t)}">${esc(label(t))}<button type="button" data-rm="${i}" title="Kaldır">✕</button></span>`).join("")
					|| `<span class="small">Henüz özellik seçilmedi.</span>`}</div>
				<div class="row" style="margin-top:6px"><input data-q placeholder="Özellik ara (isim ya da id)…" value="${esc(filter)}" list="${id}"><button type="button" class="fixed" data-addin title="Yazdığın id'yi ekle">Ekle</button></div>
				<datalist id="${id}">${data ? data.all.map((t) => `<option value="${esc(t)}">${esc(label(t))}</option>`).join("") : ""}</datalist>
				${shown.length ? `<div class="small" style="margin:6px 0 2px">${SLOT_LABELS[slot] ? esc(SLOT_LABELS[slot]) + " görevinde" : "Bu görevde"} kullanılan özellikler · tıkla, eklensin:</div>
					<div class="traitOpts">${shown.slice(0, 80).map((t) => `<button type="button" data-add="${esc(t)}" title="${esc(t)}">${esc(label(t))}</button>`).join("")}</div>`
					: data && !used.length ? `<div class="small" style="margin-top:4px">Bu görevde kullanılmış özellik bulunamadı; arama kutusundan seç.</div>` : ""}`;
			const set = (list) => { selected = list; if (opts.onChange) opts.onChange([...selected]); draw(); };
			el.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => set(selected.filter((_, i) => i !== +b.dataset.rm))));
			el.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => { filter = ""; set([...selected, b.dataset.add]); }));
			const box = el.querySelector("[data-q]");
			const addTyped = () => {
				const v = box.value.trim();
				if (!/^[A-Za-z0-9_.\-]+$/.test(v)) { toast("Listeden bir özellik seç ya da geçerli bir id yaz.", true); return; }
				if (data && !data.all.includes(v) && !Object.values(data.bySlot).some((l) => l.includes(v))) { toast(`${v} adında bir özellik bulunamadı.`, true); return; }
				if (selected.includes(v)) { toast("Bu özellik zaten ekli."); return; }
				filter = ""; set([...selected, v]);
			};
			box.addEventListener("input", () => {
				if (data && data.all.includes(box.value.trim()) && !selected.includes(box.value.trim())) { addTyped(); return; }
				filter = box.value; const pos = box.selectionStart; draw().then(() => { const n = el.querySelector("[data-q]"); n.focus(); n.setSelectionRange(pos, pos); });
			});
			box.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addTyped(); } });
			el.querySelector("[data-addin]").onclick = addTyped;
		}
		draw();
		return { setSlot: (s) => { slot = s; draw(); }, get: () => [...selected] };
	}

	return {
		TOKEN, $, esc, clone, iconUrl, textureUrl, imageUrl, toast, api, locHtml, codeArea, initNav, watch, known, sendBox, pickIcon, refs, refsHtml, pageFor,
		poll, MODULE_LABELS, ask, slug, kvGet, kvSet, listGet, listSet, stripComments, unq,
		ADVISOR_SLOTS, SLOT_LABELS, SLOT_LEDGER, LEDGERS, advisorTraits, traitLabel, traitChooser,
		set unsaved(fn) { S.unsaved = fn; },
		set onSelect(fn) { S.onSelect = fn; },
		get claude() { return S.claude; },
	};
})();

/* ===================================================================== */
/* ItemEditor: generic form for one block item                            */
/* ===================================================================== */
class ItemEditor {
	/* cfg: {
	 *   scalars: { key: { label, type: "bool"|"number"|"text"|"sprite", prefix, help } }  known single values
	 *   blocks:  { key: { label, help } }                                               known sub-blocks
	 *   special: { key: true }   keys drawn by the page (renderSpecial) instead of the generic form
	 *   locFields(model): [{ key, label, multiline }]
	 *   renderSpecial(editor, container)  page part between the texts and the generic fields
	 *   onChange(editor)                  called after every edit (preview refresh, dirty marker)
	 * } */
	constructor(container, cfg) {
		this.el = container; this.cfg = cfg; this.model = null; this.entries = []; this.loc = {}; this.locSeed = {}; this.raw = null;
	}
	load(model) {
		this.model = model;
		this.entries = model.entries.filter((e) => e.key).map((e) => ({ ...e, orig: e.type === "block" ? e.body : e.value, removed: false, isNew: false }));
		this.loc = Studio.clone(model.loc || {});
		this.locSeed = {};
		this.raw = null;
		this.render();
	}
	/* The text a key has on disk. Texts the item does not list itself (tooltips written inside the script
	 * builder) are fetched when first shown and remembered in locSeed, so only real edits count as changes. */
	locBase(key) { return (this.model.loc || {})[key] ?? this.locSeed[key] ?? ""; }
	locApi() {
		return {
			get: (key) => this.loc[key],
			set: (key, text) => { this.loc[key] = text; this.changed(); },
			seed: (key, text) => { if (!(key in (this.model.loc || {}))) this.locSeed[key] = text; if (!(key in this.loc)) this.loc[key] = text; },
		};
	}
	/* script builder options shared by every block of this item (cfg.blocks[key].script) */
	builderOptions(info, text, onChange, disabled) {
		const scope = typeof info.scope === "function" ? info.scope(this) : info.scope === undefined ? "country" : info.scope;
		return { mode: info.script, scope, text, onChange, disabled, extra: info.extra || null, loc: this.locApi(),
			prefer: (this.model.id.match(/^([A-Za-z0-9]+_)/) || [])[1] || "", idBase: this.model.id.replace(/[^A-Za-z0-9_]/g, "_") };
	}
	get(key, occ = 0) { return this.entries.find((e) => e.key === key && e.occ === occ && !e.removed) || null; }
	all(key) { return this.entries.filter((e) => e.key === key && !e.removed); }
	scalar(key, fallback = "") { const e = this.get(key); return e && e.type === "scalar" ? String(e.value).replace(/^"|"$/g, "") : fallback; }
	setScalar(key, value) {
		let e = this.entries.find((x) => x.key === key && x.type === "scalar");
		if (value === null || value === "") {
			if (e) { if (e.isNew) this.entries.splice(this.entries.indexOf(e), 1); else e.removed = true; }
		} else if (e) { e.value = value; e.removed = false; }
		else this.entries.push({ key, occ: this.countOrig(key) + this.entries.filter((x) => x.key === key && x.isNew).length, type: "scalar", value, orig: null, removed: false, isNew: true });
		this.changed();
	}
	setBlock(key, body, occ = 0) {
		const e = this.entries.find((x) => x.key === key && x.occ === occ && x.type === "block");
		if (e) { e.body = body; e.removed = false; }
		else this.entries.push({ key, occ: this.countOrig(key) + this.entries.filter((x) => x.key === key && x.isNew).length, type: "block", body, orig: null, removed: false, isNew: true });
		this.changed();
	}
	addBlock(key, body) {
		const entry = { key, occ: this.countOrig(key) + this.entries.filter((x) => x.key === key && x.isNew).length, type: "block", body, orig: null, removed: false, isNew: true };
		this.entries.push(entry);
		this.changed();
		return entry;
	}
	/* one more occurrence of a repeatable single value (recruit_character = X); setScalar edits the first one */
	addScalar(key, value) {
		const entry = { key, occ: this.countOrig(key) + this.entries.filter((x) => x.key === key && x.isNew).length, type: "scalar", value, orig: null, removed: false, isNew: true };
		this.entries.push(entry);
		this.changed();
		return entry;
	}
	remove(entry) { if (entry.isNew) this.entries.splice(this.entries.indexOf(entry), 1); else entry.removed = true; this.changed(); }
	countOrig(key) { return this.entries.filter((x) => x.key === key && !x.isNew).length; }
	/* known single values; cfg.scalarsFor(editor) lets a page offer different fields per item */
	knownScalars() { return (this.cfg.scalarsFor ? this.cfg.scalarsFor(this) : this.cfg.scalars) || {}; }
	changed() { if (this.cfg.onChange) this.cfg.onChange(this); }
	dirty() {
		if (this.raw !== null) return true;
		if (this.entries.some((e) => e.isNew || e.removed || (e.type === "block" ? e.body !== e.orig : e.value !== e.orig))) return true;
		return Object.keys(this.loc).some((k) => (this.loc[k] || "") !== this.locBase(k));
	}
	payload() {
		const p = { file: this.model.file, id: this.model.id, version: this.model.version, ops: [], loc: {} };
		if (this.raw !== null) { p.raw = this.raw; p.ops = []; }
		else {
			for (const e of this.entries) {
				if (e.isNew) {
					if (e.removed) continue;
					p.ops.push(e.type === "block" ? { op: "add_block", key: e.key, body: e.body } : { op: "set", key: e.key, occ: e.occ, value: String(e.value) });
				} else if (e.removed) p.ops.push({ op: "remove", key: e.key, occ: e.occ });
				else if (e.type === "block" && e.body !== e.orig) p.ops.push({ op: "block", key: e.key, occ: e.occ, body: e.body });
				else if (e.type === "scalar" && e.value !== e.orig) p.ops.push({ op: "set", key: e.key, occ: e.occ, value: String(e.value) });
			}
		}
		for (const k of Object.keys(this.loc)) if ((this.loc[k] || "") !== this.locBase(k)) p.loc[k] = this.loc[k];
		return p;
	}
	render() {
		const cfg = this.cfg, m = this.model, esc = Studio.esc;
		const locFields = cfg.locFields ? cfg.locFields(this) : [];
		this.el.innerHTML = `
			${m.vanilla ? `<div class="banner">Bu dosya oyunun kendi dosyası. Kaydedince moda kopyalanır ve kopya düzenlenir.</div>` : ""}
			${this.raw !== null ? `<div class="warn">Ham kod değiştirildi: alanlar kilitli. Kaydedince ham kod olduğu gibi yazılır.</div>` : ""}
			<div id="ieLoc"></div><div id="ieSpecial"></div>
			<h3>Alanlar</h3><div id="ieScalars"></div>
			<h3>Bloklar</h3><div id="ieBlocks"></div>
			<div class="section"><div class="head"><b>Alan ekle</b></div>
				<div class="row"><input id="ieNewKey" list="ieKeys" placeholder="anahtar (ör. cost, cancel, ai_will_do)"><select id="ieNewType" class="fixed"><option value="scalar">değer</option><option value="block">blok</option></select><button id="ieAdd" class="fixed">Ekle</button></div>
				<datalist id="ieKeys">${[...Object.keys(this.knownScalars()), ...Object.keys(cfg.blocks || {})].map((k) => `<option value="${esc(k)}">`).join("")}</datalist></div>
			<details ${this.raw !== null ? "open" : ""}><summary>Ham kod (bloğun tamamı)</summary>
				<textarea id="ieRaw" class="code" rows="16" spellcheck="false">${esc(this.raw !== null ? this.raw : m.raw)}</textarea>
				<div class="row" style="margin-top:6px"><button id="ieRawApply" class="fixed">Ham kodu uygula</button>${this.raw !== null ? `<button id="ieRawUndo" class="fixed">Ham kodu geri al</button>` : ""}</div>
				<div class="small">Süslü parantezler dengeli kalmalı ve öğenin kimliği değişmemeli.</div></details>`;
		const locEl = this.el.querySelector("#ieLoc");
		if (locFields.length) {
			locEl.innerHTML = `<h3>Metin (İngilizce)</h3>` + locFields.map((f, i) => `<div class="field"><label>${esc(f.label)} <span class="small">(${esc(f.key)})${(m.locInMod || {})[f.key] === false && (m.loc || {})[f.key] ? " · oyundan" : ""}</span></label>
				${f.multiline ? `<textarea data-loc="${i}" rows="4">${esc(this.loc[f.key] || "")}</textarea>` : `<input data-loc="${i}" value="${esc(this.loc[f.key] || "")}">`}</div>`).join("");
			locEl.querySelectorAll("[data-loc]").forEach((el) => el.addEventListener("input", () => { this.loc[locFields[+el.dataset.loc].key] = el.value; this.changed(); }));
		}
		if (cfg.renderSpecial) cfg.renderSpecial(this, this.el.querySelector("#ieSpecial"));
		this.renderScalars(); this.renderBlocks();
		const lock = this.raw !== null;
		this.el.querySelectorAll("#ieScalars input, #ieScalars select, #ieBlocks textarea, #ieBlocks button, #ieAdd, #ieSpecial input, #ieSpecial textarea, #ieSpecial button, #ieSpecial select").forEach((x) => { if (lock) x.disabled = true; });
		this.el.querySelector("#ieAdd").onclick = () => {
			const key = this.el.querySelector("#ieNewKey").value.trim();
			if (!/^[A-Za-z0-9_\-.@:]+$/.test(key)) { Studio.toast("Geçerli bir anahtar yaz.", true); return; }
			const known = this.knownScalars()[key];
			const type = known ? "scalar" : (cfg.blocks || {})[key] ? "block" : this.el.querySelector("#ieNewType").value;
			if (type === "scalar") this.setScalar(key, known && known.type === "bool" ? "yes" : "0");
			else this.addBlock(key, "");
			this.render();
		};
		Studio.codeArea(this.el.querySelector("#ieRaw"));
		this.el.querySelector("#ieRawApply").onclick = () => { this.raw = this.el.querySelector("#ieRaw").value; this.changed(); this.render(); };
		const undo = this.el.querySelector("#ieRawUndo"); if (undo) undo.onclick = () => { this.raw = null; this.changed(); this.render(); };
	}
	renderScalars() {
		const cfg = this.cfg, esc = Studio.esc, box = this.el.querySelector("#ieScalars");
		const special = cfg.special || {};
		const known = this.knownScalars();
		const rows = [];
		for (const [key, info] of Object.entries(known)) {
			if (special[key]) continue;
			const e = this.entries.find((x) => x.key === key && x.type === "scalar" && !x.removed);
			rows.push({ key, info, e });
		}
		/* unknown values get one row per occurrence, each bound to its own entry (set_country_flag = A, set_country_flag = B) */
		for (const e of this.entries) if (e.type === "scalar" && !e.removed && !known[e.key] && !special[e.key]) rows.push({ key: e.key, info: { label: e.key, type: "text" }, e, own: true });
		box.innerHTML = rows.map((r, i) => {
			const v = r.e ? String(r.e.value).replace(/^"|"$/g, "") : "";
			const label = `${esc(r.info.label)} <span class="small">${esc(r.key)}${r.info.help ? " · " + esc(r.info.help) : ""}</span>`;
			if (r.info.type === "bool") return `<div class="field"><label><input type="checkbox" data-s="${i}" ${v === "yes" ? "checked" : ""}> ${label}</label></div>`;
			if (r.info.type === "sprite") return `<div class="field"><label>${label}</label><div class="row"><div class="iconPreview fixed" data-pick="${i}" title="İkon seç"><img src="${Studio.iconUrl((r.info.prefix && v && !v.startsWith("GFX_") ? r.info.prefix : "") + v)}" onerror="this.style.opacity=.15"></div>
				<div><input data-s="${i}" value="${esc(v)}" placeholder="(yok)"><button data-pick="${i}" style="margin-top:4px">İkon seç…</button></div></div></div>`;
			return `<div class="field"><label>${label}</label><input data-s="${i}" value="${esc(v)}" placeholder="${r.e ? "" : "(yok — yazınca eklenir)"}"></div>`;
		}).join("");
		box.querySelectorAll("[data-s]").forEach((el) => {
			const r = rows[+el.dataset.s];
			el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
				if (r.own) {
					const v = el.value.trim();
					r.e.removed = !v; if (v) r.e.value = v;
					this.changed(); return;
				}
				if (el.type === "checkbox") this.setScalar(r.key, el.checked ? "yes" : (r.e && !r.e.isNew ? "no" : null));
				else this.setScalar(r.key, el.value.trim() || null);
				r.e = this.entries.find((x) => x.key === r.key && x.type === "scalar" && !x.removed);
			});
		});
		box.querySelectorAll("[data-pick]").forEach((el) => el.addEventListener("click", async () => {
			const r = rows[+el.dataset.pick];
			/* info.family (a string or a function of the editor) offers image generation in the picker */
			const family = typeof r.info.family === "function" ? r.info.family(this) : r.info.family;
			const gen = family ? { family, families: r.info.families, kind: this.cfg.kind, file: this.model.file, id: this.model.id } : null;
			const picked = await Studio.pickIcon({ prefix: r.info.pickPrefix ?? r.info.prefix ?? "", query: r.info.query || "", gen });
			if (!picked) return;
			let value = picked.name;
			if (r.info.short && r.info.prefix && value.startsWith(r.info.prefix)) value = value.slice(r.info.prefix.length);
			this.setScalar(r.key, value); this.render();
		}));
	}
	renderBlocks() {
		const cfg = this.cfg, esc = Studio.esc, box = this.el.querySelector("#ieBlocks");
		if (!box) return;
		const special = cfg.special || {};
		const blocks = this.entries.filter((e) => e.type === "block" && !special[e.key]);
		const offer = Object.entries(cfg.blocks || {}).filter(([k]) => !special[k] && !blocks.some((b) => b.key === k && !b.removed));
		box.innerHTML = blocks.map((e, i) => {
			const info = (cfg.blocks || {})[e.key] || {};
			const cls = e.removed ? "removed" : e.isNew ? "added" : e.body !== e.orig ? "changed" : "";
			const rows = Math.min(18, Math.max(2, (e.body.match(/\n/g) || []).length + 2));
			/* a block of effects or triggers gets the visual builder, a block of modifiers a table; the rest stay text */
			const visual = typeof StudioScript !== "undefined" && StudioScript && !e.removed ? (info.script ? "sb" : info.table ? "mt" : "") : "";
			return `<div class="section ${cls}"><div class="head"><b>${esc(info.label || e.key)}</b><span class="k">${esc(e.key)}${this.all(e.key).length > 1 ? " #" + (e.occ + 1) : ""}</span><span class="spacer"></span>
				${e.removed ? `<button class="small" data-undo="${i}">Geri al</button>` : `<button class="small" data-del="${i}" title="Bu bloğu kaldır">Kaldır</button>`}</div>
				${info.help ? `<div class="small" style="margin-bottom:4px">${esc(info.help)}</div>` : ""}
				${visual ? `<div data-${visual}="${i}"></div>` : `<textarea class="code" data-b="${i}" rows="${rows}" spellcheck="false" ${e.removed ? "disabled" : ""}>${esc(e.body)}</textarea>`}</div>`;
		}).join("") + (offer.length ? `<div class="small" style="margin:4px 0">Eklenebilir: ${offer.map(([k, v]) => `<button class="small" data-offer="${esc(k)}" title="${esc(v.help || "")}">${esc(v.label || k)}</button>`).join(" ")}</div>` : "");
		const edited = (host, e, text) => {
			e.body = text;
			host.closest(".section").className = "section " + (e.isNew ? "added" : e.body !== e.orig ? "changed" : "");
			this.changed();
		};
		box.querySelectorAll("[data-sb]").forEach((host) => {
			const e = blocks[+host.dataset.sb];
			StudioScript.builder(host, this.builderOptions((cfg.blocks || {})[e.key], e.body, (text) => edited(host, e, text), this.raw !== null));
		});
		box.querySelectorAll("[data-mt]").forEach((host) => {
			const e = blocks[+host.dataset.mt], info = (cfg.blocks || {})[e.key];
			StudioScript.pairBlock(host, { of: info.table, add: info.add, body: e.body, onChange: (text) => edited(host, e, text), disabled: this.raw !== null });
		});
		box.querySelectorAll("textarea[data-b]").forEach((el) => {
			Studio.codeArea(el);
			el.addEventListener("input", () => {
				const e = blocks[+el.dataset.b]; e.body = el.value;
				el.closest(".section").className = "section " + (e.isNew ? "added" : e.body !== e.orig ? "changed" : "");
				this.changed();
			});
		});
		box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { this.remove(blocks[+b.dataset.del]); this.render(); }));
		box.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = () => { blocks[+b.dataset.undo].removed = false; this.changed(); this.render(); }));
		box.querySelectorAll("[data-offer]").forEach((b) => (b.onclick = () => {
			const template = ((cfg.blocks || {})[b.dataset.offer] || {}).template;
			this.addBlock(b.dataset.offer, typeof template === "function" ? template(this) : template || ""); this.render();
		}));
	}
}

/* ===================================================================== */
/* ItemPage: the three-pane page of idea / decision / event editors      */
/* ===================================================================== */
class ItemPage {
	/* cfg: { kind, label, group(row), iconOf(row), subOf(row), editor (ItemEditor cfg),
	 *        renderCenter(page, el), create(page) -> Promise<{id, name, meta}|null>, toolbar(page, el) } */
	constructor(cfg) {
		this.cfg = cfg; this.kind = cfg.kind; this.files = []; this.file = ""; this.list = null; this.id = null;
		this.item = null; this.filter = ""; this.marks = new Set(); this.vanilla = false;
		this.editor = null;
		this.previewTimer = null;
	}
	$(id) { return document.getElementById(id); }
	async init() {
		const params = new URLSearchParams(location.search);
		this.vanilla = localStorage.getItem(`studio.${this.kind}.vanilla`) === "1";
		this.buildToolbar();
		await this.loadFiles();
		let file = params.get("file") || localStorage.getItem(`studio.${this.kind}.file`) || "";
		if (!this.files.some((f) => f.file === file)) {
			if (file && params.get("file")) { this.vanilla = true; await this.loadFiles(); }
			if (!this.files.some((f) => f.file === file)) file = (this.files[0] || {}).file || "";
		}
		Studio.unsaved = () => !!(this.editor && this.item && this.editor.dirty());
		Studio.onSelect = (request, id) => { if (request.file === this.file) this.select(id || ((request.items || [])[0] || {}).id); };
		Studio.watch(() => [this.file], (change) => this.onDiskChange(change));
		document.addEventListener("keydown", (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); this.save(); } });
		if (file) await this.openFile(file, params.get("id"), params.get("line"));
	}
	buildToolbar() {
		const tb = this.$("toolbar");
		tb.innerHTML = `<b style="color:var(--gold)">${Studio.esc(this.cfg.label)}</b><span class="sep"></span>
			<select id="pFile" style="max-width:340px" title="Dosya"></select>
			<label class="small"><input type="checkbox" id="pVanilla" ${this.vanilla ? "checked" : ""}> oyunun dosyalarını da göster</label>
			<span class="sep"></span><button id="pNew">＋ Yeni</button><button id="pDel" class="danger">Sil</button>
			<span id="pExtra"></span><span class="spacer"></span><span id="pDirty" class="small"></span><button id="pSave" class="primary">Kaydet</button>`;
		this.$("pFile").onchange = () => this.openFile(this.$("pFile").value);
		this.$("pVanilla").onchange = async () => { this.vanilla = this.$("pVanilla").checked; localStorage.setItem(`studio.${this.kind}.vanilla`, this.vanilla ? "1" : "0"); await this.loadFiles(); this.$("pFile").value = this.file; };
		this.$("pNew").onclick = () => this.create();
		this.$("pDel").onclick = () => this.remove();
		this.$("pSave").onclick = () => this.save();
		if (this.cfg.toolbar) this.cfg.toolbar(this, this.$("pExtra"));
	}
	async loadFiles() {
		const { files } = await Studio.api(`/api/files?module=${this.kind}&vanilla=${this.vanilla ? 1 : 0}`);
		this.files = files;
		this.$("pFile").innerHTML = files.map((f) => `<option value="${Studio.esc(f.file)}">${Studio.esc(f.file.split("/").pop())}${f.vanilla ? " (oyun)" : ""}</option>`).join("");
		if (this.file) this.$("pFile").value = this.file;
	}
	confirmLeave() { return !(this.editor && this.item && this.editor.dirty()) || confirm("Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?"); }
	async openFile(file, id = null, line = null) {
		if (!this.confirmLeave()) { this.$("pFile").value = this.file; return; }
		this.file = file; this.$("pFile").value = file; this.marks = new Set();
		localStorage.setItem(`studio.${this.kind}.file`, file);
		await this.loadList();
		if (!id && line) {
			const above = this.list.items.filter((r) => r.line <= +line).sort((a, b) => b.line - a.line)[0];
			if (above) id = above.id;
		}
		if (id && this.list.items.some((r) => r.id === id)) await this.select(id, true);
		else { this.id = null; this.item = null; this.renderEmpty(); }
	}
	async loadList() {
		try {
			this.list = await Studio.api(`/api/${this.kind}/list?file=${encodeURIComponent(this.file)}`);
			Studio.known(this.file, this.list.version, this.list.locStamp);
			this.renderList();
		} catch (e) { Studio.toast("Liste yüklenemedi: " + e.message, true, 8000); }
	}
	renderList() {
		const esc = Studio.esc, el = this.$("list");
		const q = this.filter.toLowerCase();
		const rows = (this.list ? this.list.items : []).filter((r) => !q || r.id.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q));
		let html = `<div class="filter"><input id="pFilter" placeholder="Filtrele…" value="${esc(this.filter)}"><div class="small" style="margin-top:4px">${rows.length} öğe${this.list && this.list.vanilla ? " · oyunun dosyası" : ""}</div></div>`;
		let group = null;
		const groupHead = (g) => {
			const icon = this.cfg.groupIcon ? this.cfg.groupIcon(g, this) : "";
			const label = this.cfg.groupLabel ? this.cfg.groupLabel(g, this) : g;
			return `<div class="group${this.cfg.onGroup ? " clickable" : ""}" data-g="${esc(g)}" ${this.cfg.onGroup ? 'title="Kategoriyi düzenle" style="cursor:pointer"' : ""}>
				${icon ? `<img src="${Studio.iconUrl(icon)}" style="width:18px;height:18px;vertical-align:middle;margin-right:4px" onerror="this.style.display='none'">` : ""}${esc(label)}</div>`;
		};
		const shown = new Set();
		for (const r of rows) {
			const g = this.cfg.group ? this.cfg.group(r, this) : "";
			if (g !== group) { group = g; shown.add(g); if (g) html += groupHead(g); }
			const icon = this.cfg.iconOf ? this.cfg.iconOf(r) : "";
			html += `<div class="it${r.id === this.id ? " sel" : ""}${this.marks.has(r.id) ? " marked" : ""}" data-id="${esc(r.id)}">
				${icon ? `<img src="${Studio.imageUrl(icon)}" loading="lazy" onerror="this.style.opacity=.15">` : ""}
				<div class="t"><div class="n">${esc(r.name || r.id)}${this.marks.has(r.id) ? ' <span style="color:var(--claude)">✦</span>' : ""}</div>
				<div class="i">${esc(r.id)}${this.cfg.subOf ? " · " + esc(this.cfg.subOf(r)) : ""}</div></div></div>`;
		}
		if (!q && this.cfg.extraGroups) {
			for (const g of this.cfg.extraGroups(this)) if (!shown.has(g)) html += groupHead(g) + `<div class="small" style="padding:2px 12px 6px">Bu kategoride henüz karar yok.</div>`;
		}
		el.innerHTML = html;
		if (this.cfg.onGroup) el.querySelectorAll(".group[data-g]").forEach((h) => (h.onclick = () => this.cfg.onGroup(h.dataset.g, this)));
		const f = this.$("pFilter");
		f.addEventListener("input", () => { this.filter = f.value; const pos = f.selectionStart; this.renderList(); const n = this.$("pFilter"); n.focus(); n.setSelectionRange(pos, pos); });
		el.querySelectorAll(".it").forEach((it) => (it.onclick = () => this.select(it.dataset.id)));
	}
	renderEmpty() {
		this.$("center").innerHTML = `<div class="small">Soldan bir öğe seç ya da <b>＋ Yeni</b> ile oluştur.</div>`;
		const form = this.$("form");
		form.innerHTML = `<h2>${Studio.esc(this.file.split("/").pop())}</h2><div class="small">${this.list ? this.list.items.length : 0} öğe</div>`;
		Studio.sendBox(form, { kind: "file", file: () => this.file, ids: () => [], unsaved: () => false });
		this.updateDirty();
	}
	async select(id, force = false) {
		if (!id) return;
		if (!force && id !== this.id && !this.confirmLeave()) return;
		try {
			const model = await Studio.api(`/api/${this.kind}/item?file=${encodeURIComponent(this.file)}&id=${encodeURIComponent(id)}`);
			this.showItem(model);
		} catch (e) { Studio.toast("Açılamadı: " + e.message, true, 8000); }
	}
	showItem(model) {
		this.id = model.id; this.item = model;
		Studio.known(this.file, model.version, model.locStamp);
		const params = new URLSearchParams(location.search);
		params.set("file", this.file); params.set("id", this.id); params.delete("line"); params.delete("launch");
		history.replaceState(null, "", location.pathname + "?" + params.toString());
		const form = this.$("form");
		form.innerHTML = `<h2 id="pTitle"></h2><div class="small" id="pSub"></div><div id="pEd"></div>`;
		this.editor = new ItemEditor(this.$("pEd"), { ...this.cfg.editor, kind: this.kind, onChange: () => this.changed() });
		this.editor.load(model);
		Studio.sendBox(form, { kind: this.kind, file: () => this.file, ids: () => [this.id], names: () => [this.item.loc && this.item.loc[this.cfg.nameKey ? this.cfg.nameKey(this) : this.id] || this.id],
			unsaved: () => this.editor.dirty(), save: () => this.save() });
		this.renderList();
		this.changed(true);
		const sel = this.$("list").querySelector(".it.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
	}
	changed(now = false) {
		this.updateDirty();
		const title = this.$("pTitle");
		if (title && this.editor) {
			const nameKey = this.cfg.nameKey ? this.cfg.nameKey(this) : this.id;
			title.textContent = (this.cfg.title ? this.cfg.title(this) : "") || (this.editor.loc && this.editor.loc[nameKey]) || this.id;
			this.$("pSub").textContent = `${this.id} · satır ${this.item.line}${this.item.vanilla ? " · oyunun dosyası" : ""}`;
		}
		clearTimeout(this.previewTimer);
		const draw = () => { if (this.cfg.renderCenter && this.item) this.cfg.renderCenter(this, this.$("center")); };
		if (now) draw(); else this.previewTimer = setTimeout(draw, 250);
	}
	updateDirty() {
		const dirty = !!(this.editor && this.item && this.editor.dirty());
		this.$("pDirty").textContent = dirty ? "Kaydedilmemiş değişiklik var" : "Değişiklik yok";
		this.$("pSave").disabled = !dirty;
		this.$("pDel").disabled = !this.item;
	}
	async save() {
		if (!this.editor || !this.item || !this.editor.dirty()) { Studio.toast("Kaydedilecek değişiklik yok."); return true; }
		try {
			const result = await Studio.api(`/api/${this.kind}/save`, this.editor.payload());
			this.showItem(result);
			await this.loadList();
			Studio.toast("Kaydedildi: " + (result.written || []).join(", ") + (result.backup ? `\nYedek: ${result.backup}` : "") + (result.copiedFromGame ? "\nOyunun dosyası moda kopyalandı." : ""), false, 6000);
			if (result.copiedFromGame) await this.loadFiles();
			return true;
		} catch (e) { Studio.toast("Kaydedilemedi: " + e.message, true, 10000); return false; }
	}
	async create() {
		if (!this.confirmLeave()) return;
		const spec = this.cfg.create ? await this.cfg.create(this) : null;
		if (!spec) return;
		try {
			const result = await Studio.api(`/api/${this.kind}/create`, { file: this.file, version: this.list.version, ...spec });
			await this.loadList();
			this.showItem(result);
			Studio.toast("Oluşturuldu: " + result.id + "\n" + (result.written || []).join(", "), false, 5000);
		} catch (e) { Studio.toast("Oluşturulamadı: " + e.message, true, 10000); }
	}
	async remove() {
		if (!this.item || !confirm(`${this.id} dosyadan silinsin mi? (Yedek alınır.) Başka yerlerdeki kullanımları kendiliğinden değişmez.`)) return;
		try {
			const result = await Studio.api(`/api/${this.kind}/delete`, { file: this.file, version: this.item.version, id: this.id });
			this.list = result; Studio.known(this.file, result.version, result.locStamp);
			this.id = null; this.item = null; this.editor = null;
			this.renderList(); this.renderEmpty();
			Studio.toast("Silindi. Yedek: " + (result.backup || "-"), false, 5000);
		} catch (e) { Studio.toast("Silinemedi: " + e.message, true, 10000); }
	}
	async onDiskChange(change) {
		if (!change.files.includes(this.file) && !change.loc) return;
		if (this.editor && this.item && this.editor.dirty()) {
			const form = this.$("form");
			if (!form.querySelector(".banner.disk")) {
				form.insertAdjacentHTML("afterbegin", `<div class="banner disk">Dosya diskte değişti (büyük ihtimalle Claude). Kaydedilmemiş değişikliklerin var.
					<div class="row" style="margin-top:6px"><button class="fixed" id="pDiskReload">Yeniden yükle (değişikliklerim gider)</button></div></div>`);
				this.$("pDiskReload").onclick = () => { this.editor = null; this.reloadFromDisk(); };
			}
			return;
		}
		await this.reloadFromDisk();
	}
	async reloadFromDisk() {
		const oldIds = new Set((this.list ? this.list.items : []).map((r) => r.id));
		const oldRaw = this.item ? this.item.raw : null, oldLoc = this.item ? JSON.stringify(this.item.loc) : null;
		await this.loadList();
		const added = this.list.items.filter((r) => !oldIds.has(r.id)).map((r) => r.id);
		added.forEach((id) => this.marks.add(id));
		if (this.id && this.list.items.some((r) => r.id === this.id)) {
			const model = await Studio.api(`/api/${this.kind}/item?file=${encodeURIComponent(this.file)}&id=${encodeURIComponent(this.id)}`);
			if (model.raw !== oldRaw || JSON.stringify(model.loc) !== oldLoc) this.marks.add(this.id);
			this.showItem(model);
		} else if (this.id) { this.id = null; this.item = null; this.editor = null; this.renderEmpty(); }
		this.renderList();
		if (this.marks.size) Studio.toast(`Dosya diskte değişti, yeniden yüklendi. Değişen veya eklenen ${this.marks.size} öğe mor ✦ ile işaretli.`, false, 6000);
	}
	async refsHtml(id) {
		const item = this.item;
		const rows = await Studio.refs(id, item ? { file: this.file, from: item.line, to: item.line + (item.raw.match(/\n/g) || []).length } : null);
		return Studio.refsHtml(rows);
	}
}
