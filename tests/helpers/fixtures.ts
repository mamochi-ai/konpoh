// テスト用：PNG（8bit RGB/RGBA・非インターレース）をNode上でデコードし、ブラウザのCanvas経路と同じ事実を作る
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzlibSync } from 'fflate';
import { applyDecoded, headerFacts, type Decoded } from '../../src/core/facts';
import { sha256Hex } from '../../src/core/hash';
import { readZip } from '../../src/core/zip';
import { parsePng } from '../../src/core/sniff';
import type { AssetFacts, AssetRecord } from '../../src/core/types';

export const FIX = join(__dirname, '..', 'fixtures');
export const readFix = (p: string) => new Uint8Array(readFileSync(join(FIX, p)));

export function decodePngForTest(b: Uint8Array): Decoded {
  const info = parsePng(b);
  if ('error' in info) return { ok: false, reason: info.error };
  if (info.bitDepth !== 8 || (info.colorType !== 6 && info.colorType !== 2) || info.interlace) {
    return { ok: false, reason: 'test decoder: unsupported' };
  }
  const chunks: Uint8Array[] = [];
  let o = 8;
  while (o < b.length) {
    const len = new DataView(b.buffer, b.byteOffset + o).getUint32(0);
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (type === 'IDAT') chunks.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of chunks) { all.set(c, p); p += c.length; }
  const raw = unzlibSync(all);
  const bpp = info.colorType === 6 ? 4 : 3;
  const { width: w, height: h } = info;
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += up;
      else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) {
        const pp = a + up - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp];
      out[(y * w + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { ok: true, width: w, height: h, rgba: out };
}

export async function factsFor(bytes: Uint8Array, name: string, threshold = 8): Promise<AssetFacts> {
  const sha = await sha256Hex(bytes);
  const { facts, shouldDecode } = headerFacts(bytes, name, sha, threshold);
  return shouldDecode ? applyDecoded(facts, decodePngForTest(bytes)) : facts;
}

let n = 0;
export async function assetFrom(bytes: Uint8Array, name: string): Promise<AssetRecord> {
  return {
    id: `a${++n}`,
    originalName: name,
    sourcePath: name,
    blob: new Blob([bytes as BlobPart]),
    size: bytes.length,
    sha256: await sha256Hex(bytes),
    version: 1,
    addedAt: '2026-11-01T00:00:00Z',
  };
}

export async function loadZipFixture(name: string) {
  const r = await readZip(readFix(name), { maxEntries: 200, maxTotalBytes: 100_000_000 });
  return r;
}
