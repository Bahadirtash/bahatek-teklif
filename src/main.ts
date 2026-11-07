// Bahatek Teklif arayüzü — prototype/teklif-prototip.html görünümü ve akışı, gerçek veriyle.
import * as backend from "./backend";
import { groupMails, parseEml } from "./eml";
import { baseCodeKey, codeKey, extractTokens, normTr, normalizeCodeStr } from "./eml/codes";
import type { Drawing, Item, ParsedMail, QuoteRequest } from "./eml";
import { cleanSubject, dayOf, esc, formatMoney, gmailComposeUrl, parsePrice, todayDotted } from "./format";
import { renderCrop, renderFullPage, extractPdfInfo, extractPdfRawText } from "./pdf/render";
import {
  firmKey, firmOf, isPublicDomain, itemKey, loadState, newId, persist, state, suggestFirmName,
} from "./state";
import type { Firm, PriceHistoryEntry, Result } from "./state";
import { check } from "@tauri-apps/plugin-updater";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- yardımcılar

let toastTimer = 0;
function toast(msg: string, ms = 3500): void {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.style.display = "none"), ms);
}

function openModal(html: string, wide = false): HTMLElement {
  const box = $("mb");
  box.className = wide ? "box wide" : "box";
  box.innerHTML = html;
  $("md").style.display = "flex";
  return box;
}

function closeModal(): void {
  $("md").style.display = "none";
  $("mb").innerHTML = "";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function currentRequest(): QuoteRequest | null {
  return state.requests.find((r) => r.id === state.selectedRequest) ?? null;
}

export function priceText(req: QuoteRequest, item: Item): string {
  return state.prices[req.id]?.[itemKey(item.index, item.code)] ?? "";
}

export function priceOf(req: QuoteRequest, item: Item): number | null {
  const p = parsePrice(priceText(req, item));
  return p != null && p > 0 ? p : null;
}

function descCol(req: QuoteRequest): number {
  const byName = req.headers.findIndex((h) => /tan[ıi]m|a[cç][ıi]klama/i.test(h));
  if (byName >= 0) return byName;
  return req.codeCol + 1 < req.headers.length ? req.codeCol + 1 : req.codeCol;
}

function requestTitle(req: QuoteRequest): string {
  return cleanSubject(req.subject) || `Teklif isteği ${dayOf(req.date) ?? ""}`.trim();
}

function firmName(req: QuoteRequest): string {
  return firmOf(req)?.name ?? suggestFirmName(req.sender.address, req.sender.name);
}

function statusLabel(item: Item): string {
  return item.status === "ready" ? "Çizim var" : item.status === "waiting" ? "Çizim bekleniyor" : "Çizim gelmedi";
}

/** Tarih metninden veya "(16:00 26.09.2026)" etiketinden milisaniye zaman damgası üretir */
function parseMailDateMs(dateStr?: string | null, tag?: string | null): number {
  if (tag) {
    const m = /(\d{1,2})[:.](\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(tag);
    if (m) {
      const d = new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3]), Number(m[1]), Number(m[2]));
      if (!isNaN(d.getTime())) return d.getTime();
    }
  }
  if (dateStr) {
    const dotted = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?/.exec(dateStr);
    if (dotted) {
      const d = new Date(
        Number(dotted[3]),
        Number(dotted[2]) - 1,
        Number(dotted[1]),
        Number(dotted[4] ?? 12),
        Number(dotted[5] ?? 0),
      );
      if (!isNaN(d.getTime())) return d.getTime();
    }
    const parsed = Date.parse(dateStr);
    if (!isNaN(parsed)) return parsed;
  }
  return 0;
}

/** Kalıcı Fiyat Hafızasına tek bir kalem kaydı ekler/günceller */
function upsertPriceMemory(entry: PriceHistoryEntry, saveNow = false): void {
  if (!entry.code || !(entry.price > 0)) return;
  const existing = state.history[entry.id];
  if (existing && existing.result && !entry.result) {
    entry.result = existing.result;
  }
  state.history[entry.id] = entry;
  if (saveNow) persist("history", 400);
}

/** Mevcut state.prices ve state.requests içindeki tüm fiyatlanmış kalemleri kalıcı hafızaya senkronize eder */
function syncMemoryFromCurrentState(): void {
  let changed = false;
  for (const req of state.requests) {
    const reqPrices = state.prices[req.id];
    if (!reqPrices) continue;
    const dc = descCol(req);
    const offer = state.offers[req.id];
    const isoDate = offer?.at || (parseMailDateMs(req.date, req.requestTag) ? new Date(parseMailDateMs(req.date, req.requestTag)).toISOString() : new Date().toISOString());
    for (const it of req.items) {
      const raw = reqPrices[itemKey(it.index, it.code)];
      const p = raw ? parsePrice(raw) : null;
      if (p != null && p > 0) {
        const id = `${req.id}|${normalizeCodeStr(it.code)}`;
        upsertPriceMemory({
          id,
          requestId: req.id,
          code: it.code,
          normCode: normalizeCodeStr(it.code),
          key: codeKey(it.code) ?? normalizeCodeStr(it.code),
          baseKey: baseCodeKey(it.code),
          description: it.cells[dc] ?? "",
          qty: it.qty,
          price: p,
          date: isoDate,
          firm: firmName(req),
          subject: req.subject,
          result: offer?.result ?? null,
          source: offer ? "offer" : "live",
        });
        changed = true;
      }
    }
  }
  // Ayrıca state.requests'te henüz yüklü olmasa bile state.prices içinde kayıtlı tüm geçmiş fiyatları da hafızaya al
  for (const [rId, priceMap] of Object.entries(state.prices)) {
    const offer = state.offers[rId];
    const isoDate = offer?.at || new Date().toISOString();
    for (const [k, valStr] of Object.entries(priceMap)) {
      const p = parsePrice(valStr);
      if (p == null || p <= 0) continue;
      const colonIdx = k.indexOf(":");
      const code = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
      if (!code) continue;
      const id = `${rId}|${normalizeCodeStr(code)}`;
      if (!state.history[id]) {
        upsertPriceMemory({
          id,
          requestId: rId,
          code,
          normCode: normalizeCodeStr(code),
          key: codeKey(code) ?? normalizeCodeStr(code),
          baseKey: baseCodeKey(code),
          description: "",
          qty: null,
          price: p,
          date: isoDate,
          firm: rId.split("|")[0] ?? "",
          result: offer?.result ?? null,
          source: "live",
        });
        changed = true;
      }
    }
  }
  if (changed) persist("history", 500);
}

/** kayit/kalemler.json ve Teklif Arşivi klasöründeki tüm .xlsx dosyalarını tarayıp hafızaya alır */
async function syncExternalMemory(): Promise<number> {
  let added = 0;
  try {
    const recorded = await backend.readRecordedItems();
    for (const rec of recorded) {
      const code = String(rec.code ?? "").trim();
      const price = Number(rec.price ?? 0);
      if (!code || !(price > 0)) continue;
      const rId = String(rec.requestId ?? "kayit");
      const id = `${rId}|${normalizeCodeStr(code)}`;
      upsertPriceMemory({
        id,
        requestId: rId,
        code,
        normCode: normalizeCodeStr(code),
        key: codeKey(code) ?? normalizeCodeStr(code),
        baseKey: baseCodeKey(code),
        description: String(rec.description ?? ""),
        qty: rec.qty != null ? Number(rec.qty) : null,
        price,
        date: String(rec.date || new Date().toISOString()),
        firm: String(rec.firm ?? ""),
        subject: String(rec.subject ?? ""),
        result: (rec.result === "won" || rec.result === "lost") ? rec.result : null,
        source: "kalemler",
      });
      added++;
    }
  } catch (e) {
    console.warn("kalemler.json okunamadı", e);
  }

  try {
    const archived = await backend.scanArchiveOffers(state.settings.archiveRoot);
    for (const item of archived) {
      const code = item.code.trim();
      if (!code || !(item.price > 0)) continue;
      const rId = `archive:${item.firm}/${item.folder}`;
      const id = `${rId}|${normalizeCodeStr(code)}`;
      if (!state.history[id]) {
        upsertPriceMemory({
          id,
          requestId: rId,
          code,
          normCode: normalizeCodeStr(code),
          key: codeKey(code) ?? normalizeCodeStr(code),
          baseKey: baseCodeKey(code),
          description: item.description,
          qty: item.qty,
          price: item.price,
          date: item.date,
          firm: item.firm,
          subject: item.folder,
          result: null,
          source: "archive",
        });
        added++;
      }
    }
  } catch (e) {
    console.warn("Teklif arşivi taranamadı", e);
  }

  if (added > 0) persist("history", 300);
  return added;
}

export interface PreviousPriceInfo {
  price: number;
  date: string;
  qty?: number;
  result?: Result;
  code?: string;
  firm?: string;
  count?: number;
}

/** Bir parça kodu için daha önce verilmiş en güncel fiyat teklifini (1 gün, 1 hafta, 1 yıl önceki dahil) bulur */
export function getPreviousPrice(req: QuoteRequest, code: string, desc = ""): PreviousPriceInfo | null {
  const norm = normalizeCodeStr(code);
  const cKey = codeKey(code) ?? norm;
  const bKey = baseCodeKey(code);
  const targetTokens = extractTokens(code + " " + desc).filter((t) => t.length >= 6);

  const candidates: { tier: number; time: number; info: PreviousPriceInfo }[] = [];
  const seenReqCodes = new Set<string>();

  const consider = (
    rId: string,
    candCode: string,
    candDesc: string,
    price: number,
    dateStr: string,
    qty?: number | null,
    result?: Result,
    firm?: string,
  ) => {
    if (rId === req.id || !(price > 0)) return;
    const cNorm = normalizeCodeStr(candCode);
    const dedup = `${rId}|${cNorm}`;
    if (seenReqCodes.has(dedup)) return;

    const candKey = codeKey(candCode) ?? cNorm;
    const candBase = baseCodeKey(candCode);

    let tier = 0;
    if (cNorm === norm || (cKey && candKey === cKey)) {
      tier = 3; // Birebir veya aynı revizyonlu parça kodu
    } else if (bKey && bKey.length >= 5 && candBase === bKey) {
      tier = 2; // Aynı parça numarasının önceki revizyonu
    } else if (targetTokens.length > 0) {
      const cTokens = extractTokens(candCode + " " + candDesc);
      if (targetTokens.some((t) => cTokens.includes(t))) {
        tier = 1; // Açıklama veya gövde içindeki parça numarası eşleşmesi
      }
    }
    if (tier === 0) return;
    seenReqCodes.add(dedup);
    const time = Date.parse(dateStr) || 0;
    candidates.push({
      tier,
      time,
      info: {
        price,
        date: dateStr,
        qty: qty != null ? qty : undefined,
        result: result ?? null,
        code: candCode,
        firm,
      },
    });
  };

  // 1) Kalıcı Hafıza (history.json + kalemler.json + Teklif Arşivi .xlsx taraması)
  for (const h of Object.values(state.history)) {
    const offerRes = state.offers[h.requestId]?.result ?? h.result ?? null;
    consider(h.requestId, h.code, h.description, h.price, h.date, h.qty, offerRes, h.firm);
  }

  // 2) Canlı state.prices (henüz Teklifi Hazırla'ya basılmamış olsa bile dün/bugün girilmiş tüm fiyatlar)
  for (const [rId, prices] of Object.entries(state.prices)) {
    if (rId === req.id || !prices) continue;
    const oldReq = state.requests.find((r) => r.id === rId);
    const offer = state.offers[rId];
    const dateStr =
      offer?.at ||
      (oldReq && parseMailDateMs(oldReq.date, oldReq.requestTag)
        ? new Date(parseMailDateMs(oldReq.date, oldReq.requestTag)).toISOString()
        : new Date().toISOString());

    for (const [k, rawVal] of Object.entries(prices)) {
      const p = parsePrice(rawVal);
      if (p == null || p <= 0) continue;
      const colonIdx = k.indexOf(":");
      const candCode = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
      let qty: number | undefined;
      let candDesc = "";
      if (oldReq) {
        const oldItem = oldReq.items.find((i) => itemKey(i.index, i.code) === k || i.code === candCode);
        if (oldItem) {
          if (oldItem.qty != null) qty = oldItem.qty;
          candDesc = oldItem.cells[descCol(oldReq)] ?? "";
        }
      }
      consider(rId, candCode, candDesc, p, dateStr, qty, offer?.result ?? null, oldReq ? firmName(oldReq) : undefined);
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.tier !== a.tier ? b.tier - a.tier : b.time - a.time));
  const best = candidates[0].info;
  best.count = candidates.length;
  return best;
}

function setPrice(req: QuoteRequest, item: Item, text: string): void {
  const map = (state.prices[req.id] ??= {});
  const key = itemKey(item.index, item.code);
  const trimmed = text.trim();
  if (trimmed) {
    map[key] = trimmed;
    const p = parsePrice(trimmed);
    if (p != null && p > 0) {
      const dc = descCol(req);
      const offer = state.offers[req.id];
      const isoDate =
        offer?.at ||
        (parseMailDateMs(req.date, req.requestTag)
          ? new Date(parseMailDateMs(req.date, req.requestTag)).toISOString()
          : new Date().toISOString());
      upsertPriceMemory(
        {
          id: `${req.id}|${normalizeCodeStr(item.code)}`,
          requestId: req.id,
          code: item.code,
          normCode: normalizeCodeStr(item.code),
          key: codeKey(item.code) ?? normalizeCodeStr(item.code),
          baseKey: baseCodeKey(item.code),
          description: item.cells[dc] ?? "",
          qty: item.qty,
          price: p,
          date: isoDate,
          firm: firmName(req),
          subject: req.subject,
          result: offer?.result ?? null,
          source: offer ? "offer" : "live",
        },
        true,
      );
    }
  } else {
    delete map[key];
    delete state.history[`${req.id}|${normalizeCodeStr(item.code)}`];
    persist("history", 400);
  }
  persist("prices", 400);
}

function totalText(req: QuoteRequest, item: Item): string {
  const p = priceOf(req, item);
  return p != null && item.qty != null ? formatMoney(p * item.qty) : "";
}

type SidebarFilter = "all" | "won" | "lost" | "wait";
let sidebarFilter: SidebarFilter = "all";

/** EBA sipariş / kazanıldı mailleri (SİB, SİP, Sipariş, Kazanıldı...). */
export const ORDER_RE = /(?:^|[^\p{L}\p{N}])(?:S[İIıi]B|S[İIıi]P|S[İIıi]PAR[İIıi][SŞsş]|SATINALMA|SAS|EBA|KAZANILDI|KAZANDINIZ)(?![\p{L}\p{N}])/iu;

const ORDER_NORM_RE = /(?:^|[^A-Z0-9])(SIP|SIB|SIPARIS|ACIK\s*SIPARIS|SATINALMA|SAS|KAZANILDI|KAZANDINIZ|SIPARIS\s*FORMU|SIPARIS\s*ONAY)(?![A-Z0-9])/;
const EBA_NORM_RE = /(?:^|[^A-Z0-9])(EBA|EBASYSTEM|BIMSER|WORKFLOW)(?![A-Z0-9])/;
const CANCEL_NORM_RE = /(?:^|[^A-Z0-9])(IPTAL\s*PARCA|IPTAL\s*EDIL|SIPARIS\s*IPTAL|OLUMSUZ|KAYBEDILDI)(?![A-Z0-9])/;
const QUOTE_REQ_NORM_RE = /TEKLIF\s*ISTEGI/;

/** Bir e-postanın EBA / SİP / Sipariş onay maili olup olmadığını Türkçe-güvenli olarak tespit eder */
export function isOrderMail(m: ParsedMail): boolean {
  const subj = normTr(m.subject);
  const sender = normTr(`${m.sender.address} ${m.sender.name} ${m.forwardedBy?.address ?? ""} ${m.forwardedBy?.name ?? ""}`);
  const body = normTr(m.bodyText ?? "");

  if (CANCEL_NORM_RE.test(subj)) return false;
  if (ORDER_NORM_RE.test(subj)) return true;

  // Eğer konusu doğrudan "Teklif İsteği" değilse ve EBA'dan geliyorsa veya eklerinde/gövdesinde SİP varsa
  if (!QUOTE_REQ_NORM_RE.test(subj)) {
    if (EBA_NORM_RE.test(subj) || EBA_NORM_RE.test(sender)) return true;
    if (m.drawings.some((d) => ORDER_NORM_RE.test(normTr(d.filename)) || EBA_NORM_RE.test(normTr(d.filename)))) return true;
    if (m.otherAttachments.some((a) => ORDER_NORM_RE.test(normTr(a.filename)) || EBA_NORM_RE.test(normTr(a.filename)))) return true;
    if (/(?:SIPARIS\s*NO|SIP\s*NO|ACIK\s*SIPARIS|SATINALMA\s*SIPARISI|EBA\s*BILGILENDIRME|SIPARIS\s*KALEM)/.test(body)) return true;
  }
  return false;
}

/** İptal / olumsuz sonuç maili mi? */
export function isCancelMail(m: ParsedMail): boolean {
  const subj = normTr(m.subject);
  const body = normTr(m.bodyText ?? "");
  return CANCEL_NORM_RE.test(subj) || (!QUOTE_REQ_NORM_RE.test(subj) && CANCEL_NORM_RE.test(body));
}

/** Bir metindeki tüm parça kodlarını ve numaralarını havuza ekler */
function addCodesFromTextToSet(text: string, pool: Set<string>): void {
  if (!text) return;
  for (const tok of extractTokens(text)) {
    if (tok.length >= 5) pool.add(tok);
  }
}

const processedOrderAttachments = new Set<string>();

/** EBA / SİP maillerindeki PDF ve Excel (.xlsx) eklerinin içindeki parça kodlarını arka planda okuyup kalıcı hafızaya kaydeder */
async function scanOrderMailAttachments(m: ParsedMail): Promise<void> {
  const isOrd = isOrderMail(m);
  const isCan = isCancelMail(m);
  if (!isOrd && !isCan) return;
  if (processedOrderAttachments.has(m.id)) return;
  processedOrderAttachments.add(m.id);

  const targetArr = isCan ? (state.orders.canceledTokens ??= []) : state.orders.tokens;
  const set = new Set<string>(targetArr);
  const beforeSize = set.size;

  // 1) Gövde, konu, tablo ve dosya adları
  addCodesFromTextToSet(m.subject, set);
  if (m.bodyText) addCodesFromTextToSet(m.bodyText, set);
  if (m.table) {
    for (const row of m.table.rows) {
      addCodesFromTextToSet(row.join(" "), set);
    }
  }
  for (const d of m.drawings) {
    addCodesFromTextToSet(d.filename, set);
    addCodesFromTextToSet(d.key, set);
    // PDF metin katmanını oku (EBA sipariş formu PDF'leri için)
    const pdfText = await extractPdfRawText(d).catch(() => "");
    if (pdfText) addCodesFromTextToSet(pdfText, set);
  }
  for (const att of [...m.unrecognizedPdfs, ...m.otherAttachments]) {
    addCodesFromTextToSet(att.filename, set);
    if (/\.xlsx$/i.test(att.filename) && att.data) {
      const { extractExcelText } = await import("./excel");
      const xlText = await extractExcelText(att.data).catch(() => "");
      if (xlText) addCodesFromTextToSet(xlText, set);
    } else if (/\.pdf$/i.test(att.filename) && att.data) {
      const fakeDrawing: Drawing = { filename: att.filename, key: att.filename, sheet: 1, data: att.data, mailId: m.id };
      const pdfText = await extractPdfRawText(fakeDrawing).catch(() => "");
      if (pdfText) addCodesFromTextToSet(pdfText, set);
    }
  }

  if (set.size !== beforeSize) {
    if (isCan) state.orders.canceledTokens = [...set];
    else state.orders.tokens = [...set];
    persist("orders", 300);
    renderAll();
  }
}

function offerExcelFilename(req: QuoteRequest): string {
  let dtStr = "";
  if (req.requestTag) {
    const parts = req.requestTag.trim().split(/\s+/);
    if (parts.length >= 2) {
      dtStr = `${parts[1]}_${parts[0].replace(":", ".")}`;
    } else {
      dtStr = req.requestTag.replace(":", ".");
    }
  } else if (req.date) {
    try {
      const d = new Date(req.date);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear();
        const hour = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        dtStr = `${day}.${month}.${year}_${hour}.${min}`;
      }
    } catch {}
  }
  if (!dtStr) {
    dtStr = todayDotted();
  }
  return `Teklif_${dtStr}.xlsx`;
}

// ---------------------------------------------------------------- Excel gibi sütunlar

const COLW_KEY = "bt.colWidths";
const COLHIDE_KEY = "bt.hiddenCols";
const MIN_COL_W = 15;

function loadJson<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}

const colWidths: Record<string, number> = loadJson(COLW_KEY, {});
let hiddenCols: string[] = loadJson(COLHIDE_KEY, []);

function saveColState(): void {
  try {
    localStorage.setItem(COLW_KEY, JSON.stringify(colWidths));
    localStorage.setItem(COLHIDE_KEY, JSON.stringify(hiddenCols));
  } catch {}
}

function hideColumn(name: string): void {
  if (!hiddenCols.includes(name)) hiddenCols.push(name);
  saveColState();
  renderMid();
}

export function showColumns(names: string[]): void {
  hiddenCols = hiddenCols.filter((h) => !names.includes(h));
  saveColState();
  renderMid();
}

/** Sağa yapışık sütunların (Önceki / Birim Fiyat / Toplam) right ofsetlerini hesaplar. */
function updateStickyOffsets(table: HTMLTableElement): void {
  const heads = [...table.querySelectorAll<HTMLTableCellElement>("thead th[data-stk]")]
    .sort((a, b) => Number(a.dataset.stk) - Number(b.dataset.stk));
  let right = 0;
  for (const th of heads) {
    const k = th.dataset.stk!;
    table.querySelectorAll<HTMLElement>(`[data-stk="${k}"]`).forEach((c) => (c.style.right = `${right}px`));
    right += th.offsetWidth;
  }
}

function initResizableColumns(table: HTMLTableElement): void {
  const ths = [...table.querySelectorAll<HTMLTableCellElement>("thead th")];
  // 1) Otomatik düzende ölç, sonra sabit düzene geç (sütunlar artık serbestçe daralır)
  const widths = ths.map((th) => colWidths[th.dataset.col ?? ""] ?? th.offsetWidth);
  ths.forEach((th, i) => (th.style.width = `${widths[i]}px`));
  table.style.tableLayout = "fixed";
  table.style.minWidth = "0";
  table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;

  ths.forEach((th) => {
    if (th.querySelector(".col-resizer")) return;
    const resizer = document.createElement("div");
    resizer.className = "col-resizer";
    resizer.title = "Sürükle: genişlet/daralt · Çift tık: varsayılan";
    th.appendChild(resizer);

    let startX = 0;
    let startWidth = 0;
    let startTable = 0;

    const onMouseMove = (e: MouseEvent) => {
      const w = Math.max(MIN_COL_W, startWidth + (e.clientX - startX));
      th.style.width = `${w}px`;
      table.style.width = `${startTable + (w - startWidth)}px`;
      updateStickyOffsets(table);
    };

    const onMouseUp = () => {
      resizer.classList.remove("resizing");
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (th.dataset.col) {
        colWidths[th.dataset.col] = th.offsetWidth;
        saveColState();
      }
    };

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startWidth = th.offsetWidth;
      startTable = table.offsetWidth;
      resizer.classList.add("resizing");
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    resizer.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (th.dataset.col) delete colWidths[th.dataset.col];
      saveColState();
      renderMid();
    });
  });

  // 2) Sütun gizleme: × ikonu veya sağ tık
  table.querySelectorAll<HTMLElement>("[data-hide]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      hideColumn(b.dataset.hide!);
    };
  });
  table.querySelectorAll<HTMLTableCellElement>("thead th[data-hideable]").forEach((th) => {
    th.oncontextmenu = (e) => {
      e.preventDefault();
      hideColumn(th.dataset.col!);
    };
  });

  updateStickyOffsets(table);
}

/** Önceki fiyat hücresi: yeni fiyat düştüyse yeşil ▼, arttıysa kırmızı ▲, önceki sonuç (✅/❌) rozetiyle. */
function prevCellHtml(req: QuoteRequest, it: Item): string {
  const dc = descCol(req);
  const prev = getPreviousPrice(req, it.code, it.cells[dc] ?? "");
  if (!prev) return `<span class="mu">—</span>`;
  const cur = priceOf(req, it);
  let arrow = "";
  if (cur != null) {
    const diff = cur - prev.price;
    const pct = prev.price ? Math.abs((diff / prev.price) * 100).toFixed(1) : "0";
    if (Math.abs(diff) < 0.005) arrow = `<span class="pv-eq" title="Önceki fiyatla aynı">=</span>`;
    else if (diff < 0) arrow = `<span class="pv-down" title="Önceki fiyattan %${pct} düşük">▼</span>`;
    else arrow = `<span class="pv-up" title="Önceki fiyattan %${pct} yüksek">▲</span>`;
  }
  const resTag =
    prev.result === "won"
      ? `<span title="Önceki teklif SİP ile onaylandı (Kazanıldı)" style="margin-left:3px;font-size:10px;">🟢</span>`
      : prev.result === "lost"
        ? `<span title="Önceki teklif onaylanmadı (Kalmadı)" style="margin-left:3px;font-size:10px;">🔴</span>`
        : "";
  const dateFmt = prev.date ? new Date(prev.date).toLocaleDateString("tr-TR") : "";
  const tipParts = [
    dateFmt,
    prev.qty ? `${prev.qty} adet` : "",
    prev.firm ? prev.firm : "",
    prev.result === "won" ? "Kazanıldı (SİP)" : prev.result === "lost" ? "Kalmadı" : "",
    prev.count && prev.count > 1 ? `(${prev.count} geçmiş kayıt)` : "",
  ].filter(Boolean);
  return `<span class="pv" title="Önceki teklif: ${esc(tipParts.join(" · "))}">${formatMoney(prev.price)}</span>${resTag}${arrow}`;
}

/** Tablonun üstünde her zaman görünen özet barı. */
function summaryHtml(req: QuoteRequest): string {
  const orderedCodes = getOrderedCodesPool();
  let priced = 0;
  let total = 0;
  let wonCount = 0;
  let wonTotal = 0;
  for (const it of req.items) {
    const p = priceOf(req, it);
    const isOrd = isItemOrdered(req, it, orderedCodes);
    if (isOrd) {
      wonCount++;
      if (p != null && it.qty != null) wonTotal += p * it.qty;
    }
    if (p != null) {
      priced++;
      if (it.qty != null) total += p * it.qty;
    }
  }
  const offer = state.offers[req.id];
  const lostCount = priced > wonCount ? priced - wonCount : 0;
  const status = offer?.result === "won"
    ? `<span class="badge-won">✅ Kazanıldı${wonCount > 0 ? ` (${wonCount} SİP Onay${lostCount > 0 ? ` · ${lostCount} Kalmadı` : ""})` : ""}</span>`
    : offer?.result === "lost"
      ? `<span class="badge-lost">❌ Kalmadı / Kaybedildi</span>`
      : offer || priced > 0
        ? `<span class="badge-wait">⏳ Teklif verildi · SİP bekleniyor</span>`
        : `<span class="badge-wait">Hazırlanıyor</span>`;
  const totCls = offer?.result === "won" ? "offer-total-won" : offer?.result === "lost" ? "offer-total-lost" : "";
  const wonTotSpan =
    wonCount > 0 && wonTotal > 0 && wonTotal !== total
      ? `<span>Onaylanan SİP Tutarı: <b class="offer-total-won">${formatMoney(wonTotal)} ₺</b></span>`
      : "";
  return `<span>Toplam Kalem: <b>${req.items.length}</b></span>
    <span>Fiyatlı: <b>${priced}/${req.items.length}</b></span>
    <span>Toplam Teklif: <b class="sum-tot ${totCls}">${formatMoney(total)} ₺</b></span>
    ${wonTotSpan}
    <span>Durum: ${status}</span>`;
}

function regroup(): void {
  // EBA / SİP sipariş maillerinin eklerini arka planda tara
  for (const m of state.mails.values()) {
    if (isOrderMail(m) || isCancelMail(m)) {
      scanOrderMailAttachments(m).catch(() => {});
    }
  }
  state.requests = groupMails([...state.mails.values()]);
  // İstekleri en yeniden en eskiye sırala (hiçbiri silinmez, en güncel üstte durur)
  state.requests.sort((a, b) => {
    const ta = parseMailDateMs(a.date, a.requestTag);
    const tb = parseMailDateMs(b.date, b.requestTag);
    return tb - ta;
  });
  syncMemoryFromCurrentState();
  if (!state.requests.some((r) => r.id === state.selectedRequest)) {
    state.selectedRequest = state.requests[0]?.id ?? null;
    state.selectedItem = -1;
  }
}

async function addEmlFiles(files: backend.LoadedFile[]): Promise<void> {
  if (!files.length) return;
  let ok = 0;
  for (const f of files) {
    $("status").textContent = `Okunuyor: ${f.name}…`;
    try {
      const mail = await parseEml(f.data, `eml:${f.path ?? f.name}`);
      state.mails.set(mail.id, mail);
      await backend.mailCacheWrite(mail.id, f.data);
      if (f.path && !state.session.emlPaths.includes(f.path)) state.session.emlPaths.push(f.path);
      ok++;
    } catch (e) {
      console.error(e);
      toast(`${f.name} okunamadı: ${errText(e)}`);
    }
  }
  persist("session");
  regroup();
  renderAll();
  if (ok) toast(`${ok} e-posta kalıcı hafızaya yüklendi.`);
}

async function restoreSession(): Promise<void> {
  if (!backend.inTauri) return;
  // 1) Kalıcı disk hafızasındaki (hafiza/mailler/) tüm e-postaları yükle (asla silinmez)
  try {
    const cachedIds = await backend.mailCacheList();
    let idx = 0;
    for (const id of cachedIds) {
      if (state.mails.has(id)) continue;
      try {
        if (++idx % 5 === 0) {
          $("status").textContent = `Hafıza yükleniyor: ${idx}/${cachedIds.length}…`;
        }
        const data = await backend.mailCacheRead(id);
        const mail = await parseEml(data, id);
        state.mails.set(mail.id, mail);
      } catch (e) {
        console.warn("hafıza maili okunamadı", id, e);
      }
    }
  } catch (e) {
    console.warn("hafıza listesi alınamadı", e);
  }

  // 2) Oturumdaki .eml dosyalarını yükle ve kalıcı hafızaya yedekle
  for (const path of state.session.emlPaths) {
    const id = `eml:${path}`;
    if (state.mails.has(id)) continue;
    try {
      const data = await backend.readEml(path);
      const mail = await parseEml(data, id);
      state.mails.set(mail.id, mail);
      await backend.mailCacheWrite(mail.id, data);
    } catch (e) {
      console.warn("oturum dosyası açılamadı", path, e);
    }
  }
  regroup();
}

// ---------------------------------------------------------------- Gmail (salt okuma)

let gmail: backend.GmailStatus = { configured: false, connected: false };
let gmailBusy = false;
let gmailLast = "";

function gmailQuery(): string {
  const rawRules = state.settings.firms.flatMap((f) => f.match).map((m) => m.trim()).filter(Boolean);
  const expanded = new Set<string>();
  for (const r of rawRules) {
    expanded.add(r);
    // Kurumsal e-posta ise (örn. tugce.sahin@etimakine.com.tr), aynı kurumsal alan adını da (etimakine.com.tr) ekle ki EBA ve diğer yetkililerin mailleri de gelsin
    if (r.includes("@")) {
      const dom = r.split("@")[1]?.toLowerCase() ?? "";
      if (dom && !isPublicDomain(dom)) expanded.add(dom);
    }
  }
  const since = `newer_than:${Math.max(30, state.settings.gmailDays || 60)}d`;
  return expanded.size ? `from:(${[...expanded].join(" OR ")}) ${since}` : `(teklif OR SİP OR SIP OR sipariş OR EBA) ${since}`;
}

function gmailOrderQuery(): string {
  const days = Math.max(30, state.settings.gmailOrderDays || 90);
  // Not: Gmail arama sözdizimi *eba* gibi başında yıldızlı aramayı desteklemez; doğrudan kelime araması hem göndereni hem konuyu hem ek adını kapsar.
  return `(SİP OR SIP OR SİB OR SIB OR Sipariş OR Siparis OR "Açık Sipariş" OR "Acik Siparis" OR SATINALMA OR Satınalma OR EBA OR eba OR SAS OR KAZANILDI OR "iptal parça") newer_than:${days}d`;
}

async function gmailRefresh(silent = false): Promise<void> {
  if (!gmail.connected || gmailBusy) return;
  gmailBusy = true;
  renderGmailBox();
  try {
    // 1. Firma ve teklif istekleri (kalıcı disk önbelleği sayesinde sadece yeni mailler indirilir)
    const quoteRefs = await backend.gmailList(gmailQuery(), 200);
    // 2. Sipariş / SİP / EBA onay mailleri
    const orderRefs = await backend.gmailList(gmailOrderQuery(), 200);

    const map = new Map<string, { id: string }>();
    for (const r of [...quoteRefs, ...orderRefs]) map.set(r.id, r);
    const refs = Array.from(map.values());

    const fresh = refs.filter((r) => !state.mails.has(`gmail:${r.id}`));
    let n = 0;
    for (const r of fresh) {
      $("status").textContent = `Gmail'den hafızaya alınıyor: ${++n}/${fresh.length}…`;
      const raw = await backend.gmailRaw(r.id);
      const id = `gmail:${r.id}`;
      const mail = await parseEml(raw, id);
      state.mails.set(mail.id, mail);
      // İndirilen her maili kalıcı olarak diske kaydet (bir daha asla kaybolmasın ve tekrar indirilmesin)
      await backend.mailCacheWrite(mail.id, raw);
    }
    gmailLast = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    regroup();
    renderAll();
    if (!silent || fresh.length) toast(fresh.length ? `Gmail: ${fresh.length} yeni e-posta hafızaya kaydedildi.` : "Gmail: yeni e-posta yok.");
  } catch (e) {
    const msg = errText(e);
    if (msg.includes("GMAIL_YENIDEN_BAGLAN")) {
      gmail.connected = false;
      toast("Gmail izninin süresi doldu, lütfen yeniden bağlanın.", 6000);
    } else if (!silent) toast(`Gmail: ${msg}`, 6000);
    console.warn(e);
  } finally {
    gmailBusy = false;
    renderGmailBox();
    renderStatus();
  }
}

async function gmailConnect(): Promise<void> {
  try {
    toast("Tarayıcıda Google izin ekranı açıldı…", 8000);
    const email = await backend.gmailConnect();
    state.settings.gmailAccount = email;
    persist("settings");
    gmail = await backend.gmailStatus();
    toast(`Gmail bağlandı: ${email}`);
    renderGmailBox();
    await gmailRefresh();
  } catch (e) {
    toast(`Gmail bağlantısı yapılamadı: ${errText(e)}`, 7000);
  }
}

function renderGmailBox(): void {
  const box = $("gmailBox");
  if (!gmail.configured) {
    box.innerHTML = "";
    return;
  }
  if (!gmail.connected) {
    box.innerHTML = `<button class="btn" id="gconn">Gmail'e bağlan (salt okuma)</button>`;
    $("gconn").onclick = gmailConnect;
    return;
  }
  box.innerHTML = `<button class="btn" id="gref" ${gmailBusy ? "disabled" : ""}>${gmailBusy ? "Gmail okunuyor…" : "Gmail'den yenile"}</button>
    <div class="gm">Bağlı: ${esc(state.settings.gmailAccount ?? "")}${gmailLast ? ` · son: ${gmailLast}` : ""}</div>`;
  $("gref").onclick = () => gmailRefresh();
}

// ---------------------------------------------------------------- Talaşlı İmalat Hammadde Hesaplayıcı

interface MaterialDef {
  name: string;
  density: number;
}

const MATERIALS_LIST: MaterialDef[] = [
  { name: "İmalat Çeliği (1040 / 1050 / St52)", density: 7.85 },
  { name: "Islah / Takım Çeliği (4140 / 4340 / 2379)", density: 7.85 },
  { name: "Paslanmaz Çelik (304 / 316)", density: 7.93 },
  { name: "Paslanmaz Çelik (420 / 430)", density: 7.75 },
  { name: "Alüminyum (6061 / 7075 / 5083)", density: 2.70 },
  { name: "Pirinç / Otomat (Ms58)", density: 8.45 },
  { name: "Bronz / Fosfor Bronz", density: 8.80 },
  { name: "Bakır (Elektrolitik Saf)", density: 8.96 },
  { name: "Döküm (Pik / GG25 - Sfero / GGG40)", density: 7.20 },
  { name: "Kestamid / Poliamid (PA6)", density: 1.15 },
  { name: "Delrin / POM (Asetal)", density: 1.41 },
  { name: "Teflon / PTFE", density: 2.20 },
  { name: "Polietilen (PE1000 / PE500)", density: 0.95 },
  { name: "Titanyum (Grade 2 / Grade 5)", density: 4.50 },
];

const stockCalcState = {
  shape: "plate" as "plate" | "round",
  density: "7.85",
  pricePerKg: "",
};

function materialOptionsHtml(currentDensity: string): string {
  let matched = false;
  const curNum = parseFloat(currentDensity.replace(",", "."));
  const opts = MATERIALS_LIST.map((m) => {
    const valStr = m.density.toFixed(2);
    const isMatch = !isNaN(curNum) && Math.abs(m.density - curNum) < 0.02;
    const sel = isMatch && !matched ? " selected" : "";
    if (sel) matched = true;
    return `<option value="${valStr}"${sel}>${m.name} (${valStr})</option>`;
  });
  opts.push(`<option value="custom"${!matched ? " selected" : ""}>Özel Malzeme / Serbest...</option>`);
  return opts.join("");
}

function detectMaterialDensity(materialName: string): string {
  const m = materialName.toUpperCase();
  if (/AL[UÜ]M|6061|7075|5083|ALMG/i.test(m)) return "2.70";
  if (/BAK[Iİ]R|CU\b|ECU/i.test(m)) return "8.96";
  if (/P[Iİ]R[Iİ]N[CÇ]|MS\s*58|CW614N|CW617N/i.test(m)) return "8.45";
  if (/BRONZ|RG5|RG7|CUSN/i.test(m)) return "8.80";
  if (/DELR[Iİ]N|POM/i.test(m)) return "1.41";
  if (/KESTAM[Iİ]D|POL[Iİ]AM[Iİ]D|PA\s*6/i.test(m)) return "1.15";
  if (/TEFLON|PTFE/i.test(m)) return "2.20";
  if (/POL[Iİ]ET[Iİ]LEN|PE\s*1000|PE\s*500/i.test(m)) return "0.95";
  if (/T[Iİ]TAN/i.test(m)) return "4.50";
  if (/420|430|1\.4021|1\.4034/i.test(m)) return "7.75";
  if (/304|316|PASLANMAZ|INOX|1\.4301|1\.4404/i.test(m)) return "7.93";
  if (/D[OÖ]K[UÜ]M|PIK|GG|GGG|SFERO/i.test(m)) return "7.20";
  if (/4140|4340|2379|ISLAH|TAKIM|1\.7225/i.test(m)) return "7.85";
  return "7.85";
}

function computeStockWeight(shape: "plate" | "round", dimStr: string, density: number): number {
  if (!dimStr) return 0;
  const clean = dimStr.replace(/,/g, ".").replace(/Ø|ø|dia|d/gi, " ").trim();
  const parts = clean.split(/[xX* \t]+/).map((x) => parseFloat(x.trim())).filter((x) => !isNaN(x) && x > 0);
  if (parts.length === 0) return 0;

  if (shape === "round") {
    // Silindirik / Çap / Yuvarlak Mil: Çap D x Boy L (mm)
    if (parts.length >= 2) {
      const d = parts[0];
      const l = parts[1];
      const r = d / 2;
      const vol = Math.PI * r * r * l; // mm^3
      return (vol * density) / 1000000;
    } else {
      return parts[0]; // Tek sayı girildiyse doğrudan kg
    }
  } else {
    // Kütük / Levha / Lama: En x Boy x Kalınlık (mm)
    if (parts.length >= 3) {
      const vol = parts[0] * parts[1] * parts[2]; // mm^3
      return (vol * density) / 1000000;
    } else if (parts.length === 2) {
      return (parts[0] * parts[1] * density) / 1000000;
    } else {
      return parts[0]; // Tek sayı girildiyse doğrudan kg
    }
  }
}

// ---------------------------------------------------------------- çizim

let prefetchToken = 0;
async function prefetch(req: QuoteRequest): Promise<void> {
  const token = ++prefetchToken;
  for (const item of req.items) {
    if (token !== prefetchToken) return;
    if (item.drawings[0]) await renderCrop(item.drawings[0]).catch(() => {});
  }
}

async function showFullPage(d: Drawing, item: Item | null = null): Promise<void> {
  const req = currentRequest();
  
  let prevText = "";
  if (req && item) {
    const prev = getPreviousPrice(req, item.code);
    if (prev) {
      prevText = `<span style="color:var(--wa); font-weight:600; font-size:14px; margin-right:20px;">Önceki Teklif: ${formatMoney(prev.price)} TL (${prev.qty ? prev.qty + ' adet, ' : ''}${new Date(prev.date).toLocaleDateString("tr-TR")})</span>`;
    }
  }

  const box = openModal(
    `<div class="mhead" style="justify-content: space-between;">
        <h3 style="margin:0">${esc(d.filename)}</h3>
        <div style="display:flex; align-items:center; gap: 16px;">
          <div id="pdf-extra-info"></div>
          
          <div id="stock-calc" style="display:flex; align-items:center; gap:6px; background:var(--bg); padding:4px 8px; border-radius:6px; border:1px solid var(--bd); flex-wrap:wrap;">
            <select id="calc-shape" style="font-size:11.5px; padding:3px 5px; font-weight:600; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
              <option value="plate"${stockCalcState.shape === "plate" ? " selected" : ""}>⬛ Kütük / Levha</option>
              <option value="round"${stockCalcState.shape === "round" ? " selected" : ""}>⚪ Silindirik / Çap</option>
            </select>

            <select id="calc-mat" style="font-size:11.5px; padding:3px 5px; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
              ${materialOptionsHtml(stockCalcState.density)}
            </select>

            <input type="text" id="calc-density" value="${stockCalcState.density}" title="Özgül Ağırlık (g/cm³)" style="width:48px; font-size:11.5px; padding:3px 4px; text-align:center; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);" placeholder="Özgül">

            <input type="text" id="calc-dim" placeholder="${stockCalcState.shape === "round" ? "Çap Ø x Boy (örn: 50x150)" : "En x Boy x Kalınlık (örn: 100x200x20)"}" style="width:175px; font-size:11.5px; padding:3px 6px; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);" title="Ölçüler (mm)">

            <input type="text" id="calc-price" value="${stockCalcState.pricePerKg}" placeholder="₺/kg" inputmode="decimal" style="width:65px; font-size:11.5px; padding:3px 4px; text-align:right; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);" title="Birim Fiyat (₺/kg)">

            <span id="calc-weight" style="font-size:12px; font-weight:600; color:var(--tx); min-width:65px; text-align:right;">0.00 kg</span>

            <span id="calc-res" style="color:#2ecc71; font-weight:bold; font-size:13px; min-width:75px; text-align:right;">0,00 ₺</span>

            <button class="btn sm" id="btn-apply-calc" title="Hesaplanan malzeme maliyetini teklif fiyatına kopyala" style="font-size:11px; padding:3px 8px; background:var(--ac); color:#fff; border:none; border-radius:4px; cursor:pointer;">Fiyata Aktar ↵</button>
          </div>

          ${prevText}
          ${item && req ? `
          <div id="md-price">
            <label>Teklif Ver:</label>
            <input type="text" id="pdf-price" inputmode="decimal" placeholder="0,00" value="${esc(priceText(req, item))}">
            <span id="pdf-tot" style="color:#fff; font-weight:600; font-size:15px; margin-left:8px; min-width:80px; text-align:right">${totalText(req, item)}</span>
          </div>` : ""}
          <button class="btn sm" id="zc">Kapat</button>
        </div>
      </div>
      <div class="pageview" id="pv" style="position:relative; overflow:hidden; touch-action:none; cursor:grab;">
         <p class="mu" style="color:#fff;padding:20px">Çizim hazırlanıyor…</p>
      </div>
      <div class="zoom-bar">
        <button class="btn icon" id="zo" title="Uzaklaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6M7 10h6" stroke="currentColor" style="display:none"/><path d="M7 10h6"/></svg>
        </button>
        <button class="btn icon" id="zf" style="font-size:13px; font-weight:600; padding:0 8px">SIĞDIR</button>
        <button class="btn icon" id="zi" title="Yakınlaştır">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6M7 10h6"/></svg>
        </button>
      </div>`,
    true,
  );
  $("zc").onclick = closeModal;
  if (item && req) {
    const pInput = $<HTMLInputElement>("pdf-price");
    if (pInput) {
      pInput.oninput = () => {
        const p = parsePrice(pInput.value);
        const tot = $("pdf-tot");
        if (tot) {
          if (p != null && p > 0) tot.textContent = formatMoney(p * (item.qty || 1)) + " TL";
          else tot.textContent = "—";
        }
      };
      pInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const p = parsePrice(pInput.value);
          if (p != null && p > 0) pInput.value = formatMoney(p);
          setPrice(req, item, pInput.value);
          renderMid();
          renderFooter();

          const next = document.querySelector<HTMLInputElement>(`input[data-i="${item.index + 1}"]`);
          if (next) {
            closeModal();
            openItem(item.index + 1, false);
            const nextItem = req.items[item.index + 1];
            if (nextItem && nextItem.drawings && nextItem.drawings[0]) {
               showFullPage(nextItem.drawings[0], nextItem);
            }
          } else {
            closeModal();
          }
        }
      };
    }
  }

  const calcShape = $<HTMLSelectElement>("calc-shape");
  const calcMat = $<HTMLSelectElement>("calc-mat");
  const calcDensity = $<HTMLInputElement>("calc-density");
  const calcDim = $<HTMLInputElement>("calc-dim");
  const calcPrice = $<HTMLInputElement>("calc-price");
  const calcWeight = $("calc-weight");
  const calcRes = $("calc-res");
  const btnApplyCalc = $("btn-apply-calc");

  const calcStock = () => {
    if (!calcDim || !calcDensity || !calcPrice || !calcWeight || !calcRes) return 0;
    const shape = (calcShape?.value || stockCalcState.shape) as "plate" | "round";
    stockCalcState.shape = shape;
    const density = parseFloat(calcDensity.value.replace(",", ".")) || 7.85;
    stockCalcState.density = calcDensity.value;
    stockCalcState.pricePerKg = calcPrice.value;
    const price = parsePrice(calcPrice.value) || 0;

    const weight = computeStockWeight(shape, calcDim.value, density);
    calcWeight.textContent = weight.toFixed(2) + " kg";
    const totalCost = weight * price;
    calcRes.textContent = formatMoney(totalCost) + " ₺";
    return totalCost;
  };

  extractPdfInfo(d).then((info) => {
    const el = document.getElementById("pdf-extra-info");
    if (el && (info.material || info.weight)) {
      const parts = [];
      if (info.material) parts.push(`Cinsi: ${esc(info.material)}`);
      if (info.weight) parts.push(`Ağırlık: ${esc(info.weight)}`);
      el.innerHTML = `<span style="color:#2ecc71; font-weight:600; font-size:14px; margin-right:15px;">${parts.join(" | ")}</span>`;

      if (info.material && calcDensity && calcMat) {
        const dVal = detectMaterialDensity(info.material);
        calcDensity.value = dVal;
        stockCalcState.density = dVal;
        const curNum = parseFloat(dVal);
        const match = MATERIALS_LIST.find((m) => Math.abs(m.density - curNum) < 0.02);
        if (match) calcMat.value = match.density.toFixed(2);
        else calcMat.value = "custom";
      }

      if (calcDim && info.weight && !calcDim.value) {
        calcDim.value = info.weight;
      }
      calcStock();
    }
  }).catch(() => {});

  if (calcShape) {
    calcShape.onchange = () => {
      stockCalcState.shape = calcShape.value as "plate" | "round";
      if (calcDim) {
        calcDim.placeholder = calcShape.value === "round"
          ? "Çap Ø x Boy (örn: 50x150)"
          : "En x Boy x Kalınlık (örn: 100x200x20)";
      }
      calcStock();
    };
  }

  if (calcMat) {
    calcMat.onchange = () => {
      if (calcMat.value !== "custom" && calcDensity) {
        calcDensity.value = calcMat.value;
        stockCalcState.density = calcMat.value;
      }
      calcStock();
    };
  }

  if (calcDensity) {
    calcDensity.oninput = () => {
      stockCalcState.density = calcDensity.value;
      if (calcMat) {
        const curNum = parseFloat(calcDensity.value.replace(",", "."));
        const match = MATERIALS_LIST.find((m) => !isNaN(curNum) && Math.abs(m.density - curNum) < 0.02);
        if (match) calcMat.value = match.density.toFixed(2);
        else calcMat.value = "custom";
      }
      calcStock();
    };
  }

  if (calcDim) calcDim.oninput = calcStock;
  if (calcPrice) calcPrice.oninput = calcStock;

  if (btnApplyCalc) {
    btnApplyCalc.onclick = () => {
      const cost = calcStock() || 0;
      if (cost > 0) {
        const pInput = $<HTMLInputElement>("pdf-price");
        if (pInput) {
          pInput.value = formatMoney(cost);
          pInput.dispatchEvent(new Event("input"));
          pInput.focus();
        }
      }
    };
  }

  try {
    const page = await renderFullPage(d);
    if (!box.isConnected || $("pv") == null) return;
    const pv = $("pv");
    pv.innerHTML = `<img id="pimg" src="${page.url}" alt="" style="position:absolute; transform-origin: top left; pointer-events:none;">`;
    const img = $<HTMLImageElement>("pimg");
    let zoom = 1; // 1 = sığdır
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    let startX = 0, startY = 0;

    const apply = () => {
      const fit = Math.min(pv.clientWidth / page.width, pv.clientHeight / page.height);
      const w = page.width * fit * zoom;
      const h = page.height * fit * zoom;
      
      const maxX = Math.max(0, w - pv.clientWidth);
      const maxY = Math.max(0, h - pv.clientHeight);
      
      if (w <= pv.clientWidth) offsetX = (pv.clientWidth - w) / 2;
      else offsetX = Math.max(-maxX, Math.min(0, offsetX));
      
      if (h <= pv.clientHeight) offsetY = (pv.clientHeight - h) / 2;
      else offsetY = Math.max(-maxY, Math.min(0, offsetY));

      img.style.width = `${page.width * fit}px`;
      img.style.height = `${page.height * fit}px`;
      img.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    };
    
    setTimeout(apply, 10);
    const ro = new ResizeObserver(apply);
    ro.observe(pv);

    $("zi").onclick = () => { zoom = Math.min(zoom * 1.5, 8); apply(); };
    $("zo").onclick = () => { zoom = Math.max(zoom / 1.5, 0.5); apply(); };
    $("zf").onclick = () => { zoom = 1; apply(); };
    
    pv.onwheel = (e) => {
      e.preventDefault();
      const oldZoom = zoom;
      zoom = Math.min(8, Math.max(0.5, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      
      const rect = pv.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      offsetX = mouseX - (mouseX - offsetX) * (zoom / oldZoom);
      offsetY = mouseY - (mouseY - offsetY) * (zoom / oldZoom);
      
      apply();
    };
    
    pv.onmousedown = (e) => {
      isDragging = true;
      startX = e.clientX - offsetX;
      startY = e.clientY - offsetY;
      pv.style.cursor = "grabbing";
    };
    pv.onmousemove = (e) => {
      if (!isDragging) return;
      offsetX = e.clientX - startX;
      offsetY = e.clientY - startY;
      apply();
    };
    pv.onmouseup = () => {
      isDragging = false;
      pv.style.cursor = "grab";
    };
    pv.onmouseleave = () => {
      isDragging = false;
      pv.style.cursor = "grab";
    };
  } catch (e) {
    const pv = $("pv");
    if (pv) pv.innerHTML = `<p class="err" style="padding:20px">Çizim açılamadı: ${esc(errText(e))}</p>`;
  }
}

// ---------------------------------------------------------------- sol bölme & SİP / EBA Eşleştirme Motoru

/** Tüm sipariş maillerinden (EBA, SİP, SİB, Açık Sipariş Sorgusu vb.) ve kalıcı hafızadan geçen parça kodları havuzu */
function getOrderedCodesPool(): Set<string> {
  const pool = new Set<string>(state.orders.tokens);
  let addedNew = false;

  for (const r of state.requests) {
    const isOrderReq = r.mails.some(isOrderMail);
    if (!isOrderReq) continue;

    for (const it of r.items) {
      if (it.code) {
        const before = pool.size;
        pool.add(normalizeCodeStr(it.code));
        const ck = codeKey(it.code);
        if (ck) pool.add(ck);
        const bk = baseCodeKey(it.code);
        if (bk && bk.length >= 5) pool.add(bk);
        addCodesFromTextToSet(it.code + " " + it.cells.join(" "), pool);
        if (pool.size !== before) addedNew = true;
      }
    }
    for (const m of r.mails) {
      const before = pool.size;
      addCodesFromTextToSet(m.subject, pool);
      if (m.bodyText) addCodesFromTextToSet(m.bodyText, pool);
      if (m.table) {
        for (const row of m.table.rows) {
          addCodesFromTextToSet(row.join(" "), pool);
        }
      }
      for (const d of m.drawings) {
        addCodesFromTextToSet(d.filename, pool);
        addCodesFromTextToSet(d.key, pool);
      }
      for (const att of [...m.unrecognizedPdfs, ...m.otherAttachments]) {
        addCodesFromTextToSet(att.filename, pool);
      }
      if (pool.size !== before) addedNew = true;
    }
  }

  if (addedNew) {
    state.orders.tokens = [...pool];
    persist("orders", 500);
  }
  return pool;
}

function getCanceledCodesPool(): Set<string> {
  const pool = new Set<string>(state.orders.canceledTokens ?? []);
  for (const r of state.requests) {
    if (!r.mails.some(isCancelMail)) continue;
    for (const m of r.mails) {
      addCodesFromTextToSet(m.subject, pool);
      if (m.bodyText) addCodesFromTextToSet(m.bodyText, pool);
      if (m.table) {
        for (const row of m.table.rows) addCodesFromTextToSet(row.join(" "), pool);
      }
    }
  }
  return pool;
}

/** Bir kalemin EBA / SİP sipariş havuzunda onaylanıp onaylanmadığını kontrol eder */
export function isItemOrdered(req: QuoteRequest, it: Item, orderedPool: Set<string>): boolean {
  const manualKey = `${req.id}|${normalizeCodeStr(it.code)}`;
  const manual = state.orders.itemResults?.[manualKey];
  if (manual === "won") return true;
  if (manual === "lost") return false;

  const norm = normalizeCodeStr(it.code);
  if (norm && orderedPool.has(norm)) return true;
  const ck = codeKey(it.code);
  if (ck && orderedPool.has(ck)) return true;
  const bk = baseCodeKey(it.code);
  if (bk && bk.length >= 5 && orderedPool.has(bk)) return true;

  const dc = descCol(req);
  const desc = it.cells[dc] ?? "";
  const tokens = extractTokens(`${it.code} ${desc} ${it.drawings.map((d) => d.filename).join(" ")}`);
  return tokens.some((t) => t.length >= 5 && orderedPool.has(t));
}

function isItemCanceled(req: QuoteRequest, it: Item, canceledPool: Set<string>): boolean {
  if (!canceledPool.size) return false;
  const dc = descCol(req);
  const tokens = extractTokens(`${it.code} ${it.cells[dc] ?? ""}`);
  return tokens.some((t) => t.length >= 5 && canceledPool.has(t));
}

/** En son gelen EBA / SİP sipariş mailinin zaman damgası */
function getLatestOrderMailTimeMs(): number {
  let latest = 0;
  for (const r of state.requests) {
    if (r.mails.some(isOrderMail)) {
      const t = parseMailDateMs(r.date, r.requestTag);
      if (t > latest) latest = t;
    }
  }
  return latest;
}

function renderSidebar(): void {
  const groups = new Map<string, { title: string; firm: Firm | null; people: Map<string, QuoteRequest[]> }>();
  for (const f of state.settings.firms) groups.set(f.id, { title: f.name, firm: f, people: new Map() });

  const now = Date.now();
  const orderedCodes = getOrderedCodesPool();
  const canceledCodes = getCanceledCodesPool();
  const latestOrderTime = getLatestOrderMailTimeMs();
  let offersDirty = false;
  let historyDirty = false;

  let countAll = 0;
  let countWon = 0;
  let countLost = 0;
  let countWait = 0;

  // Önce tüm isteklerin otomatik Kazanıldı (Yeşil) / Kalmadı (Kırmızı) durumlarını değerlendir
  for (const r of state.requests) {
    let pricedCount = 0;
    let wonCount = 0;
    let cancelCount = 0;
    for (const it of r.items) {
      if (priceOf(r, it) != null) pricedCount++;
      if (isItemOrdered(r, it, orderedCodes)) wonCount++;
      if (isItemCanceled(r, it, canceledCodes)) cancelCount++;
    }

    const isDirectOrder = r.mails.some(isOrderMail);
    const isDirectCancel = r.mails.some(isCancelMail);
    let offer = state.offers[r.id];

    const reqTime = parseMailDateMs(r.date, r.requestTag);
    const refTime = offer?.at ? Date.parse(offer.at) || reqTime : reqTime;
    const ageHours = refTime > 0 ? (now - refTime) / (1000 * 60 * 60) : 0;
    const deadlineMs = parseMailDateMs(r.deadline, null);
    const deadlinePassed = deadlineMs > 0 && now > deadlineMs + 4 * 60 * 60 * 1000;
    const newerOrderArrived = latestOrderTime > 0 && refTime > 0 && latestOrderTime > refTime + 2 * 60 * 60 * 1000;

    if (!offer?.manual) {
      if (isDirectOrder || wonCount > 0) {
        // SİP / EBA onayı geldi -> YEŞİL (Kazanıldı)
        if (!offer) {
          offer = state.offers[r.id] = { path: "", at: new Date(refTime || now).toISOString(), result: "won", manual: false };
          offersDirty = true;
        } else if (offer.result !== "won") {
          offer.result = "won";
          offersDirty = true;
        }
      } else if (isDirectCancel || (cancelCount > 0 && pricedCount > 0)) {
        // İptal maili geldi -> KIRMIZI (Kalmadı)
        if (!offer) {
          offer = state.offers[r.id] = { path: "", at: new Date(refTime || now).toISOString(), result: "lost", manual: false };
          offersDirty = true;
        } else if (offer.result !== "lost") {
          offer.result = "lost";
          offersDirty = true;
        }
      } else if (offer || pricedCount > 0) {
        // Fiyat verilmiş / teklif hazırlanmış ama SİP'te çıkmamış:
        // Üzerinden ~18 saat (1 gün) geçtiyse, son teklif tarihi geçtiyse veya daha yeni SİP mailleri geldiyse -> KIRMIZI (Kalmadı)
        if (ageHours >= 18 || deadlinePassed || newerOrderArrived) {
          if (!offer) {
            offer = state.offers[r.id] = { path: "", at: new Date(refTime || now).toISOString(), result: "lost", manual: false };
            offersDirty = true;
          } else if (offer.result !== "lost") {
            offer.result = "lost";
            offersDirty = true;
          }
        }
      }
    }

    // Kalem bazında sonuçları kalıcı fiyat hafızasına işle (Önceki Fiyat sütununda 🟢 / 🔴 görünmesi için)
    for (const it of r.items) {
      const hKey = `${r.id}|${normalizeCodeStr(it.code)}`;
      const hEntry = state.history[hKey];
      if (hEntry) {
        const itemRes: Result = isItemOrdered(r, it, orderedCodes)
          ? "won"
          : offer?.result === "lost" || wonCount > 0
            ? "lost"
            : offer?.result ?? null;
        if (hEntry.result !== itemRes) {
          hEntry.result = itemRes;
          historyDirty = true;
        }
      }
    }

    countAll++;
    if (offer?.result === "won") countWon++;
    else if (offer?.result === "lost") countLost++;
    else countWait++;

    // Sol menü filtre kontrolü (Varsayılan: "all" -> HİÇBİR MAIL GİZLENMEZ VEYA SİLİNMEZ)
    if (sidebarFilter === "won" && offer?.result !== "won") continue;
    if (sidebarFilter === "lost" && offer?.result !== "lost") continue;
    if (sidebarFilter === "wait" && (offer?.result === "won" || offer?.result === "lost")) continue;

    const key = firmKey(r);
    if (!groups.has(key)) groups.set(key, { title: `${suggestFirmName(r.sender.address, r.sender.name)} (izin listesinde yok)`, firm: null, people: new Map() });

    const personName = r.sender.name.trim() || r.sender.address;
    const peopleMap = groups.get(key)!.people;
    if (!peopleMap.has(personName)) peopleMap.set(personName, []);
    peopleMap.get(personName)!.push(r);
  }

  if (offersDirty) persist("offers", 300);
  if (historyDirty) persist("history", 500);

  let html = `<div class="side-filters">
    <button class="side-fbtn ${sidebarFilter === "all" ? "active" : ""}" data-sfilt="all" title="Tüm mailler ve teklifler (Hiçbiri silinmez)">Tümü (${countAll})</button>
    <button class="side-fbtn ${sidebarFilter === "won" ? "active" : ""}" data-sfilt="won" title="EBA / SİP onaylanan yeşil teklifler">🟢 SİP (${countWon})</button>
    <button class="side-fbtn ${sidebarFilter === "lost" ? "active" : ""}" data-sfilt="lost" title="Onaylanmayan / kalmayan kırmızı teklifler">🔴 Kalmadı (${countLost})</button>
    <button class="side-fbtn ${sidebarFilter === "wait" ? "active" : ""}" data-sfilt="wait" title="Açık / sonuç bekleyen teklifler">⏳ Açık (${countWait})</button>
  </div>`;

  if (!groups.size) html += `<h4>Firmalar</h4><div class="empty">Henüz teklif isteği yok.</div>`;
  for (const [key, g] of groups) {
    html += `<h4 class="firm-title" style="cursor:pointer; user-select:none;">${esc(g.title)} <span class="arrow" style="float:right;">▼</span></h4>`;
    html += `<div class="firm-reqs" style="display:block;">`;

    const sortedPeople = Array.from(g.people.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    if (!sortedPeople.length) {
      html += `<div class="req"><small>Bu filtrede kayıt yok</small></div>`;
    }

    for (const [personName, reqs] of sortedPeople) {
      html += `<div style="padding: 4px 8px; font-weight: bold; font-size: 11px; color: var(--ac); margin-top: 4px; border-top: 1px solid var(--bd);">👤 ${esc(personName)}</div>`;
      for (const r of reqs) {
        const offer = state.offers[r.id];
        const isDirectOrder = r.mails.some(isOrderMail);

        let offerTotal = 0;
        let pricedCount = 0;
        let wonCount = 0;
        for (const it of r.items) {
          const p = priceOf(r, it);
          if (p != null) {
            pricedCount++;
            if (it.qty != null) offerTotal += p * it.qty;
          }
          if (isItemOrdered(r, it, orderedCodes)) wonCount++;
        }

        const ready = r.items.filter((i) => i.status === "ready").length;
        const parts = !r.partTotal || !r.partsReceived.length
          ? `${r.mails.length} e-posta${r.partTotal ? ` (${r.partTotal} parçalık istek)` : ""}`
          : r.partsReceived.length >= r.partTotal
            ? `Parça 1–${r.partTotal} birleşti`
            : `Parça ${r.partsReceived.join(", ")} / ${r.partTotal} geldi`;

        const dayStr = dayOf(r.requestTag ?? "") ?? dayOf(r.date) ?? "";
        const bits = [dayStr, parts, `${ready}/${r.items.length} çizim`].filter(Boolean);
        if (r.deadline) bits.push(`son: ${r.deadline.replace(/\.\d{4}/, "")}`);

        const isWon = offer?.result === "won";
        const isLost = offer?.result === "lost";
        let resultBadge = "";
        let totalSpan = "";

        if (offerTotal > 0) {
          totalSpan = `<span class="${isWon ? "offer-total-won" : isLost ? "offer-total-lost" : ""}" style="font-size:12px;">${formatMoney(offerTotal)} ₺</span>`;
        }

        if (isDirectOrder) {
          resultBadge = `<span class="badge-won">📦 EBA/SİP</span>`;
        } else if (isWon) {
          resultBadge = `<span class="badge-won">✅ ${wonCount > 0 && wonCount < r.items.length ? `${wonCount} SİP` : "Kazanıldı"}</span>`;
        } else if (isLost) {
          resultBadge = `<span class="badge-lost">❌ Kalmadı</span>`;
        } else if (pricedCount > 0) {
          resultBadge = `<span class="badge-wait">${pricedCount} fiyatlı</span>`;
        }

        const band = isWon ? "won" : isLost ? "lost" : "";
        const showStatusRow = Boolean(offer || pricedCount > 0 || isDirectOrder);
        const statusLabelText = isDirectOrder
          ? "Sipariş / EBA Maili ✓"
          : offer?.path
            ? "Teklif hazırlandı ✓"
            : pricedCount > 0
              ? `Fiyat verildi (${pricedCount}/${r.items.length})`
              : "Durum";

        html += `<div class="req ${r.id === state.selectedRequest ? "on" : ""} ${band}" data-req="${esc(r.id)}">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:4px;">
            <b>${esc(requestTitle(r))}</b>
            ${resultBadge}
          </div>
          <small>${esc(bits.join(" · "))}</small>
          ${showStatusRow ? `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:3px; gap:4px;">
            <small class="${isLost ? "err" : "ok"}">${statusLabelText} ${totalSpan}</small>
            <select class="res ${isWon ? "res-won" : isLost ? "res-lost" : ""}" data-res="${esc(r.id)}">
              <option value="" ${!offer?.result ? "selected" : ""}>Bekleniyor</option>
              <option value="won" ${isWon ? "selected" : ""}>Kazanıldı (Yeşil)</option>
              <option value="lost" ${isLost ? "selected" : ""}>Kalmadı (Kırmızı)</option>
            </select>
          </div>` : ""}`;
        html += `</div>`;
      }
    }

    html += `</div>`;
    const hasAnyReq = Array.from(g.people.values()).some((arr) => arr.length > 0);
    if (!g.firm && hasAnyReq) {
      html += `<button class="btn sm" data-addfirm="${esc(key)}">Firma olarak ekle</button>`;
    }
  }

  $("firms").innerHTML = html;
  $("arch").textContent = `Arşiv: ${state.settings.archiveRoot}`;
}

function onSidebarClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const filtBtn = t.closest<HTMLElement>("[data-sfilt]");
  if (filtBtn) {
    sidebarFilter = (filtBtn.dataset.sfilt as SidebarFilter) || "all";
    renderSidebar();
    return;
  }
  const firmTitle = t.closest(".firm-title");
  if (firmTitle) {
    const reqsDiv = firmTitle.nextElementSibling as HTMLElement;
    if (reqsDiv) {
      const isHidden = reqsDiv.style.display === "none";
      reqsDiv.style.display = isHidden ? "block" : "none";
      const arrow = firmTitle.querySelector(".arrow");
      if (arrow) arrow.textContent = isHidden ? "▼" : "▶";
    }
    return;
  }

  if (t.closest("select")) return;
  const add = t.closest<HTMLElement>("[data-addfirm]");
  if (add) {
    const req = state.requests.find((r) => firmKey(r) === add.dataset.addfirm);
    if (!req) return;
    const domain = req.sender.address.split("@")[1] ?? req.sender.address;
    const rule = isPublicDomain(domain) ? req.sender.address : domain;
    state.settings.firms.push({ id: newId(), name: suggestFirmName(req.sender.address, req.sender.name), match: [rule] });
    persist("settings");
    renderAll();
    openSettings();
    return;
  }
  const el = t.closest<HTMLElement>("[data-req]");
  if (el && el.dataset.req !== state.selectedRequest) {
    state.selectedRequest = el.dataset.req!;
    state.selectedItem = -1;
    renderAll();
  }
}

function onSidebarChange(e: Event): void {
  const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-res]");
  if (!sel) return;
  const id = sel.dataset.res!;
  const val = (sel.value || null) as Result;
  const offer = (state.offers[id] ??= { path: "", at: new Date().toISOString(), result: val, manual: true });
  offer.result = val;
  offer.manual = Boolean(val);
  persist("offers");
  backend.recordResult(id, offer.result).catch((err) => console.warn(err));
  renderAll();
}

// ---------------------------------------------------------------- orta bölme

function renderMid(): void {
  const mid = $("mid");
  const req = currentRequest();
  if (!req) {
    mid.innerHTML = `<div class="welcome"><b>Teklif isteği bekleniyor</b>
      <p>B firmasının teklif isteği e-postasını (.eml) yükleyin ya da sürükleyip bırakın.${gmail.configured ? " Gmail'e bağlanırsanız istekler otomatik gelir." : ""}</p>
      <button class="btn p" id="wload">E-posta dosyası yükle</button>
      ${gmail.configured && !gmail.connected ? `<button class="btn" id="wgm">Gmail'e bağlan</button>` : ""}</div>`;
    $("wload").onclick = loadClick;
    if ($("wgm")) $("wgm").onclick = gmailConnect;
    return;
  }

  const orderedCodes = getOrderedCodesPool();
  const offer = state.offers[req.id];
  const reqHasAnySipMatch = req.items.some((it) => isItemOrdered(req, it, orderedCodes));

  const qc = req.qtyCol;
  const dc = descCol(req);
  // Gizlenen sütunlar (başlık adına göre, tüm isteklerde geçerli)
  const visible = req.headers.map((_, c) => c).filter((c) => !hiddenCols.includes(req.headers[c]));
  const head = visible.map((c) => {
    const h = req.headers[c];
    return `<th class="${c === qc ? "n" : ""}" data-col="${esc(h)}" data-hideable="1" title="${esc(h)} — sağ tık: gizle"><span class="th-l">${esc(h)}</span><button class="th-x" data-hide="${esc(h)}" title="Sütunu gizle">×</button></th>`;
  }).join("");

  const rows = req.items.map((it) => {
    const isWonItem = isItemOrdered(req, it, orderedCodes) || (offer?.result === "won" && !reqHasAnySipMatch && priceOf(req, it) != null);
    const isLostItem = !isWonItem && priceOf(req, it) != null && (offer?.result === "lost" || reqHasAnySipMatch);
    const rowStateCls = isWonItem ? "row-won" : isLostItem ? "row-lost" : "";
    const sipBadge = isWonItem
      ? `<span class="sip-tag-won" title="EBA / SİP siparişi onaylandı (Tıkla: durumu değiştir)" data-toggle-item="${it.index}">✅ SİP</span>`
      : isLostItem
        ? `<span class="sip-tag-lost" title="Siparişe dönüşmedi / Kalmadı (Tıkla: durumu değiştir)" data-toggle-item="${it.index}">❌ Kalmadı</span>`
        : "";

    const cells = visible.map((c) => {
      const v = it.cells[c] ?? "";
      if (c === req.codeCol) return `<td class="code" title="${esc(v)}"><span class="dot ${it.status}" title="${statusLabel(it)}"></span>${esc(v)}${sipBadge}</td>`;
      if (c === dc) return `<td class="desc" title="${esc(v)}">${esc(v)}</td>`;
      return `<td class="${c === qc ? "n" : ""}" title="${esc(v)}">${esc(v)}</td>`;
    }).join("");
    const pt = priceText(req, it);
    const bad = pt && parsePrice(pt) == null;
    return `<tr class="row ${rowStateCls} ${it.index === state.selectedItem ? "sel" : ""}" data-i="${it.index}">${cells}
      <td class="n stk stk-first" data-stk="2" id="pv${it.index}">${prevCellHtml(req, it)}</td>
      <td class="n stk" data-stk="1"><input data-i="${it.index}" value="${esc(pt)}" inputmode="decimal" placeholder="—" ${bad ? 'style="border-color:var(--er)"' : ""}></td>
      <td class="n tot stk" data-stk="0" id="t${it.index}">${totalText(req, it)}</td></tr>`;
  }).join("");

  const notes: string[] = [];
  if (offer && offer.result === "won") {
    const wonCnt = req.items.filter((it) => isItemOrdered(req, it, orderedCodes)).length;
    notes.push(`<div class="won-banner">✅ <b>SİPARİŞ ONAYLANDI (YEŞİL):</b> ${wonCnt > 0 ? `Bu teklifteki <b>${wonCnt} kalem</b> EBA / SİP sipariş listesinde onaylandı (yeşil satırlar).` : "Bu teklif kazanıldı ve işleme girmelidir."}</div>`);
  } else if (offer && offer.result === "lost") {
    notes.push(`<div class="lost-banner">❌ <b>KALMADI / KAYBEDİLDİ (KIRMIZI):</b> Bu teklifteki kalemler için SİP onayı gelmedi.</div>`);
  }
  const waiting = req.items.filter((i) => i.status === "waiting").length;
  if (req.partTotal && req.partsReceived.length && req.partsReceived.length < req.partTotal) {
    const miss = Array.from({ length: req.partTotal }, (_, k) => k + 1).filter((p) => !req.partsReceived.includes(p));
    notes.push(`<span class="warn">Parça ${miss.join(", ")} henüz gelmedi</span> — ${waiting} kalemin çizimi bekleniyor. Parça gelince otomatik eşleşir.`);
  } else if (waiting) {
    notes.push(`${waiting} kalemin çizimi bekleniyor.`);
  }
  if (req.unrecognizedPdfs.length) {
    notes.push(`<b>Adı çizim biçimine uymayan PDF ekleri:</b><ul>${req.unrecognizedPdfs.map((d) => `<li>${esc(d.filename)}</li>`).join("")}</ul>`);
  }
  for (const w of req.warnings) notes.push(`<span class="warn">${esc(w)}</span>`);
  if (!req.items.length) notes.push(`<span class="warn">Bu e-postalarda kalem tablosu bulunamadı. Tablo içeren parça gelince birleşir.</span>`);

  const src = req.mails.map((m) => (m.forwardedBy ? `${m.sender.address} (ileten: ${m.forwardedBy.address})` : m.sender.address));
  const twCls = offer?.result === "won" ? "won" : offer?.result === "lost" ? "lost" : "";
  mid.innerHTML = `<div class="sumbar ${twCls}">
      <div class="sum-in" id="sumbar">${summaryHtml(req)}</div>
      <div style="position:relative; display:inline-block;">
        <button class="btn sm" id="btn-col-toggle" style="display:flex; align-items:center; gap:5px; font-weight:600;">
          ⚙ Sütunlar ${hiddenCols.length ? `(${hiddenCols.length} gizli)` : ""}
        </button>
        <div id="col-menu-dropdown" style="display:none; position:absolute; right:0; top:calc(100% + 5px); background:var(--pn); border:1px solid var(--bd); border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.3); z-index:100; min-width:210px; padding:8px;">
          <div style="font-weight:700; font-size:11px; margin-bottom:6px; border-bottom:1px solid var(--bd); padding-bottom:4px; color:var(--mu); text-transform:uppercase;">Sütun Göster / Gizle</div>
          <div style="max-height:220px; overflow-y:auto; display:flex; flex-direction:column; gap:4px;">
            ${req.headers.map(h => `
              <label style="display:flex; align-items:center; gap:8px; padding:3px 6px; border-radius:4px; cursor:pointer; font-size:11.5px; user-select:none; background:var(--bg);">
                <input type="checkbox" class="col-chk-input" data-col="${esc(h)}" ${!hiddenCols.includes(h) ? "checked" : ""}>
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(h)}</span>
              </label>
            `).join("")}
          </div>
          <div style="border-top:1px solid var(--bd); margin-top:8px; padding-top:6px; display:flex; justify-content:space-between; gap:6px;">
            <button class="btn sm" id="btn-col-reset" style="font-size:11px; padding:2px 8px;">Tümünü Aç</button>
            <button class="btn sm" id="btn-col-close" style="font-size:11px; padding:2px 8px;">Kapat</button>
          </div>
        </div>
      </div>
    </div>
    <div class="tw ${twCls}"><table><thead><tr>${head}<th class="n new stk stk-first" data-stk="2" data-col="__prev">Önceki</th><th class="n new stk" data-stk="1" data-col="__price">Birim Fiyat</th><th class="n new stk" data-stk="0" data-col="__total">Toplam</th></tr></thead>
    <tbody id="tb">${rows}</tbody></table></div>
    <p class="mu">Satırın üzerine gelince sağda çizim önizlemesi büyür, çift tıkla tam ekran açılır. · Kalıcı hafıza aktif (hiçbir mail veya fiyat silinmez).</p>
    ${notes.map((n) => `<div class="note">${n}</div>`).join("")}
    <p class="mu">Gönderen: ${esc([...new Set(src)].join(", "))}</p>`;

  mid.querySelectorAll<HTMLElement>("[data-um]").forEach((a) => (a.onclick = () => showFullPage(req.unmatchedDrawings[Number(a.dataset.um)])));
  mid.querySelectorAll<HTMLElement>("[data-toggle-item]").forEach((badge) => {
    badge.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(badge.dataset.toggleItem);
      const it = req.items[idx];
      if (!it) return;
      const mKey = `${req.id}|${normalizeCodeStr(it.code)}`;
      const map = (state.orders.itemResults ??= {});
      const cur = map[mKey];
      map[mKey] = cur === "won" ? "lost" : cur === "lost" ? null : "won";
      persist("orders");
      renderAll();
    };
  });
  
  // Sütun Checkbox Dropdown Olayları
  const btnColToggle = $("btn-col-toggle");
  const colMenu = $("col-menu-dropdown");
  if (btnColToggle && colMenu) {
    btnColToggle.onclick = (e) => {
      e.stopPropagation();
      colMenu.style.display = colMenu.style.display === "none" ? "block" : "none";
    };
    colMenu.onclick = (e) => e.stopPropagation();
  }
  document.addEventListener("click", () => {
    const cm = $("col-menu-dropdown");
    if (cm) cm.style.display = "none";
  }, { once: true });

  mid.querySelectorAll<HTMLInputElement>(".col-chk-input").forEach((chk) => {
    chk.onchange = () => {
      const col = chk.dataset.col!;
      if (chk.checked) {
        hiddenCols = hiddenCols.filter((x) => x !== col);
      } else {
        if (!hiddenCols.includes(col)) hiddenCols.push(col);
      }
      saveColState();
      renderMid();
    };
  });

  const btnReset = $("btn-col-reset");
  if (btnReset) {
    btnReset.onclick = () => {
      hiddenCols = [];
      saveColState();
      renderMid();
    };
  }

  const btnClose = $("btn-col-close");
  if (btnClose && colMenu) {
    btnClose.onclick = () => {
      colMenu.style.display = "none";
    };
  }

  bindTable(req);
  const table = mid.querySelector<HTMLTableElement>("table");
  if (table) initResizableColumns(table);
}

function bindTable(req: QuoteRequest): void {
  const tb = $("tb");
  // Kullanıcı talebi: Kasan ve ekranı kapatan hover baloncuk popup'ı kaldırıldı, önizleme sağ panelde yapılıyor.
  tb.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr.row");
    if (!tr) return;
    const i = Number(tr.dataset.i);
    if ((e.target as HTMLElement).tagName === "INPUT") {
      if (i !== state.selectedItem) openItem(i, false);
      return;
    }
    openItem(i);
  });
  tb.addEventListener("input", (e) => {
    const inp = e.target as HTMLInputElement;
    if (inp.tagName !== "INPUT") return;
    const item = req.items[Number(inp.dataset.i)];
    setPrice(req, item, inp.value);
    inp.style.borderColor = (inp.value.trim() && parsePrice(inp.value) == null) ? "var(--er)" : "";
    const tEl = $(`t${item.index}`);
    if (tEl) tEl.textContent = totalText(req, item);
    const pvEl = $(`pv${item.index}`);
    if (pvEl) pvEl.innerHTML = prevCellHtml(req, item);
    renderFooter();
  });
  tb.addEventListener("change", (e) => {
    const inp = e.target as HTMLInputElement;
    if (inp.tagName !== "INPUT") return;
    const item = req.items[Number(inp.dataset.i)];
    const p = parsePrice(inp.value);
    if (p != null && p > 0) {
      inp.value = formatMoney(p);
      setPrice(req, item, inp.value);
    }
  });
  tb.addEventListener("keydown", (e) => {
    const inp = e.target as HTMLInputElement;
    if (inp.tagName !== "INPUT" || e.key !== "Enter") return;
    e.preventDefault();
    const next = tb.querySelector<HTMLInputElement>(`input[data-i="${Number(inp.dataset.i) + 1}"]`);
    if (next) {
      openItem(Number(next.dataset.i), false);
      next.focus();
      next.select();
    }
  });
}

// ---------------------------------------------------------------- sağ bölme

let sheetIndex = 0;

function openItem(i: number, focusPrice = true): void {
  const req = currentRequest();
  if (!req || i < 0 || i >= req.items.length) return;
  state.selectedItem = i;
  document.querySelectorAll<HTMLElement>("tr.row").forEach((x) => x.classList.toggle("sel", Number(x.dataset.i) === i));
  document.querySelector(`tr.row[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  $("tip").style.display = "none";
  renderRight(focusPrice);
}

function renderRight(focusPrice = false): void {
  const rp = $("rp");
  const req = currentRequest();
  const item = req?.items[state.selectedItem];
  if (!req || !item) {
    rp.innerHTML = `<p class="mu">Bir satır seçin.</p>`;
    return;
  }
  const dc = descCol(req);
  const meta = req.headers
    .map((h, c) => (c === req.codeCol || c === dc ? "" : `${esc(h)}: ${esc(item.cells[c] ?? "")}`))
    .filter(Boolean).join(" · ");
  const sheets = item.drawings.length > 1
    ? `<div class="tools">${item.drawings.map((d, k) => `<button class="btn sm ${k === sheetIndex ? "p" : ""}" data-sh="${k}">Sayfa ${d.sheet}</button>`).join("")}</div>`
    : "";
  const d = item.drawings[sheetIndex];
  const waitingText = item.status === "waiting"
    ? "Çizim bekleniyor — diğer parça gelince otomatik eşleşir."
    : "Bu kalemin çizimi e-postalarda yok.";
    
  const prev = getPreviousPrice(req, item.code, item.cells[dc] ?? "");
  let prevText = "";
  if (prev) {
    const dtStr = new Date(prev.date).toLocaleDateString("tr-TR");
    const cntStr = prev.count && prev.count > 1 ? ` · ${prev.count} geçmiş kayıt` : "";
    const resStr = prev.result === "won" ? " · ✅ SİP Onaylı" : prev.result === "lost" ? " · ❌ Kalmadı" : "";
    prevText = `<div class="b-prev" style="margin-top:10px; color:var(--wa); font-weight:600">Önceki Fiyat: ${formatMoney(prev.price)} TL (${dtStr}${prev.firm ? ` · ${esc(prev.firm)}` : ""}${cntStr}${resStr})</div>`;
  }

  rp.innerHTML = `<h3>${esc(item.code)}</h3><div class="mu">${esc(dc !== req.codeCol ? item.cells[dc] ?? "" : "")}</div>
    ${sheets}
    <div class="img" id="cropBox" title="${d ? "Tam sayfa açmak için tıklayın" : ""}">${d ? `<div class="mu">Çizim hazırlanıyor…</div>` : `<div class="mu">${waitingText}</div>`}</div>
    ${d ? `<div class="tools"><button class="btn sm" id="fullp">Tam sayfa aç</button><span class="mu">${esc(d.filename)}</span></div>` : ""}
    <div class="mu meta">${meta}</div>
    ${prevText}
    <div class="pr"><input id="pi" placeholder="Birim fiyat" value="${esc(priceText(req, item))}" inputmode="decimal"><button class="btn p" id="pa">Uygula</button></div>
    <div class="mu" style="margin-top:4px">Enter: uygula ve sonraki kaleme geç</div>

    <div id="rp-stock-calc" style="margin-top:10px; padding:10px; background:var(--bg); border:1px solid var(--bd); border-radius:6px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <div style="font-weight:700; font-size:11px; color:var(--mu); text-transform:uppercase;">⚖ Talaşlı İmalat Hammadde Hesabı</div>
        <span id="rp-calc-weight" style="font-weight:700; font-size:12px; color:var(--tx);">0.00 kg</span>
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-bottom:6px;">
        <select id="rp-calc-shape" style="font-size:11px; padding:3px 4px; font-weight:600; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
          <option value="plate"${stockCalcState.shape === "plate" ? " selected" : ""}>⬛ Kütük / Levha</option>
          <option value="round"${stockCalcState.shape === "round" ? " selected" : ""}>⚪ Silindirik / Çap</option>
        </select>
        <select id="rp-calc-mat" style="font-size:11px; padding:3px 4px; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
          ${materialOptionsHtml(stockCalcState.density)}
        </select>
      </div>
      <div style="display:grid; grid-template-columns: 55px 1fr 65px; gap:6px; margin-bottom:6px;">
        <input type="text" id="rp-calc-density" value="${stockCalcState.density}" title="Özgül Ağırlık (g/cm³)" placeholder="Özgül" style="font-size:11px; padding:3px 4px; text-align:center; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
        <input type="text" id="rp-calc-dim" placeholder="${stockCalcState.shape === "round" ? "Çap Ø x Boy (örn: 50x150)" : "En x Boy x Kalınlık (mm)"}" style="font-size:11px; padding:3px 6px; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
        <input type="text" id="rp-calc-price" value="${stockCalcState.pricePerKg}" placeholder="₺/kg" inputmode="decimal" style="font-size:11px; padding:3px 4px; text-align:right; border-radius:4px; border:1px solid var(--bd); background:var(--pn); color:var(--tx);">
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; padding-top:6px; border-top:1px dashed var(--bd);">
        <div>
          <span style="font-size:11px; color:var(--mu);">Maliyet: </span>
          <span id="rp-calc-res" style="font-weight:700; font-size:12.5px; color:#2ecc71;">0,00 ₺</span>
        </div>
        <button class="btn sm" id="rp-btn-apply" style="font-size:11px; font-weight:600; padding:2px 8px; background:var(--ac); color:#fff; border:none; border-radius:4px; cursor:pointer;">Fiyata Aktar ↵</button>
      </div>
    </div>`;

  rp.querySelectorAll<HTMLElement>("[data-sh]").forEach((b) => (b.onclick = () => {
    sheetIndex = Number(b.dataset.sh);
    renderRight();
  }));
  if (d) {
    $("cropBox").onclick = () => showFullPage(d, item);
    $("fullp").onclick = () => showFullPage(d, item);
    renderCrop(d).then((c) => {
      const box = $("cropBox");
      if (!box || state.selectedItem !== item.index || item.drawings[sheetIndex] !== d) return;
      box.innerHTML = `<img src="${c.url}" alt="${esc(item.code)}">`;
    }).catch((e) => {
      const box = $("cropBox");
      if (box) box.innerHTML = `<div class="mu err">Çizim açılamadı: ${esc(errText(e))}</div>`;
    });
  }

  // Sağ panel hammadde hesaplayıcı olayları
  const rpCalcShape = $<HTMLSelectElement>("rp-calc-shape");
  const rpCalcMat = $<HTMLSelectElement>("rp-calc-mat");
  const rpCalcDensity = $<HTMLInputElement>("rp-calc-density");
  const rpCalcDim = $<HTMLInputElement>("rp-calc-dim");
  const rpCalcPrice = $<HTMLInputElement>("rp-calc-price");
  const rpCalcWeight = $("rp-calc-weight");
  const rpCalcRes = $("rp-calc-res");
  const rpBtnApply = $("rp-btn-apply");

  const runRpCalc = () => {
    if (!rpCalcShape || !rpCalcDensity || !rpCalcDim || !rpCalcPrice || !rpCalcWeight || !rpCalcRes) return 0;
    const shape = (rpCalcShape.value || stockCalcState.shape) as "plate" | "round";
    stockCalcState.shape = shape;
    const density = parseFloat(rpCalcDensity.value.replace(",", ".")) || 7.85;
    stockCalcState.density = rpCalcDensity.value;
    stockCalcState.pricePerKg = rpCalcPrice.value;
    const price = parsePrice(rpCalcPrice.value) || 0;

    const weight = computeStockWeight(shape, rpCalcDim.value, density);
    rpCalcWeight.textContent = weight.toFixed(2) + " kg";
    const cost = weight * price;
    rpCalcRes.textContent = formatMoney(cost) + " ₺";
    return cost;
  };

  if (d) {
    extractPdfInfo(d).then((info) => {
      if (info.material && rpCalcDensity && rpCalcMat) {
        const dVal = detectMaterialDensity(info.material);
        rpCalcDensity.value = dVal;
        stockCalcState.density = dVal;
        const curNum = parseFloat(dVal);
        const match = MATERIALS_LIST.find((m) => Math.abs(m.density - curNum) < 0.02);
        if (match) rpCalcMat.value = match.density.toFixed(2);
        else rpCalcMat.value = "custom";
        runRpCalc();
      }
    }).catch(() => {});
  }

  if (rpCalcShape) {
    rpCalcShape.onchange = () => {
      stockCalcState.shape = rpCalcShape.value as "plate" | "round";
      if (rpCalcDim) {
        rpCalcDim.placeholder = rpCalcShape.value === "round"
          ? "Çap Ø x Boy (örn: 50x150)"
          : "En x Boy x Kalınlık (mm)";
      }
      runRpCalc();
    };
  }

  if (rpCalcMat) {
    rpCalcMat.onchange = () => {
      if (rpCalcMat.value !== "custom" && rpCalcDensity) {
        rpCalcDensity.value = rpCalcMat.value;
        stockCalcState.density = rpCalcMat.value;
      }
      runRpCalc();
    };
  }

  if (rpCalcDensity) {
    rpCalcDensity.oninput = () => {
      stockCalcState.density = rpCalcDensity.value;
      if (rpCalcMat) {
        const curNum = parseFloat(rpCalcDensity.value.replace(",", "."));
        const match = MATERIALS_LIST.find((m) => !isNaN(curNum) && Math.abs(m.density - curNum) < 0.02);
        if (match) rpCalcMat.value = match.density.toFixed(2);
        else rpCalcMat.value = "custom";
      }
      runRpCalc();
    };
  }

  if (rpCalcDim) rpCalcDim.oninput = runRpCalc;
  if (rpCalcPrice) rpCalcPrice.oninput = runRpCalc;

  if (rpBtnApply) {
    rpBtnApply.onclick = () => {
      const cost = runRpCalc();
      if (cost > 0) {
        const pi = $<HTMLInputElement>("pi");
        if (pi) {
          pi.value = formatMoney(cost);
          pi.focus();
        }
      }
    };
  }

  const pi = $<HTMLInputElement>("pi");
  const applyPrice = () => {
    const p = parsePrice(pi.value);
    if (p != null && p > 0) pi.value = formatMoney(p);
    setPrice(req, item, pi.value);
    const inp = document.querySelector<HTMLInputElement>(`input[data-i="${item.index}"]`);
    if (inp) {
      inp.value = pi.value;
      inp.style.borderColor = "";
    }
    const tEl = $(`t${item.index}`);
    if (tEl) tEl.textContent = totalText(req, item);
    const pvEl = $(`pv${item.index}`);
    if (pvEl) pvEl.innerHTML = prevCellHtml(req, item);
    renderFooter();
  };
  pi.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyPrice();
      const next = document.querySelector<HTMLInputElement>(`input[data-i="${item.index + 1}"]`);
      if (next) {
        openItem(item.index + 1, false);
        next.focus();
        next.select();
      }
    }
  };
  $("pa").onclick = applyPrice;
  if (focusPrice) {
    pi.focus();
    pi.select();
  }
}

// ---------------------------------------------------------------- alt şerit

function renderFooter(): void {
  const req = currentRequest();
  const items = req?.items ?? [];
  let count = 0;
  let total = 0;
  for (const it of items) {
    const p = req && priceOf(req, it);
    if (p != null) {
      count++;
      if (it.qty != null) total += p * it.qty;
    }
  }
  $("cnt").textContent = String(count);
  $("all").textContent = String(items.length);
  $("gt").textContent = formatMoney(total);
  const sb = $("sumbar");
  if (sb && req) sb.innerHTML = summaryHtml(req);
  const full = $<HTMLInputElement>("full");
  full.checked = req ? !!state.settings.fullList[firmKey(req)] : false;
  full.disabled = !req;
}

function renderStatus(): void {
  if (gmailBusy) return;
  const n = state.requests.length;
  const bits = [n ? `${n} teklif isteği` : "Teklif isteği yok"];
  if (gmail.connected) bits.push("Gmail bağlı (salt okuma)");
  $("status").textContent = bits.join(" · ");
}

function renderAll(): void {
  renderSidebar();
  renderMid();
  renderRight();
  renderFooter();
  renderStatus();
  renderGmailBox();
  const req = currentRequest();
  if (req) prefetch(req);
}

// ---------------------------------------------------------------- Teklifi Hazırla

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data.slice().buffer);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** V3 için arka planda veri kaydı: fiyatlanan her kalem + çizim PDF'i + küçük görsel. */
async function recordData(req: QuoteRequest, offerPath: string): Promise<void> {
  const dc = descCol(req);
  const records = [];
  for (const it of req.items) {
    const price = priceOf(req, it);
    if (price == null) continue;
    const drawings = [];
    for (const d of it.drawings) {
      const base = `${d.key}_S${d.sheet}_${(await sha256Hex(d.data)).slice(0, 12)}`;
      await backend.recordFile(`${base}.pdf`, d.data);
      let thumb: string | null = null;
      try {
        const c = await renderCrop(d);
        await backend.recordFile(`${base}.png`, await c.thumb());
        thumb = `${base}.png`;
      } catch (e) {
        console.warn("küçük görsel üretilemedi", e);
      }
      drawings.push({ filename: d.filename, pdf: `${base}.pdf`, thumb });
    }
    records.push({
      id: `${req.id}|${it.index}|${it.code}`,
      requestId: req.id,
      firm: firmName(req),
      sender: req.sender.address,
      subject: req.subject,
      deadline: req.deadline,
      headers: req.headers,
      cells: it.cells,
      code: it.code,
      description: it.cells[dc] ?? "",
      qty: it.qty,
      price,
      date: new Date().toISOString(),
      offerPath,
      drawings,
      result: state.offers[req.id]?.result ?? null,
    });
  }
  await backend.recordItems(records);
}

async function prepareOffer(): Promise<void> {
  const req = currentRequest();
  if (!req) {
    toast("Lütfen önce bir teklif isteği seçin.");
    return;
  }
  if (!req.items || req.items.length === 0) {
    toast("Bu istekte fiyatlandırılabilecek kalem bulunamadı.");
    return;
  }
  const full = !!state.settings.fullList[firmKey(req)];
  const rows = req.items.filter((it) => full || priceOf(req, it) != null);
  const unpriced = req.items.filter((it) => priceOf(req, it) == null).length;
  const badInput = req.items.filter((it) => priceText(req, it) && parsePrice(priceText(req, it)) == null).length;
  const day = dayOf(req.requestTag ?? "") ?? dayOf(req.date) ?? todayDotted();
  const folder = `${day} - ${cleanSubject(req.subject) || "Teklif İsteği"}`;
  const firm = firmName(req);

  let path: string;
  try {
    let templateData: Uint8Array | null = null;
    const templateAtt = req.unrecognizedPdfs?.find(a => a.filename.toLowerCase().endsWith(".xlsx")) || req.otherAttachments?.find(a => a.filename.toLowerCase().endsWith(".xlsx"));
    if (templateAtt && templateAtt.data) {
      templateData = templateAtt.data;
    }
    
    const filename = offerExcelFilename(req);

    if (templateData) {
      const { fillExcelTemplate } = await import("./excel");
      const outData = await fillExcelTemplate(req, templateData, rows);
      path = await backend.saveExcelFile(state.settings.archiveRoot, firm, folder, outData, filename);
    } else {
      path = await backend.saveOffer({
        archiveRoot: state.settings.archiveRoot,
        firm,
        folder,
        filename,
        headers: [...req.headers, "Önceki Fiyat", "Önceki Tarih"],
        qtyCol: req.qtyCol,
        rows: rows.map((it) => {
          const prev = getPreviousPrice(req, it.code);
          return {
            cells: [...it.cells, prev ? formatMoney(prev.price) : "", prev ? new Date(prev.date).toLocaleDateString("tr-TR") : ""],
            qty: it.qty,
            price: priceOf(req, it)
          };
        }),
      });
    }
  } catch (e) {
    openModal(`<h3 style="margin-top:0" class="err">Teklif kaydedilemedi</h3><p>${esc(errText(e))}</p>
      <div style="display:flex;gap:8px"><button class="btn" id="cl">Kapat</button></div>`);
    $("cl").onclick = closeModal;
    return;
  }
  state.offers[req.id] = {
    path,
    at: new Date().toISOString(),
    result: state.offers[req.id]?.result ?? null,
    manual: state.offers[req.id]?.manual ?? false,
  };
  persist("offers");
  syncMemoryFromCurrentState();
  renderSidebar();
  recordData(req, path).catch((e) => console.warn("veri kaydı yapılamadı", e));

  const qc = req.qtyCol;
  const head = [...req.headers, "Birim Fiyat", "Toplam"].map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((it) => {
    const p = priceOf(req, it);
    return `<tr>${it.cells.map((c, k) => `<td style="${k === qc ? "text-align:right" : ""}">${esc(c)}</td>`).join("")}
      <td style="text-align:right">${p != null ? formatMoney(p) : ""}</td><td style="text-align:right">${totalText(req, it)}</td></tr>`;
  }).join("");
  const reminders: string[] = [];
  if (unpriced) {
    reminders.push(`${unpriced} kalem fiyatsız${full ? " — tam liste açık, boş satır olarak gitti." : " — tam liste kapalı, teklife eklenmedi."}`);
  }
  if (badInput) reminders.push(`${badInput} kalemde fiyat okunamadı (kırmızı kutular), fiyatsız sayıldı.`);
  const subject = req.subject || requestTitle(req);
  const account = state.settings.gmailAccount ?? undefined;

  openModal(`<h3 style="margin-top:0">Teklif hazır <span class="ok">✓</span></h3>
    <p class="mu">Klasöre kaydedildi: <b>${esc(path)}</b> (${rows.length} satır${full ? ", tam liste" : ", sadece fiyatlananlar"})</p>
    ${reminders.map((r) => `<p class="warn">Hatırlatma: ${esc(r)}</p>`).join("")}
    <div style="overflow:auto;max-height:40vh"><table class="xl"><tr>${head}</tr>${body}</table></div>
    <p><b>Mail metni:</b> Sn. İlgili; Teklifiniz ektedir.<br><span class="mu">Kime: ${esc(req.sender.address)} · Konu: Re: ${esc(subject)} · Ek: teklif.xlsx</span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn p" id="nm">Gmail'de yeni mail aç</button>
    <button class="btn" id="of">Klasörü göster</button><button class="btn" id="cl">Kapat</button></div>
    <p class="mu">Uygulama mail göndermez; Excel'i ekleyip Gönder'e siz basarsınız.</p>`);
  $("cl").onclick = closeModal;
  $("of").onclick = () => backend.revealPath(path).catch((e) => toast(errText(e)));
  $("nm").onclick = () => backend.openUrl(gmailComposeUrl({ to: req.sender.address, subject, account })).catch((e) => toast(errText(e)));
}

// ---------------------------------------------------------------- Fiyat & SİP Hafızası

async function openMemoryModal(): Promise<void> {
  let query = "";
  const draw = () => {
    const pool = getOrderedCodesPool();
    const allItems = Object.values(state.history).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const q = normTr(query.trim());
    const filtered = !q
      ? allItems
      : allItems.filter((it) =>
          normTr(it.code).includes(q) ||
          normTr(it.description || "").includes(q) ||
          normTr(it.firm || "").includes(q) ||
          normTr(it.subject || "").includes(q)
        );

    const rowsHtml = filtered.slice(0, 300).map((it) => {
      const codeNorm = normalizeCodeStr(it.code);
      const baseNorm = baseCodeKey(codeNorm);
      const isSip =
        it.result === "won" ||
        pool.has(codeNorm) ||
        (baseNorm.length >= 5 && pool.has(baseNorm)) ||
        extractTokens(it.code + " " + (it.description || "")).some((t) => t.length >= 6 && pool.has(t));
      const isLost = !isSip && (it.result === "lost" || state.offers[it.requestId]?.result === "lost");
      const dt = it.date ? new Date(it.date).toLocaleDateString("tr-TR") : "—";
      const srcLabel =
        it.source === "archive"
          ? "Excel Arşivi"
          : it.source === "kalemler"
            ? "Kayıtlı Kalem"
            : it.source === "offer"
              ? "Teklif"
              : "Canlı Hafıza";
      return `<tr class="${isSip ? "row-won" : isLost ? "row-lost" : ""}" title="${esc(it.subject || it.requestId)}">
        <td><b>${esc(it.code)}</b></td>
        <td>${esc(it.description || "—")}</td>
        <td style="text-align:right;font-weight:700;color:var(--wa)">${formatMoney(it.price)} ₺</td>
        <td>${esc(dt)}</td>
        <td>${esc(it.firm || "—")}</td>
        <td>${isSip ? `<span class="sip-tag-won">✅ SİP Onaylı</span>` : isLost ? `<span class="sip-tag-lost">❌ Kalmadı</span>` : `<span class="mu">—</span>`}</td>
        <td style="text-align:center"><span class="b">${srcLabel}</span></td>
      </tr>`;
    }).join("");

    const box = openModal(`<div class="mhead">
        <h3>🧠 Kalıcı Fiyat & SİP Hafıza Merkezi</h3>
        <div style="display:flex;gap:6px">
          <button class="btn sm p" id="mem-rescan">🔄 Arşivi & Kayıtları Yeniden Tara</button>
          <button class="btn sm" id="mem-close">Kapat</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">
        <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:6px">
          <div class="mu" style="font-size:11px">Hafızadaki Parça Fiyatı</div>
          <div style="font-size:16px;font-weight:700;color:var(--wa)">${allItems.length} kayıt</div>
        </div>
        <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:6px">
          <div class="mu" style="font-size:11px">Kayıtlı Mail & Teklif İsteği</div>
          <div style="font-size:16px;font-weight:700">${state.mails.size} mail / ${state.requests.length} istek</div>
        </div>
        <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:6px">
          <div class="mu" style="font-size:11px">Hazırlanan Teklifler</div>
          <div style="font-size:16px;font-weight:700">${Object.keys(state.offers).length} teklif</div>
        </div>
        <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:6px">
          <div class="mu" style="font-size:11px">EBA / SİP Sipariş Havuzu</div>
          <div style="font-size:16px;font-weight:700;color:var(--ok)">${pool.size} kod</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
        <input type="text" id="mem-search" value="${esc(query)}" placeholder="Malzeme kodu, parça tanımı veya firma ara..." style="flex:1;padding:7px 10px;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:6px">
        <button class="btn sm" id="mem-add-toggle">➕ Manuel Fiyat Ekle</button>
      </div>
      <div id="mem-add-box" style="display:none;padding:10px;margin-bottom:10px;background:var(--bg);border:1px solid var(--bd);border-radius:6px">
        <div style="font-weight:700;font-size:11.5px;margin-bottom:6px">Hafızaya Manuel Parça Fiyatı Kaydet</div>
        <div style="display:grid;grid-template-columns:1.2fr 1.5fr 0.8fr 1fr auto;gap:6px">
          <input type="text" id="mem-in-code" placeholder="Malzeme Kodu (örn: FU00314268/B-03)" style="padding:5px 8px;background:var(--pn);color:var(--tx);border:1px solid var(--bd);border-radius:4px">
          <input type="text" id="mem-in-desc" placeholder="Malzeme Tanımı" style="padding:5px 8px;background:var(--pn);color:var(--tx);border:1px solid var(--bd);border-radius:4px">
          <input type="text" id="mem-in-price" placeholder="Birim Fiyat (₺)" style="padding:5px 8px;background:var(--pn);color:var(--tx);border:1px solid var(--bd);border-radius:4px">
          <input type="text" id="mem-in-firm" placeholder="Firma (örn: Etimakine)" value="Etimakine" style="padding:5px 8px;background:var(--pn);color:var(--tx);border:1px solid var(--bd);border-radius:4px">
          <button class="btn sm p" id="mem-in-save">Kaydet</button>
        </div>
      </div>
      <div style="overflow:auto;max-height:52vh;border:1px solid var(--bd);border-radius:6px">
        <table class="xl" style="margin:0">
          <thead>
            <tr>
              <th>Malzeme Kodu</th>
              <th>Malzeme Tanımı</th>
              <th style="text-align:right">Birim Fiyat</th>
              <th>Tarih</th>
              <th>Firma</th>
              <th>EBA / SİP Durumu</th>
              <th style="text-align:center">Kaynak</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || `<tr><td colspan="7" class="mu" style="text-align:center;padding:20px">Eşleşen fiyat kaydı bulunamadı.</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="mu" style="margin-top:8px;font-size:11px">
        Toplam ${filtered.length} kayıt listeleniyor (hiçbir fiyat veya mail silinmez; Teklif Arşivi klasöründeki tüm Excel dosyaları otomatik taranır).
      </div>`);

    $("mem-close").onclick = closeModal;
    const searchInp = $<HTMLInputElement>("mem-search");
    searchInp.oninput = () => {
      query = searchInp.value;
      const pos = searchInp.selectionStart ?? query.length;
      draw();
      const nextInp = $<HTMLInputElement>("mem-search");
      if (nextInp) {
        nextInp.focus();
        nextInp.setSelectionRange(pos, pos);
      }
    };
    $("mem-add-toggle").onclick = () => {
      const ab = $("mem-add-box");
      if (ab) ab.style.display = ab.style.display === "none" ? "block" : "none";
    };
    $("mem-in-save").onclick = () => {
      const code = $<HTMLInputElement>("mem-in-code").value.trim();
      const desc = $<HTMLInputElement>("mem-in-desc").value.trim();
      const priceVal = parsePrice($<HTMLInputElement>("mem-in-price").value);
      const firm = $<HTMLInputElement>("mem-in-firm").value.trim() || "Manuel";
      if (!code || priceVal == null || priceVal <= 0) {
        toast("Lütfen geçerli bir malzeme kodu ve birim fiyat girin.");
        return;
      }
      const norm = normalizeCodeStr(code);
      const rId = `manual:${todayDotted()}`;
      upsertPriceMemory(
        {
          id: `${rId}|${norm}`,
          requestId: rId,
          code,
          normCode: norm,
          key: codeKey(code) ?? norm,
          baseKey: baseCodeKey(code),
          description: desc,
          qty: 1,
          price: priceVal,
          date: new Date().toISOString(),
          firm,
          subject: "Manuel Hafıza Kaydı",
          result: null,
          source: "live",
        },
        true,
      );
      toast(`${code} hafızaya kaydedildi (${formatMoney(priceVal)} ₺).`);
      draw();
      renderAll();
    };
    $("mem-rescan").onclick = async () => {
      const btn = $<HTMLButtonElement>("mem-rescan");
      btn.disabled = true;
      btn.textContent = "Taranıyor...";
      await syncExternalMemory();
      renderAll();
      draw();
      toast("Teklif Arşivi ve kayıtlı kalemler hafızayla eşitlendi.");
    };
    void box;
  };
  draw();
}

// ---------------------------------------------------------------- ayarlar

async function openSettings(): Promise<void> {
  const s = state.settings;
  const draft: Firm[] = s.firms.map((f) => ({ ...f, match: [...f.match] }));
  const auto = await backend.autostartEnabled().catch(() => false);
  let archive = s.archiveRoot;

  const draw = () => {
    const box = openModal(`<div class="mhead"><h3>Ayarlar</h3></div><div class="form">
      <label>Firmalar (izin listesi) — ad ve gönderen adresi/alan adı (virgülle ayırın)</label>
      <div id="frows">${draft.map((f, k) => `<div class="firmrow">
        <input type="text" data-fn="${k}" value="${esc(f.name)}" placeholder="Firma adı">
        <input type="text" data-fm="${k}" value="${esc(f.match.join(", "))}" placeholder="ornek.com.tr, kisi@ornek.com">
        <button class="btn sm" data-fd="${k}">Sil</button></div>`).join("") || `<div class="mu">Henüz firma yok.</div>`}</div>
      <button class="btn sm" id="fadd">+ Firma ekle</button>
      <label>Teklif arşivi klasörü</label>
      <div class="row2"><input type="text" id="sarch" value="${esc(archive)}"><button class="btn sm" id="spick" ${backend.inTauri ? "" : "disabled"}>Değiştir…</button></div>
      <label>Gmail (salt okuma)</label>
      <div class="row2">${!gmail.configured
        ? `<span class="mu">Bu kurulumda Gmail bağlantısı yapılandırılmamış.</span>`
        : gmail.connected
          ? `<span>Bağlı: ${esc(s.gmailAccount ?? "")}</span><button class="btn sm" id="gdis">Bağlantıyı kes</button>`
          : `<button class="btn sm" id="gcon2">Gmail'e bağlan</button>`}</div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:8px;">
        <div>
          <label>Teklif İstekleri Gün Sayısı (Tuğçe vb.)</label>
          <input type="number" id="sdays" min="1" max="365" value="${s.gmailDays || 60}">
          <div class="mu" style="font-size:11px; margin-top:2px;">Önceki tekliflerin eksiksiz gelmesi için 60-90 gün önerilir (indirilen mailler kalıcı hafızada saklanır, silinmez).</div>
        </div>
        <div>
          <label>Sipariş / SİP / EBA Gün Sayısı</label>
          <input type="number" id="sorderdays" min="1" max="365" value="${s.gmailOrderDays || 90}">
          <div class="mu" style="font-size:11px; margin-top:2px;">EBA / SİP sipariş onaylarını yakalamak için 90 gün önerilir.</div>
        </div>
      </div>
      <label style="margin-top:10px;"><input type="checkbox" id="sauto" ${auto ? "checked" : ""} ${backend.inTauri ? "" : "disabled"}> Bilgisayar açılınca başlat</label>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn p" id="ssave">Kaydet</button><button class="btn" id="scancel">Vazgeç</button></div>`);

    const sync = () => {
      box.querySelectorAll<HTMLInputElement>("[data-fn]").forEach((i) => (draft[Number(i.dataset.fn)].name = i.value));
      box.querySelectorAll<HTMLInputElement>("[data-fm]").forEach((i) => (draft[Number(i.dataset.fm)].match = i.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)));
      archive = $<HTMLInputElement>("sarch").value;
    };
    box.querySelectorAll<HTMLElement>("[data-fd]").forEach((b) => (b.onclick = () => {
      sync();
      draft.splice(Number(b.dataset.fd), 1);
      draw();
    }));
    $("fadd").onclick = () => {
      sync();
      draft.push({ id: newId(), name: "", match: [] });
      draw();
    };
    $("spick").onclick = async () => {
      sync();
      const p = await backend.pickFolder(archive);
      if (p) {
        archive = p;
        draw();
      }
    };
    if ($("gdis")) $("gdis").onclick = async () => {
      await backend.gmailDisconnect().catch((e) => toast(errText(e)));
      gmail = await backend.gmailStatus();
      state.settings.gmailAccount = null;
      persist("settings");
      renderGmailBox();
      renderStatus();
      draw();
    };
    if ($("gcon2")) $("gcon2").onclick = async () => {
      closeModal();
      await gmailConnect();
    };
    $("scancel").onclick = closeModal;
    $("ssave").onclick = async () => {
      sync();
      s.firms = draft.filter((f) => f.name.trim() || f.match.length).map((f) => ({ ...f, name: f.name.trim() || suggestFirmName(f.match[0] ?? "") }));
      s.archiveRoot = archive.trim() || s.archiveRoot;
      s.gmailDays = Math.max(1, Math.min(365, Number($<HTMLInputElement>("sdays").value) || 60));
      s.gmailOrderDays = Math.max(1, Math.min(365, Number($<HTMLInputElement>("sorderdays").value) || 90));
      const wantAuto = $<HTMLInputElement>("sauto").checked;
      if (wantAuto !== auto) await backend.setAutostart(wantAuto).catch((e) => toast(`Açılışta başlatma ayarlanamadı: ${errText(e)}`));
      persist("settings");
      closeModal();
      await syncExternalMemory();
      renderAll();
    };
  };
  draw();
}

// ---------------------------------------------------------------- başlangıç

async function loadClick(): Promise<void> {
  try {
    await addEmlFiles(await backend.pickEmlFiles());
  } catch (e) {
    toast(`Dosya açılamadı: ${errText(e)}`);
  }
}

async function setupDragDrop(): Promise<void> {
  const drop = $("drop");
  if (backend.inTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent(async (e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") drop.style.display = "flex";
      else if (p.type === "leave") drop.style.display = "none";
      else if (p.type === "drop") {
        drop.style.display = "none";
        const paths = p.paths.filter((x) => /\.eml$/i.test(x));
        if (!paths.length) return toast("Yalnızca .eml dosyaları yüklenebilir.");
        const files = await Promise.all(paths.map(async (path) => ({ name: path.split(/[\\/]/).pop() ?? path, path, data: await backend.readEml(path) })));
        await addEmlFiles(files);
      }
    });
    return;
  }
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.style.display = "flex";
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) drop.style.display = "none";
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.style.display = "none";
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.eml$/i.test(f.name));
    await addEmlFiles(await Promise.all(files.map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) }))));
  });
}

function installErrorLogging(): void {
  window.addEventListener("error", (e) => backend.logToTerminal("hata", `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => backend.logToTerminal("hata", String(e.reason?.stack ?? e.reason)));
}

async function init(): Promise<void> {
  installErrorLogging();
  await loadState();

  $("gm").onclick = () => backend.openUrl("https://mail.google.com");
  $("load").onclick = loadClick;
  $("settings").onclick = openSettings;
  const memBtn = document.getElementById("memory-btn");
  if (memBtn) memBtn.onclick = openMemoryModal;
  $("prep").onclick = prepareOffer;
  $("firms").addEventListener("click", onSidebarClick);
  $("firms").addEventListener("change", onSidebarChange);
  $<HTMLInputElement>("full").onchange = (e) => {
    const req = currentRequest();
    if (!req) return;
    state.settings.fullList[firmKey(req)] = (e.target as HTMLInputElement).checked;
    persist("settings");
  };
  $("md").addEventListener("click", (e) => {
    if (e.target === $("md")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("md").style.display === "flex") closeModal();
  });
  await setupDragDrop();

  // Kurulumdan sonraki ilk açılışta "açılışta başlat" varsayılan olarak açılır (geliştirmede değil).
  if (backend.inTauri && import.meta.env.PROD && !state.settings.autostartInitialized) {
    await backend.setAutostart(true).catch((e) => console.warn(e));
    state.settings.autostartInitialized = true;
    persist("settings");
  }

  gmail = await backend.gmailStatus().catch(() => gmail);
  renderAll();
  await restoreSession();
  await syncExternalMemory();
  renderAll();
  if (gmail.connected) {
    gmailRefresh(true);
    window.setInterval(() => gmailRefresh(true), 10 * 60 * 1000);
  }
  if (import.meta.env.DEV && backend.inTauri) {
    const { runSelfTest } = await import("./devtest");
    runSelfTest({ state, addEmlFiles, currentRequest });
  }

  if (backend.inTauri) {
    const updateBtn = $<HTMLButtonElement>("update-btn");
    if (updateBtn) {
      updateBtn.style.display = "inline-block";
      updateBtn.onclick = async () => {
        updateBtn.textContent = "Denetleniyor...";
        updateBtn.disabled = true;
        try {
          const update = await check();
          if (update) {
            updateBtn.textContent = "İndiriliyor...";
            toast("Yeni sürüm indiriliyor, lütfen bekleyin...", 15000);
            await update.downloadAndInstall();
            updateBtn.textContent = "GÜNCELLENDİ";
            alert("Güncelleme başarıyla kuruldu! Yenilikleri görmek için uygulamayı kapatıp tekrar açın.");
          } else {
            updateBtn.textContent = "Güncel";
            toast("Uygulama zaten en güncel sürümde.");
            setTimeout(() => { updateBtn.textContent = "Güncelleme Denetle"; updateBtn.disabled = false; }, 3000);
          }
        } catch (e) {
          updateBtn.textContent = "Hata!";
          console.warn("Güncelleme kontrol hatası:", e);
          toast("Güncelleme kontrol edilemedi.");
          setTimeout(() => { updateBtn.textContent = "Güncelleme Denetle"; updateBtn.disabled = false; }, 3000);
        }
      };
    }
  }

  if (backend.inTauri && import.meta.env.PROD) {
    check().then(async (update) => {
      if (update) {
        toast("Yepyeni bir sürüm bulundu! Arka planda kuruluyor, lütfen bekleyin...", 10000);
        await update.downloadAndInstall();
        toast("Güncelleme başarıyla kuruldu! Yenilikleri görmek için uygulamayı kapatıp tekrar açın.", 60000);
      }
    }).catch(e => console.warn("Güncelleme kontrol hatası:", e));
  }
}

init().catch((e) => {
  console.error(e);
  backend.logToTerminal("hata", String(e?.stack ?? e));
  document.body.insertAdjacentHTML("afterbegin", `<p class="err" style="padding:8px 16px">Başlatma hatası: ${esc(errText(e))}</p>`);
});
