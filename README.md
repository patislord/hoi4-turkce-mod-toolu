# HOI4 Türkçe Mod Toolu

Hearts of Iron IV modları için Türkçe arayüzlü, tarayıcıda çalışan görsel bir editör. Var olan bir modu açar; focus ağaçlarını, olayları, kararları ve daha fazlasını kod yazmadan düzenlemeni sağlar.

## Gereken uygulamalar

| Uygulama | Neden gerekli | İndirme |
|---|---|---|
| **Hearts of Iron IV** | Oyunun kendi dosyaları (ikonlar, metinler, vanilla içerik) buradan okunur. |  |
| **Python 3** (3.15 ile test edildi) | Tool Python ile çalışır. Kurarken **"Add Python to PATH"** kutusunu işaretle. | https://www.python.org/downloads/ |
| **HOI4 Mod Setup** | Tool'un kullandığı ortak dosyaları (`.tools/lib`, `.tools/check.py`) modunun içine kurar. | https://github.com/klimPaskov/HOI4-Mod-Setup |
| **Git** | Bu repoyu indirmek için. (İstersen yerine GitHub'dan ZIP indirebilirsin.) | https://git-scm.com/downloads |
| *Claude Code (isteğe bağlı)* | Editörde seçtiğin şeyi tek tıkla bir Claude Code oturumuna gönderebilirsin. Kullanmıyorsan gerekmez. | https://claude.com/claude-code |

## Kurulum

1. **HOI4 Mod Setup ile modunu hazırla.** Kurulum bittiğinde modunun klasöründe `.tools` adında bir klasör olur.

2. **Bu repoyu `.tools/mod_studio` klasörüne indir.** Modunun ana klasöründe bir terminal açıp şunu çalıştır:
   ```
   git clone https://github.com/patislord/hoi4-turkce-mod-toolu.git .tools/mod_studio
   ```
   ZIP indirdiysen, içindekileri `.tools/mod_studio` klasörüne çıkar.

3. **Hangi modun düzenleneceğini ayarla.** `.tools/local_settings.json` dosyasını aç (HOI4 Mod Setup genelde oluşturur) ve yolları kendi bilgisayarına göre yaz:
   ```json
   {
     "hoi4_game_dir": "C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV",
     "mod_root": "C:/Users/<kullanıcı>/Documents/Paradox Interactive/Hearts of Iron IV/mod/<mod-klasörü>"
   }
   ```
   - `mod_root` yazmazsan tool, `.tools` klasörünün bir üstündeki klasörü mod olarak kabul eder.
   - Başka bir modu düzenlemek için sadece `mod_root` yolunu değiştir.

## Kullanım

1. `.tools/mod_studio/studio.bat` dosyasına çift tıkla.
   Ya da modun ana klasöründe: `python -B .tools/mod_studio/studio.py`
2. Siyah bir konsol penceresi açılır, metinler ve ikonlar yüklenir, ardından tarayıcıda `http://127.0.0.1:8765` kendiliğinden açılır.
3. Üstteki menüden düzenlemek istediğin bölümü seç:
   - **Odak Ağaçları** – focus'ları sürükle, ödül ve koşullarını düzenle
   - **Milli Ruhlar** – idea'lar ve modifier'ları
   - **Kararlar** – decision'lar ve kategorileri
   - **Olaylar** – event'ler, pencere önizlemesi ve olay zinciri grafiği
   - **Ülkeler** – ülke bilgileri, yeni ülke ekleme
   - **Karakterler** – liderler, danışmanlar, portreler ve özellikler
   - **Mod Sağlığı** – modundaki hataları listeler, tıklayınca ilgili editöre götürür
4. Ödül, koşul ve efektleri görsel oluşturucudan seçerek ekleyebilir ya da kodunu doğrudan yazabilirsin.
5. **Kaydet**'e bastığında değişiklikler mod dosyalarına yazılır. Oyunu açıp test edebilirsin.
6. İşin bitince konsol penceresini kapat.

**Komut satırı seçenekleri:**
- `--port 9000` – farklı bir port kullan
- `--page "focus.html?file=common/national_focus/SYR.txt"` – belirli bir sayfayla aç
- `--no-browser` – tarayıcıyı kendiliğinden açma

## Güvenlik ve yedek

- Her kayıttan önce dosyaların yedeği `.tmp/mod_studio/backups/` klasörüne (`.tools` klasörünün yanında) alınır.
- Sadece değişen kısımlar yeniden yazılır; dosyanın geri kalanına dokunulmaz.
- Oyunun kendi dosyasından bir şey düzenlersen, dosya önce moda kopyalanır. Oyun dosyaları hiç değişmez.
- Editör yalnızca senin bilgisayarında (`127.0.0.1`) çalışır ve her açılışta yeni bir erişim anahtarı üretir; başka siteler ona erişemez.

## Sık karşılaşılan sorunlar

- **`python` bulunamadı:** Python kurulurken "Add Python to PATH" işaretlenmemiş. Python'u yeniden kurup bu kutuyu işaretle.
- **`No module named lib`:** `.tools/lib` klasörü yok. Modunu HOI4 Mod Setup ile kur ve bu repoyu tam olarak `.tools/mod_studio` klasörüne koy.
- **"Stüdyoya ulaşılamıyor":** Konsol penceresi kapanmış. `studio.bat` ile yeniden başlat.
- **Port kullanımda:** `studio.py --port 9000` ile başka bir port dene.

## Notlar

- Yerelleştirme yalnızca İngilizce (`localisation/english`) dosyalarına yazılır.
- Aynı anda tek bir mod üzerinde çalışır.
