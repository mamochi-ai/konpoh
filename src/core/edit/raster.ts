// 画像編集の純粋関数（RGBA・非乗算アルファ）。元画像のデータは変更せず、常に新しい配列を返す。

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Rgb = [number, number, number];

export type Background = { kind: 'transparent' } | { kind: 'color'; rgb: Rgb };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function makeRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

export function crop(r: Raster, rect: Rect): Raster {
  const out = makeRaster(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * r.width + rect.x) * 4;
    out.data.set(r.data.subarray(src, src + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

const TRANSPARENT_ALPHA = 8;

/** 外周の画素から背景を推定する（透明か、最も多い色か） */
export function estimateBackground(r: Raster): Background {
  const { width: w, height: h, data } = r;
  const idx: number[] = [];
  const step = Math.max(1, Math.floor((w + h) / 400));
  for (let x = 0; x < w; x += step) idx.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += step) idx.push(y * w, y * w + w - 1);
  let transparent = 0;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const i of idx) {
    const p = i * 4;
    if (data[p + 3] <= TRANSPARENT_ALPHA) {
      transparent++;
      continue;
    }
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bk.n++;
    bk.r += data[p];
    bk.g += data[p + 1];
    bk.b += data[p + 2];
    buckets.set(key, bk);
  }
  if (transparent * 2 >= idx.length) return { kind: 'transparent' };
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const b of buckets.values()) if (b.n > best.n) best = b;
  return { kind: 'color', rgb: [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] };
}

function dist(data: Uint8ClampedArray, p: number, c: Rgb): number {
  const dr = data[p] - c[0];
  const dg = data[p + 1] - c[1];
  const db = data[p + 2] - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** 背景らしい画素なら1（分割位置の検出用。つながりは見ない） */
export function backgroundMask(r: Raster, bg: Background, tolerance: number): Uint8Array {
  const n = r.width * r.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (r.data[p + 3] <= TRANSPARENT_ALPHA) m[i] = 1;
    else if (bg.kind === 'color' && dist(r.data, p, bg.rgb) <= tolerance) m[i] = 1;
  }
  return m;
}

export interface RemoveOptions {
  color: Rgb;
  /** RGB距離（0〜441）。これ以下を背景とみなす */
  tolerance: number;
  /** true: 外周からつながった背景だけ消す。false: 同じ色を全部消す */
  contiguous: boolean;
  /** 背景と絵の境目を半透明にしてなじませる */
  soften: boolean;
}

/**
 * 単色背景を透明にする。AIによる切り抜きではなく、色の近さと外周からのつながりで判定する。
 * 絵の中に背景と同じ色があって外とつながっていると、そこも消える。
 */
export function removeBackground(r: Raster, o: RemoveOptions): { raster: Raster; removed: number } {
  const { width: w, height: h } = r;
  const out = cloneRaster(r);
  const d = out.data;
  const n = w * h;
  const isBgColor = (i: number) => d[i * 4 + 3] <= TRANSPARENT_ALPHA || dist(d, i * 4, o.color) <= o.tolerance;
  const bg = new Uint8Array(n);
  if (o.contiguous) {
    const stack: number[] = [];
    const seed = (i: number) => {
      if (!bg[i] && isBgColor(i)) {
        bg[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x);
      seed((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      seed(y * w);
      seed(y * w + w - 1);
    }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (i >= w) seed(i - w);
      if (i < n - w) seed(i + w);
    }
  } else {
    for (let i = 0; i < n; i++) if (isBgColor(i)) bg[i] = 1;
  }
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (bg[i]) {
      if (d[i * 4 + 3] > 0) removed++;
      d[i * 4 + 3] = 0;
    }
  }
  if (o.soften && o.tolerance > 0) {
    // 背景に接する絵の画素のうち、背景色に近いものを距離に応じて半透明にする
    const band = Math.max(8, o.tolerance);
    for (let i = 0; i < n; i++) {
      if (bg[i]) continue;
      const x = i % w;
      const touches = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (i >= w && bg[i - w]) || (i < n - w && bg[i + w]);
      if (!touches) continue;
      const dd = dist(d, i * 4, o.color);
      if (dd < o.tolerance + band) {
        const a = Math.max(0, Math.min(1, (dd - o.tolerance) / band));
        d[i * 4 + 3] = Math.round(d[i * 4 + 3] * a);
      }
    }
  }
  return { raster: out, removed };
}

// ---------------------------------------------------------------- 分割

/** 等分した内側の線の位置 */
export function gridLines(size: number, parts: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < parts; i++) out.push(Math.round((size * i) / parts));
  return out;
}

/**
 * 背景だけの列（行）が minGap 以上続く場所の中央を分割線にする。
 * 端の余白は線にしない。
 */
export function findGapLines(mask: Uint8Array, w: number, h: number, axis: 'x' | 'y', minGap: number): number[] {
  const len = axis === 'x' ? w : h;
  const empty = new Uint8Array(len);
  for (let k = 0; k < len; k++) {
    let all = 1;
    if (axis === 'x') {
      for (let y = 0; y < h; y++) if (!mask[y * w + k]) { all = 0; break; }
    } else {
      const row = k * w;
      for (let x = 0; x < w; x++) if (!mask[row + x]) { all = 0; break; }
    }
    empty[k] = all;
  }
  const lines: number[] = [];
  let k = 0;
  while (k < len && empty[k]) k++; // 先頭の余白
  let end = len - 1;
  while (end >= 0 && empty[end]) end--; // 末尾の余白
  for (; k <= end; k++) {
    if (!empty[k]) continue;
    let j = k;
    while (j <= end && empty[j]) j++;
    if (j - k >= minGap) lines.push(Math.round((k + j) / 2));
    k = j;
  }
  return lines;
}

export interface Cell extends Rect {
  row: number;
  col: number;
  index: number;
}

export function cellsFromLines(w: number, h: number, xs: number[], ys: number[]): Cell[] {
  const bx = [0, ...[...xs].sort((a, b) => a - b).filter((v) => v > 0 && v < w), w];
  const by = [0, ...[...ys].sort((a, b) => a - b).filter((v) => v > 0 && v < h), h];
  const cells: Cell[] = [];
  for (let r = 0; r < by.length - 1; r++) {
    for (let c = 0; c < bx.length - 1; c++) {
      const cw = bx[c + 1] - bx[c];
      const ch = by[r + 1] - by[r];
      if (cw > 0 && ch > 0) cells.push({ x: bx[c], y: by[r], w: cw, h: ch, row: r, col: c, index: cells.length });
    }
  }
  return cells;
}

/** 背景ではない画素の範囲。なければ null */
export function contentRect(mask: Uint8Array, w: number, rect: Rect): Rect | null {
  let l = Infinity;
  let t = Infinity;
  let r = -1;
  let b = -1;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const row = y * w;
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (!mask[row + x]) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  return r < 0 ? null : { x: l, y: t, w: r - l + 1, h: b - t + 1 };
}

/** 面積平均による縮小（乗算アルファで計算し、縁の色にじみを防ぐ）。拡大はしない */
export function downscale(r: Raster, tw: number, th: number): Raster {
  if (tw >= r.width && th >= r.height) return cloneRaster(r);
  const out = makeRaster(tw, th);
  const sx = r.width / tw;
  const sy = r.height / th;
  const s = r.data;
  for (let oy = 0; oy < th; oy++) {
    const y0 = oy * sy;
    const y1 = y0 + sy;
    for (let ox = 0; ox < tw; ox++) {
      const x0 = ox * sx;
      const x1 = x0 + sx;
      let ar = 0, ag = 0, ab = 0, aa = 0, area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const p = (y * r.width + x) * 4;
          const a = s[p + 3] / 255;
          ar += s[p] * a * wgt;
          ag += s[p + 1] * a * wgt;
          ab += s[p + 2] * a * wgt;
          aa += a * wgt;
          area += wgt;
        }
      }
      const q = (oy * tw + ox) * 4;
      if (aa > 0) {
        out.data[q] = ar / aa;
        out.data[q + 1] = ag / aa;
        out.data[q + 2] = ab / aa;
      }
      out.data[q + 3] = (aa / area) * 255;
    }
  }
  return out;
}

export function placeOnCanvas(r: Raster, w: number, h: number, x: number, y: number): Raster {
  const out = makeRaster(w, h);
  for (let yy = 0; yy < r.height; yy++) {
    const ty = y + yy;
    if (ty < 0 || ty >= h) continue;
    for (let xx = 0; xx < r.width; xx++) {
      const tx = x + xx;
      if (tx < 0 || tx >= w) continue;
      const s = (yy * r.width + xx) * 4;
      const d = (ty * w + tx) * 4;
      out.data[d] = r.data[s];
      out.data[d + 1] = r.data[s + 1];
      out.data[d + 2] = r.data[s + 2];
      out.data[d + 3] = r.data[s + 3];
    }
  }
  return out;
}

export interface SizePreset {
  id: string;
  label: string;
  /** max: 内容に合わせて小さく（上限あり）。exact: 決まった大きさの中央に配置 */
  mode: 'none' | 'max' | 'exact';
  width: number;
  height: number;
  margin: number;
  even: boolean;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: 'none', label: '大きさは変えない', mode: 'none', width: 0, height: 0, margin: 0, even: false },
  { id: 'line-sticker', label: 'LINEスタンプ用（最大370×320・余白10px・偶数）', mode: 'max', width: 370, height: 320, margin: 10, even: true },
  { id: 'line-main', label: 'LINEメイン画像用（240×240・余白10px）', mode: 'exact', width: 240, height: 240, margin: 10, even: true },
  { id: 'line-tab', label: 'LINEタブ画像用（96×74・余白2px）', mode: 'exact', width: 96, height: 74, margin: 2, even: true },
];

export interface CellOptions {
  /** 絵の周りの余白を詰める */
  trim: boolean;
  preset: SizePreset;
}

const evenUp = (n: number) => (n % 2 ? n + 1 : n);

/** 1マス分を切り出して整える。内容がなければ null */
export function prepareCell(r: Raster, mask: Uint8Array, cell: Rect, o: CellOptions): Raster | null {
  const content = contentRect(mask, r.width, cell);
  if (!content) return null;
  let piece = crop(r, o.trim ? content : cell);
  const p = o.preset;
  if (p.mode === 'none') {
    return piece;
  }
  const availW = Math.max(1, p.width - p.margin * 2);
  const availH = Math.max(1, p.height - p.margin * 2);
  const scale = Math.min(1, availW / piece.width, availH / piece.height);
  if (scale < 1) {
    piece = downscale(piece, Math.max(1, Math.floor(piece.width * scale)), Math.max(1, Math.floor(piece.height * scale)));
  }
  let cw: number;
  let ch: number;
  if (p.mode === 'exact') {
    cw = p.width;
    ch = p.height;
  } else {
    cw = Math.min(p.width, piece.width + p.margin * 2);
    ch = Math.min(p.height, piece.height + p.margin * 2);
    if (p.even) {
      cw = Math.min(p.even ? p.width - (p.width % 2) : p.width, evenUp(cw));
      ch = Math.min(p.even ? p.height - (p.height % 2) : p.height, evenUp(ch));
    }
  }
  return placeOnCanvas(piece, cw, ch, Math.floor((cw - piece.width) / 2), Math.floor((ch - piece.height) / 2));
}
