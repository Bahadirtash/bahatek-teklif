// "Teklifi Hazırla": doldurulmuş teklif.xlsx üretir ve firma klasörüne kaydeder.
// Kurallar: kod ve tanımlar harfi harfine (metin olarak) yazılır, sütun sırası/başlıkları
// B firmasınınkiyle aynı, sonuna Birim Fiyat + Toplam eklenir, kalem sırası korunur.
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Formula, Workbook, XlsxError};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferRow {
    pub cells: Vec<String>,
    pub qty: Option<f64>,
    pub price: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub archive_root: String,
    pub firm: String,
    /// "<tarih - konu>" klasör adı; Windows'ta geçersiz karakterler temizlenir.
    pub folder: String,
    pub headers: Vec<String>,
    /// Miktar sütununun indeksi; yoksa -1.
    pub qty_col: i32,
    pub rows: Vec<OfferRow>,
}

/// Windows dosya adında geçersiz karakterleri temizler (harfler/Türkçe karakterler korunur).
pub fn safe_name(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| match c {
            ':' => '-',
            '<' | '>' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = out.trim_end_matches(['.', ' ']).trim_start();
    let mut name: String = trimmed.chars().take(120).collect();
    let upper = name.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3"];
    if name.is_empty() || reserved.contains(&upper.as_str()) {
        name = format!("_{name}");
    }
    name
}

fn col_name(mut col: u16) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (col % 26) as u8) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    s
}

pub fn offer_path(offer: &Offer) -> PathBuf {
    Path::new(&offer.archive_root)
        .join(safe_name(&offer.firm))
        .join(safe_name(&offer.folder))
        .join("teklif.xlsx")
}

pub fn build_xlsx(offer: &Offer, path: &Path) -> Result<(), XlsxError> {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Teklif")?;

    let head = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x1F7A45))
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center);
    let text = Format::new().set_border(FormatBorder::Thin);
    let num = Format::new().set_border(FormatBorder::Thin).set_num_format("#,##0.##");
    let money = Format::new().set_border(FormatBorder::Thin).set_num_format("#,##0.00");

    let n = offer.headers.len() as u16;
    let price_col = n;
    let total_col = n + 1;
    for (c, h) in offer.headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, &head)?;
    }
    ws.write_string_with_format(0, price_col, "Birim Fiyat", &head)?;
    ws.write_string_with_format(0, total_col, "Toplam", &head)?;

    for (i, row) in offer.rows.iter().enumerate() {
        let r = (i + 1) as u32;
        for c in 0..n {
            let cell = row.cells.get(c as usize).map(String::as_str).unwrap_or("");
            match row.qty {
                Some(q) if c as i32 == offer.qty_col => ws.write_number_with_format(r, c, q, &num)?,
                _ => ws.write_string_with_format(r, c, cell, &text)?,
            };
        }
        match row.price {
            Some(p) => ws.write_number_with_format(r, price_col, p, &money)?,
            None => ws.write_blank(r, price_col, &money)?,
        };
        match (row.price, row.qty, offer.qty_col >= 0) {
            (Some(p), Some(q), true) => {
                let f = format!(
                    "={q}{row}*{p}{row}",
                    q = col_name(offer.qty_col as u16),
                    p = col_name(price_col),
                    row = r + 1
                );
                let total = (p * q * 100.0).round() / 100.0;
                ws.write_formula_with_format(r, total_col, Formula::new(f).set_result(total.to_string()), &money)?
            }
            _ => ws.write_blank(r, total_col, &money)?,
        };
    }

    ws.set_freeze_panes(1, 0)?;
    ws.autofit();
    ws.set_column_width(price_col, 13)?;
    ws.set_column_width(total_col, 14)?;
    wb.save(path)
}

#[tauri::command]
pub fn save_offer(offer: Offer) -> Result<String, String> {
    let path = offer_path(&offer);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
    }
    // Önce geçici dosyaya yaz: dosya Excel'de açıksa eski teklif bozulmasın.
    let tmp = path.with_extension("xlsx.tmp");
    build_xlsx(&offer, &tmp).map_err(|e| format!("Excel dosyası yazılamadı: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("teklif.xlsx kaydedilemedi (dosya Excel'de açık olabilir): {e}")
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{open_workbook, Data, Reader, Xlsx};

    fn sample() -> Offer {
        let row = |code: &str, desc: &str, q: &str, price: Option<f64>| OfferRow {
            cells: vec![code.into(), desc.into(), q.into(), "AD".into(), "02.10.2026".into()],
            qty: q.parse().ok(),
            price,
        };
        Offer {
            archive_root: String::new(),
            firm: "ETİ MAKİNE".into(),
            folder: "26.09.2026 - Teklif İsteği (16:00 26.09.2026)".into(),
            headers: ["Malzeme", "Malzeme Tanımı", "Miktar", "Ö/B", "Teslim Tarihi"].map(String::from).to_vec(),
            qty_col: 2,
            rows: vec![
                row("FU00230931-A-03", "TIA TABAN MIL TUTUCU-U00230931/A-MF", "20", Some(12.5)),
                row("FU00314268/B-03", "TIA KAPAK -U00314268/B-MF", "1", None),
            ],
        }
    }

    #[test]
    fn xlsx_harfi_harfine_ve_toplam() {
        let dir = std::env::temp_dir().join(format!("bahatek-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("teklif.xlsx");
        build_xlsx(&sample(), &path).unwrap();

        let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
        let range = wb.worksheet_range("Teklif").unwrap();
        let get = |r: u32, c: u32| range.get_value((r, c)).cloned().unwrap_or(Data::Empty);
        let headers: Vec<String> = (0..7).map(|c| get(0, c).to_string()).collect();
        assert_eq!(headers, ["Malzeme", "Malzeme Tanımı", "Miktar", "Ö/B", "Teslim Tarihi", "Birim Fiyat", "Toplam"]);
        assert_eq!(get(1, 0), Data::String("FU00230931-A-03".into()));
        assert_eq!(get(1, 1), Data::String("TIA TABAN MIL TUTUCU-U00230931/A-MF".into()));
        assert_eq!(get(1, 2), Data::Float(20.0));
        assert_eq!(get(1, 4), Data::String("02.10.2026".into()));
        assert_eq!(get(1, 5), Data::Float(12.5));
        assert_eq!(get(1, 6).to_string(), "250");
        assert_eq!(get(2, 0), Data::String("FU00314268/B-03".into()));
        assert_eq!(get(2, 5), Data::Empty);
        assert_eq!(get(2, 6), Data::Empty);
        let formulas = wb.worksheet_formula("Teklif").unwrap();
        assert_eq!(formulas.get_value((1, 6)).map(String::as_str), Some("C2*F2"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn klasor_adi_windows_uyumlu() {
        assert_eq!(safe_name("26.09.2026 - Teklif İsteği (16:00 26.09.2026)"), "26.09.2026 - Teklif İsteği (16-00 26.09.2026)");
        assert_eq!(safe_name("a/b\\c?  d. "), "a_b_c_ d");
        assert_eq!(safe_name("CON"), "_CON");
        assert_eq!(safe_name(""), "_");
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(25), "Z");
        assert_eq!(col_name(26), "AA");
    }
}
