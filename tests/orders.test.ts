import { describe, expect, it } from "vitest";
import type { ParsedMail } from "../src/eml";
import {
  LOST_AFTER_MS, OrderIndex, extractOrderKeys, isCancelMail, isOrderMail, itemMatchKeys, itemWonBySip,
  orderKeysFromMail, stripQuotedReply,
} from "../src/orders";

function mail(p: Partial<ParsedMail>): ParsedMail {
  return {
    id: p.id ?? "m1",
    sender: p.sender ?? { name: "", address: "tugce.sahin@etimakine.com.tr" },
    forwardedBy: null,
    subject: p.subject ?? "",
    date: p.date ?? "Sat, 26 Sep 2026 16:40:00 +0300",
    requestTag: null,
    partNo: null,
    partTotal: null,
    deadline: null,
    bodyText: p.bodyText,
    table: p.table ?? null,
    warnings: [],
    drawings: p.drawings ?? [],
    unrecognizedPdfs: [],
    otherAttachments: p.otherAttachments ?? [],
  };
}

describe("sipariş maili tespiti (yalnızca konu / ek adı)", () => {
  it("konuda SİP / Sipariş / EBA geçen mail sipariş mailidir", () => {
    expect(isOrderMail(mail({ subject: "SİP-2026-0912 Sipariş Onayı" }))).toBe(true);
    expect(isOrderMail(mail({ subject: "EBA Bilgilendirme: Satınalma Siparişi" }))).toBe(true);
    expect(isOrderMail(mail({ subject: "Fwd: SİPARİŞLERİNİZ" }))).toBe(true);
  });
  it("teklif isteği veya alakasız konu sipariş maili değildir (gövdede SİP geçse bile)", () => {
    expect(isOrderMail(mail({ subject: "Teklif İsteği (16:00 26.09.2026) - 1", bodyText: "SİP no: 123" }))).toBe(false);
    expect(isOrderMail(mail({ subject: "Toplantı hk.", bodyText: "Sipariş no 4500012345" }))).toBe(false);
    expect(isOrderMail(mail({ subject: "Sipahi Makine" }))).toBe(false);
  });
  it("ek adında SİP geçen mail sipariş mailidir", () => {
    const m = mail({
      subject: "Bilgi",
      otherAttachments: [{ filename: "SIP_4500012345.xlsx", mimeType: "", size: 1, mailId: "m1", data: new Uint8Array() }],
    });
    expect(isOrderMail(m)).toBe(true);
  });
  it("iptal maili ayrıca tanınır ve sipariş sayılmaz", () => {
    const m = mail({ subject: "Sipariş İptal Bildirimi" });
    expect(isCancelMail(m)).toBe(true);
    expect(isOrderMail(m)).toBe(false);
  });
});

describe("SİP kod çıkarma doğruluğu", () => {
  it("parça kodlarını alır; tarih, saat, telefon ve sipariş no gibi salt sayıları almaz", () => {
    const keys = extractOrderKeys(
      "Sipariş No: 4500012345 Tarih: 02.10.2026 14:30 Tel: 0222 246 01 63\nFU00314268/B-03 20 AD\nFTM 30002337 5 AD\nFE026BF3736",
    );
    expect(keys).toContain("00314268_B");
    expect(keys).toContain("00314268");
    expect(keys).toContain("30002337");
    expect(keys).toContain("E026BF3736");
    expect(keys).not.toContain("4500012345");
    expect(keys).not.toContain("2222460163");
    expect(keys.some((k) => k.includes("2026"))).toBe(false);
  });
  it("kalem ve sipariş kodu aynı anahtarlara indirgenir (revizyon ve önek farkı tolere edilir)", () => {
    expect(itemMatchKeys("FU00314268/B-03")).toEqual(expect.arrayContaining(["00314268_B", "00314268"]));
    expect(itemMatchKeys("U00314268_B")).toContain("00314268");
    expect(itemMatchKeys("FTM30002337")).toContain("30002337");
  });
  it("tablo varsa yalnızca malzeme sütunu kullanılır; alıntılanan eski yazışma yok sayılır", () => {
    const m = mail({
      subject: "SİP 4500012345",
      table: {
        headers: ["Sipariş No", "Malzeme", "Miktar"],
        rows: [["4500012345", "FU00314268/B-03", "5"]],
        codeCol: 1,
        qtyCol: 2,
        source: "html",
      },
      bodyText: "FU00999999/A-03 (tabloda yok, sayılmamalı)",
    });
    const keys = orderKeysFromMail(m);
    expect(keys).toContain("00314268");
    expect(keys).not.toContain("00999999");
    expect(stripQuotedReply("SİP: FU00111111/A-03\n\n27.09.2026 tarihinde Tuğçe yazdı:\n> FU00222222/A-03")).not.toContain("00222222");
  });
});

describe("Kaldı / Kalmadı zaman kuralları", () => {
  const day = 24 * 60 * 60 * 1000;
  const reqTime = Date.UTC(2026, 8, 26, 13, 0);
  const index = new OrderIndex([
    { date: reqTime + 3 * day, subject: "SİP", from: "t@e.com", cancel: false, keys: ["00314268"] },
  ]);
  it("teklif isteğinden SONRA gelen SİP'teki kalem kaldı sayılır", () => {
    expect(itemWonBySip(["00314268_B", "00314268"], reqTime, index, [reqTime])).toBe(true);
  });
  it("SİP'te olmayan kalem kaldı sayılmaz", () => {
    expect(itemWonBySip(["00999999"], reqTime, index, [reqTime])).toBe(false);
  });
  it("teklif isteğinden ÖNCE gelmiş eski SİP yeni teklifi yeşil yapmaz", () => {
    expect(itemWonBySip(["00314268"], reqTime + 10 * day, index, [reqTime + 10 * day])).toBe(false);
  });
  it("aynı parça daha yeni bir istekte tekrar sorulduysa SİP en yakın önceki isteğe aittir", () => {
    const newer = reqTime + 1 * day;
    expect(itemWonBySip(["00314268"], reqTime, index, [reqTime, newer])).toBe(false);
    expect(itemWonBySip(["00314268"], newer, index, [reqTime, newer])).toBe(true);
  });
  it("Kalmadı için bekleme süresi 48 saattir", () => {
    expect(LOST_AFTER_MS).toBe(48 * 60 * 60 * 1000);
  });
});
