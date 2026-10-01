// Uygulama durumu ve kalıcı kayıtlar (ayarlar, fiyatlar, hazırlanan teklifler, oturum).
import { defaultArchiveRoot, storeRead, storeWrite } from "./backend";
import type { ParsedMail, QuoteRequest } from "./eml";

export interface Firm {
  id: string;
  name: string;
  /** İzin listesi: tam adres (a@b.com) veya alan adı (b.com). */
  match: string[];
}

export interface Settings {
  archiveRoot: string;
  firms: Firm[];
  /** "Tam liste" seçimi, firma bazında. */
  fullList: Record<string, boolean>;
  gmailAccount: string | null;
  gmailDays: number;
  autostartInitialized: boolean;
}

export type Result = "won" | "lost" | null;

export interface OfferInfo {
  path: string;
  at: string;
  result: Result;
}

/** requestId → (kalem anahtarı → kullanıcının yazdığı fiyat metni) */
export type Prices = Record<string, Record<string, string>>;
export type Offers = Record<string, OfferInfo>;

export interface Session {
  emlPaths: string[];
}

export const state = {
  settings: null as unknown as Settings,
  prices: {} as Prices,
  offers: {} as Offers,
  session: { emlPaths: [] } as Session,
  mails: new Map<string, ParsedMail>(),
  requests: [] as QuoteRequest[],
  selectedRequest: null as string | null,
  selectedItem: -1,
};

export async function loadState(): Promise<void> {
  const s = await storeRead<Partial<Settings>>("settings");
  state.settings = {
    archiveRoot: s?.archiveRoot || (await defaultArchiveRoot()),
    firms: s?.firms ?? [],
    fullList: s?.fullList ?? {},
    gmailAccount: s?.gmailAccount ?? null,
    gmailDays: s?.gmailDays ?? 30,
    autostartInitialized: s?.autostartInitialized ?? false,
  };
  state.prices = (await storeRead<Prices>("prices")) ?? {};
  state.offers = (await storeRead<Offers>("offers")) ?? {};
  state.session = (await storeRead<Session>("session")) ?? { emlPaths: [] };
}

const timers: Record<string, number> = {};
/** Sık değişen kayıtlar (fiyatlar) için kısa gecikmeli yazma. */
export function persist(name: "settings" | "prices" | "offers" | "session", delay = 0): void {
  clearTimeout(timers[name]);
  const write = () => storeWrite(name, state[name]).catch((e) => console.error(`${name} kaydedilemedi`, e));
  if (delay) timers[name] = window.setTimeout(write, delay);
  else write();
}

export function itemKey(index: number, code: string): string {
  return `${index}:${code}`;
}

export function senderMatches(address: string, rule: string): boolean {
  const a = address.toLowerCase();
  const r = rule.trim().toLowerCase().replace(/^@/, "");
  if (!r) return false;
  if (r.includes("@")) return a === r;
  const domain = a.split("@")[1] ?? "";
  return domain === r || domain.endsWith(`.${r}`);
}

export function firmOf(req: QuoteRequest): Firm | null {
  return state.settings.firms.find((f) => f.match.some((m) => senderMatches(req.sender.address, m))) ?? null;
}

/** İzin listesinde olmayan gönderen için geçici firma anahtarı/adı. */
export function firmKey(req: QuoteRequest): string {
  return firmOf(req)?.id ?? `sender:${req.sender.address}`;
}

const PUBLIC_DOMAINS = ["gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "yandex.com", "yandex.com.tr", "icloud.com", "msn.com"];

/** Herkese açık posta servisi: firma alan adı değil, kişinin adresi eşleştirilmeli. */
export function isPublicDomain(domain: string): boolean {
  return PUBLIC_DOMAINS.includes(domain.toLowerCase());
}

export function suggestFirmName(address: string, personName = ""): string {
  const [local, domain = ""] = address.split("@");
  if (!domain || isPublicDomain(domain)) return personName.trim() || local || address;
  return (domain.split(".")[0] ?? domain).toLocaleUpperCase("tr");
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
