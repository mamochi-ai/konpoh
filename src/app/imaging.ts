// ブラウザでのデコード（Canvas）。原本Blobは変更しない。巨大画像を一斉に展開しない。
import { applyDecoded, headerFacts, APP_LIMITS, type Decoded } from '../core/facts';
import type { AssetFacts, AssetRecord } from '../core/types';
import { detectContainer } from '../core/sniff';
import type { Raster } from '../core/edit/raster';

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg' };

function makeCanvas(w: number, h: number): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; release: () => void; toBlob: () => Promise<Blob | null> } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    if (ctx) {
      return {
        ctx,
        release: () => {
          c.width = 0;
          c.height = 0;
        },
        toBlob: () => c.convertToBlob({ type: 'image/png' }).catch(() => null),
      };
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvasを利用できません');
  return {
    ctx,
    release: () => {
      c.width = 0;
      c.height = 0;
    },
    toBlob: () => new Promise((r) => c.toBlob((b) => r(b), 'image/png')),
  };
}

async function decodeBitmap(blob: Blob, container: string): Promise<ImageBitmap> {
  // 中身に合わせたMIMEで読み込む（拡張子は信用しない）。原本Blobは変えない。
  const typed = MIME[container] && blob.type !== MIME[container] ? new Blob([blob], { type: MIME[container] }) : blob;
  try {
    return await createImageBitmap(typed, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    // 一部ブラウザはオプション未対応
    return await createImageBitmap(typed);
  }
}

async function decodeRgba(blob: Blob, container: string): Promise<Decoded> {
  let bmp: ImageBitmap | null = null;
  let release = () => {};
  try {
    bmp = await decodeBitmap(blob, container);
    const { width, height } = bmp;
    const c = makeCanvas(width, height);
    release = c.release;
    c.ctx.clearRect(0, 0, width, height);
    c.ctx.drawImage(bmp, 0, 0);
    const data = c.ctx.getImageData(0, 0, width, height).data;
    return { ok: true, width, height, rgba: data };
  } catch (e) {
    return { ok: false, reason: `ブラウザで画像をデコードできません（${(e as Error)?.message || '不明なエラー'}）` };
  } finally {
    bmp?.close();
    release();
  }
}

/** 編集用に全画素を読み込む（原本Blobは変更しない） */
export async function decodeAssetRaster(asset: AssetRecord): Promise<Raster> {
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());
  const { facts, shouldDecode } = headerFacts(bytes, asset.originalName, asset.sha256, 8);
  if (!shouldDecode) throw new Error(facts.decode.ok ? '読み込めません' : facts.decode.reason);
  const d = await decodeRgba(asset.blob, facts.container);
  if (!d.ok) throw new Error(d.reason);
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.rgba as Uint8ClampedArray) };
}

export async function analyzeAsset(asset: AssetRecord, threshold: number): Promise<AssetFacts> {
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());
  const { facts, shouldDecode } = headerFacts(bytes, asset.originalName, asset.sha256, threshold);
  if (!shouldDecode) return facts;
  const decoded = await decodeRgba(asset.blob, facts.container);
  return applyDecoded(facts, decoded);
}

const THUMB = 320;

/** 縮小プレビュー。上限を超える画像は展開しない */
export async function makeThumbnail(asset: AssetRecord): Promise<{ blob: Blob | null; dims: { width: number; height: number } | null }> {
  const head = new Uint8Array(await asset.blob.slice(0, 65536).arrayBuffer());
  const container = detectContainer(head);
  if (container !== 'png' && container !== 'jpeg') return { blob: null, dims: null };
  const { facts, shouldDecode } = headerFacts(new Uint8Array(await asset.blob.arrayBuffer()), asset.originalName, asset.sha256, 8);
  const dims = facts.width && facts.height ? { width: facts.width, height: facts.height } : null;
  return { blob: shouldDecode ? await thumbBlob(asset, container, facts.width, facts.height) : null, dims };
}

async function thumbBlob(asset: AssetRecord, container: string, fw?: number, fh?: number): Promise<Blob | null> {
  let bmp: ImageBitmap | null = null;
  let release = () => {};
  try {
    bmp = await decodeBitmap(asset.blob, container);
    const w = fw ?? bmp.width;
    const h = fh ?? bmp.height;
    if (w * h > APP_LIMITS.maxPixels) return null;
    const scale = Math.min(1, THUMB / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const c = makeCanvas(tw, th);
    release = c.release;
    c.ctx.imageSmoothingQuality = 'high';
    c.ctx.drawImage(bmp, 0, 0, tw, th);
    return await c.toBlob();
  } catch {
    return null;
  } finally {
    bmp?.close();
    release();
  }
}
