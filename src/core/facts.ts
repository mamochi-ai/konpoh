// 画素データとヘッダーから「事実」を作る。規則（テンプレート）とは独立。
import type { AlphaStats, AssetFacts } from './types';
import { detectContainer, dpiFromJpeg, dpiFromPng, extFormat, parseJpeg, parsePng } from './sniff';

export const APP_LIMITS = {
  zipMaxEntries: 200,
  zipMaxTotalBytes: 100_000_000,
  maxPixels: 16_000_000,
};

export const DEFAULT_ALPHA_THRESHOLD = 8;

/** alpha>threshold の範囲から余白を測る。透明画素の有無とは別に数える */
export function analyzeAlpha(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  threshold: number,
): AlphaStats {
  let translucent = 0;
  let zero = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const a = rgba[row + x * 4 + 3];
      if (a < 255) {
        translucent++;
        if (a === 0) zero++;
      }
      if (a > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  const has = right >= 0;
  return {
    totalPixels: width * height,
    translucentPixels: translucent,
    zeroAlphaPixels: zero,
    contentBox: has ? { left, top, right, bottom } : null,
    margins: has ? { left, top, right: width - 1 - right, bottom: height - 1 - bottom } : null,
    threshold,
  };
}

export type Decoded =
  | { ok: true; width: number; height: number; rgba: ArrayLike<number> }
  | { ok: false; reason: string };

/** ヘッダーだけを読む（デコード前）。デコードすべきかを返す */
export function headerFacts(
  bytes: Uint8Array,
  name: string,
  sha256: string,
  alphaThreshold: number,
): { facts: AssetFacts; shouldDecode: boolean } {
  const container = detectContainer(bytes);
  const facts: AssetFacts = {
    sha256,
    alphaThreshold,
    analyzedAt: new Date().toISOString(),
    bytes: bytes.length,
    container,
    extFormat: extFormat(name),
    hasAlphaChannel: false,
    dpi: { status: 'unknown', reason: '画像として読めないため未確認です' },
    decode: { ok: false, reason: '' },
  };
  if (container === 'png') {
    const p = parsePng(bytes);
    if ('error' in p) {
      facts.decode = { ok: false, reason: p.error };
      return { facts, shouldDecode: false };
    }
    facts.width = p.width;
    facts.height = p.height;
    facts.png = {
      colorType: p.colorType,
      bitDepth: p.bitDepth,
      interlace: p.interlace,
      animated: p.animated,
      hasTrns: p.hasTrns,
      hasIccp: p.hasIccp,
    };
    facts.hasAlphaChannel = p.colorType === 4 || p.colorType === 6 || p.hasTrns;
    facts.dpi = dpiFromPng(p);
    if (p.animated) {
      facts.decode = { ok: false, reason: 'アニメーションPNG（APNG）は対象外です' };
      return { facts, shouldDecode: false };
    }
  } else if (container === 'jpeg') {
    const j = parseJpeg(bytes);
    if ('error' in j) {
      facts.decode = { ok: false, reason: j.error };
      return { facts, shouldDecode: false };
    }
    facts.width = j.width;
    facts.height = j.height;
    facts.jpeg = { components: j.components, hasExif: j.hasExif };
    facts.dpi = dpiFromJpeg(j);
  } else {
    facts.decode = {
      ok: false,
      reason: container === 'unknown' ? '画像のシグネチャが見つかりません' : '非対応形式のため読み込みません',
    };
    return { facts, shouldDecode: false };
  }
  if ((facts.width ?? 0) * (facts.height ?? 0) > APP_LIMITS.maxPixels) {
    facts.pixelLimitExceeded = true;
    facts.decode = { ok: false, reason: `画素数がアプリ上限（${APP_LIMITS.maxPixels / 1_000_000}メガピクセル）を超えるため展開しません` };
    return { facts, shouldDecode: false };
  }
  return { facts, shouldDecode: true };
}

export function applyDecoded(facts: AssetFacts, decoded: Decoded): AssetFacts {
  if (!decoded.ok) return { ...facts, decode: { ok: false, reason: decoded.reason } };
  if (decoded.width !== facts.width || decoded.height !== facts.height) {
    return {
      ...facts,
      decode: {
        ok: false,
        reason: `ヘッダー寸法（${facts.width}×${facts.height}）とデコード結果（${decoded.width}×${decoded.height}）が一致しません`,
      },
    };
  }
  return {
    ...facts,
    decode: { ok: true },
    alpha: analyzeAlpha(decoded.rgba, decoded.width, decoded.height, facts.alphaThreshold),
  };
}

export function factsValid(f: AssetFacts | undefined, sha256: string, threshold: number): f is AssetFacts {
  return !!f && f.sha256 === sha256 && f.alphaThreshold === threshold;
}
