// Malzeme kodu ve çizim dosya adı ↔ eşleştirme anahtarı.
// FU00314268/B-03 ↔ U00314268_B_SHT1.pdf  →  anahtar "00314268_B"
// FE026BF3736 ↔ E026BF3736.pdf             →  anahtar "E026BF3736"

/** Klasik format: FU00314268/B-03, FU00230931-A-03 vs. */
const CLASSIC_CODE_RE = /^[A-Z]{0,5}(\d{4,})[/-]([A-Z])-\d+$/i;

/** TIA formatı: TIA 30012486, TIA-30007436_K00041645-B-dwg1 */
const TIA_CODE_RE = /^TIA[\s_-]?(?=.*\d)[0-9A-Z_.-]{4,}$/i;

/** FE formatı: FE026BF3609, FE026BF3736 */
const FE_CODE_RE = /^FE(?=.*\d)[0-9A-Z_.-]{4,}$/i;

/** FTM formatı: FTM30002337, FTM 30002453, FTM30005458 */
const FTM_CODE_RE = /^FTM[\s_-]?(?=.*\d)[0-9A-Z_.-]{4,}$/i;

/** ME / MF formatı */
const MEMF_CODE_RE = /^(?:ME|MF)[\s_-]?(?=.*\d)[0-9A-Z_.-]{4,}$/i;

/** Genel malzeme kodu: En az bir rakam ve harf içeren, 4-40 karakter uzunluğunda endüstriyel parça kodları */
const GENERAL_CODE_RE = /^(?![0-9]+$)(?=.*\d)[A-Z0-9/_-]{4,40}$/i;

/** Çizim adı: U00314268_B_SHT1.pdf, 12345_C_SHT2.pdf */
const DRAWING_RE = /^[A-Z]{0,5}(\d{4,})_([A-Z])_SHT(\d+)\b[^/\\]*\.(?:pdf|png|jpe?g)$/i;

export function isItemCode(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.length < 4 || trimmed.length > 50) return false;
  // Birden fazla boşluk varsa veya Türkçe genel metin ise ele
  const words = trimmed.split(/\s+/);
  if (words.length > 2) return false;
  // Eğer 2 kelime ise ilki bilinen bir kod öneki (TIA, FTM, ME, MF, PARÇA, KOD) veya harf öbeği olmalı
  if (words.length === 2) {
    if (!/^(?:TIA|FTM|FE|FU|ME|MF|PARCA|ITEM|NO|[A-Z]{2,4})$/i.test(words[0])) return false;
    if (!/^[0-9A-Z_.-]{3,}$/i.test(words[1])) return false;
  }
  
  // Tarihleri veya salt sayıları veya genel başlıkları ele
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(trimmed)) return false;
  if (/^\d+([.,]\d+)?$/.test(trimmed)) return false;
  if (/^(?:AD|ADET|MT|METRE|KG|TAKIM|SET)$/i.test(trimmed)) return false;
  if (/^(?:MALZEME|PARCA|TANIM|NO|SIRA|TARIH|ACIKLAMA)$/i.test(trimmed)) return false;

  return CLASSIC_CODE_RE.test(trimmed) ||
         TIA_CODE_RE.test(trimmed) ||
         FE_CODE_RE.test(trimmed) ||
         FTM_CODE_RE.test(trimmed) ||
         MEMF_CODE_RE.test(trimmed) ||
         GENERAL_CODE_RE.test(trimmed);
}

/** Türkçe karakterleri büyük ASCII harflere dönüştürür (İ/i/ı -> I, Ş/ş -> S vb.) */
export function normTr(s: string): string {
  return s
    .replace(/[İiıI]/g, "I")
    .replace(/[Şş]/g, "S")
    .replace(/[Ğğ]/g, "G")
    .replace(/[Üü]/g, "U")
    .replace(/[Öö]/g, "O")
    .replace(/[Çç]/g, "C")
    .toUpperCase();
}

/** Koddan baştaki 'F' harfini veya TIA boşluğunu normalize et */
export function normalizeCodeStr(s: string): string {
  let clean = normTr(s.trim()).replace(/[\s\t\r\n]+/g, "");
  // Uzantı varsa kaldır
  const lastDot = clean.lastIndexOf(".");
  if (lastDot > 0 && lastDot >= clean.length - 5) {
    clean = clean.substring(0, lastDot);
  }
  return clean;
}

/** Revizyon harfinden bağımsız ana parça anahtarı (Önceki fiyat ve SİP eşleştirmesi için) */
export function baseCodeKey(code: string): string {
  const trimmed = normTr(code.trim());
  const m = CLASSIC_CODE_RE.exec(trimmed);
  if (m) {
    return m[1]; // "FU00230931-A-03" -> "00230931"
  }
  const mNum = /^[A-Z]{0,5}[\s_-]?(\d{5,12})(?:[/_-][A-Z](?:-\d+)?)?$/i.exec(trimmed);
  if (mNum) {
    return mNum[1]; // "U00314268_A" -> "00314268", "FTM30002337" -> "30002337"
  }
  const ck = codeKey(trimmed);
  if (ck) {
    return ck.replace(/_[A-Z]$/, "").replace(/[^A-Z0-9]/g, "");
  }
  return normalizeCodeStr(trimmed).replace(/[^A-Z0-9]/g, "");
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
  
  // Normal dosya adı: uzantıyı kaldır ve _SHT varsa ayır
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

/** Bir metindeki anlamlı kod bloklarını (5+ haneli sayılar, alfanümerik parça no) çıkarır */
export function extractTokens(s: string): string[] {
  const tokens = new Set<string>();
  // Dosya uzantısını (.pdf, .png, .xlsx vb.) ve tarihleri (26.09.2026) kaldır
  const noExt = s
    .replace(/\.(?:pdf|png|jpe?g|dwg|dxf|tiff?|xlsx?)\b/gi, "")
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ");
  const upper = normTr(noExt);

  // Klasik kod kalıpları: FU00314268/B-03, U00314268_B vb.
  for (const m of upper.matchAll(/[A-Z]{0,5}(\d{5,12})[/_-]([A-Z])(?:-\d+)?/g)) {
    tokens.add(`${m[1]}_${m[2]}`);
    tokens.add(m[1]);
    const noZero = m[1].replace(/^0+/, "");
    if (noZero.length >= 5) tokens.add(noZero);
  }

  // Harf içinde veya bağımsız geçen 5-12 basamaklı parça numaraları (FU00314268 -> 00314268, FTM30002337 -> 30002337, TIA 30012486 -> 30012486)
  for (const m of upper.matchAll(/(?<!\d)\d{5,12}(?!\d)/g)) {
    const num = m[0];
    tokens.add(num);
    const noZero = num.replace(/^0+/, "");
    if (noZero.length >= 5) tokens.add(noZero);
  }

  // Harf-sayı blokları (E026BF3736, FE026BF3736, K00041645, U00314268, BFBY2026.01.306)
  for (const m of upper.matchAll(/[A-Z0-9_./-]{4,}/g)) {
    const rawBlock = m[0].replace(/^[./_-]+|[./_-]+$/g, "");
    const clean = rawBlock.replace(/[^A-Z0-9]/g, "");
    if (clean.length >= 5 && /[A-Z]/.test(clean) && /\d/.test(clean)) {
      tokens.add(clean);
      // Baştaki F düşmesini de ekle (FE026BF3736 -> E026BF3736, FU00314268 -> U00314268)
      if ((clean.startsWith("FE") || clean.startsWith("FU")) && clean.length >= 6) {
        tokens.add(clean.substring(1));
      }
      // Yaygın son ekleri kaldır (_MF, _ME, _DWG, SHT1 vb.)
      const trimmedSuffix = clean.replace(/(?:MF|ME|DWG\d*|SHT\d+)$/i, "");
      if (trimmedSuffix.length >= 5 && trimmedSuffix !== clean) {
        tokens.add(trimmedSuffix);
        if ((trimmedSuffix.startsWith("FE") || trimmedSuffix.startsWith("FU")) && trimmedSuffix.length >= 6) {
          tokens.add(trimmedSuffix.substring(1));
        }
      }
    }
  }
  return [...tokens];
}

/** İki anahtarın veya kod ile çizimin eşleşip eşleşmediğini kontrol eder */
export function isMatch(itemCode: string, drawingFilename: string, itemDesc: string = ""): boolean {
  const cKey = codeKey(itemCode);
  const dObj = drawingKey(drawingFilename);
  const dKey = dObj.key;

  if (cKey && dKey) {
    if (cKey === dKey) return true;
    const cClean = cKey.replace(/[^A-Z0-9]/g, "");
    const dClean = dKey.replace(/[^A-Z0-9]/g, "");
    if (cClean === dClean) return true;
    if (cClean.length >= 6 && dClean.length >= 6) {
      if (cClean.includes(dClean) || dClean.includes(cClean)) return true;
    }
  }

  // Token tabanlı derin eşleştirme (TIA 30012486 <-> 30012486.pdf / TIA 30007436_K00041645-B-dwg1 <-> 30007436.pdf)
  const itemTokens = extractTokens(itemCode + " " + itemDesc);
  const drawingTokens = extractTokens(drawingFilename);

  for (const it of itemTokens) {
    for (const dt of drawingTokens) {
      if (it === dt) return true;
      if (it.length >= 6 && dt.length >= 6) {
        if (it.includes(dt) || dt.includes(it)) return true;
      }
    }
  }

  return false;
}

