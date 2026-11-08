/**
 * İletilmiş maillerdeki Türkçe tarih metinlerini okur.
 * Örnekler:
 *   "26 Eylül 2026 Cumartesi 14:32"        (Outlook TR "Gönderildi:")
 *   "26 Eyl 2026 Cmt, saat 14:32"           (Gmail TR "Tarih:")
 *   "Cmt, 26 Eyl 2026 14:32"
 *   "26 Eylül 2026"                         (saat yoksa 12:00 kabul edilir)
 */

const TR_MONTHS: Array<[RegExp, number]> = [
  [/^oca/, 0],
  [/^şub|^sub/, 1],
  [/^mar/, 2],
  [/^nis/, 3],
  [/^may/, 4],
  [/^haz/, 5],
  [/^tem/, 6],
  [/^ağu|^agu/, 7],
  [/^eyl/, 8],
  [/^eki/, 9],
  [/^kas/, 10],
  [/^ara/, 11],
];

function trMonthIndex(word: string): number {
  const w = word.toLocaleLowerCase("tr-TR");
  for (const [re, idx] of TR_MONTHS) if (re.test(w)) return idx;
  return -1;
}

/** Türkçe ay adlı tarihi milisaniyeye çevirir; okuyamazsa 0 döner. */
export function parseTurkishDateMs(text: string): number {
  const m = /(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3,})\.?\s+(\d{4})/.exec(text);
  if (!m) return 0;
  const month = trMonthIndex(m[2]);
  if (month < 0) return 0;
  const rest = text.slice(m.index + m[0].length);
  const t = /(\d{1,2})[:.](\d{2})/.exec(rest);
  const d = new Date(Number(m[3]), month, Number(m[1]), t ? Number(t[1]) : 12, t ? Number(t[2]) : 0);
  if (isNaN(d.getTime()) || d.getDate() !== Number(m[1])) return 0;
  return d.getTime();
}
