# Lemma - LLM'ler için Kalıcı Bellek (MCP)

[English](README.md) | [Türkçe](README.tr.md)

Lemma, Büyük Dil Modelleri (LLM) için kalıcı bir bellek katmanı sağlayan bir Model Kontrol Protokolü (MCP) sunucusudur. LLM'lerin oturumlar arasında gerçekleri, tercihleri ve bağlamı hatırlamasını sağlayan, biyolojik çürüme (decay) algoritmasına sahip şık bir arayüzdür.

## Lemma Nedir?

Lemma, AI asistanları için harici bir "hipokampüs" görevi görür. İnsan beyni her şeyi kaydetmez; bilgiyi sentezler, damıtır ve fragmanlar bırakır. Sık erişilen bilgiler güçlenirken, kullanılmayan bilgiler zamanla solar ve unutulur.

Lemma aynı prensiple çalışır:

- **Ham konuşmalar asla saklanmaz** — sadece sentezlenmiş fragmanlar tutulur.
- **Fragmanlar zamanla çürür** — sık erişilenler kalıcı hale gelir.
- **LLM her oturumda bu fragmanları okur** ve bağlamını hatırlar.

## Nasıl Çalışır?

### Bellek Yapısı

Her bellek fragmanı şu alanlara sahiptir:

| Alan | Tip | Açıklama |
|-------|------|-------------|
| `id` | string | Benzersiz kimlik (`m` + 6 hex karakter) |
| `title` | string | Hızlı tarama için kısa başlık |
| `fragment` | string | Sentezlenmiş bellek metni |
| `project` | string | Proje kapsamı (küresel için `null`) |
| `confidence` | float | Güven puanı 0.0-1.0 (zamanla azalır) |
| `source` | string | `"user"` (kullanıcı istedi) veya `"ai"` (AI fark etti) |
| `created` | string | Oluşturulma tarihi (YYYY-MM-DD) |
| `lastAccessed` | string | Son erişim zamanı (ISO timestamp) |
| `accessed` | int | Mevcut çürüme döngüsündeki erişim sayısı |

### Çürüme (Decay) Mekanizması

Çürüme, bellek her okunduğunda uygulanır. Lemma, biyolojik bir model kullanır: erişim sıklığı belleği güçlendirirken, erişilmeyen süre belleği zayıflatır:

```
modifier = max(0.005, 0.05 - (accessed * 0.005))
time_multiplier = 1 + (gecen_gun_sayisi * 0.05)
decay_step = modifier * time_multiplier
confidence = confidence - decay_step
```

- **Sıklık**: Sık erişilen öğeler minimum çürüme hızına ulaşır.
- **Güncellik**: Uzun süre erişilmeyen öğeler `time_multiplier` nedeniyle daha hızlı çürür.
- **Temizlik**: Güven puanı **0.1'in altına düşen** fragmanlar otomatik olarak silinir.

### Bellek Dosyası Konumu

Bellekler JSONL formatında şu adreste saklanır:

| İşletim Sistemi | Yol |
|---|---|
| **Windows** | `C:\Users\{kullanıcı}\.lemma\memory.jsonl` |
| **macOS** | `/Users/{kullanıcı}/.lemma/memory.jsonl` |
| **Linux** | `/home/{kullanıcı}/.lemma/memory.jsonl` |

## Hızlı Başlangıç (Kurulum Gerektirmez)

Lemma'yı kullanmanın en kolay yolu `npx` kullanarak doğrudan GitHub üzerinden çalıştırmaktır. Depoyu (repository) indirmenize bile gerek yok!

Bunu MCP istemci konfigürasyonunuza ekleyin:

**Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`  
**Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lemma": {
      "command": "npx",
      "args": ["-y", "github:xenitV1/lemma"]
    }
  }
}
```

---

## 🚀 Manuel Kurulum (Geliştiriciler İçin)

Eğer Lemma üzerinde değişiklik yapmak veya yerel çalıştırmak isterseniz:

```bash
git clone https://github.com/xenitV1/lemma
cd Lemma
npm install
```

### Gereksinimler

- Node.js 18.0.0 veya üzeri

### Yerel Konfigürasyon

Eğer depoyu yerel olarak klonladıysanız, bu konfigürasyonu kullanın:

```json
{
  "mcpServers": {
    "lemma": {
      "command": "node",
      "args": ["C:\\yol\\to\\Lemma\\memory.js"]
    }
  }
}
```

---

## Sistem İstemi (System Prompt)

SUNUCU, `lemma://system-prompt` adresinde bir sistem istemi kaynağı sağlar. MCP istemcileri bunu otomatik olarak keşfedebilir.

**Manuel konfigürasyon** (gerekirse):

```
# Lemma — Kalıcı Bellek Sistemi

Bu senin kalıcı bellek katmanındır. İnsan beyni gibi çalışır: sadece önemli fragmanlar tutulur, sık erişilenler güçlenir, kullanılmayanlar silinir.

BELLEĞE YAZMA KURALLARI:
1. Kullanıcı açıkça hatırlamanı isterse → kaydet. kaynak: "user"
2. Önemli bir şey fark edersen → kaydet. kaynak: "ai"
3. Ham veriyi değil, sentezlenmiş özü yaz. Tek cümle yeterlidir.
4. Her şeyi saklama. Sadece gerçekten önemli olanları seç.
5. Yeni bir fragman eskisiyle çelişiyorsa → add yerine update kullan.

BELLEKTEN OKUMA:
- Mevcut bağlamla ilgili olduklarında fragmanları kullan.
- Güven puanı (confidence) 0.3'ün altındakilere daha az güven.

Her oturumun başında: Saklanan fragmanları yüklemek için memory_read çağır.
```

## Mevcut Araçlar (Tools)

### `memory_read`

Bellek fragmanlarını LLM kullanımı için formatlanmış şekilde döndürür. Güven çürümesini uygular, en iyi K öğeyi seçer ve optimum bağlam için yeniden formatlar.

**Parametreler:**
- `project` (string, opsiyonel): Filtrelenecek proje adı (varsayılan: mevcut proje).
- `query` (string, opsiyonel): Belirli bir bağlamı bulmak için semantik arama anahtar kelimesi.

**Dönüş:** Güven çubuklarıyla formatlanmış string:

```
=== LEMMA BELLEK FRAGMANLARI ===
[m1a2b3] █████ (🤖 ai) İletişim tarzı
    Kullanıcı kısa ve doğrudan cevapları tercih ediyor
[m4c5d6] █████ (👤 user) Proje yığını
    Proje TypeScript, Node 20 kullanıyor
================================
```

### `memory_check`

**ZORUNLU:** Herhangi bir analiz, araştırma veya doküman okumadan ÖNCE çağrılmalıdır. Projenin/konunun zaten bellekte olup olmadığını kontrol eder. Gereksiz (tekrar eden) çalışmayı önler.

**Parametreler:**
- `project` (string, opsiyonel): Kontrol edilecek proje adı (varsayılan: mevcut proje).

### `memory_add`

Yeni bir bellek fragmanı ekler.

**Parametreler:**
- `fragment` (string, zorunlu): Saklanacak bellek metni
- `title` (string, opsiyonel): Kısa başlık (sağlanmazsa ilk 40 karakterden otomatik oluşturulur)
- `source` (string, opsiyonel): "user" veya "ai", varsayılan "ai"

**Örnek:**
```json
{
  "fragment": "Kullanıcı tüm uygulamalarda karanlık modu tercih ediyor",
  "title": "Karanlık mod tercihi",
  "source": "ai"
}
```

### `memory_update`

Mevcut bir bellek fragmanını günceller.

**Parametreler:**
- `id` (string, zorunlu): Güncellenecek fragman kimliği
- `title` (string, opsiyonel): Yeni başlık metni
- `fragment` (string, opsiyonel): Yeni fragman metni
- `confidence` (number, opsiyonel): Yeni güven puanı 0.0-1.0

**Örnek:**
```json
{
  "id": "m1a2b3",
  "title": "Güncellenmiş başlık",
  "fragment": "Güncellenmiş bilgi",
  "confidence": 0.9
}
```

### `memory_forget`

Bir bellek fragmanını siler.

**Parametreler:**
- `id` (string, zorunlu): Silinecek fragman kimliği

### `memory_list`

Tüm bellek fragmanlarını JSON formatında listeler.

**Parametreler:** Yok

**Dönüş:** Tüm fragmanların JSON dizisi

## Yetenek Takibi (Skill Tracking)

Lemma ayrıca çalışma sırasında kullandığınız yetenekleri takip eder. Bu, zaman içinde bir uzmanlık profili oluşturmaya yardımcı olur.

### `skill_get`

Kullanım istatistikleriyle birlikte tüm takip edilen yetenekleri getirir.

**Parametreler:**
- `category` (string, opsiyonel): Kategoriye göre filtrele (frontend, backend, tool, language, database)
- `skill` (string, opsiyonel): Belirli bir yetenek adı için detay getir

**Dönüş:** Kullanım sayısına göre sıralanmış formatlanmış yetenek listesi

**Örnek çıktı:**
```
=== LEMMA YETENEKLER ===
[frontend] react: 45x (son: 2026-03-06) [hooks, jsx, state] (3 öğrenim)
[backend] nodejs: 30x (son: 2026-03-05) [express, api]
[language] typescript: 25x (son: 2026-03-06)
=========================
```

### `skill_practice`

Yetenek kullanımını kaydet - kullanım sayısını artırır, son_kullanım tarihini günceller ve isteğe bağlı olarak bağlamlar/öğrenimler ekler.

**Parametreler:**
- `skill` (string, zorunlu): Yetenek adı (örn. "react", "python", "git")
- `category` (string, zorunlu): Kategori: frontend, backend, tool, language, database
- `contexts` (string dizisi, opsiyonel): Ek bağlamlar (örn. ["hooks", "state"])
- `learnings` (string dizisi, opsiyonel): Kullanım sırasında keşfedilen yeni öğrenimler

**Örnek:**
```json
{
  "skill": "react",
  "category": "frontend",
  "contexts": ["hooks", "useCallback"],
  "learnings": ["useCallback gereksiz yeniden render'ları önler"]
}
```

### `skill_discover`

Mevcut projeden package.json bağımlılıklarını analiz ederek yetenekleri otomatik keşfet.

**Parametreler:** Yok

**Dönüş:** Yeni keşfedilen ve kaydedilen yeteneklerin listesi

### Yetenek Dosyası Konumu

Yetenekler JSONL formatında şu adreste saklanır:

| İşletim Sistemi | Yol |
|---|---|
| **Windows** | `C:\Users\{kullanıcı}\.lemma\skills.jsonl` |
| **macOS** | `/Users/{kullanıcı}/.lemma/skills.jsonl` |
| **Linux** | `/home/{kullanıcı}/.lemma/skills.jsonl` |

### Yetenek Veri Yapısı

```json
{
  "id": "s1a2b3",
  "skill": "react",
  "category": "frontend",
  "usage_count": 45,
  "last_used": "2026-03-06",
  "contexts": ["hooks", "jsx", "state"],
  "learnings": ["useCallback gereksiz yeniden render'ları önler"]
}
```

## Felsefe

### Saklanması Gerekenler

**Kullanıcı Katmanı:**
- Kullanıcı tercihleri (iletişim tarzı, format, dil)
- Proje bağlamı (teknoloji yığını, klasör yapısı, konvansiyonlar)
- Açıkça istenen anılar

**Yetenek Katmanı:**
- Kullanılan başarılı çözümler ve yaklaşımlar
- Tekrar eden görevler için keşfedilen kısayollar
- Denenen ve başarısız olan yaklaşımlar
- Görev tipleri ve en uygun strateji kalıpları

### Saklanmaması Gerekenler

- Ham konuşma içeriği
- Tekrar etmeyecek tek seferlik sorular
- Geçici veya yüksek bağlama özgü bilgiler
- Kişisel veya hassas veriler

## Geliştirme

### Testleri Çalıştırma

```bash
npm test
```

### Proje Yapısı

```
Lemma/
├── memory.js       # Ana MCP sunucu uygulaması
├── memory-core.js  # Temel bellek mantığı (yükle, kaydet, çürüme)
├── test.js         # Test paketi
├── package.json    # Bağımlılıklar ve metadata
├── README.md       # Bu dosya
└── .gitignore      # Git ignore kuralları
```

## Güvenlik

`memory.jsonl` yerel bir dosyadır ve asla hiçbir yere gönderilmez. Kullanıcılar içeriğini inceleyebilir veya MCP araçları üzerinden istedikleri zaman temizleyebilirler.

## Lisans

MIT License
