# Bahatek Teklif

Talaşlı imalat atölyeleri için teklif hazırlama masaüstü uygulaması (Tauri 2 + TypeScript, vanilla).
Proje kararları ve yol haritası: `CLAUDE.md`. Referans tasarım: `prototype/teklif-prototip.html`.

## Geliştirme

```sh
npm install
npm run tauri dev
```

- `npm test` — mail ayrıştırıcı, eşleştirme ve biçim testleri (`testdata/` varsa gerçek maillerle de).
- `cargo test --manifest-path src-tauri/Cargo.toml` — Excel üretimi testleri.
- Uçtan uca öz-test (yalnızca geliştirme sürümü):
  `BAHATEK_SELFTEST=$PWD/testdata/Fwd_Teklif_Istegi_26.09.2026-1.eml BAHATEK_SELFTEST_ARCHIVE=/tmp/arsiv npm run tauri dev`
  → .eml yükler, fiyat girer, teklif.xlsx üretir, sonucu terminale yazar ve kapanır.

## Gmail bağlantısı (salt okuma)

`.env.example` dosyasını `.env` olarak kopyalayıp Google OAuth "Masaüstü uygulaması" istemci bilgilerini girin.
Bilgiler derleme sırasında gömülür. Bilgi yoksa uygulama .eml yükleme ile çalışır, Gmail düğmesi görünmez.
Google Cloud'da OAuth izin ekranı test modunda olmalı ve kullanıcı test kullanıcısı olarak eklenmelidir.

## Klasör yapısı

- `src/eml/` — .eml ayrıştırma, parçalı mail birleştirme, çizim eşleştirme
- `src/pdf/` — PDF.js ile bellekte render, çizim kırpma (revizyon tablosu ve antet hariç)
- `src/main.ts` — arayüz; `src/state.ts` — kalıcı ayarlar/fiyatlar; `src/backend.ts` — Tauri komutları
- `src-tauri/src/offer.rs` — teklif.xlsx üretimi ve arşive kayıt
- `src-tauri/src/gmail.rs` — Gmail okuma (gmail.readonly; gönderme kodu yok)
- `src-tauri/src/store.rs` — yerel kayıtlar ve V3 için arka plan veri kaydı

## Windows kurulum dosyası

GitHub Actions → "Windows kurulum" iş akışı (`.github/workflows/windows.yml`). Çıktı: NSIS `.exe` ve `.msi`.
