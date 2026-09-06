<p align="center">
  <img src="../assets/logo.png" width="200" alt="Lemma Logo">
</p>

# Lemma — LLM'ler için Kalıcı Bellek (MCP)

[English](../README.md) | [Türkçe](README.tr.md)

Lemma, LLM'lere oturumlar arası kalıcı bellek sağlayan bir MCP sunucusudur. Bellekler her oturuma otomatik enjekte edilir — araç çağrısına gerek yoktur. Bilgi kullanım yoluyla evrilir: sık erişilenler güçlenir, kullanılmayanlar solar, örüntüler yeniden kullanılabilir yeteneklere dönüştürülür. Arka planda otonom bir zeka katmanı çalışır — çelişkileri tespit eder, eylem önerileri sunar ve ilgili bilgileri otomatik bağlar. **Mantık sürekliliği** denenen/reddedilen yaklaşımları kaydeder ve her yeni oturumun başında çıkmaz sokakları (dead-end) hatırlatır, böylece aynı başarısız yol iki kez denenmez.

## Hızlı Başlangıç

Lemma'yı MCP istemci yapılandırmanıza ekleyin:

**Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
**Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Claude Code (Linux):** `~/.claude.json` veya `~/.claude/settings.json`
**opencode:** `~/.config/opencode/opencode.json` (Linux/macOS) veya `%APPDATA%\opencode\opencode.json` (Windows)

```json
{
  "mcpServers": {
    "lemma": {
      "command": "npx",
      "args": ["-y", "lemma-mcp@latest"]
    }
  }
}
```

> `@latest` kullanmak npx'in her zaman en yeni sürümü çekmesini sağlar.

**Gereksinimler:** Node.js 20.0.0 veya üzeri

### CLI Kullanımı

```bash
lemma -lib    # Library Mode: bilgi tabanınızın tam anlık görüntüsü
lemma -vis    # Visualizer: tarayıcıda etkileşimli bellek grafiği
lemma -vis -p 8080  # Özel port ile Visualizer (varsayılan: 3456)
```

**Library Mode** (`-lib`) tüm bellekler, rehberler, ilişkiler, eski fragmanlar, damıtma adayları ve önerilen eylemlerin tam analizini çıkarır. Periyodik bakım ve inceleme için kullanışlıdır.

**Visualizer** (`-vis`) yalnızca localhost'a bağlı, token korumalı bir HTTP sunucusu başlatır ve bellek fragmanlarınızı tarayıcıda etkileşimli D3.js grafiği olarak açar. Düğümler bellekleri, bağlantılar ilişkileri ve çağrışımları gösterir. Düzenleme, silme, bağlama ve bağlantı kaldırma işlemleri SQLite veritabanına gerçek zamanlı yazılır.

## Nasıl Çalışır?

Bellekler `tools/list` üzerinden araç açıklamalarına enjekte edilir. LLM her oturuma en önemli belleklerini zaten bilerek başlar.

**3 katmanlı enjeksiyon:**
- En önemli bellekler için tam içerik (token bütçeli)
- Kalan bellekler için özet indeksi
- Öğrenimleriyle aktif rehberler

**Bellek türleri:** `fact`, `pattern`, `lesson`, `warning`, `context`

**Bilgi hattı:** Memory (ne biliyorsun, `memory_add`) → Pattern (`type: "pattern"`) → Guide (nasıl çalışıyorsun, `guide_distill` → `guide_practice`)

**Proje dosyasına müdahale yok:** Lemma belleği MCP prompt katmanı (sistem prompt'u ve araç açıklamaları) üzerinden enjekte eder; `AGENTS.md`'ye veya herhangi bir proje dosyasına asla yazmaz. Tüm MCP istemcilerinde aynı çalışır. (Eski sürümlerin bıraktığı `<!-- lemma:* -->` blokları açılışta otomatik temizlenir.)

## Otonom Zeka

Lemma arka planda zeka çalıştırır — manuel tetiklemeye gerek yoktur:

- **Çelişki Tespiti:** Yeni bellekleri mevcut bilgiyle otomatik karşılaştırır. Çelişkileri çözüm önerileriyle raporlar.
- **Proaktif Öneriler:** Bellek ekledikten veya rehber pratiği yaptıktan sonra örüntüleri damıtma, yinelenenleri birleştirme veya düşük performanslı rehberleri iyileştirme gibi eylemler önerir.
- **Otomatik Bağlama:** Sık birlikte okunan bellekler ve konu örtüşen fragmanlar otomatik olarak ilişkilendirilir.

Manuel derin analiz de özel araçlarla kullanılabilir.

## Araçlar (29)

Lemma `memory_read`, `memory_add`, `session_start` gibi kısa MCP araç adları sunar. Çoğu istemci araçları sunucu adıyla birlikte gösterir; bu yüzden `mcp_lemma_memory_add` gibi adlar görmeniz normaldir. `mcp_lemma_lemma_memory_add` gibi iki kez tekrarlanan adlar kullanılmaz.

### Bellek (10)

| Araç | Açıklama |
|------|----------|
| `memory_read` | Fragmanları oku/ara. Özet modu veya ID ile tam detay |
| `memory_add` | Bulguları kaydet. Gizli bilgileri otomatik sansürler, tekrarları ve çelişkileri algılar |
| `memory_update` | ID ile fragman güncelle |
| `memory_feedback` | Pozitif/negatif geri bildirim, güveni ayarlar |
| `memory_forget` | Fragman sil |
| `memory_merge` | Fragmanları birleştir, ilişkiler ve rehber bağlantıları aktarılır |
| `memory_relate` | Tipli bağlantılar oluştur (`contradicts`, `supersedes`, `supports`, `related_to`) |
| `memory_stats` | Fragman sayıları, güven, proje dağılımı |
| `memory_audit` | Bütünlük kontrolü (yetim, tekrar, anomali) |
| `memory_library` | Tüm bilgi tabanının analiz sinyalleri ve önerilerle tam anlık görüntüsü |

### Rehberler (7)

| Araç | Açıklama |
|------|----------|
| `guide_get` | Kullanıma göre sıralı rehberler, kategori veya görev filtresi |
| `guide_practice` | Rehber kullanımını kaydet. Rehber yoksa otomatik oluşturur |
| `guide_create` | Detaylı kılavuzla rehber oluştur |
| `guide_distill` | Belleği rehber öğrenimine dönüştür (çift yönlü bağlantı) |
| `guide_update` | Rehber özelliklerini, anti-örüntüleri, tuzakları güncelle |
| `guide_forget` | Rehber sil |
| `guide_merge` | Rehberleri birleştir, kaynak bellekleri aktar |

### Oturumlar (5)

| Araç | Açıklama |
|------|----------|
| `session_start` | İzlenen oturum başlat, ilgili bağlamı önceden yükle |
| `session_attempt` | Denenen bir yaklaşımı kaydet (reddedilen/kısmi/umut verici) — çıkmaz sokaklar değerli bellektir |
| `session_end` | İnceleme, otomatik bağlama ve önerilerle oturumu sonlandır |
| `session_stats` | Sanal oturum istatistikleri |
| `suggestion_respond` | Sunulan iyileştirme önerisini kabul et veya reddet (Lemma tercihlerini öğrenir) |

### Zeka (4)

| Araç | Açıklama |
|------|----------|
| `conflict_scan` | Tüm bellekleri çelişkiler için tara |
| `proactive_analysis` | Tam bilgi tabanı analizi: eski, yetim, damıtma adayları, kullanım dışı |
| `project_analytics` | Oturumlar arası proje sağlığı, büyüme oranı, beceri kapsama |
| `semantic_search` | TF-IDF benzerlik araması |

### Yedekleme ve geri yükleme (3)

| Araç | Açıklama |
|------|----------|
| `backup_create` | Tüm veritabanı kayıtlarını tek taşınabilir dosyaya yedekler ve doğrular |
| `backup_preview` | Yedeği kontrol eder, mevcut kayıtlarla karşılaştırır ve onay için hazırlar |
| `backup_restore` | Açık onaydan sonra güvenlik yedeği alıp hafızayı geri yükler |

## MCP ile yedekleme ve geri yükleme

Terminal kullanmadan asistanına **“Lemma hafızamı şu klasöre yedekle”** diyebilirsin. Asistan `backup_create` aracını çağırır ve doğrulanmış `.lemma-backup` dosyasının konumunu verir. Klasör belirtmezsen `~/.lemma/backups/` kullanılır. Dosyalar tarih ve benzersiz ad taşır; eski yedeklerin üzerine yazılmaz.

Yeni bilgisayarda uyumlu Lemma MCP sürümünü kurup dosyayı bilgisayara getirmen yeterlidir. Windows, macOS ve Linux aynı yedek biçimini kullanır. **“Şu dosyadan Lemma hafızamı geri yükle”** dediğinde:

1. `backup_preview` dosyayı doğrular, yedekteki ve mevcut hafızadaki kayıt sayılarını gösterir. İşlem tüm projeleri ve genel hafızayı yedekteki duruma döndürür; kayıtları birleştirmez.
2. Önizleme bağlantı durumunu da gösterir: **“Hazır”**, kontrol edilen başka Lemma bağlantısı olmadığını; **“Engellendi”**, çözülmesi gereken bir bağlantı engeli bulunduğunu belirtir. Engel varsa onay istenmez, onay anahtarı üretilmez ve önceki anahtarlar geçersiz olur. Belirtilen diğer bağlantıları veya görselleştiricileri kapatıp yeniden önizleme yaparsın; **bu konuşmanın MCP bağlantısı açık kalır**. Durum hazır olduğunda asistan senden açık onay ister. Açık konuşma sayısı tek başına engel değildir; veritabanına bağlı Lemma bağlantıları kontrol edilir. Eski Lemma sürümleri ve harici SQLite araçları bu kontrolde görülemez.
3. `backup_restore` bağlantıları tekrar kontrol eder; önizlemeden sonra yeni bir bağlantı açılmışsa işlem engellenir. Hazır durumu, önizleme anındaki bağlantı kontrolünü gösterir; geri yüklemenin başarı garantisi değildir. Lemma mevcut veritabanının doğrulanmış güvenlik yedeğini oluşturur. Ardından kayıtları tek SQLite işlemi içinde geri yükleyip kontrol eder. İşlem tamamlanmadan hata oluşursa mevcut veriler korunur.
4. MCP bağlantısını kullanmaya devam edebilirsin. Sonuçta verilen `safety_backup_path`, gerekirse aynı önizleme/onay akışıyla önceki hafızaya dönmeni sağlar.

Önizleme, **mevcut bağlantının işlem numarasını (PID)** ve **engelleyici diğer bağlantıların işlem numaralarını** ayrı gösterir. Her bağlantının ayrıca kendine ait kimliği bulunur; aynı işlemde birden fazla bağlantı varsa bu belirtilir ve mevcut işlem kapatılmaz. Bu kayıtlardan konuşma adı veya kimliği belirlenemiyorsa açıkça “belirlenemiyor” denir. Doğrulanamayan bağlantı kayıtları ve inceleme hataları da ayrı gösterilir ve geri yüklemeyi engeller. İşlem numarası bir kapatma talimatı değildir; diğer bağlantıları kendi uygulaması üzerinden kapatıp yeniden önizleme yapılır.

Hafıza, rehberler, öğrenimler, ilişkiler, arşivlenmiş/geçersiz kılınmış kayıtlar, sürüm geçmişi, kanıtlar, geri bildirimler ve veritabanındaki oturum/deneme/öneri kayıtları kapsanır. Arama indeksleri yeniden oluşturulur. Yedek alındığında açık olan oturumlar geri yüklemede geçmiş kayıt olarak kapatılır; mevcut konuşmanın metni silinmez. Temiz bağlam için yeni konuşma açabilirsin.

Bilgisayara özgü `config.json`, ham oturum ve trafik logları, tanılama logları, kurulu skill/model dosyaları ve MCP istemci ayarları kapsam dışındadır. Kayıtların içinde geçen eski dosya yolları otomatik değiştirilmez.

İlk sürümde veritabanı boyutu en fazla 128 MiB olabilir. Bu yedek biçimindeki bilinen 1–8 şemaları güncel şemaya (8) geri yüklenebilir. Eski şemanın tanımı ve geçiş geçmişi doğrulanır; dönüşüm yalnızca uygulamanın kendi geçişleriyle bellekteki kopyada yapılır. Orijinal dosya değişmez. Önizlemede `schema_upgrade` sürüm aralığı ve notları onaydan önce gösterilir. Şema 1 veya 2'den dönüşümde proje yolları/adları ve genel kapsam normalleştirilir. Bu özellik rastgele eski SQLite/JSONL dosyalarını içe aktarmaz ve gelecekteki sürümler için sınırsız uyumluluk vaat etmez. Bozuk, bilinmeyen veya daha yeni şemalı yedekler reddedilir. Onay 10 dakika geçerlidir, tek kullanımlıktır; dosya ya da hafıza değişirse yeniden önizleme ve onay gerekir. Yeni Lemma bağlantıları işlem kilidine uyar, açık diğer bağlantılar geri yüklemeyi engeller. Eski sürümler ve harici SQLite araçları bu bağlantı kontrolüne katılmadığından onları da kapatmalısın.

**Yedekler şifrelenmez; özel bilgilerini içerir.** Güvenilir bir yerde sakla ve formatlanacak diskin dışında bir kopya bulundur. Bu özellik bulut eşitleme veya tüm kurulum dosyalarının yedeği değildir. `lemma -lib` çıktısı geri yüklenebilir bir yedek değildir. Ayrıntılı kapsam ve güvenlik davranışı için [İngilizce belgeye](../README.md#backup-and-restore-through-mcp) bakabilirsin.

**Eski kurulumlarla uyumluluk:** Lemma 0.15.0 öncesinden kalmış kullanılmayan `memory_vectors` / `vec0` yapısı, yalnızca bilinen tablo tanımları ve sürüm metaverisi eşleşiyorsa, veri tabloları boşsa ve eski yazma sayacı yoksa kabul edilir. Yedek dosyası bu eski yapıyı da saklar. Geri yükleme hedefte zaten bulunan boş yapıyı korur; yeni kurulumda artık kullanılmayan indeksi yeniden oluşturmaz. Hafıza, rehber ve güncel arama verileri normal biçimde geri yüklenir. Veri içeren vektör tabloları veya farklı şemalar reddedilir; mevcut veritabanında otomatik temizlik yapılmaz.

## Bu bilgi neden hatırlandı?

Asistanına “Bu bilgiyi neden hatırladığını açıkla” diyebilir veya `memory_read` / `semantic_search` çağrısına `explain: true` ekleyebilirsin. Varsayılan olarak kapalıdır; normal yanıtlar uzamaz ve yeni bir araç eklenmez.

```json
{"query":"retry policy","project":"projem","explain":true,"response_format":"json"}
```

`recall_explanation`, gerçek seçim yöntemini ve puanını, kayıtlı kaynağı/oturumu, kaynak dosyalarını ve kontrol durumunu gösterir. Kimlikle okumada “bu kimlik istendi” der; ilişkiler üzerinden gelen kayıtlarda kök kimliği ve bağlantı derinliğini gösterir. Açıklama **bu çağrıya aittir**; eski bir konuşmanın veya otomatik bağlam eklemesinin nedenini sonradan tahmin etmez.

Güven puanı doğruluk kanıtı, son erişim tarihi de son doğrulama tarihi değildir. Kaynak dosyaları yalnızca `verification.stale_check` açıkken kontrol edilir; kayıt başına en fazla beş kaynak incelenir ve sınır belirtilir. Kaynak yoksa veya kontrol kapalıysa bunu açıkça söyler. Kod parçasının hâlâ bulunması, bilginin doğruluğunun kanıtlandığı anlamına gelmez. Açıklama, bu okumanın erişim/güven artışından önceki durumu kullanır; metin ve JSON biçimlerini destekler.

Açıklama istemek kayıtları otomatik düzeltmez. İnceledikten sonra içeriği `memory_update` ile düzeltebilir, eski bilgiyi geçmişini koruyarak `memory_forget` + `invalidate: true` ile gizleyebilir veya `memory_relate` ile yeni bilgiye/çelişkiye bağlayabilirsin.

## Yapılandırma

`~/.lemma/config.json` konumunda isteğe bağlı:

```json
{
  "token_budget": {
    "full_content": 5000,
    "summary_index": 1000,
    "guides_detail": 1000
  },
  "injection": {
    "max_full_content_fragments": 15,
    "max_summary_fragments": 30,
    "max_guides": 20
  },
  "virtual_session": {
    "timeout_minutes": 30
  }
}
```

## Dosya Konumları

| İşletim Sistemi | Yol |
|---|---|
| **Windows** | `C:\Users\{username}\.lemma\` |
| **macOS/Linux** | `~/.lemma/` |

Dosyalar: `lemma.db` (SQLite), `config.json`, `sessions/`, `logs/`

## Arama

Lemma bellek arama, tekrar algılama ve konu örtüşme tespiti için **SQLite FTS5** tam metin arama kullanır.

## Veri Depolama

Tüm veriler tek bir SQLite veritabanında (`~/.lemma/lemma.db`) saklanır:

| Tablo | Amaç |
|-------|------|
| `memories` | Bellek fragmanları (FTS5 + metadata) |
| `guides` | Prosedürel bilgi ve öğrenimler |
| `sessions` | Oturum takibi ve sonuçlar |
| `relations` | Bellekler arası tipli bağlantılar |
| `guide_learnings` | Rehber bazlı biriken öğrenimler |
| `guide_memory_links` | Çift yönlü rehber ↔ bellek bağlantıları |

Eski JSONL dosyaları ilk çalıştırmada otomatik olarak taşınır.

## Güvenlik

Lemma tasarım gereği yerel-önceliklidir:

- **Yerel depolama** — tüm veriler `~/.lemma/` dizininde kalır; hiçbir şey harici sunuculara gönderilmez.
- **Gizli bilgi sansürleme** — gizliler bellek fragmanlarından VE traffic log'larından otomatik temizlenir (API anahtarları, tokenlar, bağlantı dizgileri için 17 regex deseni; konum-tabanlı, aşırı-maskeleme ve overlap bug'ı yok).
- **Visualizer sertleştirme** — visualizer yalnızca `127.0.0.1`'e bağlanır (`0.0.0.0` asla), `X-Lemma-Token` gerektirir ve dar bir localhost CORS allow-list kullanır (`Access-Control-Allow-Origin: *` yok).

## Dokümantasyon

- [Geliştirme Rehberi](development/DEVELOPMENT.md) — Mimari, proje yapısı, test
- [Araştırmalar](research/README.md) — Lemma'nın tasarımını etkileyen akademik makaleler
- [Değişiklik Günlüğü](../CHANGELOG.md) — Sürüm geçmişi

## Lisans

MIT
