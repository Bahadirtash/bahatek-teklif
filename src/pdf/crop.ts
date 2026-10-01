// Çizim önizleme kırpması: revizyon tablosu (üst) ve antet/tolerans cetveli (alt) dışarıda
// bırakılır, sadece görünüşlerin olduğu alan gösterilir.
//
// Şablon (gerçek çizimlerden ölçüldü): sayfanın içinde bir çerçeve var (kenardan 22–57 pt).
// Revizyon tablosu çerçevenin sağ üst köşesinde, antet sağ alt köşesinde; ikisi de ~550 pt
// genişliğinde. A4 dikeyde (595 pt) bu bloklar tüm genişliği kaplar, yatay sayfalarda
// (1191/1684/2384 pt) sağda kalır ve görünüşler solda/altta da olabilir. Bu yüzden sabit
// yüzdelik kırpma yerine: çerçeve görüntüden bulunur, bloklar beyazla örtülür, kalan çizimin
// sınırları otomatik bulunur. Ölçüler sayfa yüksekliğine (842 pt) oranlanır.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropLayout {
  /** Render edilecek alan (çerçeve içi), pt. */
  region: Rect;
  /** Beyazla örtülecek alanlar, pt (sayfa koordinatı). */
  exclude: Rect[];
}

const REF_H = 842;
const FRAME = 22; // çerçeve bulunamazsa varsayılan kenar payı
const INSET = 6; // çerçeve çizgisini dışarıda bırakmak için ek pay
const BLOCK_W = 552; // revizyon tablosu ve antet genişliği
const REV_H = 92; // revizyon tablosu yüksekliği (~86 pt) + pay
const TITLE_H = 212; // antet yüksekliği, İŞ EMRİ kutusu dahil (~208 pt) + pay

/** frame: çerçeve dikdörtgeni (pt); verilmezse varsayılan pay kullanılır. */
export function cropLayout(pageW: number, pageH: number, frame?: Rect | null): CropLayout {
  const k = pageH / REF_H;
  const fr = frame ?? { x: FRAME * k, y: FRAME * k, w: pageW - 2 * FRAME * k, h: pageH - 2 * FRAME * k };
  const i = INSET * k;
  const right = fr.x + fr.w;
  const bottom = fr.y + fr.h;
  const bx = Math.max(0, right - BLOCK_W * k - i);
  return {
    region: { x: fr.x + i, y: fr.y + i, w: fr.w - 2 * i, h: fr.h - 2 * i },
    exclude: [
      { x: bx, y: 0, w: pageW - bx, h: fr.y + REV_H * k },
      { x: bx, y: bottom - TITLE_H * k, w: pageW - bx, h: pageH - bottom + TITLE_H * k },
    ],
  };
}

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface TrimOptions {
  /** Bu değerden koyu (gri) piksel çizim sayılır. */
  threshold?: number;
  /** Bulunan sınırlara eklenecek pay, px. */
  pad?: number;
  /** Bağlantı analizinde hücre boyu, px. */
  cell?: number;
  /** Bu hücre mesafesindeki parçalar aynı gruba sayılır. */
  join?: number;
  /** Toplam koyu pikselin bu oranından az olan parçalar atılır. */
  minShare?: number;
  /** Bu oranın altındaki parçalar, ana gruptan alanın bu oranı kadar uzaksa atılır. */
  farShare?: number;
  farGap?: number;
}

function isDark(d: Uint8ClampedArray, i: number, threshold: number): boolean {
  return d[i + 3] > 0 && 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < threshold;
}

/**
 * Çizim çerçevesini bulur (px): her kenarda, sayfa kenar çizgisinden (ilk %0.8) sonra gelen,
 * boyunun/eninin büyük kısmını kaplayan ilk düz çizgi. (En içteki çizgi değil: A4 dikeyde
 * revizyon tablosu ve antetin yatay çizgileri de sayfa boyunca uzanır.)
 */
export function findFrame(img: Pixels, threshold = 200): Rect | null {
  const { width: W, height: H, data: d } = img;
  const col = new Uint32Array(W);
  const row = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isDark(d, (y * W + x) * 4, threshold)) {
        col[x]++;
        row[y]++;
      }
    }
  }
  const firstLine = (arr: Uint32Array, len: number, min: number, fromEnd: boolean): number => {
    for (let t = Math.ceil(len * 0.008); t < len * 0.12; t++) {
      const p = fromEnd ? len - 1 - t : t;
      if (arr[p] >= min) return p;
    }
    return -1;
  };
  const left = firstLine(col, W, H * 0.75, false);
  const right = firstLine(col, W, H * 0.75, true);
  const top = firstLine(row, H, W * 0.75, false);
  const bottom = firstLine(row, H, W * 0.75, true);
  if (left < 0 || right < 0 || top < 0 || bottom < 0) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Beyaz boşluğu kırpar; ana çizimden kopuk küçük parçaları (antet kırıntısı, barkod ucu)
 * süzer. Sonuç px cinsinden dikdörtgen; çizim yoksa null.
 */
export function findContentBox(img: Pixels, opts: TrimOptions = {}): Rect | null {
  const { threshold = 200, pad = 25, cell = 6, join = 4, minShare = 0.02, farShare = 0.03, farGap = 0.12 } = opts;
  const gw = Math.ceil(img.width / cell);
  const gh = Math.ceil(img.height / cell);
  const counts = new Uint32Array(gw * gh);
  const d = img.data;
  let total = 0;
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width;
    const gy = ((y / cell) | 0) * gw;
    for (let x = 0; x < img.width; x++) {
      if (isDark(d, (row + x) * 4, threshold)) {
        counts[gy + ((x / cell) | 0)]++;
        total++;
      }
    }
  }
  if (!total) return null;

  // Hücre grafiği üzerinde "join" mesafesiyle bağlı parçalar.
  const label = new Int32Array(gw * gh).fill(-1);
  const comps: { n: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || label[start] >= 0) continue;
    const id = comps.length;
    const c = { n: 0, x0: gw, y0: gh, x1: -1, y1: -1 };
    comps.push(c);
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % gw, py = (p / gw) | 0;
      c.n += counts[p];
      c.x0 = Math.min(c.x0, px); c.x1 = Math.max(c.x1, px);
      c.y0 = Math.min(c.y0, py); c.y1 = Math.max(c.y1, py);
      for (let ny = Math.max(0, py - join); ny <= Math.min(gh - 1, py + join); ny++) {
        for (let nx = Math.max(0, px - join); nx <= Math.min(gw - 1, px + join); nx++) {
          const q = ny * gw + nx;
          if (counts[q] && label[q] < 0) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
  }

  // Büyük parçalar ana gruptur; küçükler ancak ana gruba yakınsa kalır (N6/N5 gibi uzak
  // işaretler ve antet kırıntıları atılır, görünüş yanındaki ölçü/kesit yazıları kalır).
  const main = comps.filter((c) => c.n >= total * farShare);
  if (!main.length) main.push(comps.reduce((a, b) => (b.n > a.n ? b : a)));
  const gapX = farGap * gw, gapY = farGap * gh;
  const near = (c: (typeof comps)[number]) =>
    main.some((m) => c.x0 - m.x1 < gapX && m.x0 - c.x1 < gapX && c.y0 - m.y1 < gapY && m.y0 - c.y1 < gapY);
  const use = comps.filter((c) => main.includes(c) || (c.n >= total * minShare && near(c)));
  const x0 = Math.min(...use.map((c) => c.x0)) * cell;
  const y0 = Math.min(...use.map((c) => c.y0)) * cell;
  const x1 = Math.min(img.width, (Math.max(...use.map((c) => c.x1)) + 1) * cell);
  const y1 = Math.min(img.height, (Math.max(...use.map((c) => c.y1)) + 1) * cell);
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  return { x, y, w: Math.min(img.width, x1 + pad) - x, h: Math.min(img.height, y1 + pad) - y };
}
