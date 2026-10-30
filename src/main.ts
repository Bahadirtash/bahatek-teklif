// Bahatek Teklif arayüzü — prototype/teklif-prototip.html görünümü ve akışı, gerçek veriyle.
import * as backend from "./backend";
import { groupMails, parseEml } from "./eml";
import { normalizeCodeStr } from "./eml/codes";
import type { Drawing, Item, QuoteRequest } from "./eml";
import { cleanSubject, dayOf, esc, formatMoney, gmailComposeUrl, parsePrice, todayDotted } from "./format";
import { renderCrop, renderFullPage, extractPdfInfo } from "./pdf/render";
import {
  firmKey, firmOf, isPublicDomain, itemKey, loadState, newId, persist, state, suggestFirmName,
} from "./state";
import type { Firm, Result } from "./state";
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
  return e instanceof Error ? e.message : errText(e);
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
export function getPreviousPrice(req: QuoteRequest, code: string): { price: number; date: string; qty?: number } | null {
  let best: { price: number; date: string; qty?: number } | null = null;
  for (const [rId, offer] of Object.entries(state.offers)) {
    if (rId === req.id) continue;
    const prices = state.prices[rId];
    if (!prices) continue;
    const key = Object.keys(prices).find(k => k.endsWith(`:${code}`));
    if (key && prices[key]) {
      const p = parsePrice(prices[key]);
      if (p != null && (!best || new Date(offer.at) > new Date(best.date))) {
        let qty: number | undefined;
        const oldReq = state.requests.find(r => r.id === rId);
        if (oldReq) {
          const oldItem = oldReq.items.find(i => itemKey(i.index, i.code) === key);
          if (oldItem && oldItem.qty != null) qty = oldItem.qty;
        }
        best = { price: p, date: offer.at, qty };
      }
    }
  }
  return best;
}

function setPrice(req: QuoteRequest, item: Item, text: string): void {
  const map = (state.prices[req.id] ??= {});
  const key = itemKey(item.index, item.code);
  if (text.trim()) map[key] = text.trim();
  else delete map[key];
  persist("prices", 400);
}

function totalText(req: QuoteRequest, item: Item): string {
  const p = priceOf(req, item);
  return p != null && item.qty != null ? formatMoney(p * item.qty) : "";
}

function descCol(req: QuoteRequest): number {
  const byName = req.headers.findIndex((h) => /tanım/i.test(h));
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

let showOldOffers = false;

/** EBA sipariş / kazanıldı mailleri (SİB, SİP, Sipariş, Kazanıldı...). */
export const ORDER_RE = /(?:^|[^\p{L}\p{N}])(?:S[İI]B|S[İI]P|S[İI]PAR[İI][SŞ]|SATINALMA|KAZANILDI|KAZANDINIZ)(?![\p{L}\p{N}])/iu;

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

/** Önceki fiyat hücresi: yeni fiyat düştüyse yeşil ▼, arttıysa kırmızı ▲. */
function prevCellHtml(req: QuoteRequest, it: Item): string {
  const prev = getPreviousPrice(req, it.code);
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
  const tip = `${new Date(prev.date).toLocaleDateString("tr-TR")}${prev.qty ? ` · ${prev.qty} adet` : ""}`;
  return `<span class="pv" title="Önceki teklif: ${esc(tip)}">${formatMoney(prev.price)}</span>${arrow}`;
}

/** Tablonun üstünde her zaman görünen özet barı. */
function summaryHtml(req: QuoteRequest): string {
  let priced = 0;
  let total = 0;
  for (const it of req.items) {
    const p = priceOf(req, it);
    if (p != null) {
      priced++;
      if (it.qty != null) total += p * it.qty;
    }
  }
  const offer = state.offers[req.id];
  const status = offer?.result === "won"
    ? `<span class="badge-won">Kazanıldı</span>`
    : offer?.result === "lost"
      ? `<span class="badge-lost">Kaybedildi</span>`
      : offer
        ? `<span class="badge-wait">Teklif verildi · sonuç bekleniyor</span>`
        : `<span class="badge-wait">Hazırlanıyor</span>`;
  const totCls = offer?.result === "won" ? "offer-total-won" : offer?.result === "lost" ? "offer-total-lost" : "";
  return `<span>Toplam Kalem: <b>${req.items.length}</b></span>
    <span>Fiyatlı: <b>${priced}/${req.items.length}</b></span>
    <span>Toplam Tutar: <b class="sum-tot ${totCls}">${formatMoney(total)} ₺</b></span>
    <span>Durum: ${status}</span>`;
}

function regroup(): void {
  state.requests = groupMails([...state.mails.values()]);
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
  if (ok) toast(`${ok} e-posta yüklendi.`);
}

async function restoreSession(): Promise<void> {
  if (!backend.inTauri || !state.session.emlPaths.length) return;
  const keep: string[] = [];
  for (const path of state.session.emlPaths) {
    try {
      const data = await backend.readEml(path);
      const mail = await parseEml(data, `eml:${path}`);
      state.mails.set(mail.id, mail);
      keep.push(path);
    } catch (e) {
      console.warn("oturum dosyası açılamadı", path, e);
    }
  }
  if (keep.length !== state.session.emlPaths.length) {
    state.session.emlPaths = keep;
    persist("session");
  }
  regroup();
}

function removeRequest(req: QuoteRequest): void {
  for (const m of req.mails) {
    state.mails.delete(m.id);
    if (m.id.startsWith("eml:")) state.session.emlPaths = state.session.emlPaths.filter((p) => `eml:${p}` !== m.id);
  }
  persist("session");
  regroup();
  renderAll();
}

// ---------------------------------------------------------------- Gmail (salt okuma)

let gmail: backend.GmailStatus = { configured: false, connected: false };
let gmailBusy = false;
let gmailLast = "";

function gmailQuery(): string {
  const rules = state.settings.firms.flatMap((f) => f.match).map((m) => m.trim()).filter(Boolean);
  const since = `newer_than:${Math.max(1, state.settings.gmailDays || 3)}d`;
  // İzin listesi boşsa ilk kurulum: konusunda "teklif" geçenler, firma eklenebilsin diye.
  return rules.length ? `from:(${rules.join(" OR ")}) ${since}` : `subject:teklif ${since}`;
}

function gmailOrderQuery(): string {
  const days = Math.max(1, state.settings.gmailOrderDays || 30);
  return `(subject:(SİP OR SİB OR Sipariş OR "Açık Sipariş" OR SATINALMA OR KAZANILDI OR "iptal parça" OR SIPARIS) OR from:(*eba* OR *siparis*)) newer_than:${days}d`;
}

async function gmailRefresh(silent = false): Promise<void> {
  if (!gmail.connected || gmailBusy) return;
  gmailBusy = true;
  renderGmailBox();
  try {
    // 1. Ağır teklif istekleri (Tuğçe vb.) — kısa gün aralığı (RAM şişmesini önler)
    const quoteRefs = await backend.gmailList(gmailQuery(), 60);
    // 2. Hafif sipariş/SİP/EBA mailleri — geniş gün aralığı (30-45 gün, kazanıldı/kaybedildi için)
    const orderRefs = await backend.gmailList(gmailOrderQuery(), 60);

    const map = new Map<string, { id: string }>();
    for (const r of [...quoteRefs, ...orderRefs]) map.set(r.id, r);
    const refs = Array.from(map.values());

    const fresh = refs.filter((r) => !state.mails.has(`gmail:${r.id}`));
    let n = 0;
    for (const r of fresh) {
      $("status").textContent = `Gmail'den alınıyor: ${++n}/${fresh.length}…`;
      const raw = await backend.gmailRaw(r.id);
      const mail = await parseEml(raw, `gmail:${r.id}`);
      state.mails.set(mail.id, mail);
    }
    gmailLast = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    regroup();
    renderAll();
    if (!silent || fresh.length) toast(fresh.length ? `Gmail: ${fresh.length} yeni e-posta.` : "Gmail: yeni e-posta yok.");
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

// ---------------------------------------------------------------- sol bölme

/** Tüm sipariş maillerinden (SİP, SİB, Açık Sipariş Sorgusu vb.) geçen parça kodları havuzu */
function getOrderedCodesPool(): Set<string> {
  const pool = new Set<string>();
  for (const r of state.requests) {
    const isOrderReq = r.mails.some(m => ORDER_RE.test(m.subject));
    if (isOrderReq) {
      for (const it of r.items) {
        if (it.code) {
          pool.add(normalizeCodeStr(it.code));
          const nums = it.code.match(/\b\d{5,12}\b/g);
          if (nums) nums.forEach(n => pool.add(n));
        }
      }
      for (const m of r.mails) {
        let text = m.subject.toUpperCase();
        if (m.table) {
          for (const row of m.table.rows) {
            text += " " + row.join(" ");
          }
        }
        for (const num of text.matchAll(/\b\d{5,10}\b/g)) {
          pool.add(num[0]);
        }
      }
    }
  }
  return pool;
}

function renderSidebar(): void {
  const groups = new Map<string, { title: string; firm: Firm | null; people: Map<string, QuoteRequest[]> }>();
  for (const f of state.settings.firms) groups.set(f.id, { title: f.name, firm: f, people: new Map() });
  
  const now = Date.now();
  let hiddenOldOffers = 0;
  const orderedCodes = getOrderedCodesPool();

  for (const r of state.requests) {
    const key = firmKey(r);
    if (!groups.has(key)) groups.set(key, { title: `${suggestFirmName(r.sender.address, r.sender.name)} (izin listesinde yok)`, firm: null, people: new Map() });
    
    const personName = r.sender.name.trim() || r.sender.address;
    const peopleMap = groups.get(key)!.people;
    if (!peopleMap.has(personName)) peopleMap.set(personName, []);
    peopleMap.get(personName)!.push(r);
  }

  let html = "";
  if (!groups.size) html = `<h4>Firmalar</h4><div class="empty">Henüz teklif isteği yok.</div>`;
  for (const [key, g] of groups) {
    html += `<h4 class="firm-title" style="cursor:pointer; user-select:none;">${esc(g.title)} <span class="arrow" style="float:right;">▼</span></h4>`;
    html += `<div class="firm-reqs" style="display:block;">`;
    
    const sortedPeople = Array.from(g.people.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    
    if (!sortedPeople.length) {
      html += `<div class="req"><small>Teklif isteği yok</small></div>`;
    }
    
    for (const [personName, reqs] of sortedPeople) {
       html += `<div style="padding: 4px 8px; font-weight: bold; font-size: 11px; color: var(--ac); margin-top: 4px; border-top: 1px solid var(--bd);">👤 ${esc(personName)}</div>`;
       for (const r of reqs) {
          const offer = state.offers[r.id];
          
          // EBA'dan veya Tuğçe'den gelen SİP / SİB / Açık Sipariş Sorgusu maillerinde bu parçalar var mı?
          const isDirectOrderMail = r.mails.some(m => ORDER_RE.test(m.subject));
          const hasMatchingOrder = r.items.some(it => {
            const norm = normalizeCodeStr(it.code);
            if (orderedCodes.has(norm)) return true;
            const nums = it.code.match(/\b\d{5,12}\b/g);
            return nums ? nums.some(n => orderedCodes.has(n)) : false;
          });

          if ((isDirectOrderMail || hasMatchingOrder) && offer && !offer.result) {
            offer.result = "won";
            persist("offers");
          }

          // KULLANICI KURALI: Teklifi henüz VERİLMEMİŞ (hazırlanmamış) mailler ASLA gizlenmez!
          // Sadece teklifi verilmiş ve üzerinden 24 saat geçmişler onay kutusuyla gizlenebilir.
          const isOld = offer && (now - new Date(offer.at).getTime() > 24 * 60 * 60 * 1000);
          if (isOld && !showOldOffers && r.id !== state.selectedRequest) {
            hiddenOldOffers++;
            continue;
          }

          // Teklif toplam tutarı
          let offerTotal = 0;
          for (const it of r.items) {
            const p = priceOf(r, it);
            if (p != null && it.qty != null) {
              offerTotal += p * it.qty;
            }
          }

          const ready = r.items.filter((i) => i.status === "ready").length;
          const parts = !r.partTotal || !r.partsReceived.length
            ? `${r.mails.length} e-posta${r.partTotal ? ` (${r.partTotal} parçalık istek)` : ""}`
            : r.partsReceived.length >= r.partTotal
              ? `Parça 1–${r.partTotal} birleşti`
              : `Parça ${r.partsReceived.join(", ")} / ${r.partTotal} geldi`;
          
          const bits = [parts, `${ready}/${r.items.length} çizim`];
          if (r.deadline) bits.push(`son tarih ${r.deadline.replace(/\.\d{4}/, "")}`);
          
          let resultBadge = "";
          let totalSpan = "";
          if (offer) {
            const isWon = offer.result === "won";
            const isLost = offer.result === "lost";
            if (offerTotal > 0) {
              totalSpan = `<span class="${isWon ? "offer-total-won" : isLost ? "offer-total-lost" : ""}" style="font-size:12px;">${formatMoney(offerTotal)} ₺</span>`;
            }
            if (isWon) resultBadge = `<span class="badge-won">✅ Kazanıldı</span>`;
            else if (isLost) resultBadge = `<span class="badge-lost">❌ Kaybedildi</span>`;
          }

          const band = offer?.result === "won" ? "won" : offer?.result === "lost" ? "lost" : "";
          html += `<div class="req ${r.id === state.selectedRequest ? "on" : ""} ${band}" data-req="${esc(r.id)}">
            <button class="btn-rm" data-rmreq="${esc(r.id)}" title="Gizle/Sil">×</button>
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <b>${esc(requestTitle(r))}</b>
              ${resultBadge}
            </div>
            <small>${esc(bits.join(" · "))}</small>
            ${offer ? `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:3px;">
              <small class="ok">Teklif hazırlandı ✓ ${totalSpan}</small>
              <select class="res ${offer.result === "won" ? "res-won" : offer.result === "lost" ? "res-lost" : ""}" data-res="${esc(r.id)}">
                <option value="" ${!offer.result ? "selected" : ""}>Sonuç: bekleniyor</option>
                <option value="won" ${offer.result === "won" ? "selected" : ""}>Kazanıldı</option>
                <option value="lost" ${offer.result === "lost" ? "selected" : ""}>Kaybedildi</option>
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

  if (hiddenOldOffers > 0 || showOldOffers) {
    html += `<div style="padding: 8px 12px; font-size: 11px; color: var(--mu); border-top: 1px solid var(--bd); margin-top: 8px;">
      <label style="cursor: pointer; display: flex; align-items: center; gap: 6px;">
        <input type="checkbox" id="chk-old-offers" ${showOldOffers ? "checked" : ""}> 1 günden eski teklifleri göster (${hiddenOldOffers} gizli)
      </label>
    </div>`;
  }

  $("firms").innerHTML = html;
  
  const chkOld = $<HTMLInputElement>("chk-old-offers");
  if (chkOld) {
    chkOld.onchange = () => {
      showOldOffers = chkOld.checked;
      renderSidebar();
    };
  }
  $("arch").textContent = `Arşiv: ${state.settings.archiveRoot}`;
}

function onSidebarClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const rm = t.closest<HTMLElement>("[data-rmreq]");
  if (rm) {
    e.stopPropagation();
    const req = state.requests.find((r) => r.id === rm.dataset.rmreq);
    if (req && confirm("Bu isteği listeden kaldırmak istediğinize emin misiniz?")) removeRequest(req);
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
  const offer = state.offers[id];
  if (!offer) return;
  offer.result = (sel.value || null) as Result;
  persist("offers");
  backend.recordResult(id, offer.result).catch((err) => console.warn(err));
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

  const qc = req.qtyCol;
  const dc = descCol(req);
  // Gizlenen sütunlar (başlık adına göre, tüm isteklerde geçerli)
  const visible = req.headers.map((_, c) => c).filter((c) => !hiddenCols.includes(req.headers[c]));
  const head = visible.map((c) => {
    const h = req.headers[c];
    return `<th class="${c === qc ? "n" : ""}" data-col="${esc(h)}" data-hideable="1" title="${esc(h)} — sağ tık: gizle"><span class="th-l">${esc(h)}</span><button class="th-x" data-hide="${esc(h)}" title="Sütunu gizle">×</button></th>`;
  }).join("");
  const rows = req.items.map((it) => {
    const cells = visible.map((c) => {
      const v = it.cells[c] ?? "";
      if (c === req.codeCol) return `<td class="code" title="${esc(v)}"><span class="dot ${it.status}" title="${statusLabel(it)}"></span>${esc(v)}</td>`;
      if (c === dc) return `<td class="desc" title="${esc(v)}">${esc(v)}</td>`;
      return `<td class="${c === qc ? "n" : ""}" title="${esc(v)}">${esc(v)}</td>`;
    }).join("");
    const pt = priceText(req, it);
    const bad = pt && parsePrice(pt) == null;
    return `<tr class="row ${it.index === state.selectedItem ? "sel" : ""}" data-i="${it.index}">${cells}
      <td class="n stk stk-first" data-stk="2" id="pv${it.index}">${prevCellHtml(req, it)}</td>
      <td class="n stk" data-stk="1"><input data-i="${it.index}" value="${esc(pt)}" inputmode="decimal" placeholder="—" ${bad ? 'style="border-color:var(--er)"' : ""}></td>
      <td class="n tot stk" data-stk="0" id="t${it.index}">${totalText(req, it)}</td></tr>`;
  }).join("");

  const notes: string[] = [];
  const offer = state.offers[req.id];
  if (offer && offer.result === "won") {
    notes.push(`<div class="won-banner">✅ <b>SİPARİŞ ONAYLANDI:</b> Bu teklif kazanıldı ve işleme girmelidir.</div>`);
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
    <p class="mu">Satırın üzerine gelince sağda çizim önizlemesi büyür, çift tıkla tam ekran açılır.</p>
    ${notes.map((n) => `<div class="note">${n}</div>`).join("")}
    <p class="mu">Gönderen: ${esc([...new Set(src)].join(", "))} · <a href="#" id="rm">Bu isteği listeden kaldır</a></p>`;

  mid.querySelectorAll<HTMLElement>("[data-um]").forEach((a) => (a.onclick = () => showFullPage(req.unmatchedDrawings[Number(a.dataset.um)])));
  $("rm").onclick = (e) => {
    e.preventDefault();
    removeRequest(req);
  };
  
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
    
  const prev = getPreviousPrice(req, item.code);
  let prevText = "";
  if (prev) {
    prevText = `<div class="b-prev" style="margin-top:10px; color:var(--wa); font-weight:600">Önceki Fiyat: ${formatMoney(prev.price)} TL (${new Date(prev.date).toLocaleDateString("tr-TR")})</div>`;
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
  state.offers[req.id] = { path, at: new Date().toISOString(), result: state.offers[req.id]?.result ?? null };
  persist("offers");
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
          <input type="number" id="sdays" min="1" max="60" value="${s.gmailDays}">
          <div class="mu" style="font-size:11px; margin-top:2px;">Ağır PDF çizimleri için 1-3 gün önerilir.</div>
        </div>
        <div>
          <label>Sipariş / SİP / EBA Gün Sayısı</label>
          <input type="number" id="sorderdays" min="1" max="180" value="${s.gmailOrderDays || 30}">
          <div class="mu" style="font-size:11px; margin-top:2px;">Kazanılanları yakalamak için 30-45 gün önerilir.</div>
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
      s.gmailDays = Math.max(1, Math.min(60, Number($<HTMLInputElement>("sdays").value) || 2));
      s.gmailOrderDays = Math.max(1, Math.min(180, Number($<HTMLInputElement>("sorderdays").value) || 30));
      const wantAuto = $<HTMLInputElement>("sauto").checked;
      if (wantAuto !== auto) await backend.setAutostart(wantAuto).catch((e) => toast(`Açılışta başlatma ayarlanamadı: ${errText(e)}`));
      persist("settings");
      closeModal();
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
