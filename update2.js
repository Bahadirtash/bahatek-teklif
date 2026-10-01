import fs from 'fs';

// 1. Edit index.html
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace('<aside class="col right" id="rp"><p class="mu">Bir satır seçin.</p></aside>', '');
fs.writeFileSync('index.html', html);

// 2. Edit styles.css
let css = fs.readFileSync('src/styles.css', 'utf8');
css = css.replace('grid-template-columns:230px minmax(0,1fr) 340px', 'grid-template-columns:230px minmax(0,1fr)');
if (!css.includes('.bubble')) {
  css += `
.bubbles { display: flex; flex-direction: column; gap: 12px; padding-bottom: 24px; }
.bubble { display: flex; gap: 16px; background: var(--pn); border: 1px solid var(--bd); border-radius: 8px; padding: 12px; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
.bubble:hover { border-color: var(--ac); }
.bubble.sel { border-color: var(--ac); background: var(--hl); }
.bubble .b-thumb { width: 100px; height: 100px; border: 1px solid var(--bd); border-radius: 6px; cursor: zoom-in; object-fit: contain; background: #fff; flex-shrink: 0; }
.bubble .b-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.bubble .b-title { font-weight: 600; font-size: 15px; color: var(--ac); }
.bubble .b-meta { font-size: 13px; color: var(--mu); }
.bubble .b-prev { font-size: 12px; color: var(--wa); margin-top: 4px; font-weight: 500; }
.bubble .b-price { width: 140px; text-align: right; display: flex; flex-direction: column; align-items: flex-end; }
.bubble .b-price input { width: 100%; text-align: right; font-size: 16px; padding: 8px; border: 2px solid var(--bd); border-radius: 6px; }
.bubble .b-price input:focus { border-color: var(--ac); outline: none; }
.bubble .b-price input.bad { border-color: var(--er); }
.b-price-label { font-size: 11px; color: var(--mu); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
.b-total { font-weight: 600; font-size: 14px; margin-top: 6px; color: var(--tx); }

#md-price { position: absolute; top: 16px; right: 80px; display: flex; gap: 8px; align-items: center; background: rgba(0,0,0,0.7); padding: 8px 12px; border-radius: 8px; z-index: 30; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
#md-price label { color: #fff; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
#md-price input { padding: 6px 10px; font-size: 15px; border-radius: 4px; border: none; text-align: right; width: 120px; outline: none; }
#md-price input:focus { box-shadow: 0 0 0 2px var(--ac); }
`;
}
fs.writeFileSync('src/styles.css', css);

// 3. Edit main.ts
let ts = fs.readFileSync('src/main.ts', 'utf8');

const getPrevFn = `export function getPreviousPrice(req: QuoteRequest, code: string): { price: number; date: string } | null {
  let best: { price: number; date: string } | null = null;
  for (const [rId, offer] of Object.entries(state.offers)) {
    if (rId === req.id) continue;
    const prices = state.prices[rId];
    if (!prices) continue;
    const key = Object.keys(prices).find(k => k.endsWith(\`-\${code}\`));
    if (key && prices[key]) {
      const p = parsePrice(prices[key]);
      if (p != null && (!best || new Date(offer.at) > new Date(best.date))) {
        best = { price: p, date: offer.at };
      }
    }
  }
  return best;
}

function setPrice(req: QuoteRequest, item: Item, val: string): void {`;
ts = ts.replace('function setPrice(req: QuoteRequest, item: Item, val: string): void {', getPrevFn);

// Replace saveOffer logic
ts = ts.replace(
  'headers: req.headers,\n      qtyCol: req.qtyCol,\n      rows: rows.map((it) => ({ cells: it.cells, qty: it.qty, price: priceOf(req, it) })),',
  `headers: [...req.headers, "Önceki Fiyat", "Önceki Tarih"],
      qtyCol: req.qtyCol,
      rows: rows.map((it) => {
        const prev = getPreviousPrice(req, it.code);
        return {
          cells: [...it.cells, prev ? formatMoney(prev.price) : "", prev ? new Date(prev.date).toLocaleDateString("tr-TR") : ""],
          qty: it.qty,
          price: priceOf(req, it)
        };
      }),`
);

// We need to modify renderRequest body EXACTLY.
// Let's replace from `const qc = req.qtyCol;` to `bindTable(req);`
const startIdx = ts.indexOf('const qc = req.qtyCol;');
const endStr = '  bindTable(req);\n}';
const endIdx = ts.indexOf(endStr, startIdx) + endStr.length;

if (startIdx !== -1 && endIdx !== -1) {
  const replacement = `const dc = descCol(req);
  const rows = req.items.map((it) => {
    const pt = priceText(req, it);
    const bad = pt && parsePrice(pt) == null;
    const prev = getPreviousPrice(req, it.code);
    
    let thumbUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' fill='%23f4f5f7'/%3E%3Cpath d='M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z' fill='%23bdc3c7'/%3E%3C/svg%3E";
    
    return \`<div class="bubble \${it.index === state.selectedItem ? "sel" : ""}" data-i="\${it.index}">
      <img src="\${thumbUrl}" class="b-thumb" alt="Çizim" id="bimg-\${it.index}">
      <div class="b-info">
        <div class="b-title"><span class="dot \${it.status}" title="\${statusLabel(it)}"></span>\${esc(it.code)}</div>
        <div class="b-meta">\${esc(it.cells[dc] || "Açıklama yok")}</div>
        <div class="b-meta">Miktar: \${it.qty != null ? it.qty : "Belirsiz"}</div>
        \${prev ? \`<div class="b-prev">Önceki: \${formatMoney(prev.price)} TL (\${new Date(prev.date).toLocaleDateString("tr-TR")})</div>\` : ""}
      </div>
      <div class="b-price">
        <div class="b-price-label">Birim Fiyat</div>
        <input data-i="\${it.index}" value="\${esc(pt)}" inputmode="decimal" placeholder="0,00" \${bad ? 'class="bad"' : ""}>
        <div class="b-total" id="t\${it.index}">\${totalText(req, it)}</div>
      </div>
    </div>\`;
  }).join("");

  const notes: string[] = [];
  const waiting = req.items.filter((i) => i.status === "waiting").length;
  const missing = req.items.filter((i) => i.status === "missing").length;
  if (req.partTotal && req.partsReceived.length && req.partsReceived.length < req.partTotal) {
    const miss = Array.from({ length: req.partTotal }, (_, k) => k + 1).filter((p) => !req.partsReceived.includes(p));
    notes.push(\`<span class="warn">Parça \${miss.join(", ")} henüz gelmedi</span> — \${waiting} kalemin çizimi bekleniyor.\`);
  } else if (waiting) {
    notes.push(\`\${waiting} kalemin çizimi bekleniyor.\`);
  }
  if (missing) notes.push(\`<span class="err">\${missing} kalemin çizimi hiçbir parçada gelmedi.</span>\`);
  for (const w of req.warnings) notes.push(\`<span class="warn">\${esc(w)}</span>\`);
  if (!req.items.length) notes.push(\`<span class="warn">Bu e-postalarda kalem tablosu bulunamadı.</span>\`);

  const src = req.mails.map((m) => (m.forwardedBy ? \`\${m.sender.address} (ileten: \${m.forwardedBy.address})\` : m.sender.address));
  
  mid.innerHTML = \`<div class="bubbles" id="tb">\${rows}</div>
    <p class="mu">Çizim önizlemesi için küçük resme tıklayın.</p>
    \${notes.map((n) => \`<div class="note">\${n}</div>\`).join("")}
    <p class="mu">Gönderen: \${esc([...new Set(src)].join(", "))} · <a href="#" id="rm">Bu isteği listeden kaldır</a></p>\`;

  req.items.forEach(async it => {
    if (it.drawings[0]) {
      try {
        const c = await renderCrop(it.drawings[0]);
        const img = document.getElementById(\`bimg-\${it.index}\`) as HTMLImageElement;
        if (img) img.src = c.url;
      } catch (e) {}
    }
  });

  const rm = $("rm");
  if (rm) rm.onclick = (e) => { e.preventDefault(); removeRequest(req); };
  
  bindTable(req);
}`;
  ts = ts.substring(0, startIdx) + replacement + ts.substring(endIdx);
} else {
  console.log("Could not find renderRequest body!");
}

// Replace bindTable
const bindTableStart = ts.indexOf('function bindTable(req: QuoteRequest): void {');
const bindTableEndStr = '  tb.addEventListener("mousemove", (e) => {';
const bindTableEndIdx = ts.indexOf(bindTableEndStr, bindTableStart);
if (bindTableStart !== -1 && bindTableEndIdx !== -1) {
  const tbReplacement = `function bindTable(req: QuoteRequest): void {
  const tb = $("tb");
  if (!tb) return;
  tb.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const bubble = t.closest<HTMLElement>(".bubble");
    if (!bubble) return;
    const i = Number(bubble.dataset.i);
    
    if (t.tagName === "IMG" && t.classList.contains("b-thumb")) {
      const item = req.items[i];
      if (item && item.drawings.length > 0) showFullPage(item.drawings[0], item);
      return;
    }
    
    if (t.tagName === "INPUT") {
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
    inp.classList.toggle("bad", !!inp.value.trim() && parsePrice(inp.value) == null);
    const tEl = $(\`t\${item.index}\`);
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
    const next = tb.querySelector<HTMLInputElement>(\`input[data-i="\${Number(inp.dataset.i) + 1}"]\`);
    if (next) {
      openItem(Number(next.dataset.i), false);
      next.focus();
      next.select();
    }
  });

  // Keep mousemove dummy to replace the exact block structure
  tb.addEventListener("mousemove", (e) => {`;
  ts = ts.substring(0, bindTableStart) + tbReplacement + ts.substring(bindTableEndIdx + bindTableEndStr.length);
}

// Clean up openItem and remove renderRight usage
const openItemStart = ts.indexOf('function openItem(i: number, focusPrice = false): void {');
const openItemEndStr = '  renderRight(focusPrice);\n}';
const openItemEndIdx = ts.indexOf(openItemEndStr, openItemStart) + openItemEndStr.length;
if (openItemStart !== -1 && openItemEndIdx !== -1) {
  const openItemReplacement = `function openItem(i: number, focusPrice = false): void {
  state.selectedItem = i;
  document.querySelectorAll<HTMLElement>(".bubble").forEach((x) => x.classList.toggle("sel", Number(x.dataset.i) === i));
  document.querySelector(\`.bubble[data-i="\${i}"]\`)?.scrollIntoView({ block: "nearest" });
  if (focusPrice) {
    const inp = document.querySelector<HTMLInputElement>(\`input[data-i="\${i}"]\`);
    if (inp) { inp.focus(); inp.select(); }
  }
}`;
  ts = ts.substring(0, openItemStart) + openItemReplacement + ts.substring(openItemEndIdx);
}

// Remove renderRight body (we can just leave it as empty function to not break references if any)
const rrStart = ts.indexOf('function renderRight(focusPrice = false): void {');
const rrEndStr = '    apply();\n  };\n}';
const rrEndIdx = ts.indexOf(rrEndStr, rrStart) + rrEndStr.length;
if (rrStart !== -1 && rrEndIdx !== -1) {
  ts = ts.substring(0, rrStart) + 'function renderRight(focusPrice = false): void {}' + ts.substring(rrEndIdx);
}

// Modify showFullPage
ts = ts.replace('async function showFullPage(d: Drawing): Promise<void> {', 'async function showFullPage(d: Drawing, item: Item | null = null): Promise<void> {');
ts = ts.replace(
  'const box = openModal(\n    `<div class="mhead"><h3>${esc(d.filename)}</h3>',
  `const req = currentRequest();
  const box = openModal(
    \`<div class="mhead"><h3>\${esc(d.filename)}</h3>
      \${item && req ? \`
      <div id="md-price">
        <label>Teklif Ver:</label>
        <input type="text" id="pdf-price" inputmode="decimal" placeholder="0,00" value="\${esc(priceText(req, item))}">
      </div>\` : ""}
`
);

const zcStart = ts.indexOf('$("zc").onclick = closeModal;');
if (zcStart !== -1) {
  const zcReplacement = `$("zc").onclick = closeModal;
  if (item && req) {
    const pInput = $<HTMLInputElement>("pdf-price");
    if (pInput) {
      pInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const p = parsePrice(pInput.value);
          if (p != null && p > 0) pInput.value = formatMoney(p);
          setPrice(req, item, pInput.value);
          closeModal();
          renderRequest(); // re-render bubbles to show new price
          renderFooter();
        }
      };
    }
  }`;
  ts = ts.substring(0, zcStart) + zcReplacement + ts.substring(zcStart + '$("zc").onclick = closeModal;'.length);
}

fs.writeFileSync('src/main.ts', ts);
console.log('Update complete!');
