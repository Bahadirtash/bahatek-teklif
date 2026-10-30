// Malzeme kodu ve çizim dosya adı ↔ eşleştirme anahtarı.
// FU00314268/B-03 ↔ U00314268_B_SHT1.pdf  →  anahtar "00314268_B"
// FE026BF3736 ↔ E026BF3736.pdf             →  anahtar "E026BF3736"

/** Klasik format: FU00314268/B-03, FU00230931-A-03 vs. */
const CLASSIC_CODE_RE = /^[A-Z]{0,5}(\d{4,})[/-]([A-Z])-\d+$/i;

/** FE formatı: FE026BF3609, FE026BF3736 */
const FE_CODE_RE = /^FE[0-9A-Z_.-]{4,}$/i;

/** FTM formatı: FTM30002337, FTM30002453, FTM30005458 */
const FTM_CODE_RE = /^FTM[0-9A-Z_.-]{4,}$/i;

/** ME / MF formatı */
const MEMF_CODE_RE = /^(?:ME|MF)[0-9A-Z_.-]{4,}$/i;

/** Genel malzeme kodu: En az bir rakam ve harf içeren, boşluksuz, 4-32 karakter uzunluğunda endüstriyel parça kodları */
const GENERAL_CODE_RE = /^(?![0-9]+$)(?=.*\d)[A-Z0-9/_-]{4,32}$/i;

/** Çizim adı: U00314268_B_SHT1.pdf, 12345_C_SHT2.pdf */
const DRAWING_RE = /^[A-Z]{0,5}(\d{4,})_([A-Z])_SHT(\d+)\b[^/\\]*\.(?:pdf|png|jpe?g)$/i;

export function isItemCode(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.length < 4 || trimmed.length > 40) return false;
  if (/\s/.test(trimmed)) return false; // Parça kodunda boşluk olmaz
  // Tarihleri veya salt sayıları veya genel başlıkları ele
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(trimmed)) return false;
  if (/^\d+([.,]\d+)?$/.test(trimmed)) return false;
  if (/^(?:AD|ADET|MT|METRE|KG|TAKIM|SET)$/i.test(trimmed)) return false;
  if (/^(?:MALZEME|PARCA|TANIM|NO|SIRA|TARIH)$/i.test(trimmed)) return false;

  return CLASSIC_CODE_RE.test(trimmed) ||
         FE_CODE_RE.test(trimmed) ||
         FTM_CODE_RE.test(trimmed) ||
         MEMF_CODE_RE.test(trimmed) ||
         GENERAL_CODE_RE.test(trimmed);
}

/** Koddan baştaki 'F' harfini kaldırarak normalize et (FE026BF... -> E026BF..., FU0031... -> U0031...) */
export function normalizeCodeStr(s: string): string {
  let clean = s.trim().toUpperCase().replace(/[\s\t\r\n]+/g, "");
  // Uzantı varsa kaldır
  const lastDot = clean.lastIndexOf(".");
  if (lastDot > 0 && lastDot >= clean.length - 5) {
    clean = clean.substring(0, lastDot);
  }
  return clean;
}

export function codeKey(code: string): string | null {
  const trimmed = code.trim();
  if (!isItemCode(trimmed)) return null;

  const m = CLASSIC_CODE_RE.exec(trimmed);
  if (m) {
    return `${m[1]}_${m[2].toUpperCase()}`;
  }
  
  const norm = normalizeCodeStr(trimmed);
  // Eğer FE... ile başlıyorsa hem FE... hem de E... eşleşebilsin diye E... haline getir
  if (norm.startsWith("FE") && norm.length > 3) {
    return norm.substring(1); // "FE026BF3736" -> "E026BF3736"
  }
  if (norm.startsWith("FU") && norm.length > 3) {
    return norm.substring(1); // "FU00314268" -> "U00314268"
  }
  return norm;
}

export function drawingKey(filename: string): { key: string; sheet: number } {
  const trimmed = filename.trim();
  const m = DRAWING_RE.exec(trimmed);
  if (m) {
    return { key: `${m[1]}_${m[2].toUpperCase()}`, sheet: Number(m[3]) };
  }
  
  // Normal dosya adı: uzantıyı kaldır ve _SHT varsa ayır, case'i koru
  let base = trimmed;
  const lastDot = base.lastIndexOf(".");
  if (lastDot > 0) base = base.substring(0, lastDot);

  const shtMatch = /_SHT(\d+)$/i.exec(base);
  let sheet = 1;
  if (shtMatch) {
    sheet = Number(shtMatch[1]);
    base = base.substring(0, shtMatch.index);
  }

  return { key: base, sheet };
}

/** İki anahtarın veya kod ile çizimin eşleşip eşleşmediğini kontrol eder */
export function isMatch(itemCode: string, drawingFilename: string, itemDesc: string = ""): boolean {
  const cKey = codeKey(itemCode);
  const dObj = drawingKey(drawingFilename);
  const dKey = dObj.key;

  if (cKey && dKey) {
    if (cKey === dKey) return true;
    // Biri diğerinin alt kümesi mi? (ör. 026BF3736 içinde E026BF3736 veya tam tersi)
    const cClean = cKey.replace(/[^A-Z0-9]/g, "");
    const dClean = dKey.replace(/[^A-Z0-9]/g, "");
    if (cClean === dClean) return true;
    if (cClean.length >= 6 && dClean.length >= 6) {
      if (cClean.includes(dClean) || dClean.includes(cClean)) return true;
    }
  }

  // Malzeme tanımı içinde çizim adı geçiyor mu? (Örn: Tanım: "TIA KRSLMA TKZU BFBY2026.01.306_MF", Çizim: "BFBY2026.01.306.pdf")
  if (itemDesc) {
    const dClean = dKey.replace(/[^A-Z0-9]/g, "");
    const descClean = itemDesc.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (dClean.length >= 6 && descClean.includes(dClean)) {
      return true;
    }
  }

  return false;
}

