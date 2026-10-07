// Tek bir .eml (RFC 822) mailini ayrıştırır: gönderen, konu, kalem tablosu, çizim ekleri.
// Gmail'den gelen ham mail (format=raw) de aynı fonksiyondan geçer.
import PostalMime from "postal-mime";
import type { Address } from "postal-mime";
import { drawingKey } from "./codes";
import { tableFromHtml, tableFromText } from "./table";
import type { Drawing, ItemTable, OtherAttachment, ParsedMail, Person } from "./types";

/** İletilen mail blok başlığı (Gmail TR/EN, Outlook). */
const FORWARD_MARKER_RE =
  /^\s*(?:-{3,}\s*(?:Forwarded message|İletilen ileti|Original Message|Orijinal İleti|Özgün İleti)\s*-{3,}|_{10,})\s*$/gim;

const FORWARD_FIELDS: Record<string, "from" | "date" | "subject"> = {
  from: "from", "gönderen": "from", kimden: "from",
  date: "date", sent: "date", tarih: "date", "gönderildi": "date", "gönderilme": "date",
  subject: "subject", konu: "subject",
};

const REQUEST_TAG_RE = /\((\d{1,2}:\d{2})\s+(\d{1,2}\.\d{1,2}\.\d{4})\)/;
const PART_NO_RE = /-\s*(\d{1,2})\s*$/;
const PART_TOTAL_RE = /(\d{1,2})\s+parça/i;
const DEADLINE_RE = /(\d{1,2}\.\d{1,2}\.\d{4})\s*(?:saat\s*:?\s*)?(\d{1,2}[:.]\d{2})?\s*'?[ae]?\s*kadar/i;

let idCounter = 0;

function personFromText(s: string): Person {
  const addr = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(s) ?? /\[mailto:([^\]\s]+)\]/i.exec(s) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(s);
  const address = addr ? addr[1].toLowerCase() : "";
  const name = s.replace(/<[^>]*>|\[mailto:[^\]]*\]/gi, "").replace(/["']/g, "").trim();
  return { name: name === address ? "" : name, address };
}

function personFromAddress(a: Address | undefined): Person {
  if (!a) return { name: "", address: "" };
  if ("group" in a && a.group) return personFromAddress(a.group[0]);
  return { name: a.name ?? "", address: (a.address ?? "").toLowerCase() };
}

interface ForwardHeader {
  from: Person;
  date: string;
  subject: string;
}

/** Gövdedeki en içteki (orijinal) iletilen mail başlığını okur. */
function findForwardHeader(text: string): ForwardHeader | null {
  const markers = [...text.matchAll(FORWARD_MARKER_RE)];
  for (let k = markers.length - 1; k >= 0; k--) {
    const after = text.slice(markers[k].index! + markers[k][0].length).split(/\r?\n/);
    const fields: Partial<Record<"from" | "date" | "subject", string>> = {};
    let seen = 0;
    for (const raw of after) {
      const line = raw.trim();
      if (!line) {
        if (seen) break;
        continue;
      }
      const m = /^([^:]{2,20}):\s*(.*)$/.exec(line);
      const field = m && FORWARD_FIELDS[m[1].trim().toLocaleLowerCase("tr")];
      if (!m) break;
      seen++;
      if (field && fields[field] === undefined) fields[field] = m[2].trim();
    }
    if (fields.from) {
      return { from: personFromText(fields.from), date: fields.date ?? "", subject: fields.subject ?? "" };
    }
  }
  return null;
}

function sameRows(a: ItemTable, b: ItemTable): boolean {
  return a.rows.length === b.rows.length && a.rows.every((r, i) => r.join("\u0001") === b.rows[i].join("\u0001"));
}

function toBytes(c: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof c === "string") return new TextEncoder().encode(c);
  return c instanceof Uint8Array ? c : new Uint8Array(c);
}

export async function parseEml(raw: ArrayBuffer | Uint8Array | string, id?: string): Promise<ParsedMail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const mailId = id ?? (email.messageId || `mail-${++idCounter}`);
  const text = email.text ?? "";
  const html = email.html ?? "";
  const warnings: string[] = [];

  const envelopeFrom = personFromAddress(email.from);
  const fwd = findForwardHeader(text);
  const subject = fwd ? fwd.subject : (email.subject ?? "");
  const date = fwd?.date || email.date || "";

  // Kalem tablosu: HTML birincil, düz metin yedek; ikisi de varsa çapraz kontrol.
  const htmlTable = html ? tableFromHtml(html) : null;
  const { table: textTable, unparsed } = tableFromText(text);
  const table = htmlTable ?? textTable;
  if (htmlTable && textTable && !sameRows(htmlTable, textTable)) {
    warnings.push(
      `HTML tablo (${htmlTable.rows.length} kalem) ile düz metin tablo (${textTable.rows.length} kalem) farklı; HTML kullanıldı.`,
    );
  }
  if (!htmlTable && unparsed.length) {
    warnings.push(`${unparsed.length} satır okunamadı: ${unparsed.slice(0, 3).join(" | ")}`);
  }

  const drawings: Drawing[] = [];
  const unrecognizedPdfs: OtherAttachment[] = [];
  const otherAttachments: OtherAttachment[] = [];
  for (const att of email.attachments) {
    const filename = att.filename ?? "";
    const data = toBytes(att.content);
    const isDrawing = (att.mimeType === "application/pdf" || /^image\/(png|jpeg)$/i.test(att.mimeType) || /\.(pdf|png|jpe?g)$/i.test(filename)) && !/\.(step|stp)$/i.test(filename);
    const info = { filename, mimeType: att.mimeType, size: data.byteLength, mailId };
    if (!isDrawing) {
      otherAttachments.push(info);
      continue;
    }
    const dk = drawingKey(filename);
    if (dk) {
      drawings.push({ filename, key: dk.key, sheet: dk.sheet, data, mailId });
    } else {
      drawings.push({ filename, key: filename, sheet: 1, data, mailId });
    }
  }

  const tag = REQUEST_TAG_RE.exec(subject);
  const partNo = tag ? PART_NO_RE.exec(subject) : null;
  const partTotal = PART_TOTAL_RE.exec(text) ?? PART_TOTAL_RE.exec(html);
  const deadline = DEADLINE_RE.exec(text.replace(/\s+/g, " "));

  return {
    id: mailId,
    sender: fwd ? fwd.from : envelopeFrom,
    forwardedBy: fwd ? envelopeFrom : null,
    subject,
    date,
    requestTag: tag ? `${tag[1]} ${tag[2]}` : null,
    partNo: partNo ? Number(partNo[1]) : null,
    partTotal: partTotal ? Number(partTotal[1]) : null,
    deadline: deadline ? [deadline[1], deadline[2]?.replace(".", ":")].filter(Boolean).join(" ") : null,
    table,
    warnings,
    drawings,
    unrecognizedPdfs,
    otherAttachments,
  };
}
