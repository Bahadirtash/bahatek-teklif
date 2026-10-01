# Bahatek Teklif – Proje Devir Belgesi

Sahip: Bahadır Taş, Bahatek Software CEO. Ürün ticari olarak satılacak. Kullanıcılar: talaşlı imalat yapan küçük atölyeler (A firması). Teklif isteyen büyük firma = B firması.
Geliştirme MacBook'ta, hedef platform **Windows**. Arayüz dili Türkçe.

## Sorun
B firması Gmail'e teklif isteği maili gönderir: gövdede düz metin kalem tablosu (Malzeme, Malzeme Tanımı, Miktar, Ö/B, Teslim Tarihi), ekte kalem başına çizim PDF'i. Kullanıcı bugün her kalem için PDF'i elle bulup fiyat verip Excel'e taşıyor: 2–3 saat. Hedef: 15–20 dakika.

## Ürün (V1)
Windows'a kurulan, açılışta başlayan **Tauri** masaüstü uygulaması. Tek sayfa, 3 bölme:
- Sol: firmalar ve teklif istekleri (parçalı mailler tek satırda birleşik), "Gmail'i Aç" düğmesi (varsayılan tarayıcıda mail.google.com), arşiv yolu.
- Orta: kalem tablosu. Sütunlar B firmasının sırasıyla + sonuna **Birim Fiyat** (kullanıcı elle girer, başta BOŞ) ve **Toplam** (miktar × birim fiyat, otomatik).
- Sağ: seçili kalemin çizimi (PDF) + fiyat kutusu. Enter = uygula ve sonraki kaleme geç.
- Alt şerit: fiyatlanan/toplam kalem, genel toplam, "Tam liste" onay kutusu, **Teklifi Hazırla**.
- Satır üstüne gelince çizim önizleme balonu; tıklayınca sağda büyür.
- Referans tasarım: `prototype/teklif-prototip.html` (kullanıcı ve arkadaşları çok beğendi; görünümü ve akışı koru).

## Kesin kararlar
1. **Gmail'e SADECE OKUMA izni** (gmail.readonly). Uygulama asla mail göndermez, taslak yazmaz, gönderme kodu hiç bulunmaz.
2. "Teklifi Hazırla": doldurulmuş **.xlsx** üretir, firma klasörüne kaydeder (`Teklif Arşivi/<Firma>/<tarih - konu>/teklif.xlsx`), ekranda "klasöre kaydedildi" der. Ayrıca "Gmail'de yeni mail aç" düğmesi (`mail.google.com/?view=cm&su=...&body=...`, API'siz): Konu `Re: <B firmasının konusu>`, gövde `Sn. İlgili;\n\nTeklifiniz ektedir.` Kullanıcı Excel'i kendisi ekleyip Gönder'e basar.
3. Cevap maili tek mail, tek ek (.xlsx). Tablo gövdeye yapıştırılmaz, PDF geri gönderilmez.
4. Excel kuralları: kod ve tanımlar **harfi harfine** korunur (ör. `FU00230931-A-03` tireli, düzeltilmez). Sütun sırası/başlıkları B firmasınınkiyle aynı, sonuna Birim Fiyat + Toplam. Kalem sırası korunur. "Tam liste" işaretliyse fiyatsız kalemler boş satır olarak gider, değilse sadece fiyatlananlar. Bu seçim firma bazında hatırlanır.
5. Eksik fiyat varsa sadece hatırlatma uyarısı, engel yok.
6. PDF'ler **diske indirilmez**, bellekte açılır (PDF.js). Çizimler ticari sır: veri kullanıcının makinesinde kalır, sunucuya gitmez.
7. Google: geliştirme/deneme için OAuth **test modu** (max 100 test kullanıcı, token 7 günde yenilenir). Satış öncesi ayrıca Google OAuth doğrulaması (kısıtlı kapsam, güvenlik değerlendirmesi) yapılacak. Kod imzalama sertifikası da satış öncesi.
8. Firma izin listesi (gönderen adresi/alan adı). Lisans paketleri firma sayısına göre olabilir (3/10/sınırsız).
9. Windows kurulum dosyası GitHub Actions ile üretilir (Mac'ten değil). Windows 10/11'de WebView2 hazır gelir.

## Gerçek mail verisiyle doğrulanan bulgular (`testdata/`)
- `Fwd_Teklif_Istegi_26.09.2026-1.eml`: 94 kalem gövdede düz metin, 38 PDF eki (`U00335586_A_SHT1.pdf` biçiminde). Diğer 56 kalemin PDF'i "- 2" ve "- 3" mailinde. Bu mail iletilmiş ("Fwd:"), içinde orijinal B firması başlığı var. Gerçekte doğrudan gelecek; ikisini de ele al.
- `File.eml`: konu satırı BOŞ, 3 xlsx ek (ETİ MAKİNE.xlsx = aynı 94 kalem, doğrulandı). Diğer iki xlsx (`Eti Yapılan İşler.xlsx`, `KARADAĞ HESAPLAMA.xlsx`) **kullanıcının kendi dosyaları, projeyle ilgisi yok, YOKSAY.**
- Gövde tablosu satırı regex: `^(FU\d+[/-][A-Z]-\d+)\s+(.+?)\s+(\d+)\s+(\S+)\s+(\d\d\.\d\d\.\d{4})$` (sekme/çoklu boşlukla ayrılmış). Gövde ile xlsx birebir tuttu.
- **PDF eşleştirme anahtarı = numara + revizyon harfi:** `U00314268_B_SHT1.pdf` ↔ `FU00314268/B-03` (kodun 3–10. karakterleri = 8 haneli numara, sonraki harf revizyon). 38/38 eşleşti, harfler uyumlu. `SHT1` sayfa/sheet numarası; SHT2 gibi ekler gelebilir. Eşleşmeyen ekler ayrı listede gösterilmeli, hiçbir şey sessizce kaybolmasın.
- **Parçalı mailler:** "Teklif İsteği (16:00 26.09.2026) - 1/2/3", metinde "3 parça olarak gönderilmiştir". Konu bazen boş/Fwd olur → birleştirmeyi tek kurala bağlama: aynı gönderen + aynı tarih-saat + aynı gövde tablosu birlikte kullan. PDF önce, tablo sonra gelirse de eşleşmeli. Kalem PDF beklerken "çizim bekleniyor" durumu göster.
- Çizim PDF'leri: tek sayfa, farklı boyutlar (595x842, 1191x842, 1684x842, 2384x842 pt). **Metin katmanı YOK** (yazılar vektör çizgi). V1'de gerekmez; ileride OCR gerekir.
- **Çizim önizleme kırpma (V1'e dahil):** revizyon tablosu (üst) ve antet/tolerans cetveli (alt) dışarıda bırakılıp sadece görünüşlerin olduğu orta alan gösterilir. Denenen yöntem: sayfanın kabaca x %6–94, y %13.5–73.5 bölgesini render et, sonra beyaz boşluğu otomatik kırp (piksel eşiği <200, 25px pay). Alt kenarda antet parçaları (İŞ EMRİ kutusu, barkod) kalıyor: alt sınırı yukarı çekip küçük izole parçaları süz. Tam sayfa PDF tek tıkla yine açılabilmeli.
  - **Uygulanan yöntem (`src/pdf/crop.ts`, 38/38 çizimde görsel olarak doğrulandı):** sabit yüzde yatay sayfalarda (1191/1684/2384 pt) görünüşleri kesiyordu. Şablon: çerçeve kenardan 22–57 pt içeride (sayfa boyutuna göre değişir), revizyon tablosu çerçevenin sağ üstünde (~86 pt yüksek), antet + İŞ EMRİ kutusu sağ altında (~208 pt yüksek), ikisi de ~550 pt geniş (A4 dikeyde tüm genişlik). Çerçeve görüntüden bulunur (kenar çizgisinden sonraki ilk uzun çizgi), bu iki blok beyazla örtülür, kalan çizim bağlantılı parçalara ayrılıp ana gruptan uzak küçük parçalar (N6/N5 işareti, kırıntılar) atılır. Üretim notları ("ELOKSAL KAPLANACAKTIR" vb.) korunur.

## Yol haritası
- **V1:** Gmail okuma, teklif toplama/birleştirme, kalem tablosu, PDF eşleştirme + balon + kırpma, fiyat girişi, xlsx üretme, firma arşivi. Önce `testdata/*.eml`'i yerelden yükleyerek çalıştır, Gmail bağlantısı sonra.
- **V1'de bugünden yapılacak veri kaydı (arka planda, ekranda görünmez):** her fiyatlanan kalem için kod, tanım, miktar, birim fiyat, tarih, çizim PDF'i ve küçük görseli, sonuç alanı (kazanıldı/kaybedildi, elle). Amaç V3 için veri biriktirmek.
- **V2:** aynı/benzer kod ve çizim için "daha önce şu fiyata vermiştin" arşiv araması.
- **V3:** çizimden OCR ile malzeme/ölçü/tolerans okuma, benzer çizim bulma, fiyat aralığı tahmini. PyTorch değil, hafif ONNX/klasik yöntemler. Tahmin öneri olarak görünür, kullanıcı onaylamadan fiyata girmez. Her firmanın verisi ayrı tutulur.

## İlk görevler
1. Bu klasörde Tauri (TypeScript, vanilla) projesini kur, `npm run tauri dev` ile boş pencere çalışsın.
2. `.eml` ayrıştırıcı (örn. postal-mime): gövde tablosu + PDF ekleri + kod-numara-revizyon eşleştirme. Test: 94 kalem, 38 PDF eşleşmeli, 56 kalem "çizim bekleniyor".
3. Prototip arayüzünü gerçek veriye bağla; PDF.js ile bellekte render + kırpma.

## Gizlilik
`testdata/` gerçek B firması çizimleri ve mailleri içerir (ticari sır). Git'e eklenmemeli (.gitignore), depo gizli olmalı.
