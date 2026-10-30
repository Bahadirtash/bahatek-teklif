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

/** Koddan baştaki 'F' harfini veya TIA boşluğunu normalize et */
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
function extractTokens(s: string): string[] {
  const tokens = new Set<string>();
  // Dosya uzantısını (.pdf, .png vb.) kaldır
  const noExt = s.replace(/\.(?:pdf|png|jpe?g|dwg|dxf|tiff?)\b/gi, "");
  const upper = noExt.toUpperCase();

  // 5 veya daha fazla basamaklı ardışık sayılar (Eti Makine parça no: 30012486)
  for (const m of upper.matchAll(/\b\d{5,12}\b/g)) {
    tokens.add(m[0]);
  }
  // Harf-sayı blokları (E026BF3736, K00041645, U00314268, BFBY2026)
  for (const m of upper.matchAll(/[A-Z0-9_.-]{4,}/g)) {
    const clean = m[0].replace(/[^A-Z0-9]/g, "");
    if (clean.length >= 4 && /\d/.test(clean)) {
      tokens.add(clean);
      // Baştaki F düşmesini de ekle
      if (clean.startsWith("FE") || clean.startsWith("FU")) {
        tokens.add(clean.substring(1));
      }
      // Yaygın son ekleri kaldır (_MF, _ME, _DWG vb.)
      const trimmedSuffix = clean.replace(/(?:MF|ME|DWG\d*)$/i, "");
      if (trimmedSuffix.length >= 4 && trimmedSuffix !== clean) {
        tokens.add(trimmedSuffix);
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

