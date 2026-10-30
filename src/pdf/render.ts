// Çizim PDF'lerini bellekte (PDF.js) render eder; diske hiçbir şey yazılmaz.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Drawing } from "../eml";
import { cropLayout, findContentBox, findFrame } from "./crop";
import Tesseract from 'tesseract.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface CropImage {
  url: string;
  width: number;
  height: number;
  /** V3 veri kaydı için küçük PNG. */
  thumb: () => Promise<Uint8Array>;
}

const docs = new WeakMap<Drawing, Promise<PDFDocumentProxy>>();
const crops = new WeakMap<Drawing, Promise<CropImage>>();

function loadDoc(d: Drawing): Promise<PDFDocumentProxy> {
  let p = docs.get(d);
  if (!p) {
    // PDF.js veriyi worker'a aktarırken tamponu boşaltır; kopya verilir.
    p = pdfjs.getDocument({ data: d.data.slice(), verbosity: 0 }).promise;
    docs.set(d, p);
  }
  return p;
}

// Aynı anda tek render: arayüz akıcı kalsın.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

function canvasToBlob(c: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("görsel üretilemedi"))), type));
}

async function renderPageCanvas(d: Drawing, maxPixels: number, maxScale: number): Promise<{ canvas: HTMLCanvasElement; scale: number; w: number; h: number }> {
  const ext = d.filename.toLowerCase().split('.').pop();
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
    return new Promise((resolve, reject) => {
      const blob = new Blob([d.data as any]);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(maxScale, Math.sqrt(maxPixels / (img.width * img.height)));
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(img.width * scale);
        canvas.height = Math.ceil(img.height * scale);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({ canvas, scale, w: img.width, h: img.height });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Görsel yüklenemedi"));
      };
      img.src = url;
    });
  }

  const doc = await loadDoc(d);
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxScale, Math.sqrt(maxPixels / (base.width * base.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  return { canvas, scale, w: base.width, h: base.height };
}

/** Görünüşlerin olduğu orta alan (revizyon tablosu ve antet hariç). */
export function renderCrop(d: Drawing): Promise<CropImage> {
  let p = crops.get(d);
  if (!p) {
    p = serial(async () => {
      const { canvas, scale: s, w, h } = await renderPageCanvas(d, 16e6, 3.5);
      const ctx = canvas.getContext("2d")!;
      const framePx = findFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
      const frame = framePx && { x: framePx.x / s, y: framePx.y / s, w: framePx.w / s, h: framePx.h / s };
      const layout = cropLayout(w, h, frame);
      ctx.fillStyle = "#fff";
      for (const r of layout.exclude) ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      const R = {
        x: Math.round(layout.region.x * s),
        y: Math.round(layout.region.y * s),
        w: Math.round(layout.region.w * s),
        h: Math.round(layout.region.h * s),
      };
      const box = findContentBox(ctx.getImageData(R.x, R.y, R.w, R.h)) ?? { x: 0, y: 0, w: R.w, h: R.h };
      const out = document.createElement("canvas");
      out.width = box.w;
      out.height = box.h;
      out.getContext("2d")!.drawImage(canvas, R.x + box.x, R.y + box.y, box.w, box.h, 0, 0, box.w, box.h);
      const url = URL.createObjectURL(await canvasToBlob(out));
      const thumb = async () => {
        const k = Math.min(1, 400 / Math.max(out.width, out.height));
        const t = document.createElement("canvas");
        t.width = Math.max(1, Math.round(out.width * k));
        t.height = Math.max(1, Math.round(out.height * k));
        const tc = t.getContext("2d")!;
        tc.imageSmoothingQuality = "high";
        tc.drawImage(out, 0, 0, t.width, t.height);
        return new Uint8Array(await (await canvasToBlob(t)).arrayBuffer());
      };
      return { url, width: box.w, height: box.h, thumb };
    });
    p.catch(() => crops.delete(d));
    crops.set(d, p);
  }
  return p;
}

/** Tam sayfa (kırpmasız) görüntü; büyütülerek incelenebilsin diye yüksek çözünürlük. */
export async function renderFullPage(d: Drawing): Promise<{ url: string; width: number; height: number }> {
  return serial(async () => {
    const { canvas } = await renderPageCanvas(d, 36e6, 6);
    const url = URL.createObjectURL(await canvasToBlob(canvas));
    return { url, width: canvas.width, height: canvas.height };
  });
}

/** Bilinen endüstriyel malzeme kaliteleri ve standartları */
const KNOWN_MATERIALS = [
  /\b(AISI\s*\d{3}[A-Z]*)\b/i,
  /\b(1\.\d{4})\b/i,
  /\b(St\s*-?\s*\d{2}(?:-\d)?)\b/i,
  /\b(C\s*-?\s*\d{2})\b/i,
  /\b(Ç\s*-?\s*\d{4})\b/i,
  /\b(4140|1040|4340|2379|2083)\b/i,
  /\b(Al[uü]minyum(?:\s*\d{4})?|6061|6082|7075|5083)\b/i,
  /\b(Pirin[cç]|Ms\s*58|Bak[ıi]r|Bronz)\b/i,
  /\b(Kestamid|Delrin|POM|Poliasetal|PTFE|Teflon|Polietilen|PE\s*1000|Poliamid|PA\s*6)\b/i,
  /\b([0-9A-Z]{2,10}\s+Kalite)\b/i,
];

const MATERIAL_BLACKLIST = [
  "çizen", "cizen", "kontrol", "tarih", "ölçek", "olcek", "resim", "sayfa",
  "revizyon", "rev", "gıda", "gida", "bisküvi", "biskuvi", "makina", "makine",
  "adet", "parça", "parca", "no", "imza", "onay", "teknik", "destek", "mevlüt",
  "mevlut", "yersel", "şirket", "etiket", "tolerans", "açıklama", "aciklama"
];

function isCleanMaterial(val?: string): boolean {
  if (!val) return false;
  const lower = val.toLowerCase().trim();
  if (lower.length < 2 || lower.length > 35) return false;
  for (const bl of MATERIAL_BLACKLIST) {
    if (lower === bl || lower.startsWith(bl + " ") || lower.endsWith(" " + bl)) {
      return false;
    }
  }
  return true;
}

/** PDF içindeki antet kısmından Malzeme cinsi ve Ağırlığı okumaya çalışır. */
export async function extractPdfInfo(d: Drawing): Promise<{ material?: string; weight?: string }> {
  try {
    let text = "";
    const ext = d.filename.toLowerCase().split('.').pop();
    const isImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg';
    let rawItems: string[] = [];

    if (!isImage) {
      try {
        const doc = await loadDoc(d);
        const page = await doc.getPage(1);
        const content = await page.getTextContent();
        rawItems = content.items.map((s: any) => s.str.trim()).filter(Boolean);
        text = rawItems.join(" ");
      } catch (err) {
        // Vektör okunamazsa OCR'a geçilir
      }
    }

    // Doğrudan metinde bilinen malzeme var mı kontrol et
    let material: string | undefined;
    let weight: string | undefined;

    for (const pat of KNOWN_MATERIALS) {
      const m = text.match(pat);
      if (m && isCleanMaterial(m[1])) {
        material = m[1].toUpperCase().replace(/\s+/g, " ").trim();
        break;
      }
    }

    // Ağırlık kontrolü
    const wMatch = text.match(/(?:ağırlık|ağırlığı|weight)[\s:]*([0-9.,]+\s*(?:kg|gr|g)?)/i);
    if (wMatch) weight = wMatch[1].trim();

    // Eğer henüz bulunamadıysa antet odaklı OCR yap
    if (!material || isImage || !text.trim()) {
      const { canvas } = await renderPageCanvas(d, 16e6, 3.5);
      
      // Antet genellikle sağ alt köşededir; sağ alt %45 genişlik ve %30 yükseklik alanını kırp
      const antetW = Math.round(canvas.width * 0.45);
      const antetH = Math.round(canvas.height * 0.30);
      const antetX = canvas.width - antetW;
      const antetY = canvas.height - antetH;

      const antetCanvas = document.createElement("canvas");
      antetCanvas.width = antetW;
      antetCanvas.height = antetH;
      const actx = antetCanvas.getContext("2d")!;
      actx.drawImage(canvas, antetX, antetY, antetW, antetH, 0, 0, antetW, antetH);

      const antetUrl = antetCanvas.toDataURL("image/jpeg", 0.95);
      const { data } = await Tesseract.recognize(antetUrl, 'tur+eng');
      const ocrText = data.text;

      // 1. OCR metninde bilinen malzeme var mı?
      for (const pat of KNOWN_MATERIALS) {
        const m = ocrText.match(pat);
        if (m && isCleanMaterial(m[1])) {
          material = m[1].toUpperCase().replace(/\s+/g, " ").trim();
          break;
        }
      }

      // 2. Malzeme: ... şeklinde geçiyor mu?
      if (!material) {
        const mLines = ocrText.split(/\r?\n/);
        for (let i = 0; i < mLines.length; i++) {
          const line = mLines[i];
          const mRegex = /(?:malzeme(?:si)?|material)[\s:]*([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*)/i;
          const match = line.match(mRegex);
          if (match && isCleanMaterial(match[1])) {
            material = match[1].trim();
            break;
          }
          if (/malzeme/i.test(line) && i + 1 < mLines.length) {
            const nextCandidate = mLines[i + 1].trim();
            if (isCleanMaterial(nextCandidate)) {
              material = nextCandidate;
              break;
            }
          }
        }
      }

      if (!weight) {
        const owMatch = ocrText.match(/(?:ağırlık|ağırlığı|weight)[\s:]*([0-9.,]+\s*(?:kg|gr|g)?)/i);
        if (owMatch) weight = owMatch[1].trim();
      }
    }

    if (!isCleanMaterial(material)) {
      material = undefined;
    }

    return { material, weight };
  } catch (e) {
    console.error("Text extraction failed", e);
    return {};
  }
}

