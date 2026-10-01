// Parçalı mailleri tek teklif isteğinde birleştirir ve çizimleri kalemlere eşleştirir.
// Konu bazen boş/Fwd olduğundan tek kurala bağlı değil: aynı gönderen + (aynı konu
// etiketi "(16:00 26.09.2026)" VEYA aynı kalem tablosu VEYA çizimleri tablodaki kalemlere uyan).
import { codeKey } from "./codes";
import type { Drawing, Item, OtherAttachment, ParsedMail, QuoteRequest } from "./types";

function senderKey(m: ParsedMail): string {
  return m.sender.address || m.sender.name.toLocaleLowerCase("tr");
}

function tableFingerprint(m: ParsedMail): string | null {
  const t = m.table;
  return t ? t.rows.map((r) => r[t.codeCol]).join("|") : null;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function tableKeys(m: ParsedMail): Set<string> {
  const t = m.table;
  const keys = new Set<string>();
  if (t) for (const r of t.rows) {
    const k = codeKey(r[t.codeCol]);
    if (k) keys.add(k);
  }
  return keys;
}

export function groupMails(mails: ParsedMail[]): QuoteRequest[] {
  const parent = mails.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const byKey = new Map<string, number>();
  mails.forEach((m, i) => {
    const s = senderKey(m);
    const fp = tableFingerprint(m);
    for (const k of [m.requestTag && `tag:${s}:${m.requestTag}`, fp && `fp:${s}:${fp}`]) {
      if (!k) continue;
      const j = byKey.get(k);
      if (j === undefined) byKey.set(k, i);
      else union(i, j);
    }
  });

  // Tablosuz gruplar (önce/ayrı gelen çizim parçaları): aynı gönderenin tablosunda
  // çizim anahtarları geçen gruba katılır.
  const groupHasTable = (root: number) => mails.some((m, i) => find(i) === root && m.table);
  mails.forEach((m, i) => {
    if (groupHasTable(find(i)) || !m.drawings.length) return;
    const target = mails.findIndex((o, j) => {
      if (!o.table || senderKey(o) !== senderKey(m)) return false;
      const keys = tableKeys(o);
      return m.drawings.some((d) => keys.has(d.key)) && j !== i;
    });
    if (target >= 0) union(i, target);
  });

  const groups = new Map<number, number[]>();
  mails.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });

  return [...groups.values()].map((idx) => buildRequest(idx.map((i) => mails[i])));
}

function buildRequest(group: ParsedMail[]): QuoteRequest {
  const mails = [...group].sort((a, b) => (a.partNo ?? Infinity) - (b.partNo ?? Infinity));
  const warnings = mails.flatMap((m) => m.warnings);

  const withTable = mails.filter((m) => m.table);
  const table = withTable[0]?.table ?? null;
  const fp = withTable[0] ? tableFingerprint(withTable[0]) : null;
  if (withTable.some((m) => tableFingerprint(m) !== fp)) {
    warnings.push("Parçalardaki kalem tabloları birbirinden farklı; ilk parçanınki kullanıldı.");
  }

  // Aynı çizim birden fazla parçada gelirse tek sayılır.
  const seen = new Set<string>();
  const drawings: Drawing[] = [];
  for (const d of mails.flatMap((m) => m.drawings)) {
    const k = `${d.filename}|${d.data.byteLength}`;
    if (!seen.has(k)) {
      seen.add(k);
      drawings.push(d);
    }
  }
  const unrecognizedPdfs: OtherAttachment[] = mails.flatMap((m) => m.unrecognizedPdfs);

  const partsReceived = [...new Set(mails.map((m) => m.partNo).filter((n): n is number => n != null))].sort(
    (a, b) => a - b,
  );
  const partTotal = mails.reduce<number | null>((t, m) => (m.partTotal != null ? Math.max(t ?? 0, m.partTotal) : t), null);
  const complete = partTotal != null
    ? Array.from({ length: partTotal }, (_, k) => k + 1).every((p) => partsReceived.includes(p))
    : partsReceived.length === 0;

  const used = new Set<Drawing>();
  const items: Item[] = (table?.rows ?? []).map((cells, index) => {
    const code = cells[table!.codeCol];
    const key = codeKey(code);
    const own = key ? drawings.filter((d) => d.key === key).sort((a, b) => a.sheet - b.sheet) : [];
    own.forEach((d) => used.add(d));
    const qtyText = table!.qtyCol >= 0 ? cells[table!.qtyCol] : "";
    const qty = /^\d+([.,]\d+)?$/.test(qtyText) ? Number(qtyText.replace(",", ".")) : null;
    return {
      index,
      cells,
      code,
      key,
      qty,
      drawings: own,
      status: own.length ? "ready" : complete ? "missing" : "waiting",
    };
  });

  const first = mails[0];
  const sKey = senderKey(first);
  return {
    id: `${sKey}|${first.requestTag ?? (fp ? hash(fp) : first.id)}`,
    sender: first.sender,
    subject: (withTable[0] ?? first).subject,
    date: (withTable[0] ?? first).date,
    requestTag: first.requestTag,
    deadline: mails.find((m) => m.deadline)?.deadline ?? null,
    partTotal,
    partsReceived,
    mails,
    headers: table?.headers ?? [],
    codeCol: table?.codeCol ?? 0,
    qtyCol: table?.qtyCol ?? -1,
    items,
    unmatchedDrawings: drawings.filter((d) => !used.has(d)),
    unrecognizedPdfs,
    warnings,
  };
}
