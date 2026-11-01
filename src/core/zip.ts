// ZIPの読み書き。書出しは「無圧縮（store）」で画像バイトをそのまま格納し、再エンコードしない。
import { Inflate } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

export class ZipAbortError extends Error {
  constructor() {
    super('中止しました');
    this.name = 'ZipAbortError';
  }
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new ZipAbortError();
}

const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- 書出し

export interface ZipWriteEntry {
  path: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

/** store方式での完成ZIPサイズ（生成前に正確に計算できる） */
export function zipSize(entries: { path: string; size: number }[]): number {
  let total = 22;
  for (const e of entries) {
    const n = enc.encode(e.path).length;
    total += 30 + n + e.size + 46 + n;
  }
  return total;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface BuildZipOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, path: string) => void;
  date?: Date;
}

export async function buildZip(entries: ZipWriteEntry[], opts: BuildZipOptions = {}): Promise<Blob> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const { time, date } = dosDateTime(opts.date ?? new Date());
  let offset = 0;
  const totalBytes = entries.reduce((s, e) => s + e.size, 0) || 1;
  let doneBytes = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    checkAbort(opts.signal);
    const key = e.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new ZipError(`出力パスが重複しています: ${e.path}`);
    seen.add(key);
    const data = await e.read();
    if (data.length !== e.size) throw new ZipError(`サイズが変わっています: ${e.path}`);
    if (offset + data.length > 0xfffffff0) throw new ZipError('4GBを超えるZIPは作成できません');
    const crc = crc32(data);
    const name = enc.encode(e.path);
    const utf8 = /[^\x20-\x7e]/.test(e.path) ? 0x0800 : 0;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 10, true);
    lv.setUint16(6, utf8, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 10, true);
    cv.setUint16(8, utf8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    parts.push(lh, data);
    central.push(ch);
    offset += lh.length + data.length;
    doneBytes += data.length;
    opts.onProgress?.(doneBytes, totalBytes, e.path);
    await yieldTick();
  }
  checkAbort(opts.signal);
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd] as BlobPart[], { type: 'application/zip' });
}

// ---------------------------------------------------------------- 読込

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

export interface ZipFileOut {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface ZipReadResult {
  files: ZipFileOut[];
  skipped: { path: string; reason: string }[];
}

export interface ReadZipOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** ネストZIPなど、展開せず除外する拡張子 */
  skipExtensions?: string[];
}

interface CdEntry {
  rawName: string;
  flags: number;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
  isDir: boolean;
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(bytes);
    } catch {
      return Array.from(bytes, (c) => String.fromCharCode(c)).join('');
    }
  }
}

/** パス正規化。絶対パス・..・空は null（拒否） */
export function normalizeZipPath(raw: string): { path: string } | { error: string } {
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { error: '絶対パスのため拒否しました' };
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) return { error: '「..」を含むパスのため拒否しました' };
  if (!segs.length) return { error: '空のパスです' };
  return { path: segs.join('/').normalize('NFC') };
}

function parseCentralDirectory(b: Uint8Array): CdEntry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('ZIPの終端情報が見つかりません（破損またはZIPではありません）');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('ZIP64形式は非対応です');
  if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 6, true) !== 0) throw new ZipError('分割ZIPは非対応です');
  if (cdOffset + cdSize > eocd) throw new ZipError('ZIPの目録が壊れています');
  const out: CdEntry[] = [];
  let o = cdOffset;
  for (let i = 0; i < count; i++) {
    if (o + 46 > b.length || v.getUint32(o, true) !== 0x02014b50) throw new ZipError('ZIPの目録が壊れています');
    const flags = v.getUint16(o + 8, true);
    const nameLen = v.getUint16(o + 28, true);
    const extraLen = v.getUint16(o + 30, true);
    const commentLen = v.getUint16(o + 32, true);
    const compSize = v.getUint32(o + 20, true);
    const size = v.getUint32(o + 24, true);
    const localOffset = v.getUint32(o + 42, true);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64形式は非対応です');
    const rawName = decodeName(b.subarray(o + 46, o + 46 + nameLen), (flags & 0x0800) !== 0);
    out.push({
      rawName,
      flags,
      method: v.getUint16(o + 10, true),
      crc: v.getUint32(o + 16, true),
      compSize,
      size,
      localOffset,
      isDir: rawName.endsWith('/') || rawName.endsWith('\\'),
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

class LimitError extends Error {}

function isSystemFile(path: string): boolean {
  const segs = path.split('/');
  const base = segs[segs.length - 1];
  return segs.includes('__MACOSX') || base === '.DS_Store' || base.startsWith('._') || base === 'Thumbs.db' || base === 'desktop.ini';
}

/** 上限（ファイル数・展開総量）を宣言値と実バイトの両方で監視する */
export async function readZip(buf: Uint8Array, limits: ZipLimits, opts: ReadZipOptions = {}): Promise<ZipReadResult> {
  const entries = parseCentralDirectory(buf);
  const fileEntries = entries.filter((e) => !e.isDir);
  if (fileEntries.length > limits.maxEntries) {
    throw new ZipError(`ファイル数が${fileEntries.length}件で、アプリ上限${limits.maxEntries}件を超えるため中止しました`);
  }
  const declared = fileEntries.reduce((s, e) => s + e.size, 0);
  if (declared > limits.maxTotalBytes) {
    throw new ZipError(`展開後の合計が${declared.toLocaleString()}バイトで、アプリ上限${limits.maxTotalBytes.toLocaleString()}バイトを超えるため中止しました`);
  }
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const result: ZipReadResult = { files: [], skipped: [] };
  const seen = new Set<string>();
  const skipExt = (opts.skipExtensions ?? []).map((x) => x.toLowerCase());
  let total = 0;
  let idx = 0;
  for (const e of fileEntries) {
    checkAbort(opts.signal);
    idx++;
    const norm = normalizeZipPath(e.rawName);
    if ('error' in norm) {
      result.skipped.push({ path: e.rawName, reason: norm.error });
      continue;
    }
    const path = norm.path;
    if (isSystemFile(path)) {
      result.skipped.push({ path, reason: 'システムが作る付属ファイルのため除外しました' });
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) {
      result.skipped.push({ path, reason: '正規化後に同じパスのファイルが既にあるため拒否しました' });
      continue;
    }
    seen.add(key);
    const lower = path.toLowerCase();
    if (skipExt.some((x) => lower.endsWith(x))) {
      result.skipped.push({ path, reason: 'ZIPの中のZIPは展開しません' });
      continue;
    }
    if (e.flags & 0x0001) {
      result.skipped.push({ path, reason: '暗号化されたZIPは非対応です' });
      continue;
    }
    if (e.method !== 0 && e.method !== 8) {
      result.skipped.push({ path, reason: `圧縮方式${e.method}は非対応です` });
      continue;
    }
    const lo = e.localOffset;
    if (lo + 30 > buf.length || v.getUint32(lo, true) !== 0x04034b50) {
      result.skipped.push({ path, reason: 'ローカルヘッダーが壊れています' });
      continue;
    }
    const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    if (start + e.compSize > buf.length) {
      result.skipped.push({ path, reason: 'データが途中で切れています' });
      continue;
    }
    const comp = buf.subarray(start, start + e.compSize);
    let data: Uint8Array;
    try {
      if (e.method === 0) {
        if (e.compSize !== e.size) throw new Error('サイズ情報が一致しません');
        total += comp.length;
        if (total > limits.maxTotalBytes) throw new LimitError();
        data = comp.slice();
      } else {
        const chunks: Uint8Array[] = [];
        let got = 0;
        const inf = new Inflate((chunk) => {
          got += chunk.length;
          if (total + got > limits.maxTotalBytes) throw new LimitError();
          if (got > e.size) throw new Error('宣言サイズより大きく展開されました');
          chunks.push(chunk);
        });
        const STEP = 16384;
        for (let i = 0; i < comp.length; i += STEP) {
          checkAbort(opts.signal);
          inf.push(comp.subarray(i, Math.min(comp.length, i + STEP)), i + STEP >= comp.length);
          if (i % (STEP * 32) === 0) await yieldTick();
        }
        if (comp.length === 0) inf.push(new Uint8Array(0), true);
        total += got;
        data = new Uint8Array(got);
        let p = 0;
        for (const c of chunks) {
          data.set(c, p);
          p += c.length;
        }
      }
      if (data.length !== e.size) throw new Error('宣言サイズと展開後のサイズが一致しません');
      if (crc32(data) !== e.crc) throw new Error('CRCが一致しません（破損）');
    } catch (err) {
      if (err instanceof LimitError) {
        throw new ZipError(`展開中の実バイトがアプリ上限${limits.maxTotalBytes.toLocaleString()}バイトを超えたため中止しました`);
      }
      if (err instanceof ZipAbortError) throw err;
      result.skipped.push({ path, reason: `展開できません: ${(err as Error).message}` });
      continue;
    }
    const segs = path.split('/');
    result.files.push({ path, name: segs[segs.length - 1], data });
    opts.onProgress?.(idx, fileEntries.length);
    await yieldTick();
  }
  return result;
}
