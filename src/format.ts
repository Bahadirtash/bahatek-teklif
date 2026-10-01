// Türkçe sayı girişi/gösterimi ve teklif metinleri.

/**
 * Kullanıcının yazdığı fiyatı okur: "1.250,50" → 1250.5, "12,5" → 12.5, "12.5" → 12.5,
 * "1.250" → 1250. Virgül varsa ondalık ayırıcıdır ve noktalar binliktir; virgül yoksa tek
 * nokta ve ardından 1–2 hane ondalık sayılır. Okunamazsa null.
 */
export function parsePrice(input: string): number | null {
  let s = input.trim().replace(/\s|₺|TL/gi, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (!/^\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(n: number): string {
  return n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "Fwd: Teklif İsteği (16:00 26.09.2026) - 1" → "Teklif İsteği (16:00 26.09.2026)" */
export function cleanSubject(subject: string): string {
  let s = subject.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(fwd?|fw|[iİ]lt|[iİ]letilen|ynt|re|yan[ıI]t)\s*:\s*/i, "");
  }
  return s.replace(/\s*-\s*\d{1,2}\s*$/, "").trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  oca: 1, şub: 2, sub: 2, nis: 4, haz: 6, tem: 7, ağu: 8, agu: 8, eyl: 9, eki: 10, kas: 11, ara: 12,
};

/** Mail tarih satırından "gg.aa.yyyy" üretir (İngilizce ve Türkçe ay kısaltmaları). */
export function dayOf(dateLine: string): string | null {
  const dotted = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(dateLine);
  if (dotted) return `${dotted[1].padStart(2, "0")}.${dotted[2].padStart(2, "0")}.${dotted[3]}`;
  const m = /(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})[a-zçğıöşü]*\s+(\d{4})/.exec(dateLine);
  if (m) {
    const month = MONTHS[m[2].toLocaleLowerCase("tr")];
    if (month) return `${m[1].padStart(2, "0")}.${String(month).padStart(2, "0")}.${m[3]}`;
  }
  return null;
}

export function todayDotted(d = new Date()): string {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

export const REPLY_BODY = "Sn. İlgili;\n\nTeklifiniz ektedir.";

/** Gmail'de yeni mail penceresi (API'siz): kullanıcı Excel'i ekleyip kendisi gönderir. */
export function gmailComposeUrl(o: { to?: string; subject: string; account?: string }): string {
  const p = new URLSearchParams({ view: "cm", fs: "1" });
  if (o.to) p.set("to", o.to);
  p.set("su", `Re: ${o.subject}`.trim());
  p.set("body", REPLY_BODY);
  if (o.account) p.set("authuser", o.account);
  return `https://mail.google.com/mail/?${p.toString().replace(/\+/g, "%20")}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
