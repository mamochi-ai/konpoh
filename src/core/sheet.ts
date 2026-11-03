// 一覧画像（分割が必要な画像）の見分け。ヘッダーの寸法だけで判断する純粋関数。
import type { AssetRecord, CheckTemplate } from './types';
import { detectContainer, parseJpeg, parsePng } from './sniff';

export interface Dims {
  width: number;
  height: number;
}

/** PNG/JPEGのヘッダーから寸法を読む。読めなければ null */
export function imageDims(bytes: Uint8Array): Dims | null {
  const c = detectContainer(bytes);
  const info = c === 'png' ? parsePng(bytes) : c === 'jpeg' ? parseJpeg(bytes) : null;
  if (!info || 'error' in info) return null;
  return { width: info.width, height: info.height };
}

/** スタンプの上限寸法（テンプレートの sticker 役割の max） */
export function stickerMax(t: CheckTemplate): Dims | null {
  const r = t.roles.find((x) => x.id === 'sticker');
  return r && r.dimensions.mode !== 'none' ? { width: r.dimensions.width, height: r.dimensions.height } : null;
}

/** 一覧画像とみなす倍率。上限を少し超えるだけの1枚（例 400×320）はチェックのサイズ超過として扱う */
export const SHEET_RATIO = 1.5;

/** スタンプ上限の1.5倍を超える＝一覧画像の可能性が高い（1枚絵でも縮小が必要） */
export function isLikelySheet(d: Dims | null | undefined, t: CheckTemplate): boolean {
  const m = stickerMax(t);
  return !!d && !!m && (d.width > m.width * SHEET_RATIO || d.height > m.height * SHEET_RATIO);
}

/**
 * まだ分割していない一覧画像らしい画像（編集タブで分割・縮小を案内する対象）。
 * 分割で作った画像と、すでに分割済みの画像は除く。
 */
export function unsplitSheets(assets: AssetRecord[], dims: Record<string, Dims | null | undefined>, t: CheckTemplate): AssetRecord[] {
  const splitSources = new Set(assets.filter((a) => a.derivedFrom?.op === 'split').map((a) => a.derivedFrom!.assetId));
  // 透過で作った画像を分割した場合、元の画像も分割済みとみなす
  for (const a of assets) if (a.derivedFrom?.op === 'background' && splitSources.has(a.id)) splitSources.add(a.derivedFrom.assetId);
  return assets.filter((a) => a.derivedFrom?.op !== 'split' && !splitSources.has(a.id) && isLikelySheet(dims[a.id], t));
}
