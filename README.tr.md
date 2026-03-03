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
Bellek fragmanlarını LLM kullanımı için formatlanmış şekilde döndürür. Güven çürümesini otomatik uygular, en alakalı fragmanları seçer ve bağlam için reformat eder.

**Parametreler:**
- `project` (string, opsiyonel): Filtrelenecek proje adı.
- `query` (string, opsiyonel): Belirli bir bağlamı bulmak için semantik arama anahtar kelimesi.

### `memory_check`
**ZORUNLU:** Herhangi bir analiz, araştırma veya doküman okumadan ÖNCE çağırlmalıdır. Projenin/konunun zaten bellekte olup olmadığını kontrol eder. Gereksiz (tekrar eden) çalışmayı önler.

**Parametreler:**
- `project` (string, opsiyonel): Kontrol edilecek proje adı.

### `memory_add`
Yeni bir bellek fragmanı ekler. Bilgiyi kısa, tekrar kullanılabilir parçalara sentezler.

### `memory_update`
Mevcut bir fragmanı günceller (başlık, metin veya güven puanı).

### `memory_forget`
Bir fragmanı kimliğine (ID) göre siler.

### `memory_list`
Tüm fragmanları JSON formatında listeler.

## Lisans

MIT License
