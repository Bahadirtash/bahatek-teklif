// Malzeme kodu ve çizim dosya adı ↔ eşleştirme anahtarı.
// FU00314268/B-03 ↔ U00314268_B_SHT1.pdf  →  anahtar "00314268_B"

/** Malzeme kodu: FU00314268/B-03, FU00230931-A-03 (tireli de gelir, düzeltilmez). */
const CODE_RE = /^[A-Z]{1,3}(\d{6,})[/-]([A-Z])-\d+$/;

/** Çizim adı: U00314268_B_SHT1.pdf (sonrasında " (1)" gibi ekler olabilir). */
const DRAWING_RE = /^[A-Z]{0,3}(\d{6,})_([A-Z])_SHT(\d+)\b[^/\\]*\.pdf$/i;

export function isItemCode(s: string): boolean {
  return CODE_RE.test(s.trim());
}

export function codeKey(code: string): string | null {
  const m = CODE_RE.exec(code.trim());
  return m ? `${m[1]}_${m[2]}` : null;
}

export function drawingKey(filename: string): { key: string; sheet: number } | null {
  const m = DRAWING_RE.exec(filename.trim());
  return m ? { key: `${m[1]}_${m[2].toUpperCase()}`, sheet: Number(m[3]) } : null;
}
