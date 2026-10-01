// Çizim PDF'lerini bellekte (PDF.js) render eder; diske hiçbir şey yazılmaz.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Drawing } from "../eml";
import { cropLayout, findContentBox, findFrame } from "./crop";

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
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, scale, w: base.width, h: base.height };
}

/** Görünüşlerin olduğu orta alan (revizyon tablosu ve antet hariç). */
export function renderCrop(d: Drawing): Promise<CropImage> {
  let p = crops.get(d);
  if (!p) {
    p = serial(async () => {
      const { canvas, scale: s, w, h } = await renderPageCanvas(d, 9e6, 2.2);
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
    const { canvas } = await renderPageCanvas(d, 14e6, 3);
    const url = URL.createObjectURL(await canvasToBlob(canvas));
    return { url, width: canvas.width, height: canvas.height };
  });
}
