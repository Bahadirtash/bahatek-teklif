import { describe, expect, it } from "vitest";
import { cleanSubject, dayOf, gmailComposeUrl, parsePrice } from "../src/format";

describe("fiyat girişi", () => {
  it("Türkçe ve noktalı yazımları doğru okur", () => {
    expect(parsePrice("12,5")).toBe(12.5);
    expect(parsePrice("12.5")).toBe(12.5);
    expect(parsePrice("12.50")).toBe(12.5);
    expect(parsePrice("1.250")).toBe(1250);
    expect(parsePrice("1.250,50")).toBe(1250.5);
    expect(parsePrice("1250")).toBe(1250);
    expect(parsePrice(" 85 TL ")).toBe(85);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice("1,2,3")).toBeNull();
  });
});

describe("konu ve tarih", () => {
  it("klasör adı için konuyu sadeleştirir", () => {
    expect(cleanSubject("Fwd: Teklif İsteği (16:00 26.09.2026) - 1")).toBe("Teklif İsteği (16:00 26.09.2026)");
    expect(cleanSubject("FW: İlt: Teklif İsteği")).toBe("Teklif İsteği");
    expect(cleanSubject("")).toBe("");
  });

  it("mail tarih satırından gün üretir", () => {
    expect(dayOf("26 Eyl 2026 Cmt, 16:40")).toBe("26.09.2026");
    expect(dayOf("Tue, 29 Sep 2026 21:53:10 +0300")).toBe("29.09.2026");
    expect(dayOf("Teklif İsteği (16:00 26.09.2026)")).toBe("26.09.2026");
    expect(dayOf("")).toBeNull();
  });

  it("Gmail yeni mail bağlantısı: konu Re: ..., gövde sabit metin", () => {
    const url = new URL(gmailComposeUrl({ to: "tugce@bfirma.com.tr", subject: "Teklif İsteği (16:00 26.09.2026) - 1" }));
    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect(url.searchParams.get("view")).toBe("cm");
    expect(url.searchParams.get("to")).toBe("tugce@bfirma.com.tr");
    expect(url.searchParams.get("su")).toBe("Re: Teklif İsteği (16:00 26.09.2026) - 1");
    expect(url.searchParams.get("body")).toBe("Sn. İlgili;\n\nTeklifiniz ektedir.");
  });
});
