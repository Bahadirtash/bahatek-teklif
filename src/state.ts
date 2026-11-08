// Uygulama durumu ve kalıcı kayıtlar (ayarlar, fiyatlar, hazırlanan teklifler, oturum).
import { defaultArchiveRoot, storeRead, storeWrite } from "./backend";
import type { ParsedMail, QuoteRequest } from "./eml";
import type { OrderMailRecord } from "./orders";

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
  gmailOrderDays: number;
  /** Firmalar dışında SİP / EBA maili gönderebilecek ek adresler (ör. eba@firma.com.tr). */
  orderSenders: string[];
  autostartInitialized: boolean;
  /** Kayıt şeması sürümü (tek seferlik geçişler için). */
  dataVersion: number;
}

export type Result = "won" | "lost" | null;
/** Kalem bazında elle verilen durum. */
export type ItemManual = "won" | "lost" | "wait";

export interface OfferInfo {
  path: string;
  at: string;
  /** Yalnızca kullanıcının elle seçtiği sonuç (manual=true). Otomatik sonuç kaydedilmez, hesaplanır. */
  result: Result;
  manual?: boolean;
}

export interface PriceHistoryEntry {
  id: string;
  requestId: string;
  code: string;
  normCode: string;
  key: string;
  baseKey: string;
  description: string;
  qty: number | null;
  price: number;
  date: string;
  firm: string;
  subject?: string;
  /** Eski sürümlerden kalma alan; artık kullanılmaz (sonuç her seferinde hesaplanır). */
  result?: Result;
  source?: "live" | "offer" | "archive" | "kalemler";
}

export interface OrdersStore {
  /** Görülmüş sipariş / iptal mailleri: mailId → hafif özet (mail Gmail penceresinden çıksa da unutulmaz). */
  mails: Record<string, OrderMailRecord>;
  /** Kalem bazında elle verilen sonuçlar: "requestId|normKod" → won / lost / wait */
  itemResults: Record<string, ItemManual>;
}

/** requestId → (kalem anahtarı → kullanıcının yazdığı fiyat metni) */
export type Prices = Record<string, Record<string, string>>;
export type Offers = Record<string, OfferInfo>;
export type HistoryMap = Record<string, PriceHistoryEntry>;

export interface Session {
  emlPaths: string[];
}

export const DATA_VERSION = 4;
export const DEFAULT_GMAIL_DAYS = 3;
export const DEFAULT_ORDER_DAYS = 30;

export const state = {
  settings: null as unknown as Settings,
  prices: {} as Prices,
  offers: {} as Offers,
  history: {} as HistoryMap,
  orders: { mails: {}, itemResults: {} } as OrdersStore,
  session: { emlPaths: [] } as Session,
  mails: new Map<string, ParsedMail>(),
  requests: [] as QuoteRequest[],
  selectedRequest: null as string | null,
  selectedItem: -1,
};

/**
 * v2.3.0 → v2.4.0 tek seferlik temizlik:
 * - zorla 60/90 güne çıkarılan Gmail süreleri 3/30 güne döner,
 * - kirlenmiş SİP kod havuzu (tokens) atılır, yeniden ve doğru biçimde kurulur,
 * - otomatik yazılmış (elle seçilmemiş) Kazanıldı/Kalmadı sonuçları ve sahte teklif kayıtları silinir.
 * Fiyatlar, hazırlanan teklif dosyaları ve fiyat hafızası KORUNUR.
 * Dönüş: geçiş yapıldıysa true (çağıran disk e-posta önbelleğini de temizler).
 */
export async function loadState(): Promise<boolean> {
  const s = await storeRead<Partial<Settings>>("settings");
  const migrate = (s?.dataVersion ?? 0) < DATA_VERSION;
  let gmailDays = s?.gmailDays ?? DEFAULT_GMAIL_DAYS;
  let orderDays = s?.gmailOrderDays ?? DEFAULT_ORDER_DAYS;
  if (migrate) {
    if (gmailDays === 60 || gmailDays > 30) gmailDays = DEFAULT_GMAIL_DAYS;
    if (orderDays === 90 || orderDays > 90) orderDays = DEFAULT_ORDER_DAYS;
  }
  state.settings = {
    archiveRoot: s?.archiveRoot || (await defaultArchiveRoot()),
    firms: s?.firms ?? [],
    fullList: s?.fullList ?? {},
    gmailAccount: s?.gmailAccount ?? null,
    gmailDays: Math.max(1, Math.min(30, gmailDays)),
    gmailOrderDays: Math.max(1, Math.min(90, orderDays)),
    orderSenders: s?.orderSenders ?? [],
    autostartInitialized: s?.autostartInitialized ?? false,
    dataVersion: DATA_VERSION,
  };
  state.prices = (await storeRead<Prices>("prices")) ?? {};
  state.offers = (await storeRead<Offers>("offers")) ?? {};
  state.history = (await storeRead<HistoryMap>("history")) ?? {};
  const loadedOrders = await storeRead<Partial<OrdersStore> & { tokens?: unknown }>("orders");
  state.orders = {
    mails: migrate ? {} : loadedOrders?.mails ?? {},
    itemResults: (loadedOrders?.itemResults as Record<string, ItemManual>) ?? {},
  };
  state.session = (await storeRead<Session>("session")) ?? { emlPaths: [] };

  if (migrate) {
    for (const [id, o] of Object.entries(state.offers)) {
      if (o.manual) continue;
      if (!o.path) delete state.offers[id]; // v2.3.0'ın otomatik oluşturduğu sahte kayıt
      else o.result = null; // otomatik sonuç; artık hesaplanıyor
    }
    for (const [k, v] of Object.entries(state.orders.itemResults)) {
      if (v !== "won" && v !== "lost" && v !== "wait") delete state.orders.itemResults[k];
    }
    for (const h of Object.values(state.history)) delete h.result;
    persist("settings");
    persist("offers");
    persist("orders");
    persist("history");
  }
  return migrate;
}

const timers: Record<string, number> = {};
/** Sık değişen kayıtlar (fiyatlar, hafıza) için kısa gecikmeli yazma. */
export function persist(name: "settings" | "prices" | "offers" | "session" | "history" | "orders", delay = 0): void {
  clearTimeout(timers[name]);
  const write = () => storeWrite(name, state[name]).catch((e) => console.error(`${name} kaydedilemedi`, e));
  if (delay) timers[name] = window.setTimeout(write, delay);
  else write();
}

export function itemKey(index: number, code: string): string {
  return `${index}:${code}`;
}

/**
 * Kesin gönderici eşleşmesi:
 * - kural tam adresse (a@b.com) YALNIZCA o adres eşleşir (alan adına genişletilmez),
 * - kural alan adıysa (b.com) o alan adı ve alt alan adları eşleşir.
 */
export function senderMatches(address: string, rule: string): boolean {
  const a = (address || "").trim().toLowerCase();
  const r = (rule || "").trim().toLowerCase().replace(/^@/, "");
  if (!a || !r) return false;
  if (r.includes("@")) return a === r;
  const domain = a.split("@")[1] ?? "";
  return a === r || domain === r || domain.endsWith(`.${r}`);
}

/** Tüm firma izin kuralları (boşlar atılmış). */
export function allFirmRules(): string[] {
  return state.settings.firms.flatMap((f) => f.match).map((m) => m.trim()).filter(Boolean);
}

/** Mailin göndereni (veya ileteni) firma izin listesinde mi? */
export function mailFromAllowedFirm(m: ParsedMail): boolean {
  const rules = allFirmRules();
  const addrs = [m.sender.address, m.forwardedBy?.address ?? ""].filter(Boolean);
  return addrs.some((a) => rules.some((r) => senderMatches(a, r)));
}

/** Sipariş maili için izinli gönderen mi? (firma kuralları + ek SİP/EBA gönderenleri) */
export function mailFromAllowedOrderSender(m: ParsedMail): boolean {
  if (mailFromAllowedFirm(m)) return true;
  const extra = state.settings.orderSenders.map((x) => x.trim()).filter(Boolean);
  const addrs = [m.sender.address, m.forwardedBy?.address ?? ""].filter(Boolean);
  return addrs.some((a) => extra.some((r) => senderMatches(a, r)));
}

export function firmOf(req: QuoteRequest): Firm | null {
  const addrs = [req.sender.address, ...req.mails.map((m) => m.forwardedBy?.address ?? "")].filter(Boolean);
  return state.settings.firms.find((f) => f.match.some((m) => addrs.some((a) => senderMatches(a, m)))) ?? null;
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
