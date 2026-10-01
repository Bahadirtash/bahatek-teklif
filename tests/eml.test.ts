import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeKey, drawingKey, groupMails, parseEml } from "../src/eml";

// ---------- Sentetik mail üretici ----------

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function mkEml(o: { from: string; subject: string; text?: string; html?: string; pdfs?: string[] }): string {
  const B = "BOUNDARY-X";
  const parts: string[] = [];
  if (o.text !== undefined) {
    parts.push(`Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(o.text)}`);
  }
  if (o.html !== undefined) {
    parts.push(`Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(o.html)}`);
  }
  for (const name of o.pdfs ?? []) {
    parts.push(
      `Content-Type: application/pdf; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${b64(`%PDF-1.4 fake ${name}`)}`,
    );
  }
  return (
    `From: ${o.from}\r\nSubject: =?UTF-8?B?${b64(o.subject)}?=\r\nDate: Sat, 26 Sep 2026 16:40:00 +0300\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${B}"\r\n\r\n` +
    parts.map((p) => `--${B}\r\n${p}\r\n`).join("") +
    `--${B}--\r\n`
  );
}

const ROWS = [
  "FU00111111/A-03\tTIA KAPAK -U00111111/A-MF\t2\tAD\t08.10.2026",
  "FU00230931-A-03\tTIA TABAN MIL TUTUCU-U00230931/A-MF\t20\tAD\t02.10.2026",
  "FU00333333/B-03\tTIA-1 YAN PLAKA 1 -U00333333/B-MF\t1\tAD\t09.10.2026",
];
const TABLE_TEXT =
  "Sn. İlgili;\n\n3 parça olarak gönderilmiştir.\nMalzeme\tMalzeme Tanımı\tMiktar\tÖ/B\tTeslim Tarihi\n" +
  ROWS.join("\n") +
  "\n";
const B_FIRM = "Tuğçe Şahin <tugce@bfirma.com.tr>";

// ---------- Kod ↔ çizim anahtarı ----------

describe("kod ve çizim anahtarı", () => {
  it("numara + revizyon harfi ile eşler", () => {
    expect(codeKey("FU00314268/B-03")).toBe("00314268_B");
    expect(codeKey("FU00230931-A-03")).toBe("00230931_A");
    expect(drawingKey("U00314268_B_SHT1.pdf")).toEqual({ key: "00314268_B", sheet: 1 });
    expect(drawingKey("U00314268_B_SHT2 (1).pdf")).toEqual({ key: "00314268_B", sheet: 2 });
    expect(drawingKey("teknik_sartname.pdf")).toBeNull();
    expect(codeKey("TIA KAPAK")).toBeNull();
  });
});

// ---------- Sentetik birleştirme senaryoları ----------

describe("parçalı mail birleştirme", () => {
  it("konu etiketiyle 3 parçayı birleştirir, düz metin tabloyu harfi harfine okur", async () => {
    const mails = await Promise.all([
      parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 1", text: TABLE_TEXT, pdfs: ["U00111111_A_SHT1.pdf"] })),
      parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 2", text: TABLE_TEXT, pdfs: ["U00230931_A_SHT2.pdf", "U00230931_A_SHT1.pdf"] })),
      parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 3", text: TABLE_TEXT, pdfs: ["U00333333_B_SHT1.pdf"] })),
    ]);
    const reqs = groupMails(mails);
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.partsReceived).toEqual([1, 2, 3]);
    expect(r.partTotal).toBe(3);
    expect(r.headers).toEqual(["Malzeme", "Malzeme Tanımı", "Miktar", "Ö/B", "Teslim Tarihi"]);
    expect(r.items.map((i) => i.code)).toEqual(["FU00111111/A-03", "FU00230931-A-03", "FU00333333/B-03"]);
    expect(r.items[2].cells[1]).toBe("TIA-1 YAN PLAKA 1 -U00333333/B-MF");
    expect(r.items.map((i) => i.qty)).toEqual([2, 20, 1]);
    expect(r.items.every((i) => i.status === "ready")).toBe(true);
    expect(r.items[1].drawings.map((d) => d.filename)).toEqual(["U00230931_A_SHT1.pdf", "U00230931_A_SHT2.pdf"]);
    expect(r.unmatchedDrawings).toHaveLength(0);
  });

  it("eksik parça varken çizimsiz kalem 'bekleniyor', hepsi gelince 'yok' olur", async () => {
    const p1 = await parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 1", text: TABLE_TEXT, pdfs: ["U00111111_A_SHT1.pdf"] }));
    expect(groupMails([p1])[0].items.map((i) => i.status)).toEqual(["ready", "waiting", "waiting"]);
    const p2 = await parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 2", text: TABLE_TEXT }));
    const p3 = await parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 3", text: TABLE_TEXT }));
    expect(groupMails([p1, p2, p3])[0].items.map((i) => i.status)).toEqual(["ready", "missing", "missing"]);
  });

  it("konu boşken: önce gelen tablosuz çizim maili, sonra gelen tabloya bağlanır", async () => {
    const pdfFirst = await parseEml(mkEml({ from: B_FIRM, subject: "", text: "Ekte.", pdfs: ["U00333333_B_SHT1.pdf", "U09999999_Z_SHT1.pdf", "sartname.pdf"] }));
    const tableLater = await parseEml(mkEml({ from: B_FIRM, subject: "", text: TABLE_TEXT }));
    const reqs = groupMails([pdfFirst, tableLater]);
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.items.map((i) => i.status)).toEqual(["waiting", "waiting", "ready"]);
    // Eşleşmeyen ve tanınmayan ekler kaybolmaz.
    expect(r.unmatchedDrawings.map((d) => d.filename)).toEqual(["U09999999_Z_SHT1.pdf"]);
    expect(r.unrecognizedPdfs.map((d) => d.filename)).toEqual(["sartname.pdf"]);
  });

  it("farklı gönderenin aynı etiketli maili birleşmez", async () => {
    const a = await parseEml(mkEml({ from: B_FIRM, subject: "Teklif İsteği (16:00 26.09.2026) - 1", text: TABLE_TEXT }));
    const b = await parseEml(mkEml({ from: "Başka <satinalma@baska.com>", subject: "Teklif İsteği (16:00 26.09.2026) - 1", text: TABLE_TEXT }));
    expect(groupMails([a, b])).toHaveLength(2);
  });

  it("iletilen (Fwd) mailde orijinal gönderen ve konu kullanılır; HTML tablo birincil", async () => {
    const text =
      "Saygılarımla\n\n---------- Forwarded message ---------\nGönderen: <tugce@bfirma.com.tr>\n" +
      "Date: 26 Eyl 2026 Cmt, 16:40\nSubject: Teklif İsteği (16:00 26.09.2026) - 1\nTo: <x@bfirma.com.tr>\n\n" +
      TABLE_TEXT;
    const html =
      "<table><tr><th>Malzeme</th><th>Malzeme Tanımı</th><th>Miktar</th><th>Ö/B</th><th>Teslim Tarihi</th></tr>" +
      ROWS.map((r) => `<tr>${r.split("\t").map((c) => `<td>${c.replace("&", "&amp;")}</td>`).join("")}</tr>`).join("") +
      "</table>";
    const m = await parseEml(mkEml({ from: "Atölye <atolye@gmail.com>", subject: "Fwd: Teklif İsteği (16:00 26.09.2026) - 1", text, html }));
    expect(m.sender.address).toBe("tugce@bfirma.com.tr");
    expect(m.forwardedBy?.address).toBe("atolye@gmail.com");
    expect(m.subject).toBe("Teklif İsteği (16:00 26.09.2026) - 1");
    expect(m.requestTag).toBe("16:00 26.09.2026");
    expect(m.partNo).toBe(1);
    expect(m.table?.source).toBe("html");
    expect(m.warnings).toEqual([]);
  });
});

// ---------- Gerçek test verisi (testdata/ git'te yok; yoksa atlanır) ----------

const FWD = "testdata/Fwd_Teklif_Istegi_26.09.2026-1.eml";
const FILE = "testdata/File.eml";

describe.skipIf(!existsSync(FWD) || !existsSync(FILE))("gerçek test verisi", () => {
  it("Fwd Teklif İsteği - 1: 94 kalem, 38 çizim eşleşir, 56 çizim bekleniyor", async () => {
    const m = await parseEml(readFileSync(FWD));
    expect(m.sender.address).toBe("tugce.sahin@etimakine.com.tr");
    expect(m.forwardedBy?.address).toBe("krdgmakina@gmail.com");
    expect(m.requestTag).toBe("16:00 26.09.2026");
    expect(m.partNo).toBe(1);
    expect(m.partTotal).toBe(3);
    expect(m.deadline).toBe("28.09.2026 15:00");
    expect(m.table?.source).toBe("html");
    expect(m.warnings).toEqual([]); // HTML ve düz metin tablo birebir aynı
    expect(m.drawings).toHaveLength(38);

    const [r] = groupMails([m]);
    expect(r.headers).toEqual(["Malzeme", "Malzeme Tanımı", "Miktar", "Ö/B", "Teslim Tarihi"]);
    expect(r.items).toHaveLength(94);
    expect(r.items.filter((i) => i.status === "ready")).toHaveLength(38);
    expect(r.items.filter((i) => i.status === "waiting")).toHaveLength(56);
    expect(r.unmatchedDrawings).toHaveLength(0);
    expect(r.unrecognizedPdfs).toHaveLength(0);

    // Harfi harfine: tireli kod düzeltilmez.
    const tireli = r.items.find((i) => i.code === "FU00230931-A-03");
    expect(tireli?.cells).toEqual(["FU00230931-A-03", "TIA TABAN MIL TUTUCU-U00230931/A-MF", "20", "AD", "02.10.2026"]);
    const kapak = r.items.find((i) => i.code === "FU00314268/B-03");
    expect(kapak?.drawings.map((d) => d.filename)).toEqual(["U00314268_B_SHT1.pdf"]);
    expect(kapak?.drawings[0].data.subarray(0, 5)).toEqual(new TextEncoder().encode("%PDF-"));
  });

  it("File.eml: konu boş, aynı 94 kalem, xlsx ekleri yok sayılır", async () => {
    const [fwd, file] = await Promise.all([parseEml(readFileSync(FWD)), parseEml(readFileSync(FILE))]);
    expect(file.subject).toBe("");
    expect(file.table?.rows).toEqual(fwd.table?.rows);
    expect(file.drawings).toHaveLength(0);
    expect(file.otherAttachments).toHaveLength(3);
    expect(file.warnings).toEqual([]);
  });
});
