/* HOI4 Türkçe Mod Toolu: what the visual script builder knows about effects and triggers.
 *
 * An entry describes one statement the builder can draw as a form instead of code:
 *   k      the script key (`add_political_power`), or `match` (a RegExp) for keys that are data
 *          themselves: a country tag, a state number, ROOT/FROM/PREV, event_target:name
 *   l      Turkish label, c: palette category, h: one line of help
 *   v      the value of the `key = value` form: a field type (below)
 *   list   the items of the `key = { a b c }` form
 *   f      the fields of the `key = { name = value ... }` form: [{ k, l, <field type>, def, opt, rep, cmp }]
 *          opt: only written when the user adds it, rep: may repeat, cmp: the user picks = < >
 *   map    `key = { <picked id> = value ... }` (set_technology): { key: field type, value: field type }
 *   body   "effects" or "triggers": the block holds statements (a scope, a condition, a loop)
 *   scope  what the statements inside run on ("country", "state", "character"); `same` keeps the scope
 *   limit  the block takes a `limit = { }` of triggers
 *   code   the block is edited as text (create_unit, start_civil_war): `tpl` is its starting text
 *   cmp    a trigger that compares (`has_stability > 0.6`)
 *
 * Field types: { t: "num" | "int" | "bool" | "text" | "str" (always quoted) | "loc" (a localisation
 * key with its English text) | "enum" (o: [[value, label]]) | "pick" (of: a catalog of mod_catalog.py)
 * | "picks" (a `{ a b c }` list of picks) | "code" (a sub-block as text) }.
 *
 * Scopes are not written here: the builder reads the scopes each effect and trigger supports from the
 * game's own documentation (catalogs effect_doc and trigger_doc). tests/test_studio_script.py checks
 * every key below against that documentation.
 */
"use strict";

const ScriptSchema = (() => {
	const NUM = { t: "num" }, PCT = { t: "num", pct: true }, INT = { t: "int" }, BOOL = { t: "bool" }, TXT = { t: "text" }, STR = { t: "str" }, LOC = { t: "loc" };
	const P = (of, more) => ({ t: "pick", of, ...(more || {}) });
	const PS = (of) => ({ t: "picks", of });
	const EN = (...o) => ({ t: "enum", o });
	const CODE = { t: "code" };
	const f = (k, l, type, def = "", more = null) => ({ k, l, ...type, def, ...(more || {}) });
	const OPT = { opt: true }, REP = { rep: true }, CMP = { cmp: true };

	const CATEGORIES = {
		effect: [["pol", "Siyaset ve kaynaklar"], ["idea", "Ruhlar ve karakterler"], ["eco", "Sanayi, inşaat, araştırma"], ["mil", "Ordu"],
			["dip", "Diplomasi ve savaş"], ["land", "Toprak ve eyaletler"], ["evt", "Olay, karar, odak"], ["flag", "İşaret (flag) ve değişken"], ["flow", "Koşul, kapsam, döngü"]],
		trigger: [["pol", "Ülkenin durumu"], ["dip", "Diplomasi ve savaş"], ["land", "Toprak ve eyaletler"], ["flag", "İşaret (flag) ve değişken"], ["flow", "VE / VEYA, kapsam"], ["ai", "Yapay zekâ ağırlığı"]],
	};

	const EVENT_FIELDS = [f("id", "Olay", P("event")), f("days", "Kaç gün sonra", INT, "1", OPT), f("hours", "Kaç saat sonra", INT, "6", OPT),
		f("random_days", "Artı rastgele gün", INT, "2", OPT), f("random_hours", "Artı rastgele saat", INT, "6", OPT), f("tooltip", "İpucu metni", LOC, "", OPT)];
	const BUILDING = [f("type", "Bina", P("building"), "industrial_complex"), f("level", "Seviye", INT, "1"), f("instant_build", "Anında bitsin", BOOL, "yes"),
		f("province", "Hangi illerde (province)", CODE, "all_provinces = yes", OPT)];
	const VARIABLE = [f("var", "Değişken", TXT, "my_variable"), f("value", "Değer", NUM, "1"), f("tooltip", "İpucu metni", LOC, "", OPT)];
	const OPINION = [f("target", "Hangi ülkeye karşı", P("country")), f("modifier", "İlişki değiştirici", P("opinion_modifier"))];
	const FLAG = (catalog) => [f("flag", "İşaret", P(catalog)), f("days", "Kaç gün sürsün", INT, "30", OPT), f("value", "Değer", INT, "1", OPT)];
	const ITER = { limit: true, body: "effects" };
	const TITER = { body: "triggers" };
	const STATE_LOOP = [f("prioritize", "Öncelikli eyaletler", PS("state"), "", OPT)];
	const AI_STRATEGIES = EN(["alliance", "İttifak kur"], ["antagonize", "Düşmanlaş"], ["befriend", "Dostluk kur"], ["conquer", "Fethet"], ["contain", "Çevrele"],
		["declare_war", "Savaş ilan et"], ["protect", "Koru"], ["support", "Destekle"], ["influence", "Etkile"], ["ignore", "Görmezden gel"], ["invade", "İstila et"], ["prepare_for_war", "Savaşa hazırlan"]);
	const CONTINENTS = EN(["europe", "Avrupa"], ["asia", "Asya"], ["middle_east", "Orta Doğu"], ["africa", "Afrika"], ["north_america", "Kuzey Amerika"], ["south_america", "Güney Amerika"], ["australia", "Okyanusya"]);
	const RELATIONS = EN(["non_aggression_pact", "Saldırmazlık paktı"], ["guarantee", "Garanti"], ["puppet", "Kukla"], ["military_access", "Askeri geçiş"], ["docking_rights", "Liman hakkı"]);
	const COMPARE = EN(["greater_than", "büyük"], ["less_than", "küçük"], ["equals", "eşit"], ["not_equals", "eşit değil"], ["greater_than_or_equals", "büyük ya da eşit"], ["less_than_or_equals", "küçük ya da eşit"]);
	const REFS = ["ROOT", "FROM", "PREV", "THIS", "FROM.FROM", "PREV.PREV", "OWNER", "CONTROLLER", "CAPITAL", "OVERLORD", "FACTION_LEADER"];
	const REF_MATCH = /^(ROOT|FROM|PREV|THIS|OWNER|CONTROLLER|CAPITAL|OVERLORD|FACTION_LEADER)(\.(ROOT|FROM|PREV|THIS|OWNER|CONTROLLER|CAPITAL|OVERLORD|FACTION_LEADER))*$/i;

	/* dynamic keys shared by effects and triggers: `body` is filled in per mode */
	const dynamic = (body) => [
		{ id: "@country", match: /^[A-Z][A-Z0-9]{2}$/, l: "Başka bir ülkede", c: "flow", h: "İçindekiler seçtiğin ülke için çalışır (ör. FRA = { ... }).", keyPick: "country", scope: "country", body },
		{ id: "@state", match: /^\d+$/, l: "Belirli bir eyalette", c: "flow", h: "İçindekiler seçtiğin eyalet için çalışır (ör. 554 = { ... }).", keyPick: "state", scope: "state", body },
		{ id: "@ref", match: REF_MATCH, l: "ROOT / FROM / PREV kapsamında", c: "flow", h: "ROOT: bunu başlatan ülke. FROM: olayı gönderen. PREV: bir önceki kapsam.", keyEnum: REFS, scope: null, body },
		{ id: "@target", match: /^event_target:/, l: "Kayıtlı hedefte (event_target)", c: "flow", keyText: "event_target:", scope: null, body },
		{ id: "@var", match: /^var:/, l: "Değişkendeki kapsamda (var:)", c: "flow", keyText: "var:", scope: null, body },
	];

	const EFFECTS = [
		/* ---------------- politics and resources ---------------- */
		{ k: "add_political_power", l: "Siyasi güç ekle", c: "pol", v: { ...NUM, def: "50" } },
		{ k: "add_stability", l: "İstikrar ekle", c: "pol", h: "0.05 = %5", v: { ...PCT, def: "0.05" } },
		{ k: "add_war_support", l: "Savaş desteği ekle", c: "pol", h: "0.05 = %5", v: { ...PCT, def: "0.05" } },
		{ k: "add_command_power", l: "Komuta gücü ekle", c: "pol", v: { ...NUM, def: "25" } },
		{ k: "add_manpower", l: "İnsan gücü ekle", c: "pol", h: "Ülkede ya da eyalette.", v: { ...INT, def: "10000" } },
		{ k: "add_popularity", l: "Parti desteği ekle", c: "pol", f: [f("ideology", "İdeoloji", P("ideology"), "neutrality"), f("popularity", "Miktar", PCT, "0.05")] },
		{ k: "set_politics", l: "Yönetimi değiştir", c: "pol", f: [f("ruling_party", "Yöneten ideoloji", P("ideology"), "neutrality"), f("elections_allowed", "Seçim yapılır", BOOL, "no"),
			f("last_election", "Son seçim tarihi", STR, "1936.1.1", OPT), f("election_frequency", "Seçim sıklığı (ay)", INT, "48", OPT), f("long_name", "Parti uzun adı", TXT, "", OPT), f("name", "Parti adı", TXT, "", OPT)] },
		{ k: "set_cosmetic_tag", l: "Ülke adını ve bayrağını değiştir", c: "pol", h: "Kozmetik etiket: TAG_<ideoloji> adları ve bayrakları bu etiketle aranır.", v: TXT },
		{ k: "drop_cosmetic_tag", l: "Kozmetik etiketi kaldır", c: "pol", v: { ...BOOL, def: "yes" } },
		{ k: "add_threat", l: "Dünya gerginliği ekle", c: "pol", v: { ...NUM, def: "1" } },
		{ k: "add_named_threat", l: "Dünya gerginliği ekle (sebep adıyla)", c: "pol", f: [f("threat", "Miktar", NUM, "1"), f("name", "Sebep metni", LOC)] },
		{ k: "set_capital", l: "Başkenti taşı", c: "pol", f: [f("state", "Eyalet", P("state")), f("remember_old_capital", "Eski başkenti hatırla", BOOL, "yes", OPT)] },
		{ k: "set_major", l: "Büyük güç say", c: "pol", v: { ...BOOL, def: "yes" } },
		{ k: "set_rule", l: "Ülke kuralı ayarla", c: "pol", h: "ör. can_create_factions = yes", code: true, tpl: "can_create_factions = yes" },
		{ k: "set_party_name", l: "Parti adını değiştir", c: "pol", f: [f("ideology", "İdeoloji", P("ideology"), "neutrality"), f("long_name", "Uzun ad", TXT), f("name", "Kısa ad", TXT)] },
		{ k: "hold_election", l: "Seçim yap", c: "pol", v: P("country", { def: "ROOT" }) },
		{ k: "add_fuel", l: "Yakıt ekle", c: "pol", v: { ...INT, def: "1000" } },
		{ k: "add_legitimacy", l: "Meşruiyet ekle (sürgün hükümeti)", c: "pol", v: { ...INT, def: "10" } },
		{ k: "add_power_balance_value", l: "Güç dengesini kaydır", c: "pol", f: [f("id", "Denge", TXT), f("value", "Miktar", NUM, "0.1")] },

		/* ---------------- ideas and characters ---------------- */
		{ k: "add_ideas", l: "Milli ruh ekle", c: "idea", v: P("idea"), list: P("idea") },
		{ k: "remove_ideas", l: "Milli ruhu kaldır", c: "idea", v: P("idea"), list: P("idea") },
		{ k: "swap_ideas", l: "Milli ruhu yenisiyle değiştir", c: "idea", h: "Eski ruh kalkar, yenisi gelir; ipucunda fark gösterilir.", f: [f("remove_idea", "Kalkan ruh", P("idea")), f("add_idea", "Gelen ruh", P("idea")), f("days", "Kaç gün sürsün", INT, "180", OPT)] },
		{ k: "add_timed_idea", l: "Süreli milli ruh ekle", c: "idea", f: [f("idea", "Ruh", P("idea")), f("days", "Kaç gün", INT, "180"), f("months", "Ay", INT, "6", OPT), f("years", "Yıl", INT, "1", OPT)] },
		{ k: "modify_timed_idea", l: "Süreli ruhun süresini değiştir", c: "idea", f: [f("idea", "Ruh", P("idea")), f("days", "Eklenecek gün", INT, "30")] },
		{ k: "remove_ideas_with_trait", l: "Bu özelliği taşıyan ruhları kaldır", c: "idea", v: P("leader_trait") },
		{ k: "show_ideas_tooltip", l: "Ruhun etkilerini ipucunda göster", c: "idea", v: P("idea") },
		{ k: "add_dynamic_modifier", l: "Dinamik modifier ekle", c: "idea", f: [f("modifier", "Modifier", P("dynamic_modifier")), f("scope", "Hedef kapsam", TXT, "", OPT), f("days", "Kaç gün", INT, "180", OPT)] },
		{ k: "remove_dynamic_modifier", l: "Dinamik modifier'ı kaldır", c: "idea", f: [f("modifier", "Modifier", P("dynamic_modifier")), f("scope", "Hedef kapsam", TXT, "", OPT)] },
		{ k: "recruit_character", l: "Karakteri ülkeye al", c: "idea", v: P("character") },
		{ k: "promote_character", l: "Karakteri ülkenin başına geçir", c: "idea", v: P("character"), f: [f("character", "Karakter", P("character")), f("ideology", "Alt ideoloji", P("sub_ideology"), "", OPT)] },
		{ k: "retire_character", l: "Karakteri emekli et", c: "idea", v: P("character") },
		{ k: "activate_advisor", l: "Danışmanı göreve başlat", c: "idea", h: "Danışmanın idea_token değeri (çoğunlukla karakter kimliği).", v: P("character") },
		{ k: "deactivate_advisor", l: "Danışmanı görevden al", c: "idea", v: P("character") },
		{ k: "add_country_leader_trait", l: "Lidere özellik ekle", c: "idea", v: P("leader_trait") },
		{ k: "remove_country_leader_trait", l: "Liderden özellik kaldır", c: "idea", v: P("leader_trait") },
		{ k: "swap_country_leader_traits", l: "Liderin özelliğini değiştir", c: "idea", f: [f("remove", "Kalkan özellik", P("leader_trait")), f("add", "Gelen özellik", P("leader_trait"))] },
		{ k: "retire_country_leader", l: "Ülke liderini emekli et", c: "idea", v: { ...BOOL, def: "yes" } },
		{ k: "kill_country_leader", l: "Ülke liderini öldür", c: "idea", v: { ...BOOL, def: "yes" } },
		{ k: "set_nationality", l: "Karakterin ülkesini değiştir", c: "idea", f: [f("character", "Karakter", P("character")), f("target_country", "Yeni ülke", P("country"))] },

		/* ---------------- industry, construction, research ---------------- */
		{ k: "add_building_construction", l: "Bina inşa et", c: "eco", h: "Eyalet kapsamında çalışır.", f: BUILDING },
		{ k: "add_extra_state_shared_building_slots", l: "Bina yuvası ekle", c: "eco", h: "Eyalet kapsamında çalışır.", v: { ...INT, def: "1" } },
		{ k: "add_offsite_building", l: "Harita dışı fabrika ekle", c: "eco", h: "Bombalanamayan, eyalete bağlı olmayan fabrika.", f: [f("type", "Bina", P("building"), "arms_factory"), f("level", "Seviye", INT, "1")] },
		{ k: "add_resource", l: "Kaynak ekle", c: "eco", f: [f("type", "Kaynak", P("resource"), "steel"), f("amount", "Miktar", INT, "8"), f("state", "Eyalet", P("state"), "", OPT), f("days", "Geçici (gün)", INT, "180", OPT)] },
		{ k: "remove_building", l: "Bina yık", c: "eco", f: [f("type", "Bina", P("building"), "industrial_complex"), f("level", "Seviye", INT, "1")] },
		{ k: "set_building_level", l: "Bina seviyesini ayarla", c: "eco", f: [f("type", "Bina", P("building"), "infrastructure"), f("level", "Seviye", INT, "5"), f("instant_build", "Anında", BOOL, "yes", OPT), f("province", "İller", CODE, "all_provinces = yes", OPT)] },
		{ k: "damage_building", l: "Binaya hasar ver", c: "eco", f: [f("type", "Bina", P("building"), "industrial_complex"), f("damage", "Hasar", NUM, "1")] },
		{ k: "set_state_category", l: "Eyalet türünü değiştir", c: "eco", h: "Tür, eyaletin bina yuvası sayısını belirler.", v: P("state_category") },
		{ k: "add_research_slot", l: "Araştırma yuvası ekle", c: "eco", v: { ...INT, def: "1" } },
		{ k: "set_research_slots", l: "Araştırma yuvası sayısını ayarla", c: "eco", v: { ...INT, def: "3" } },
		{ k: "add_tech_bonus", l: "Araştırma bonusu ver", c: "eco", h: "Hız 1.0 = %100. Kategori ya da teknoloji seç.", f: [f("name", "Bonus adı", TXT, "", OPT), f("bonus", "Hız bonusu", PCT, "1.0"), f("uses", "Kaç kez kullanılır", INT, "1"),
			f("ahead_reduction", "Erken araştırma cezası indirimi (yıl)", NUM, "1", OPT), f("category", "Kategori", P("tech_category"), "", REP), f("technology", "Teknoloji", P("tech"), "", { rep: true, opt: true })] },
		{ k: "add_doctrine_cost_reduction", l: "Doktrin maliyeti indirimi", c: "eco", f: [f("name", "Adı", TXT, "", OPT), f("cost_reduction", "İndirim", PCT, "0.5"), f("uses", "Kaç kez", INT, "1"), f("category", "Doktrin kategorisi", P("tech_category"), "land_doctrine", REP)] },
		{ k: "set_technology", l: "Teknolojiyi aç", c: "eco", h: "1 = açılır, 0 = kapanır.", map: { key: P("tech"), value: { ...INT, def: "1" }, l: "Teknoloji" }, f: [f("popup", "Bildirim penceresi", BOOL, "no", OPT)] },
		{ k: "add_equipment_to_stockpile", l: "Depoya teçhizat ekle", c: "eco", f: [f("type", "Teçhizat", P("equipment"), "infantry_equipment"), f("amount", "Miktar", INT, "1000"), f("producer", "Üretici ülke", P("country"), "", OPT)] },
		{ k: "add_breakthrough_progress", l: "Atılım ilerlemesi ekle", c: "eco", f: [f("specialization", "Uzmanlık", TXT, "specialization_land"), f("value", "Miktar", NUM, "1")] },
		{ k: "add_victory_points", l: "Zafer puanı ekle", c: "eco", f: [f("province", "İl numarası", INT), f("value", "Puan", INT, "5")] },
		{ k: "build_railway", l: "Demiryolu yap", c: "eco", code: true, tpl: "level = 1\nstart_state = 1\ntarget_state = 2" },

		/* ---------------- army ---------------- */
		{ k: "army_experience", l: "Kara tecrübesi ekle", c: "mil", v: { ...INT, def: "25" } },
		{ k: "navy_experience", l: "Deniz tecrübesi ekle", c: "mil", v: { ...INT, def: "25" } },
		{ k: "air_experience", l: "Hava tecrübesi ekle", c: "mil", v: { ...INT, def: "25" } },
		{ k: "load_oob", l: "Hazır birlikleri yükle (OOB dosyası)", c: "mil", h: "history/units içindeki bir dosyanın birliklerini ülkeye ekler.", v: P("oob", { quoted: true }) },
		{ k: "create_unit", l: "Birlik oluştur", c: "mil", h: "Bir şablondan tümen kurar.", code: true,
			tpl: "division = \"name = \\\"New Division\\\" division_template = \\\"Infantry Division\\\" start_experience_factor = 0.3\"\nowner = ROOT" },
		{ k: "division_template", l: "Tümen şablonu tanımla", c: "mil", code: true, tpl: "name = \"New Template\"\nregiments = {\n\tinfantry = { x = 0 y = 0 }\n\tinfantry = { x = 0 y = 1 }\n}" },
		{ k: "delete_unit_template_and_units", l: "Şablonu ve birliklerini sil", c: "mil", f: [f("division_template", "Şablon adı", STR), f("disband", "Teçhizat depoya dönsün", BOOL, "yes", OPT)] },
		{ k: "set_division_template_lock", l: "Tümen şablonunu kilitle", c: "mil", f: [f("division_template", "Şablon adı", STR), f("is_locked", "Kilitli", BOOL, "yes")] },
		{ k: "add_ace", l: "As pilot ekle", c: "mil", code: true, tpl: "name = \"Name\"\nsurname = \"Surname\"\ncallsign = \"Callsign\"\ntype = fighter_genius" },

		/* ---------------- diplomacy and war ---------------- */
		{ k: "create_wargoal", l: "Savaş hedefi ver", c: "dip", f: [f("type", "Hedef türü", P("wargoal"), "annex_everything"), f("target", "Hedef ülke", P("country")), f("generator", "İstenen eyaletler", PS("state"), "", OPT), f("expire", "Geçerlilik (gün)", INT, "0", OPT)] },
		{ k: "declare_war_on", l: "Savaş ilan et", c: "dip", f: [f("target", "Hedef ülke", P("country")), f("type", "Savaş hedefi", P("wargoal"), "annex_everything"), f("generator", "İstenen eyaletler", PS("state"), "", OPT)] },
		{ k: "add_opinion_modifier", l: "İlişki değiştirici ekle", c: "dip", h: "Bu ülkenin hedef ülke hakkındaki görüşünü değiştirir.", f: OPINION },
		{ k: "reverse_add_opinion_modifier", l: "Karşı tarafın görüşünü değiştir", c: "dip", h: "Hedef ülkenin bu ülke hakkındaki görüşü.", f: OPINION },
		{ k: "remove_opinion_modifier", l: "İlişki değiştiriciyi kaldır", c: "dip", f: OPINION },
		{ k: "give_guarantee", l: "Bağımsızlığını garanti et", c: "dip", v: P("country") },
		{ k: "give_military_access", l: "Askeri geçiş izni ver", c: "dip", v: P("country") },
		{ k: "diplomatic_relation", l: "Diplomatik ilişki kur ya da boz", c: "dip", f: [f("country", "Ülke", P("country")), f("relation", "İlişki", RELATIONS, "non_aggression_pact"), f("active", "Kur (hayır: boz)", BOOL, "yes")] },
		{ k: "create_faction", l: "İttifak (faction) kur", c: "dip", v: TXT },
		{ k: "add_to_faction", l: "İttifaka al", c: "dip", v: P("country") },
		{ k: "remove_from_faction", l: "İttifaktan çıkar", c: "dip", v: P("country") },
		{ k: "leave_faction", l: "İttifaktan ayrıl", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "dismantle_faction", l: "İttifakı dağıt", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "set_faction_name", l: "İttifak adını değiştir", c: "dip", v: TXT },
		{ k: "puppet", l: "Kukla yap", c: "dip", v: P("country"), f: [f("target", "Ülke", P("country")), f("end_wars", "Savaşları bitsin", BOOL, "yes", OPT), f("end_civil_wars", "İç savaşları bitsin", BOOL, "yes", OPT)] },
		{ k: "annex_country", l: "İlhak et", c: "dip", f: [f("target", "Ülke", P("country")), f("transfer_troops", "Birlikleri devral", BOOL, "yes")] },
		{ k: "release", l: "Ülkeyi serbest bırak", c: "dip", v: P("country") },
		{ k: "release_puppet", l: "Kukla olarak serbest bırak", c: "dip", v: P("country") },
		{ k: "set_autonomy", l: "Özerklik düzeyini ayarla", c: "dip", f: [f("target", "Ülke", P("country")), f("autonomy_state", "Özerklik", P("autonomy"), "autonomy_free"), f("freedom_level", "Özgürlük oranı", NUM, "0.4", OPT), f("end_wars", "Savaşları bitsin", BOOL, "no", OPT), f("end_civil_wars", "İç savaşları bitsin", BOOL, "no", OPT)] },
		{ k: "add_autonomy_ratio", l: "Özerklik ilerlemesi ekle", c: "dip", f: [f("value", "Miktar", NUM, "0.1"), f("localization", "Sebep metni", LOC, "", OPT)] },
		{ k: "white_peace", l: "Beyaz barış imzala", c: "dip", v: P("country"), f: [f("tag", "Ülke", P("country")), f("message", "Bildirim metni", LOC, "", OPT)] },
		{ k: "add_to_war", l: "Savaşa kat", c: "dip", f: [f("targeted_alliance", "Kimin yanında", P("country")), f("enemy", "Kime karşı", P("country")), f("hostility_reason", "Sebep", EN(["asked_to_join", "çağrıldı"], ["ally", "müttefik"], ["guarantee", "garanti"]), "asked_to_join", OPT)] },
		{ k: "add_ai_strategy", l: "Yapay zekâ stratejisi ekle", c: "dip", f: [f("type", "Strateji", AI_STRATEGIES, "befriend"), f("id", "Hedef ülke", P("country")), f("value", "Güç", INT, "100")] },
		{ k: "start_civil_war", l: "İç savaş başlat", c: "dip", code: true, tpl: "ideology = communism\nsize = 0.4" },
		{ k: "add_civil_war_target", l: "İç savaş hedefi yap", c: "dip", v: P("country") },
		{ k: "set_truce", l: "Ateşkes imzala", c: "dip", f: [f("target", "Ülke", P("country")), f("days", "Kaç gün", INT, "180")] },
		{ k: "start_border_war", l: "Sınır çatışması başlat", c: "dip", code: true, tpl: "change_state_after_war = no\nattacker = {\n\tstate = 1\n\tnum_provinces = 4\n}\ndefender = {\n\tstate = 2\n\tnum_provinces = 4\n}" },

		/* ---------------- land and states ---------------- */
		{ k: "add_core_of", l: "Çekirdek toprak yap (core)", c: "land", h: "Eyalet kapsamında: bu eyalet seçilen ülkenin çekirdeği olur.", v: P("country") },
		{ k: "remove_core_of", l: "Çekirdeği kaldır", c: "land", v: P("country") },
		{ k: "add_claim_by", l: "Toprak iddiası ekle (claim)", c: "land", v: P("country") },
		{ k: "remove_claim_by", l: "Toprak iddiasını kaldır", c: "land", v: P("country") },
		{ k: "transfer_state", l: "Eyaleti devral", c: "land", h: "Ülke kapsamında: eyalet bu ülkeye geçer.", v: P("state") },
		{ k: "transfer_state_to", l: "Eyaleti şu ülkeye ver", c: "land", h: "Eyalet kapsamında.", v: P("country") },
		{ k: "set_state_owner_to", l: "Eyaletin sahibini değiştir", c: "land", v: P("country") },
		{ k: "set_state_controller_to", l: "Eyaletin kontrolcüsünü değiştir", c: "land", v: P("country") },
		{ k: "add_state_core", l: "Eyaleti çekirdek yap", c: "land", h: "Ülke kapsamında.", v: P("state") },
		{ k: "add_state_claim", l: "Eyalet üzerinde iddia ekle", c: "land", v: P("state") },
		{ k: "remove_state_core", l: "Eyalet çekirdeğini kaldır", c: "land", v: P("state") },
		{ k: "remove_state_claim", l: "Eyalet iddiasını kaldır", c: "land", v: P("state") },
		{ k: "set_demilitarized_zone", l: "Askerden arındırılmış bölge yap", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "set_state_name", l: "Eyalet adını değiştir", c: "land", v: LOC },
		{ k: "reset_state_name", l: "Eyalet adını eski hâline getir", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "set_province_name", l: "İl (şehir) adını değiştir", c: "land", f: [f("id", "İl numarası", INT), f("name", "Yeni ad", LOC)] },
		{ k: "add_compliance", l: "Uyum ekle (işgal)", c: "land", v: { ...INT, def: "10" } },
		{ k: "add_resistance", l: "Direniş ekle (işgal)", c: "land", v: { ...INT, def: "10" } },
		{ k: "add_province_modifier", l: "İle modifier ekle", c: "land", code: true, tpl: "static_modifiers = { }\nprovince = 1" },

		/* ---------------- events, decisions, focuses ---------------- */
		{ k: "country_event", l: "Olay tetikle", c: "evt", h: "Gecikme eklemek için gün ya da saat alanını ekle.", v: P("event"), f: EVENT_FIELDS, prefer: "f" },
		{ k: "news_event", l: "Haber olayı tetikle", c: "evt", v: P("event"), f: EVENT_FIELDS, prefer: "f" },
		{ k: "state_event", l: "Eyalet olayı tetikle", c: "evt", v: P("event"), f: [...EVENT_FIELDS, f("trigger_for", "Kime gösterilsin", TXT, "controller", OPT)], prefer: "f" },
		{ k: "unlock_decision_tooltip", l: "\"Karar açıldı\" ipucu göster", c: "evt", h: "Yalnızca ipucudur; kararın kendi görünürlük koşulu açmalıdır.", v: P("decision"), f: [f("decision", "Karar", P("decision")), f("show_effect_tooltip", "Etkisini göster", BOOL, "yes", OPT), f("show_modifiers", "Modifier'ları göster", BOOL, "yes", OPT)] },
		{ k: "unlock_decision_category_tooltip", l: "\"Karar kategorisi açıldı\" ipucu", c: "evt", v: P("decision_category") },
		{ k: "activate_mission", l: "Görevi başlat", c: "evt", v: P("decision") },
		{ k: "remove_mission", l: "Görevi kaldır", c: "evt", v: P("decision") },
		{ k: "activate_decision", l: "Kararı etkinleştir", c: "evt", v: P("decision") },
		{ k: "remove_decision", l: "Etkin kararı kaldır", c: "evt", v: P("decision") },
		{ k: "activate_targeted_decision", l: "Hedefli kararı etkinleştir", c: "evt", f: [f("target", "Hedef", P("country")), f("decision", "Karar", P("decision"))] },
		{ k: "remove_targeted_decision", l: "Hedefli kararı kaldır", c: "evt", f: [f("target", "Hedef", P("country")), f("decision", "Karar", P("decision"))] },
		{ k: "add_days_remove", l: "Kararın kalan süresini değiştir", c: "evt", f: [f("decision", "Karar", P("decision")), f("days", "Gün (eksi: kısalt)", INT, "30")] },
		{ k: "add_days_mission_timeout", l: "Görevin süresini değiştir", c: "evt", f: [f("mission", "Görev", P("decision")), f("days", "Gün (eksi: kısalt)", INT, "30")] },
		{ k: "unlock_national_focus", l: "Odağı aç (önkoşulsuz)", c: "evt", v: P("focus") },
		{ k: "complete_national_focus", l: "Odağı tamamlanmış say", c: "evt", v: P("focus") },
		{ k: "mark_focus_tree_layout_dirty", l: "Odak ağacını yeniden çiz", c: "evt", h: "allow_branch koşulu değişince ağacın görünümü yenilenir.", v: { ...BOOL, def: "yes" } },
		{ k: "load_focus_tree", l: "Odak ağacını değiştir", c: "evt", v: TXT, f: [f("tree", "Ağaç kimliği", TXT), f("keep_completed", "Tamamlananlar kalsın", BOOL, "yes", OPT)] },

		/* ---------------- flags and variables ---------------- */
		{ k: "set_country_flag", l: "Ülke işareti koy (flag)", c: "flag", h: "Sonradan has_country_flag ile sorulur.", v: P("country_flag"), f: FLAG("country_flag") },
		{ k: "clr_country_flag", l: "Ülke işaretini kaldır", c: "flag", v: P("country_flag") },
		{ k: "modify_country_flag", l: "Ülke işaretinin değerini değiştir", c: "flag", f: [f("flag", "İşaret", P("country_flag")), f("value", "Eklenecek", INT, "1")] },
		{ k: "set_global_flag", l: "Dünya işareti koy", c: "flag", v: P("global_flag"), f: FLAG("global_flag") },
		{ k: "clr_global_flag", l: "Dünya işaretini kaldır", c: "flag", v: P("global_flag") },
		{ k: "set_state_flag", l: "Eyalet işareti koy", c: "flag", v: P("state_flag"), f: FLAG("state_flag") },
		{ k: "clr_state_flag", l: "Eyalet işaretini kaldır", c: "flag", v: P("state_flag") },
		{ k: "set_variable", l: "Değişkene değer ata", c: "flag", f: VARIABLE, loose: true },
		{ k: "add_to_variable", l: "Değişkene ekle", c: "flag", f: VARIABLE, loose: true },
		{ k: "subtract_from_variable", l: "Değişkenden çıkar", c: "flag", f: VARIABLE, loose: true },
		{ k: "multiply_variable", l: "Değişkeni çarp", c: "flag", f: VARIABLE, loose: true },
		{ k: "divide_variable", l: "Değişkeni böl", c: "flag", f: VARIABLE, loose: true },
		{ k: "set_temp_variable", l: "Geçici değişkene ata", c: "flag", f: VARIABLE, loose: true },
		{ k: "add_to_temp_variable", l: "Geçici değişkene ekle", c: "flag", f: VARIABLE, loose: true },
		{ k: "clamp_variable", l: "Değişkeni sınırla", c: "flag", f: [f("var", "Değişken", TXT), f("min", "En az", NUM, "0"), f("max", "En çok", NUM, "100")] },
		{ k: "clear_variable", l: "Değişkeni sil", c: "flag", v: TXT },
		{ k: "save_event_target_as", l: "Bu kapsamı hedef olarak kaydet", c: "flag", h: "Sonra event_target:ad ile kullanılır.", v: TXT },
		{ k: "save_global_event_target_as", l: "Bu kapsamı kalıcı hedef olarak kaydet", c: "flag", v: TXT },
		{ k: "clear_global_event_target", l: "Kalıcı hedefi sil", c: "flag", v: TXT },

		/* ---------------- flow, scopes, loops ---------------- */
		{ k: "if", l: "Eğer… (koşul sağlanırsa)", c: "flow", h: "Koşul doğruysa içindekiler çalışır.", limit: true, limitFirst: true, body: "effects", same: true },
		{ k: "else_if", l: "Değilse eğer…", c: "flow", limit: true, limitFirst: true, body: "effects", same: true },
		{ k: "else", l: "Değilse", c: "flow", body: "effects", same: true },
		{ k: "hidden_effect", l: "Gizli etki (ipucunda görünmez)", c: "flow", body: "effects", same: true },
		{ k: "effect_tooltip", l: "Yalnızca ipucu (uygulanmaz)", c: "flow", h: "İçindekiler çalışmaz, yalnızca ipucunda gösterilir.", body: "effects", same: true },
		{ k: "custom_effect_tooltip", l: "Oyuncuya not (özel ipucu metni)", c: "flow", h: "Ödül ipucuna kendi yazdığın bir satır ekler.", v: LOC },
		{ k: "random_list", l: "Rastgele biri (ağırlıklı liste)", c: "flow", h: "Ağırlıklara göre seçeneklerden biri çalışır.", weights: true },
		{ k: "random", l: "Şansa bağlı (yüzde)", c: "flow", f: [f("chance", "Şans (%)", INT, "50")], body: "effects", same: true },
		{ k: "every_owned_state", l: "Sahip olunan her eyalette", c: "flow", ...ITER, scope: "state" },
		{ k: "random_owned_state", l: "Sahip olunan rastgele bir eyalette", c: "flow", ...ITER, scope: "state", f: STATE_LOOP },
		{ k: "random_owned_controlled_state", l: "Sahip olunan ve kontrol edilen rastgele bir eyalette", c: "flow", ...ITER, scope: "state", f: STATE_LOOP },
		{ k: "every_controlled_state", l: "Kontrol edilen her eyalette", c: "flow", ...ITER, scope: "state" },
		{ k: "random_controlled_state", l: "Kontrol edilen rastgele bir eyalette", c: "flow", ...ITER, scope: "state", f: STATE_LOOP },
		{ k: "every_core_state", l: "Her çekirdek eyalette", c: "flow", ...ITER, scope: "state" },
		{ k: "random_core_state", l: "Rastgele bir çekirdek eyalette", c: "flow", ...ITER, scope: "state", f: STATE_LOOP },
		{ k: "every_state", l: "Dünyadaki her eyalette", c: "flow", ...ITER, scope: "state" },
		{ k: "random_state", l: "Dünyadan rastgele bir eyalette", c: "flow", ...ITER, scope: "state", f: STATE_LOOP },
		{ k: "every_neighbor_state", l: "Komşu her eyalette", c: "flow", ...ITER, scope: "state" },
		{ k: "random_neighbor_state", l: "Rastgele komşu bir eyalette", c: "flow", ...ITER, scope: "state" },
		{ k: "capital_scope", l: "Başkent eyaletinde", c: "flow", body: "effects", scope: "state" },
		{ k: "every_country", l: "Her ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "every_other_country", l: "Diğer her ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "random_country", l: "Rastgele bir ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "random_other_country", l: "Rastgele başka bir ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "every_neighbor_country", l: "Her komşu ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "random_neighbor_country", l: "Rastgele komşu bir ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "every_enemy_country", l: "Savaşta olunan her ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "random_enemy_country", l: "Rastgele bir düşman ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "every_allied_country", l: "Her müttefik ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "random_allied_country", l: "Rastgele müttefik bir ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "every_subject_country", l: "Her bağımlı ülkede (kuklalar)", c: "flow", ...ITER, scope: "country" },
		{ k: "random_subject_country", l: "Rastgele bağımlı bir ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "every_occupied_country", l: "Toprağı işgal edilen her ülkede", c: "flow", ...ITER, scope: "country" },
		{ k: "owner", l: "Eyaletin sahibi ülkede", c: "flow", body: "effects", scope: "country" },
		{ k: "controller", l: "Eyaleti kontrol eden ülkede", c: "flow", body: "effects", scope: "country" },
		{ k: "overlord", l: "Efendi ülkede (overlord)", c: "flow", body: "effects", scope: "country" },
		{ k: "faction_leader", l: "İttifak liderinde", c: "flow", body: "effects", scope: "country" },
		{ k: "every_character", l: "Ülkenin her karakterinde", c: "flow", ...ITER, scope: "character" },
		{ k: "every_unit_leader", l: "Her komutanda", c: "flow", ...ITER, scope: "character" },
		{ k: "random_unit_leader", l: "Rastgele bir komutanda", c: "flow", ...ITER, scope: "character" },
		...dynamic("effects"),
	];

	const TRIGGERS = [
		/* ---------------- the country ---------------- */
		{ k: "has_political_power", l: "Siyasi gücü", c: "pol", cmp: true, v: { ...NUM, def: "100" }, op: ">" },
		{ k: "has_stability", l: "İstikrarı", c: "pol", h: "0.6 = %60", cmp: true, v: { ...PCT, def: "0.6" }, op: ">" },
		{ k: "has_war_support", l: "Savaş desteği", c: "pol", cmp: true, v: { ...PCT, def: "0.5" }, op: ">" },
		{ k: "has_government", l: "Yönetimdeki ideoloji", c: "pol", v: P("ideology", { def: "neutrality" }) },
		{ k: "has_idea", l: "Şu milli ruha sahip", c: "pol", v: P("idea") },
		{ k: "has_completed_focus", l: "Şu odağı tamamlamış", c: "pol", v: P("focus") },
		{ k: "has_tech", l: "Şu teknolojiye sahip", c: "pol", v: P("tech") },
		{ k: "has_character", l: "Şu karaktere sahip", c: "pol", v: P("character") },
		{ k: "has_country_leader", l: "Şu lidere sahip", c: "pol", code: true, tpl: "character = TAG_character\nruling_only = yes" },
		{ k: "has_idea_with_trait", l: "Şu özellikte danışmanı var", c: "pol", v: P("leader_trait") },
		{ k: "has_manpower", l: "İnsan gücü", c: "pol", cmp: true, v: { ...INT, def: "100000" }, op: ">" },
		{ k: "has_army_experience", l: "Kara tecrübesi", c: "pol", cmp: true, v: { ...INT, def: "50" }, op: ">" },
		{ k: "has_army_manpower", l: "Ordudaki asker sayısı", c: "pol", f: [f("size", "Asker", INT, "100000", { cmp: true, op: ">" })] },
		{ k: "has_army_size", l: "Tümen sayısı", c: "pol", f: [f("size", "Tümen", INT, "18", { cmp: true, op: ">" }), f("type", "Yalnızca şu tür", EN(["infantry", "piyade"], ["armor", "zırhlı"], ["anti_tank", "tanksavar"]), "infantry", OPT)] },
		{ k: "num_divisions", l: "Toplam tümen sayısı", c: "pol", cmp: true, v: { ...INT, def: "24" }, op: ">" },
		{ k: "has_navy_size", l: "Gemi sayısı", c: "pol", f: [f("size", "Gemi", INT, "20", { cmp: true, op: ">" }), f("type", "Yalnızca şu tür", TXT, "", OPT)] },
		{ k: "num_of_factories", l: "Toplam fabrika sayısı", c: "pol", cmp: true, v: { ...INT, def: "20" }, op: ">" },
		{ k: "num_of_military_factories", l: "Askeri fabrika sayısı", c: "pol", cmp: true, v: { ...INT, def: "10" }, op: ">" },
		{ k: "num_of_civilian_factories", l: "Sivil fabrika sayısı", c: "pol", cmp: true, v: { ...INT, def: "10" }, op: ">" },
		{ k: "num_of_naval_factories", l: "Tersane sayısı", c: "pol", cmp: true, v: { ...INT, def: "5" }, op: ">" },
		{ k: "num_of_controlled_states", l: "Kontrol edilen eyalet sayısı", c: "pol", cmp: true, v: { ...INT, def: "10" }, op: ">" },
		{ k: "amount_research_slots", l: "Araştırma yuvası sayısı", c: "pol", cmp: true, v: { ...INT, def: "3" }, op: ">" },
		{ k: "has_equipment", l: "Depoda teçhizat var", c: "pol", map: { key: P("equipment"), value: { ...INT, def: "1000" }, l: "Teçhizat", cmp: true, op: ">" } },
		{ k: "has_resources_amount", l: "Kaynak miktarı", c: "pol", f: [f("resource", "Kaynak", P("resource"), "oil"), f("amount", "Miktar", INT, "10", { cmp: true, op: ">" })] },
		{ k: "has_capitulated", l: "Teslim olmuş", c: "pol", v: { ...BOOL, def: "yes" } },
		{ k: "surrender_progress", l: "Teslimiyet ilerlemesi", c: "pol", cmp: true, v: { ...PCT, def: "0.5" }, op: ">" },
		{ k: "is_ai", l: "Yapay zekâ oynuyor", c: "pol", v: { ...BOOL, def: "yes" } },
		{ k: "is_major", l: "Büyük güç", c: "pol", v: { ...BOOL, def: "yes" } },
		{ k: "date", l: "Tarih", c: "pol", h: "yıl.ay.gün, ör. 1939.9.1", cmp: true, v: { ...TXT, def: "1939.1.1" }, op: ">" },
		{ k: "has_dlc", l: "DLC etkin", c: "pol", v: STR },
		{ k: "has_game_rule", l: "Oyun kuralı seçili", c: "pol", f: [f("rule", "Kural", TXT), f("option", "Seçenek", TXT)] },
		{ k: "has_cosmetic_tag", l: "Kozmetik etiketi şu", c: "pol", v: TXT },
		{ k: "has_focus_tree", l: "Odak ağacı şu", c: "pol", v: TXT },
		{ k: "has_active_mission", l: "Şu görev sürüyor", c: "pol", v: P("decision") },
		{ k: "has_decision", l: "Şu karar etkin", c: "pol", v: P("decision") },
		{ k: "has_dynamic_modifier", l: "Şu dinamik modifier'a sahip", c: "pol", f: [f("modifier", "Modifier", P("dynamic_modifier")), f("scope", "Hedef kapsam", TXT, "", OPT)] },
		{ k: "has_template", l: "Şu adda tümen şablonu var", c: "pol", v: STR },
		{ k: "has_elections", l: "Seçim yapılıyor", c: "pol", v: { ...BOOL, def: "yes" } },
		{ id: "@popularity", match: /^(democratic|communism|fascism|neutrality)$/, l: "Parti desteği", c: "pol", h: "0.3 = %30", keyPick: "ideology", cmp: true, v: { ...PCT, def: "0.3" }, op: ">", pairOnly: true },
		{ k: "tag", l: "Ülke şu (şu anki etiket)", c: "pol", v: P("country") },
		{ k: "original_tag", l: "Ülke şu (asıl etiket)", c: "pol", h: "İç savaş kopyaları da sayılır.", v: P("country") },

		/* ---------------- diplomacy and war ---------------- */
		{ k: "exists", l: "Ülke var", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "country_exists", l: "Şu ülke var", c: "dip", v: P("country") },
		{ k: "has_war", l: "Savaşta", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "has_war_with", l: "Şu ülkeyle savaşta", c: "dip", v: P("country") },
		{ k: "has_defensive_war", l: "Savunma savaşında", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "has_offensive_war", l: "Saldırı savaşında", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "has_defensive_war_with", l: "Şu ülkeye karşı savunmada", c: "dip", v: P("country") },
		{ k: "has_offensive_war_with", l: "Şu ülkeye saldırıyor", c: "dip", v: P("country") },
		{ k: "has_civil_war", l: "İç savaşta", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "is_in_faction", l: "Bir ittifakta", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "is_in_faction_with", l: "Şu ülkeyle aynı ittifakta", c: "dip", v: P("country") },
		{ k: "is_faction_leader", l: "İttifak lideri", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "is_subject", l: "Bağımlı ülke (kukla)", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "is_subject_of", l: "Şu ülkenin bağımlısı", c: "dip", v: P("country") },
		{ k: "is_puppet", l: "Kukla", c: "dip", v: { ...BOOL, def: "yes" } },
		{ k: "is_puppet_of", l: "Şu ülkenin kuklası", c: "dip", v: P("country") },
		{ k: "has_subject", l: "Şu ülke bağımlısı", c: "dip", v: P("country") },
		{ k: "num_subjects", l: "Bağımlı ülke sayısı", c: "dip", cmp: true, v: { ...INT, def: "1" }, op: ">" },
		{ k: "has_autonomy_state", l: "Özerklik düzeyi şu", c: "dip", v: P("autonomy") },
		{ k: "is_neighbor_of", l: "Şu ülkenin komşusu", c: "dip", v: P("country") },
		{ k: "has_opinion", l: "Şu ülke hakkındaki görüşü", c: "dip", f: [f("target", "Ülke", P("country")), f("value", "Görüş", INT, "20", { cmp: true, op: ">" })] },
		{ k: "has_opinion_modifier", l: "İlişki değiştiricisi var", c: "dip", v: P("opinion_modifier") },
		{ k: "has_non_aggression_pact_with", l: "Şu ülkeyle saldırmazlık paktı var", c: "dip", v: P("country") },
		{ k: "has_guaranteed", l: "Şu ülkeyi garanti ediyor", c: "dip", v: P("country") },
		{ k: "is_guaranteed_by", l: "Şu ülke tarafından garanti ediliyor", c: "dip", v: P("country") },
		{ k: "has_military_access_to", l: "Şu ülkeden geçiş izni var", c: "dip", v: P("country") },
		{ k: "gives_military_access_to", l: "Şu ülkeye geçiş izni veriyor", c: "dip", v: P("country") },
		{ k: "has_wargoal_against", l: "Şu ülkeye karşı savaş hedefi var", c: "dip", v: P("country") },
		{ k: "is_justifying_wargoal_against", l: "Şu ülkeye karşı savaş hedefi hazırlıyor", c: "dip", v: P("country") },
		{ k: "threat", l: "Dünya gerginliği", c: "dip", h: "0.5 = %50", cmp: true, v: { ...PCT, def: "0.5" }, op: ">" },
		{ k: "has_added_tension_amount", l: "Yarattığı gerginlik", c: "dip", cmp: true, v: { ...NUM, def: "10" }, op: ">" },
		{ k: "strength_ratio", l: "Ordu gücü oranı", c: "dip", f: [f("tag", "Şu ülkeye göre", P("country")), f("ratio", "Oran", NUM, "1", { cmp: true, op: ">" })] },
		{ k: "is_fully_controlled_by", l: "Tamamen şu ülkenin elinde", c: "dip", v: P("country") },

		/* ---------------- land and states ---------------- */
		{ k: "owns_state", l: "Şu eyaletin sahibi", c: "land", h: "Ülke kapsamında.", v: P("state") },
		{ k: "controls_state", l: "Şu eyaleti kontrol ediyor", c: "land", v: P("state") },
		{ k: "has_full_control_of_state", l: "Şu eyaletin tamamını kontrol ediyor", c: "land", v: P("state") },
		{ k: "is_owned_by", l: "Eyaletin sahibi şu ülke", c: "land", h: "Eyalet kapsamında.", v: P("country") },
		{ k: "is_controlled_by", l: "Eyaleti şu ülke kontrol ediyor", c: "land", v: P("country") },
		{ k: "is_owned_and_controlled_by", l: "Eyalet şu ülkenin ve onun kontrolünde", c: "land", v: P("country") },
		{ k: "is_core_of", l: "Eyalet şu ülkenin çekirdeği", c: "land", v: P("country") },
		{ k: "is_claimed_by", l: "Eyalette şu ülkenin iddiası var", c: "land", v: P("country") },
		{ k: "state", l: "Eyalet şu", c: "land", h: "Eyalet kapsamında: numarasıyla eyalet.", v: P("state") },
		{ k: "region", l: "Stratejik bölge numarası", c: "land", v: INT },
		{ k: "is_capital", l: "Başkent eyaleti", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "is_coastal", l: "Kıyı eyaleti", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "is_island_state", l: "Ada eyaleti", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "is_on_continent", l: "Şu kıtada", c: "land", v: { ...CONTINENTS, def: "europe" } },
		{ k: "is_in_home_area", l: "Anavatana karadan bağlı", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "is_demilitarized_zone", l: "Askerden arındırılmış bölge", c: "land", v: { ...BOOL, def: "yes" } },
		{ k: "infrastructure", l: "Altyapı seviyesi", c: "land", cmp: true, v: { ...INT, def: "3" }, op: ">" },
		{ k: "industrial_complex", l: "Sivil fabrika sayısı (eyalette)", c: "land", cmp: true, v: { ...INT, def: "1" }, op: ">" },
		{ k: "arms_factory", l: "Askeri fabrika sayısı (eyalette)", c: "land", cmp: true, v: { ...INT, def: "1" }, op: ">" },
		{ k: "dockyard", l: "Tersane sayısı (eyalette)", c: "land", cmp: true, v: { ...INT, def: "1" }, op: ">" },
		{ k: "free_building_slots", l: "Boş bina yuvası", c: "land", f: [f("building", "Bina", P("building"), "industrial_complex"), f("size", "Boş yuva", INT, "0", { cmp: true, op: ">" }), f("include_locked", "Kilitli yuvalar da", BOOL, "yes", OPT)] },
		{ k: "has_state_category", l: "Eyalet türü şu", c: "land", v: P("state_category") },
		{ k: "state_population", l: "Eyalet nüfusu", c: "land", cmp: true, v: { ...INT, def: "1000000" }, op: ">" },
		{ k: "compliance", l: "Uyum (işgal)", c: "land", cmp: true, v: { ...INT, def: "50" }, op: ">" },
		{ k: "resistance", l: "Direniş (işgal)", c: "land", cmp: true, v: { ...INT, def: "50" }, op: ">" },

		/* ---------------- flags and variables ---------------- */
		{ k: "has_country_flag", l: "Ülke işareti var (flag)", c: "flag", v: P("country_flag"), f: [f("flag", "İşaret", P("country_flag")), f("days", "Koyulalı gün", INT, "30", { cmp: true, op: ">", opt: true }), f("value", "Değeri", INT, "1", { cmp: true, op: ">", opt: true })] },
		{ k: "has_global_flag", l: "Dünya işareti var", c: "flag", v: P("global_flag"), f: [f("flag", "İşaret", P("global_flag")), f("days", "Koyulalı gün", INT, "30", { cmp: true, op: ">", opt: true })] },
		{ k: "has_state_flag", l: "Eyalet işareti var", c: "flag", v: P("state_flag"), f: [f("flag", "İşaret", P("state_flag")), f("days", "Koyulalı gün", INT, "30", { cmp: true, op: ">", opt: true })] },
		{ k: "check_variable", l: "Değişkeni karşılaştır", c: "flag", f: [f("var", "Değişken", TXT, "my_variable"), f("value", "Değer", NUM, "1"), f("compare", "Karşılaştırma", COMPARE, "greater_than_or_equals")], loose: true },
		{ k: "has_variable", l: "Değişken tanımlı", c: "flag", v: TXT },
		{ k: "has_event_target", l: "Kayıtlı hedef var", c: "flag", v: TXT },

		/* ---------------- logic and scopes ---------------- */
		{ k: "AND", l: "Hepsi doğru olmalı (VE)", c: "flow", ...TITER, same: true },
		{ k: "OR", l: "En az biri doğru olmalı (VEYA)", c: "flow", ...TITER, same: true },
		{ k: "NOT", l: "Hiçbiri doğru olmamalı (DEĞİL)", c: "flow", ...TITER, same: true },
		{ k: "count_triggers", l: "En az şu kadarı doğru olmalı", c: "flow", f: [f("amount", "Kaç tanesi", INT, "2")], ...TITER, same: true },
		{ k: "if", l: "Eğer… ise şunlar da doğru olmalı", c: "flow", limit: true, limitFirst: true, ...TITER, same: true },
		{ k: "else_if", l: "Değilse eğer…", c: "flow", limit: true, limitFirst: true, ...TITER, same: true },
		{ k: "else", l: "Değilse", c: "flow", ...TITER, same: true },
		{ k: "hidden_trigger", l: "Gizli koşul (ipucunda görünmez)", c: "flow", ...TITER, same: true },
		{ k: "custom_trigger_tooltip", l: "Koşulu kendi metninle göster", c: "flow", h: "İçindeki koşullar yerine yazdığın metin görünür.", f: [f("tooltip", "Görünen metin", LOC)], ...TITER, same: true },
		{ k: "always", l: "Her zaman", c: "flow", h: "yes: her zaman doğru, no: hiçbir zaman.", v: { ...BOOL, def: "yes" } },
		{ k: "any_owned_state", l: "Sahip olunan eyaletlerden biri", c: "flow", ...TITER, scope: "state" },
		{ k: "all_owned_state", l: "Sahip olunan eyaletlerin hepsi", c: "flow", ...TITER, scope: "state" },
		{ k: "any_controlled_state", l: "Kontrol edilen eyaletlerden biri", c: "flow", ...TITER, scope: "state" },
		{ k: "all_controlled_state", l: "Kontrol edilen eyaletlerin hepsi", c: "flow", ...TITER, scope: "state" },
		{ k: "any_core_state", l: "Çekirdek eyaletlerden biri", c: "flow", ...TITER, scope: "state" },
		{ k: "all_core_state", l: "Çekirdek eyaletlerin hepsi", c: "flow", ...TITER, scope: "state" },
		{ k: "any_state", l: "Dünyadaki eyaletlerden biri", c: "flow", ...TITER, scope: "state" },
		{ k: "all_state", l: "Dünyadaki eyaletlerin hepsi", c: "flow", ...TITER, scope: "state" },
		{ k: "any_neighbor_state", l: "Komşu eyaletlerden biri", c: "flow", ...TITER, scope: "state" },
		{ k: "all_neighbor_state", l: "Komşu eyaletlerin hepsi", c: "flow", ...TITER, scope: "state" },
		{ k: "capital_scope", l: "Başkent eyaleti için", c: "flow", ...TITER, scope: "state" },
		{ k: "any_country", l: "Ülkelerden biri", c: "flow", ...TITER, scope: "country" },
		{ k: "all_country", l: "Ülkelerin hepsi", c: "flow", ...TITER, scope: "country" },
		{ k: "any_other_country", l: "Diğer ülkelerden biri", c: "flow", ...TITER, scope: "country" },
		{ k: "all_other_country", l: "Diğer ülkelerin hepsi", c: "flow", ...TITER, scope: "country" },
		{ k: "any_neighbor_country", l: "Komşu ülkelerden biri", c: "flow", ...TITER, scope: "country" },
		{ k: "all_neighbor_country", l: "Komşu ülkelerin hepsi", c: "flow", ...TITER, scope: "country" },
		{ k: "any_enemy_country", l: "Düşman ülkelerden biri", c: "flow", ...TITER, scope: "country" },
		{ k: "all_enemy_country", l: "Düşman ülkelerin hepsi", c: "flow", ...TITER, scope: "country" },
		{ k: "any_allied_country", l: "Müttefiklerden biri", c: "flow", ...TITER, scope: "country" },
		{ k: "all_allied_country", l: "Müttefiklerin hepsi", c: "flow", ...TITER, scope: "country" },
		{ k: "any_subject_country", l: "Bağımlı ülkelerden biri", c: "flow", ...TITER, scope: "country" },
		{ k: "all_subject_countries", l: "Bağımlı ülkelerin hepsi", c: "flow", ...TITER, scope: "country" },
		{ k: "owner", l: "Eyaletin sahibi için", c: "flow", ...TITER, scope: "country" },
		{ k: "controller", l: "Eyaleti kontrol eden için", c: "flow", ...TITER, scope: "country" },
		{ k: "overlord", l: "Efendi ülke için", c: "flow", ...TITER, scope: "country" },
		{ k: "faction_leader", l: "İttifak lideri için", c: "flow", ...TITER, scope: "country" },
		...dynamic("triggers"),

		/* ---------------- AI weight blocks (ai_will_do, ai_chance) ---------------- */
		{ k: "base", l: "Temel ağırlık", c: "ai", h: "Yapay zekânın bunu seçme isteği; 0 = asla.", v: { ...NUM, def: "1" }, ai: true },
		{ k: "factor", l: "Çarpan", c: "ai", h: "Ağırlığı bununla çarpar.", v: { ...NUM, def: "1" }, ai: true },
		{ k: "add", l: "Ağırlığa ekle", c: "ai", v: { ...NUM, def: "1" }, ai: true },
		{ k: "modifier", l: "Şu durumda ağırlığı değiştir", c: "ai", h: "İçindeki koşullar doğruysa çarpan ya da ekleme uygulanır.", f: [f("factor", "Çarpan", NUM, "2", OPT), f("add", "Ekle", NUM, "1", OPT)], ...TITER, same: true, ai: true, tplFields: ["factor"] },
	];

	/* Blocks that are not effects but sit among them: the parts of an event option. */
	const OPTION_PARTS = [
		{ k: "name", l: "Seçenek metni", hidden: true, v: TXT },
		{ k: "trigger", l: "Seçeneğin görünme koşulu", h: "Koşul doğru değilse seçenek hiç gösterilmez.", body: "triggers", same: true },
		{ k: "ai_chance", l: "Yapay zekânın seçme ağırlığı", body: "triggers", same: true, aiRoot: true },
		{ k: "original_recipient_only", l: "Yalnızca ilk alıcıya göster", v: { ...BOOL, def: "yes" } },
	];

	const index = { effect: new Map(), trigger: new Map() };
	for (const e of EFFECTS) if (e.k) index.effect.set(e.k, e);
	for (const e of TRIGGERS) if (e.k) index.trigger.set(e.k, e);
	const patterns = { effect: EFFECTS.filter((e) => e.match), trigger: TRIGGERS.filter((e) => e.match) };
	const WEIGHT = { id: "@weight", l: "Seçenek (ağırlık)", weight: true, body: "effects", same: true };
	const AI_ROOT = { aiRoot: true };

	/* The entry that describes a statement, or null. `mode` is "effect" or "trigger"; `parent` is the
	 * entry of the block the statement sits in: the numbers inside random_list are weights, not states,
	 * and base / factor / add / modifier only mean something inside an AI weight block. */
	function find(mode, key, parent, isBlock) {
		if (key == null) return null;
		if (parent && parent.weights) return /^-?\d+(\.\d+)?$/.test(key) && isBlock ? WEIGHT : null;
		const inAi = !!(parent && (parent.aiRoot || parent.ai));
		const usable = (e) => e && (!e.ai || inAi) && (isBlock ? !!(e.f || e.list || e.map || e.body || e.code || e.weights) : !!e.v);
		const known = index[mode].get(key);
		if (usable(known)) return known;
		if (known) return null;  /* a known key written in a form the entry does not describe */
		/* IF, ELSE, and, or, not are written in either case */
		for (const variant of [String(key).toLowerCase(), String(key).toUpperCase()]) {
			const other = index[mode].get(variant);
			if (other && other.body && isBlock && usable(other)) return other;
		}
		for (const e of patterns[mode]) if (e.match.test(key) && (isBlock ? !e.pairOnly : !!e.pairOnly)) return e;
		return null;
	}

	return { EFFECTS, TRIGGERS, OPTION_PARTS, CATEGORIES, find, WEIGHT, AI_ROOT, REFS };
})();

if (typeof module !== "undefined") module.exports = ScriptSchema;
