// Bahatek Teklif arayüzü — prototype/teklif-prototip.html görünümü ve akışı, gerçek veriyle.
import * as backend from "./backend";
import { groupMails, parseEml } from "./eml";
import type { Drawing, Item, QuoteRequest } from "./eml";
import { cleanSubject, dayOf, esc, formatMoney, gmailComposeUrl, parsePrice, todayDotted } from "./format";
import { renderCrop, renderFullPage } from "./pdf/render";
import {
  firmKey, firmOf, isPublicDomain, itemKey, loadState, newId, persist, state, suggestFirmName,
} from "./state";
import type { Firm, Result } from "./state";

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

function priceText(req: QuoteRequest, item: Item): string {
  return state.prices[req.id]?.[itemKey(item.index, item.code)] ?? "";
}

function priceOf(req: QuoteRequest, item: Item): number | null {
  const p = parsePrice(priceText(req, item));
  return p != null && p > 0 ? p : null;
}
export function getPreviousPrice(req: QuoteRequest, code: string): { price: number; date: string } | null {
  let best: { price: number; date: string } | null = null;
  for (const [rId, offer] of Object.entries(state.offers)) {
    if (rId === req.id) continue;
    const prices = state.prices[rId];
    if (!prices) continue;
    const key = Object.keys(prices).find(k => k.endsWith(`-${code}`));
    if (key && prices[key]) {
      const p = parsePrice(prices[key]);
      if (p != null && (!best || new Date(offer.at) > new Date(best.date))) {
        best = { price: p, date: offer.at };
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

// ---------------------------------------------------------------- mail yükleme

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
  const since = `newer_than:${Math.max(1, state.settings.gmailDays)}d`;
  // İzin listesi boşsa ilk kurulum: konusunda "teklif" geçenler, firma eklenebilsin diye.
  return rules.length ? `from:(${rules.join(" OR ")}) ${since}` : `subject:teklif ${since}`;
}

async function gmailRefresh(silent = false): Promise<void> {
  if (!gmail.connected || gmailBusy) return;
  gmailBusy = true;
  renderGmailBox();
  try {
    const refs = await backend.gmailList(gmailQuery(), 60);
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
  const box = openModal(
    `<div class="mhead" style="justify-content: space-between;">
        <h3 style="margin:0">${esc(d.filename)}</h3>
        <div style="display:flex; align-items:center; gap: 16px;">
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
          closeModal();
          renderMid(); // re-render bubbles to show new price
          renderFooter();
        }
      };
    }
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

function renderSidebar(): void {
  const groups = new Map<string, { title: string; firm: Firm | null; people: Map<string, QuoteRequest[]> }>();
  for (const f of state.settings.firms) groups.set(f.id, { title: f.name, firm: f, people: new Map() });
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
          const ready = r.items.filter((i) => i.status === "ready").length;
          const parts = !r.partTotal || !r.partsReceived.length
            ? `${r.mails.length} e-posta${r.partTotal ? ` (${r.partTotal} parçalık istek)` : ""}`
            : r.partsReceived.length >= r.partTotal
              ? `Parça 1–${r.partTotal} birleşti`
              : `Parça ${r.partsReceived.join(", ")} / ${r.partTotal} geldi`;
          const offer = state.offers[r.id];
          const bits = [parts, `${ready}/${r.items.length} çizim`];
          if (r.deadline) bits.push(`son tarih ${r.deadline.replace(/\.\d{4}/, "")}`);
          html += `<div class="req ${r.id === state.selectedRequest ? "on" : ""}" data-req="${esc(r.id)}">
            <button class="btn-rm" data-rmreq="${esc(r.id)}" title="Gizle/Sil">×</button>
            <b>${esc(requestTitle(r))}</b><small>${esc(bits.join(" · "))}</small>
            ${offer ? `<small class="ok">Teklif hazırlandı ✓</small>
              <select class="res" data-res="${esc(r.id)}">
                <option value="" ${!offer.result ? "selected" : ""}>Sonuç: bekleniyor</option>
                <option value="won" ${offer.result === "won" ? "selected" : ""}>Kazanıldı</option>
                <option value="lost" ${offer.result === "lost" ? "selected" : ""}>Kaybedildi</option>
              </select>` : ""}
          </div>`;
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
  const head = req.headers.map((h, c) => `<th class="${c === qc ? "n" : ""}">${esc(h)}</th>`).join("");
  const rows = req.items.map((it) => {
    const cells = it.cells.map((v, c) => {
      if (c === req.codeCol) return `<td class="code"><span class="dot ${it.status}" title="${statusLabel(it)}"></span>${esc(v)}</td>`;
      if (c === dc) return `<td class="desc" title="${esc(v)}">${esc(v)}</td>`;
      return `<td class="${c === qc ? "n" : ""}">${esc(v)}</td>`;
    }).join("");
    const pt = priceText(req, it);
    const bad = pt && parsePrice(pt) == null;
    return `<tr class="row ${it.index === state.selectedItem ? "sel" : ""}" data-i="${it.index}">${cells}
      <td class="n"><input data-i="${it.index}" value="${esc(pt)}" inputmode="decimal" placeholder="—" ${bad ? 'style="border-color:var(--er)"' : ""}></td>
      <td class="n tot" id="t${it.index}">${totalText(req, it)}</td></tr>`;
  }).join("");

  const notes: string[] = [];
  const offer = state.offers[req.id];
  if (offer && offer.result === "won") {
    notes.push(`<div class="won-banner">✅ <b>SİPARİŞ ONAYLANDI:</b> Bu teklif kazanıldı ve işleme girmelidir.</div>`);
  }
  const waiting = req.items.filter((i) => i.status === "waiting").length;
  const missing = req.items.filter((i) => i.status === "missing").length;
  if (req.partTotal && req.partsReceived.length && req.partsReceived.length < req.partTotal) {
    const miss = Array.from({ length: req.partTotal }, (_, k) => k + 1).filter((p) => !req.partsReceived.includes(p));
    notes.push(`<span class="warn">Parça ${miss.join(", ")} henüz gelmedi</span> — ${waiting} kalemin çizimi bekleniyor. Parça gelince otomatik eşleşir.`);
  } else if (waiting) {
    notes.push(`${waiting} kalemin çizimi bekleniyor.`);
  }
  if (missing) notes.push(`<span class="err">${missing} kalemin çizimi hiçbir parçada gelmedi.</span>`);
  if (req.unmatchedDrawings.length) {
    notes.push(`<b>Hiçbir kaleme eşleşmeyen çizimler (${req.unmatchedDrawings.length}):</b><ul>${req.unmatchedDrawings
      .map((d, k) => `<li><a data-um="${k}">${esc(d.filename)}</a></li>`).join("")}</ul>`);
  }
  if (req.unrecognizedPdfs.length) {
    notes.push(`<b>Adı çizim biçimine uymayan PDF ekleri:</b><ul>${req.unrecognizedPdfs.map((d) => `<li>${esc(d.filename)}</li>`).join("")}</ul>`);
  }
  for (const w of req.warnings) notes.push(`<span class="warn">${esc(w)}</span>`);
  if (!req.items.length) notes.push(`<span class="warn">Bu e-postalarda kalem tablosu bulunamadı. Tablo içeren parça gelince birleşir.</span>`);

  const src = req.mails.map((m) => (m.forwardedBy ? `${m.sender.address} (ileten: ${m.forwardedBy.address})` : m.sender.address));
  mid.innerHTML = `<div class="tw"><table><thead><tr>${head}<th class="n new">Birim Fiyat</th><th class="n new">Toplam</th></tr></thead>
    <tbody id="tb">${rows}</tbody></table></div>
    <p class="mu">Satırın üzerine gelince çizim önizlemesi açılır, tıklayınca sağda büyür.</p>
    ${notes.map((n) => `<div class="note">${n}</div>`).join("")}
    <p class="mu">Gönderen: ${esc([...new Set(src)].join(", "))} · <a href="#" id="rm">Bu isteği listeden kaldır</a></p>`;

  mid.querySelectorAll<HTMLElement>("[data-um]").forEach((a) => (a.onclick = () => showFullPage(req.unmatchedDrawings[Number(a.dataset.um)])));
  $("rm").onclick = (e) => {
    e.preventDefault();
    removeRequest(req);
  };
  bindTable(req);
}

function bindTable(req: QuoteRequest): void {
  const tb = $("tb");
  tb.addEventListener("mouseover", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr.row");
    if (!tr) {
      $("tip").style.display = "none";
      return;
    }
    const item = req.items[Number(tr.dataset.i)];
    const d = item?.drawings[0];
    if (d) {
      const tip = $("tip");
      tip.style.display = "block";
      const img = $("ti") as HTMLImageElement;
      if (img.dataset.f !== d.filename) {
        img.src = "";
        img.dataset.f = d.filename;
        renderCrop(d).then((c) => {
          if (img.dataset.f === d.filename) img.src = c.url;
        }).catch(() => (img.src = ""));
      }
      const rect = tr.getBoundingClientRect();
      let top = rect.bottom;
      if (top + tip.offsetHeight > window.innerHeight) top = Math.max(0, rect.top - tip.offsetHeight);
      tip.style.top = `${top}px`;
      tip.style.left = `${Math.min(rect.left + 50, window.innerWidth - tip.offsetWidth - 20)}px`;
    }
  });
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
    <div class="mu" style="margin-top:6px">Enter: uygula ve sonraki kaleme geç</div>`;

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
  const full = $<HTMLInputElement>("full");
  full.checked = req ? !!state.settings.fullList[firmKey(req)] : false;
  full.disabled = !req;
  $<HTMLButtonElement>("prep").disabled = !req || !items.length;
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
  if (!req) return;
  const full = !!state.settings.fullList[firmKey(req)];
  const rows = req.items.filter((it) => full || priceOf(req, it) != null);
  const unpriced = req.items.filter((it) => priceOf(req, it) == null).length;
  const badInput = req.items.filter((it) => priceText(req, it) && parsePrice(priceText(req, it)) == null).length;
  const day = dayOf(req.requestTag ?? "") ?? dayOf(req.date) ?? todayDotted();
  const folder = `${day} - ${cleanSubject(req.subject) || "Teklif İsteği"}`;
  const firm = firmName(req);

  let path: string;
  try {
    path = await backend.saveOffer({
      archiveRoot: state.settings.archiveRoot,
      firm,
      folder,
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
      <label>Gmail'den kaç günlük e-posta okunsun</label>
      <input type="number" id="sdays" min="1" max="365" value="${s.gmailDays}">
      <label><input type="checkbox" id="sauto" ${auto ? "checked" : ""} ${backend.inTauri ? "" : "disabled"}> Bilgisayar açılınca başlat</label>
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
      s.gmailDays = Math.max(1, Math.min(365, Number($<HTMLInputElement>("sdays").value) || 30));
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
}

init().catch((e) => {
  console.error(e);
  backend.logToTerminal("hata", String(e?.stack ?? e));
  document.body.insertAdjacentHTML("afterbegin", `<p class="err" style="padding:8px 16px">Başlatma hatası: ${esc(errText(e))}</p>`);
});
