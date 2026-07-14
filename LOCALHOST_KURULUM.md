# Localhost Kurulum Rehberi

Bu proje hiçbir kod değişikliği gerektirmeden localhost'ta çalışır. `.env` dosyası
zaten oluşturuldu (`/`.env`), sadece veritabanı bağlantısını tamamlamanız yeterli.

## 1) Bağımlılıkları kur

```bash
npm install
```

## 2) Veritabanı — 2 seçenek

`server.js` PostgreSQL bağlantısını **SSL zorunlu** olacak şekilde kuruyor
(`ssl:{rejectUnauthorized:false}` — bu satıra dokunmadım, business logic/backend
kuralımız gereği). Bunun için en hızlı ve sıfır-kurulum gerektirmeyen yol:

### Seçenek A — Ücretsiz bulut Postgres (önerilen, 2 dakika)

1. [neon.tech](https://neon.tech) (ya da Supabase) üzerinde ücretsiz bir proje açın.
2. Verilen bağlantı adresini (`postgres://...`) kopyalayıp `.env` içindeki
   `DATABASE_URL` satırına yapıştırın.
3. Bu servisler SSL'i zaten native destekliyor — `server.js`'te hiçbir şey
   değiştirmenize gerek yok, doğrudan çalışır.

### Seçenek B — Kendi bilgisayarınızda Postgres

Yerel Postgres kurulumu varsayılan olarak SSL kapalıdır; `server.js`'in SSL
istemesi nedeniyle bağlantı hatası alırsınız. Postgres'te SSL'i açmanız gerekir:

```bash
# postgresql.conf içinde:
ssl = on
# ve bir self-signed sertifika oluşturup ssl_cert_file / ssl_key_file ile göstermeniz gerekir
```

Bu adım biraz uğraştırıcıdır — çoğu test senaryosu için **Seçenek A** çok daha
hızlıdır ve kod değişikliği gerektirmez.

Veritabanı bağlandıktan sonra tabloları **elle oluşturmanıza gerek yok** —
`server.js` açılışta `CREATE TABLE IF NOT EXISTS` ile tüm şemayı kendisi kurar.

## 3) Sunucuyu başlat

```bash
npm run dev     # nodemon ile (kod değişince otomatik yeniden başlar)
# veya
npm start       # production modu
```

Sunucu `http://localhost:3000` üzerinde açılır (`.env` içindeki `PORT`).

## 4) Test edilecek ekranlar

| URL | Ekran |
|---|---|
| `http://localhost:3000/` | Landing / giriş |
| `http://localhost:3000/menu/:slug` | Müşteri menüsü (Sprint 1-2'nin test alanı) |
| `http://localhost:3000/panel` (ya da uygulamanın yönlendirdiği panel yolu) | İşletme paneli → Design sekmesi |

İlk kayıt olduğunuzda oluşturduğunuz restoranın `slug` değerini panelden
görebilirsiniz; test verisi için birkaç kategori/ürün eklemeniz gerekir (arayüz
üzerinden, ekstra bir seed script'i bu pakette yok).

## 5) Opsiyonel özellikler hakkında not

`.env` içinde boş bırakılan alanlar (Google login, e-posta, dosya yükleme,
ödeme) ilgili özelliği pasif bırakır ama **sunucunun açılmasını engellemez** —
sadece o özelliklere tıkladığınızda hata alırsınız. Hero/kategori navigasyonu
testleri için bunlara ihtiyacınız yok.
