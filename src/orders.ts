// EBA / SİP sipariş mailleri → "Kaldı (yeşil) / Kalmadı (kırmızı)" motoru.
// Saf fonksiyonlar: DOM'a, Tauri'ye veya global duruma dokunmaz (birim testlenebilir).
//
// Temel kurallar:
// 1. Bir mail ancak KONUSUNDA veya EK DOSYA ADINDA açıkça SİP / SİB / SİPARİŞ / EBA /
//    SATINALMA SİPARİŞİ geçiyorsa sipariş mailidir. Gövdeye bakılarak karar verilmez.
// 2. Sipariş mailinden SADECE parça koduna benzeyen ifadeler alınır (FU00314268/B-03,
//    U00314268_B, FTM30002337, FE026BF3736, TIA 30012486 ...). Tarih, saat, telefon,
//    sipariş no gibi salt sayılar asla havuza girmez.
// 3. Bir kalem, ancak teklif isteğinden SONRA tarihli bir sipariş mailinde geçiyorsa "kaldı" olur.
import { baseCodeKey, codeKey, normTr, normalizeCodeStr } from "./eml/codes";
import type { ParsedMail } from "./eml";

/** Kalıcı olarak saklanan (orders.json) tek bir sipariş/iptal mailinin hafif özeti. */
export interface OrderMailRecord {
  /** Mailin zaman damgası (ms). */
  date: number;
  subject: string;
  from: string;
  /** true: iptal/olumsuz mail, false: sipariş (SİP) maili. */
  cancel: boolean;
  /** Mailden çıkarılan eşleştirme anahtarları. */
  keys: string[];
}

const ORDER_WORD_RE = /(?:^|[^A-Z0-9])(SIP|SIB|SIPARIS[A-Z]*|EBA|SATINALMA\s*SIPARIS[A-Z]*)(?![A-Z0-9])/;
const CANCEL_WORD_RE = /(?:^|[^A-Z0-9])(IPTAL[A-Z]*|OLUMSUZ)(?![A-Z0-9])/;
const QUOTE_REQ_RE = /TEKLIF\s*ISTEG/;

function attachmentNames(m: ParsedMail): string[] {
  return [...m.drawings.map((d) => d.filename), ...m.unrecognizedPdfs.map((a) => a.filename), ...m.otherAttachments.map((a) => a.filename)];
}

/** Konusunda veya ek adında açıkça SİP/Sipariş/EBA geçen mail mi? (Teklif isteği değilse.) */
export function isOrderMail(m: ParsedMail): boolean {
  const subj = normTr(m.subject || "");
  if (QUOTE_REQ_RE.test(subj)) return false;
  if (CANCEL_WORD_RE.test(subj)) return false;
  if (ORDER_WORD_RE.test(subj)) return true;
  return attachmentNames(m).some((n) => ORDER_WORD_RE.test(normTr(n)));
}

/** Konusunda SİP/Sipariş bağlamıyla birlikte İPTAL / OLUMSUZ geçen mail mi? */
export function isCancelMail(m: ParsedMail): boolean {
  const subj = normTr(m.subject || "");
  if (QUOTE_REQ_RE.test(subj)) return false;
  return CANCEL_WORD_RE.test(subj) && ORDER_WORD_RE.test(subj);
}

function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") n++;
  return n;
}

/**
 * Bir malzeme kodunun eşleştirme anahtarları. Hem teklif kalemine hem sipariş mailindeki
 * koda AYNI fonksiyon uygulanır, böylece eşleştirme simetrik olur.
 * Örn. "FU00314268/B-03" → ["FU00314268/B-03", "00314268_B", "00314268"]
 */
export function itemMatchKeys(code: string): string[] {
  const raw = (code || "").trim();
  if (!raw) return [];
  const keys = new Set<string>();
  const norm = normalizeCodeStr(raw);
  if (norm.length >= 5 && digitCount(norm) >= 4) keys.add(norm);
  const ck = codeKey(raw);
  if (ck && digitCount(ck) >= 5) keys.add(ck.toUpperCase());
  const bk = baseCodeKey(raw);
  if (bk && bk.length >= 6 && digitCount(bk) >= 5) keys.add(bk);
  return [...keys];
}

const CLASSIC_IN_TEXT = /(?<![A-Z0-9])[A-Z]{0,5}\d{5,12}[/_-][A-Z](?:-\d+)?(?![A-Z0-9])/g;
const PREFIXED_IN_TEXT = /(?<![A-Z0-9])(?:FU|FTM|FE|TIA|ME|MF|U|E)[\s_-]?[0-9A-Z]{5,14}(?![A-Z0-9])/g;

/** Serbest metinden SADECE parça koduna benzeyen ifadelerin anahtarlarını çıkarır (salt sayılar alınmaz). */
export function extractOrderKeys(text: string): string[] {
  if (!text) return [];
  const up = normTr(text);
  const keys = new Set<string>();
  for (const m of up.matchAll(CLASSIC_IN_TEXT)) for (const k of itemMatchKeys(m[0])) keys.add(k);
  for (const m of up.matchAll(PREFIXED_IN_TEXT)) {
    const tok = m[0].replace(/\s+/g, "");
    if (digitCount(tok) < 5) continue;
    for (const k of itemMatchKeys(tok)) keys.add(k);
  }
  return [...keys];
}

/** Cevap/alıntı kısmını keser: eski yazışmadaki (ör. teklif isteğindeki) kodlar SİP sanılmasın. */
export function stripQuotedReply(body: string): string {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (/^-{2,}\s*(original message|orijinal ileti|özgün ileti|ozgun ileti)/i.test(t)) break;
    if (/(wrote|yazdı|yazdi):\s*$/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Bir sipariş mailinin (xlsx ekleri hariç) eşleştirme anahtarları. */
export function orderKeysFromMail(m: ParsedMail): string[] {
  const keys = new Set<string>();
  const add = (arr: string[]) => arr.forEach((k) => keys.add(k));
  add(extractOrderKeys(m.subject));
  if (m.table && m.table.rows.length) {
    // Tablo varsa: yalnızca malzeme kodu sütunu (sipariş no / tarih / miktar sütunları değil).
    for (const row of m.table.rows) {
      const cell = row[m.table.codeCol] ?? "";
      add(itemMatchKeys(cell));
      add(extractOrderKeys(cell));
    }
  } else if (m.bodyText) {
    add(extractOrderKeys(stripQuotedReply(m.bodyText)));
  }
  for (const n of attachmentNames(m)) add(extractOrderKeys(n.replace(/\.[a-z0-9]{2,4}$/i, "")));
  return [...keys];
}

/** Tüm sipariş/iptal maillerinden kurulan, anahtar → tarih listesi indeksi. O(1) sorgu. */
export class OrderIndex {
  private won = new Map<string, number[]>();
  private cancel = new Map<string, number[]>();
  /** İndeksteki en eski sipariş mailinin tarihi (0: hiç yok). */
  readonly coverageStart: number;
  readonly size: number;

  constructor(records: Iterable<OrderMailRecord>) {
    let earliest = 0;
    let n = 0;
    for (const r of records) {
      n++;
      if (!earliest || r.date < earliest) earliest = r.date;
      const map = r.cancel ? this.cancel : this.won;
      for (const k of r.keys) {
        const arr = map.get(k);
        if (arr) arr.push(r.date);
        else map.set(k, [r.date]);
      }
    }
    this.coverageStart = earliest;
    this.size = n;
  }

  /** Verilen anahtarlardan herhangi biri için `since` sonrası sipariş tarihleri. */
  orderDatesAfter(keys: string[], since: number): number[] {
    const out: number[] = [];
    for (const k of keys) for (const d of this.won.get(k) ?? []) if (d >= since) out.push(d);
    return out;
  }

  canceledAfter(keys: string[], since: number): boolean {
    return keys.some((k) => (this.cancel.get(k) ?? []).some((d) => d >= since));
  }

  /** Tüm sipariş anahtarları (hafıza penceresindeki sayaç için). */
  wonKeyCount(): number {
    return this.won.size;
  }
}

/** Teklif isteği tarihinden biraz öncesine tolerans (saat dilimi / etiket farkları). */
export const ORDER_SLACK_MS = 6 * 60 * 60 * 1000;
/** Teklif hazırlandıktan sonra SİP gelmezse "Kalmadı" denmeden önce beklenen süre. */
export const LOST_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Kalem bu teklif isteğine ait bir siparişle mi eşleşiyor?
 * `reqTime` sonrasında sipariş gelmiş olmalı ve araya AYNI parçayı içeren daha yeni bir
 * teklif isteği girmemiş olmalı (sipariş en yakın önceki isteğe aittir).
 */
export function itemWonBySip(keys: string[], reqTime: number, index: OrderIndex, newerRequestTimes: number[]): boolean {
  if (!keys.length || !reqTime) return false;
  const dates = index.orderDatesAfter(keys, reqTime - ORDER_SLACK_MS);
  return dates.some((d) => !newerRequestTimes.some((t) => t > reqTime && t <= d));
}
