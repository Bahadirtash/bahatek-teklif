// Malzeme kodu ve çizim dosya adı ↔ eşleştirme anahtarı.
// FU00314268/B-03 ↔ U00314268_B_SHT1.pdf  →  anahtar "00314268_B"

/** Malzeme kodu: FU00314268/B-03, FU00230931-A-03, TSY..., UU..., sadece rakamlılar vs. */
const CODE_RE = /^[A-Z]{0,5}(\d{4,})[/-]([A-Z])-\d+$/i;

/** Çizim adı: U00314268_B_SHT1.pdf, 12345_C_SHT2.pdf (sonrasında " (1)" gibi ekler olabilir). */
const DRAWING_RE = /^[A-Z]{0,5}(\d{4,})_([A-Z])_SHT(\d+)\b[^/\\]*\.pdf$/i;

export function isItemCode(s: string): boolean {
  return CODE_RE.test(s.trim());
}

export function codeKey(code: string): string | null {
  const m = CODE_RE.exec(code.trim());
  return m ? `${m[1]}_${m[2].toUpperCase()}` : null;
}

export function drawingKey(filename: string): { key: string; sheet: number } {
  const m = DRAWING_RE.exec(filename.trim());
  if (m) {
    return { key: `${m[1]}_${m[2].toUpperCase()}`, sheet: Number(m[3]) };
  }
  // Eğer özel formatta değilse, dosya adını (uzantısız) anahtar olarak kullan
  let base = filename.trim();
  const lastDot = base.lastIndexOf(".");
  if (lastDot > 0) base = base.substring(0, lastDot);
  return { key: base, sheet: 1 };
}
