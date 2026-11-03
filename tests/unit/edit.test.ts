// 第2段階：背景透過と一覧画像の分割
import { describe, expect, it } from 'vitest';
import { decodePngForTest, factsFor, loadZipFixture } from '../helpers/fixtures';
import {
  backgroundMask,
  cellsFromLines,
  estimateBackground,
  findGapLines,
  gridLines,
  makeRaster,
  prepareCell,
  removeBackground,
  SIZE_PRESETS,
  downscale,
  type Raster,
} from '../../src/core/edit/raster';
import { encodePng } from '../../src/core/edit/png';
import { evaluateRole } from '../../src/core/rules';
import { LINE_TEMPLATE } from '../../src/core/templates';

const line = LINE_TEMPLATE;
const sticker = line.roles[0];
const preset = SIZE_PRESETS.find((p) => p.id === 'line-sticker')!;

function toRaster(d: ReturnType<typeof decodePngForTest>): Raster {
  if (!d.ok) throw new Error(d.reason);
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.rgba as Uint8Array) };
}

/** 透過スタンプを白背景の一覧画像（2×2、すき間40px、外周30px、拡大1.5倍相当の大きさ）に貼る */
async function whiteSheet(): Promise<{ sheet: Raster; tiles: Raster[] }> {
  const zip = await loadZipFixture('valid-line-16.zip');
  const tiles = ['01.png', '02.png', '05.png', '09.png'].map((n) => toRaster(decodePngForTest(zip.files.find((f) => f.name === n)!.data)));
  const tw = 370, th = 320, gap = 40, pad = 30;
  const W = pad * 2 + tw * 2 + gap, H = pad * 2 + th * 2 + gap;
  const sheet = makeRaster(W, H);
  sheet.data.fill(255);
  tiles.forEach((t, i) => {
    const ox = pad + (i % 2) * (tw + gap);
    const oy = pad + Math.floor(i / 2) * (th + gap);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const s = (y * tw + x) * 4, d = ((oy + y) * W + ox + x) * 4, a = t.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) sheet.data[d + c] = Math.round(t.data[s + c] * a + 255 * (1 - a));
      sheet.data[d + 3] = 255;
    }
  });
  return { sheet, tiles };
}

describe('背景の推定と透過', () => {
  it('白背景を推定し、外周からつながった白だけ透明にする', async () => {
    const { sheet } = await whiteSheet();
    const bg = estimateBackground(sheet);
    expect(bg).toEqual({ kind: 'color', rgb: [255, 255, 255] });
    const { raster, removed } = removeBackground(sheet, { color: [255, 255, 255], tolerance: 30, contiguous: true, soften: true });
    expect(removed).toBeGreaterThan(sheet.width * sheet.height * 0.3);
    expect(raster.data[3]).toBe(0); // 角は透明
    expect(sheet.data[3]).toBe(255); // 元データは変わらない
    expect(estimateBackground(raster)).toEqual({ kind: 'transparent' });
  });
  it('外とつながらない囲まれた白は残す／全体モードでは消す', () => {
    // 黒い枠の中に白
    const r = makeRaster(10, 10);
    for (let i = 0; i < 100; i++) {
      const x = i % 10, y = Math.floor(i / 10);
      const ring = x >= 2 && x <= 7 && y >= 2 && y <= 7 && (x === 2 || x === 7 || y === 2 || y === 7);
      const v = ring ? 0 : 255;
      r.data.set([v, v, v, 255], i * 4);
    }
    const inner = (5 * 10 + 5) * 4 + 3;
    expect(removeBackground(r, { color: [255, 255, 255], tolerance: 10, contiguous: true, soften: false }).raster.data[inner]).toBe(255);
    expect(removeBackground(r, { color: [255, 255, 255], tolerance: 10, contiguous: false, soften: false }).raster.data[inner]).toBe(0);
  });
  it('透過済み画像は透明と推定', async () => {
    const zip = await loadZipFixture('valid-line-16.zip');
    expect(estimateBackground(toRaster(decodePngForTest(zip.files[0].data)))).toEqual({ kind: 'transparent' });
  });
});

describe('分割', () => {
  it('等分の線', () => {
    expect(gridLines(100, 4)).toEqual([25, 50, 75]);
    expect(cellsFromLines(100, 60, [50], [30]).map((c) => [c.x, c.y, c.w, c.h])).toEqual([
      [0, 0, 50, 30], [50, 0, 50, 30], [0, 30, 50, 30], [50, 30, 50, 30],
    ]);
  });
  it('白背景の一覧画像から、すき間で2×2を検出し、LINEスタンプ用に整えると規格検査でエラーなし', async () => {
    const { sheet } = await whiteSheet();
    const { raster } = removeBackground(sheet, { color: [255, 255, 255], tolerance: 30, contiguous: true, soften: true });
    const mask = backgroundMask(raster, { kind: 'transparent' }, 0);
    const xs = findGapLines(mask, raster.width, raster.height, 'x', 8);
    const ys = findGapLines(mask, raster.width, raster.height, 'y', 8);
    expect(xs.length).toBe(1);
    expect(ys.length).toBe(1);
    const cells = cellsFromLines(raster.width, raster.height, xs, ys);
    expect(cells.length).toBe(4);
    for (const c of cells) {
      const piece = prepareCell(raster, mask, c, { trim: true, preset })!;
      expect(piece.width).toBeLessThanOrEqual(370);
      expect(piece.height).toBeLessThanOrEqual(320);
      expect(piece.width % 2).toBe(0);
      expect(piece.height % 2).toBe(0);
      const png = encodePng(piece);
      const f = await factsFor(png, 'cut.png');
      expect(f.dpi.status).toBe('ok');
      const problems = evaluateRole(f, sticker, line).filter((x) => x.severity !== 'info');
      expect(problems, JSON.stringify(problems)).toEqual([]);
    }
  });
  it('空のマスは null（切り出さない）', () => {
    const r = makeRaster(20, 20);
    const mask = backgroundMask(r, { kind: 'transparent' }, 0);
    expect(prepareCell(r, mask, { x: 0, y: 0, w: 20, h: 20 }, { trim: true, preset })).toBeNull();
  });
  it('大きい絵は縮小して余白10pxに収める', () => {
    const r = makeRaster(800, 400);
    r.data.fill(255);
    const mask = backgroundMask(r, { kind: 'transparent' }, 0);
    const out = prepareCell(r, mask, { x: 0, y: 0, w: 800, h: 400 }, { trim: true, preset })!;
    expect(out.width).toBe(370);
    expect(out.height).toBeLessThanOrEqual(320);
    // 左端10pxは透明
    expect(out.data[(Math.floor(out.height / 2) * out.width + 5) * 4 + 3]).toBe(0);
  });
  it('メイン画像用は240×240ちょうど', () => {
    const r = makeRaster(100, 50);
    r.data.fill(200);
    const mask = backgroundMask(r, { kind: 'transparent' }, 0);
    const out = prepareCell(r, mask, { x: 0, y: 0, w: 100, h: 50 }, { trim: true, preset: SIZE_PRESETS.find((p) => p.id === 'line-main')! })!;
    expect([out.width, out.height]).toEqual([240, 240]);
  });
});

describe('PNGエンコード', () => {
  it('往復で画素一致・72dpi', async () => {
    const r = makeRaster(7, 5);
    for (let i = 0; i < r.data.length; i++) r.data[i] = (i * 37) & 255;
    const png = encodePng(r);
    const d = decodePngForTest(png);
    expect(d.ok && Array.from(d.rgba as Uint8Array)).toEqual(Array.from(r.data));
    const f = await factsFor(png, 'x.png');
    expect(f.dpi.status === 'ok' && Math.round(f.dpi.x)).toBe(72);
  });
  it('縮小は透明部分の色をにじませない', () => {
    const r = makeRaster(2, 1);
    r.data.set([255, 0, 0, 255, 0, 255, 0, 0]);
    const o = downscale(r, 1, 1);
    expect(Array.from(o.data.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(o.data[3]).toBe(128);
  });
});
