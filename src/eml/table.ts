// Gövdedeki kalem tablosunu bulur: önce HTML tablo (başlıklar ve sütun sınırları kesin),
// yoksa düz metin satırları.
import { isItemCode } from "./codes";
import type { ItemTable } from "./types";

const DEFAULT_HEADERS = ["Malzeme", "Malzeme Tanımı", "Miktar", "Ö/B", "Teslim Tarihi"];

/** CLAUDE.md'de gerçek veriyle doğrulanan satır biçimi (boşluk/sekme ile ayrılmış). */
const TEXT_ROW_RE = /^(\S+)\s+(.+?)\s+(\d+)\s+(\S+)\s+(\d\d\.\d\d\.\d{4})$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  Ccedil: "Ç", ccedil: "ç", Ouml: "Ö", ouml: "ö", Uuml: "Ü", uuml: "ü",
  Iuml: "Ï", iuml: "ï", deg: "°", plusmn: "±", Oslash: "Ø", oslash: "ø",
  times: "×", micro: "µ", ndash: "–", mdash: "—",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return NAMED_ENTITIES[e] ?? all;
  });
}

function cellText(html: string): string {
  const text = decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""));
  return text.replace(/[\s ]+/g, " ").trim();
}

function htmlRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1]));
    rows.push(cells);
  }
  return rows;
}

function normalizeHeader(s: string): string {
  return s.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
}

function findQtyCol(headers: string[], rows: string[][], codeCol: number): number {
  const byName = headers.findIndex((h) => normalizeHeader(h) === "miktar");
  if (byName >= 0) return byName;
  for (let c = 0; c < (rows[0]?.length ?? 0); c++) {
    if (c !== codeCol && rows.every((r) => /^\d+([.,]\d+)?$/.test(r[c] ?? ""))) return c;
  }
  return -1;
}

export function tableFromHtml(html: string): ItemTable | null {
  const rows = htmlRows(html);
  // En uzun ardışık "kod içeren satır" dizisi kalem tablosudur.
  let best: { start: number; end: number; codeCol: number } | null = null;
  let i = 0;
  while (i < rows.length) {
    const codeCol = rows[i].findIndex(isItemCode);
    if (codeCol < 0) {
      i++;
      continue;
    }
    const width = rows[i].length;
    let j = i + 1;
    while (j < rows.length && rows[j].length === width && isItemCode(rows[j][codeCol] ?? "")) j++;
    if (!best || j - i > best.end - best.start) best = { start: i, end: j, codeCol };
    i = j;
  }
  if (!best) return null;

  const data = rows.slice(best.start, best.end);
  const prev = rows[best.start - 1];
  const isHeaderLike = (r: string[]) => r.some(c => /malzeme|a[cç][ıi]klama|miktar|fiyat|tarih|tan[ıi]m|s[ıi]ra/i.test(normalizeHeader(c)));
  const headers =
    prev && prev.length === data[0].length && !prev.some(isItemCode) && isHeaderLike(prev)
      ? prev
      : data[0].length === DEFAULT_HEADERS.length
        ? [...DEFAULT_HEADERS]
        : data[0].map((_, k) => `Sütun ${k + 1}`);
  return {
    headers,
    rows: data,
    codeCol: best.codeCol,
    qtyCol: findQtyCol(headers, data, best.codeCol),
    source: "html",
  };
}

export interface TextTableResult {
  table: ItemTable | null;
  /** Kod ile başlayıp biçime uymayan satırlar (ör. satır kaydırması). */
  unparsed: string[];
}

export function tableFromText(text: string): TextTableResult {
  const lines = text.split(/\r?\n/);
  const rows: string[][] = [];
  const unparsed: string[] = [];
  let firstRowLine = -1;

  lines.forEach((raw, n) => {
    const line = raw.trim();
    const first = line.split(/\s+/)[0] ?? "";
    if (!isItemCode(first)) return;
    let cells: string[] | null = null;
    if (line.includes("\t")) {
      const parts = line.split(/\t+/).map((c) => c.trim());
      if (parts.length >= 3) cells = parts;
    }
    if (!cells) {
      const m = TEXT_ROW_RE.exec(line);
      if (m) cells = m.slice(1);
    }
    if (cells) {
      if (firstRowLine < 0) firstRowLine = n;
      rows.push(cells);
    } else {
      unparsed.push(line);
    }
  });

  if (!rows.length) return { table: null, unparsed };

  const headerLine = (lines[firstRowLine - 1] ?? "").trim();
  const isHeaderLike = (r: string[]) => r.some(c => /malzeme|a[cç][ıi]klama|miktar|fiyat|tarih|tan[ıi]m|s[ıi]ra/i.test(normalizeHeader(c)));
  let headers: string[];
  if (headerLine.includes("\t") && headerLine.split(/\t+/).length === rows[0].length && isHeaderLike(headerLine.split(/\t+/))) {
    headers = headerLine.split(/\t+/).map((h) => h.trim());
  } else if (rows[0].length === DEFAULT_HEADERS.length) {
    headers = [...DEFAULT_HEADERS];
  } else {
    headers = rows[0].map((_, k) => `Sütun ${k + 1}`);
  }
  return {
    table: { headers, rows, codeCol: 0, qtyCol: findQtyCol(headers, rows, 0), source: "text" },
    unparsed,
  };
}
