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
        // Hata olursa (bozuk PDF vs.) fallback'e geçer
      }
    }

    if (isImage || !text.trim()) {
      // Metin yoksa veya resimse OCR ile okuma yap (Tesseract)
      const { canvas } = await renderPageCanvas(d, 16e6, 3.5);
      const url = canvas.toDataURL("image/jpeg", 0.9);
      const { data } = await Tesseract.recognize(url, 'tur+eng');
      text = data.text;
    }

    let material: string | undefined;
    let weight: string | undefined;
    
    const matMatch = text.match(/(?:malzeme(?:si)?|cinsi?|material)[\s:]*([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*)/i);
    if (matMatch) material = matMatch[1].trim();

    const wMatch = text.match(/(?:ağırlık|ağırlığı|weight)[\s:]*([0-9.,]+\s*(?:kg|gr|g)?)/i);
    if (wMatch) weight = wMatch[1].trim();

    if ((!material || !weight) && rawItems.length > 0) {
      for (let i = 0; i < rawItems.length; i++) {
        const lower = rawItems[i].toLowerCase();
        if (!material && (lower.includes('malzeme') || lower.includes('cinsi') || lower.includes('material'))) {
          const parts = rawItems[i].split(':');
          if (parts.length > 1 && parts[1].trim()) material = parts[1].trim();
          else if (i + 1 < rawItems.length) material = rawItems[i+1];
        }
        if (!weight && (lower.includes('ağırlık') || lower.includes('ağırlığı') || lower.includes('weight'))) {
          const parts = rawItems[i].split(':');
          if (parts.length > 1 && parts[1].trim()) weight = parts[1].trim();
          else if (i + 1 < rawItems.length) weight = rawItems[i+1];
        }
      }
    }
    return { material, weight };
  } catch (e) {
    console.error("Text extraction failed", e);
    return {};
  }
}

