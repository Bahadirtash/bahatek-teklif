import { describe, expect, it } from "vitest";
import { parseTurkishDateMs } from "../src/dates";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe("parseTurkishDateMs", () => {
  it("Outlook TR biçimi", () => {
    expect(parseTurkishDateMs("26 Eylül 2026 Cumartesi 14:32")).toBe(at(2026, 8, 26, 14, 32));
  });
  it("Gmail TR biçimi", () => {
    expect(parseTurkishDateMs("26 Eyl 2026 Cmt, saat 14:32")).toBe(at(2026, 8, 26, 14, 32));
  });
  it("gün adı önde", () => {
    expect(parseTurkishDateMs("Cmt, 26 Eyl 2026 14:32")).toBe(at(2026, 8, 26, 14, 32));
  });
  it("Türkçe karakterli aylar", () => {
    expect(parseTurkishDateMs("3 Şubat 2026 09:05")).toBe(at(2026, 1, 3, 9, 5));
    expect(parseTurkishDateMs("15 Ağu 2026 Cmt 08:00")).toBe(at(2026, 7, 15, 8, 0));
    expect(parseTurkishDateMs("1 ARALIK 2026 10:00")).toBe(at(2026, 11, 1, 10, 0));
  });
  it("saat yoksa öğlen kabul edilir", () => {
    expect(parseTurkishDateMs("5 Kasım 2026")).toBe(at(2026, 10, 5, 12, 0));
  });
  it("İngilizce ve geçersiz tarihleri okumaz", () => {
    expect(parseTurkishDateMs("Sat, 26 Sep 2026 16:40:00 +0300")).toBe(0);
    expect(parseTurkishDateMs("31 Şubat 2026")).toBe(0);
    expect(parseTurkishDateMs("")).toBe(0);
  });
});
