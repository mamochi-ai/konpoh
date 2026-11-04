// e2e用：スクリーンショットPNGの左上1画素を読む（8bit RGB/RGBA、フィルタ対応）
import { unzlibSync } from 'fflate';
export function PNG(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8, w = 0, ct = 0;
  const idat = [];
  while (o < b.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (type === 'IHDR') { w = dv.getUint32(o + 8); ct = b[o + 17]; }
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const all = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of idat) { all.set(c, p); p += c.length; }
  const raw = unzlibSync(all);
  const bpp = ct === 6 ? 4 : 3;
  // 1行目だけ復元（フィルタ0/1/2/3/4。前の行は0）
  const ft = raw[0];
  const line = raw.subarray(1, 1 + w * bpp);
  const out = new Uint8Array(w * bpp);
  for (let x = 0; x < w * bpp; x++) {
    const a = x >= bpp ? out[x - bpp] : 0;
    let v = line[x];
    if (ft === 1 || ft === 4) v += a;
    else if (ft === 3) v += a >> 1;
    out[x] = v & 255;
  }
  return [out[0], out[1], out[2]];
}
