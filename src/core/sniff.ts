// 拡張子を信用せず、シグネチャとヘッダーから形式・寸法・DPIを読む純粋関数群
import type { Container, DpiFact } from './types';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function detectContainer(b: Uint8Array): Container {
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 2) === 'BM') return 'bmp';
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(b, 0, 4) === 'PK\x03\x04' || ascii(b, 0, 4) === 'PK\x05\x06') return 'zip';
  if (ascii(b, 0, 4) === '%PDF') return 'pdf';
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  const head = ascii(b, 0, Math.min(b.length, 1024)).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--')) && head.includes('<svg')) return 'svg';
  return 'unknown';
}

const EXT_MAP: Record<string, string> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  svg: 'svg',
  heic: 'heic',
  heif: 'heic',
  avif: 'avif',
  bmp: 'bmp',
  tif: 'tiff',
  tiff: 'tiff',
  zip: 'zip',
  pdf: 'pdf',
  apng: 'png',
};

export function extFormat(name: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (!m) return null;
  return EXT_MAP[m[1].toLowerCase()] ?? m[1].toLowerCase();
}

export const IMAGE_LIKE_EXTS = new Set(['png', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif', 'bmp', 'tiff']);

export const CONTAINER_LABEL: Record<Container, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  svg: 'SVG',
  heic: 'HEIC/HEIF',
  avif: 'AVIF',
  bmp: 'BMP',
  tiff: 'TIFF',
  zip: 'ZIP',
  pdf: 'PDF',
  unknown: '不明',
};

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  animated: boolean;
  hasTrns: boolean;
  hasIccp: boolean;
  phys?: { x: number; y: number; unit: number };
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

/** PNGのチャンクをIDATまで読む。acTL（APNG）はIDAT前にある */
export function parsePng(b: Uint8Array): PngInfo | { error: string } {
  if (detectContainer(b) !== 'png') return { error: 'PNGシグネチャがありません' };
  let o = 8;
  let info: PngInfo | null = null;
  let sawIdat = false;
  while (o + 8 <= b.length) {
    const len = u32(b, o);
    const type = ascii(b, o + 4, 4);
    const data = o + 8;
    if (data + len + 4 > b.length) return { error: `チャンク ${type} が途中で切れています` };
    if (!info && type !== 'IHDR') return { error: '先頭にIHDRチャンクがありません' };
    if (type === 'IHDR') {
      if (len < 13) return { error: 'IHDRが不正です' };
      info = {
        width: u32(b, data),
        height: u32(b, data + 4),
        bitDepth: b[data + 8],
        colorType: b[data + 9],
        interlace: b[data + 12],
        animated: false,
        hasTrns: false,
        hasIccp: false,
      };
    } else if (type === 'acTL') {
      info!.animated = true;
    } else if (type === 'tRNS') {
      info!.hasTrns = true;
    } else if (type === 'iCCP') {
      info!.hasIccp = true;
    } else if (type === 'pHYs' && len >= 9) {
      info!.phys = { x: u32(b, data), y: u32(b, data + 4), unit: b[data + 8] };
    } else if (type === 'IDAT') {
      sawIdat = true;
      break;
    } else if (type === 'IEND') {
      break;
    }
    o = data + len + 4;
  }
  if (!info) return { error: 'IHDRが読み取れません' };
  if (!sawIdat) return { error: '画像データ（IDAT）がありません' };
  if (info.width === 0 || info.height === 0) return { error: '寸法が0です' };
  return info;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  density?: { units: number; x: number; y: number };
  hasExif: boolean;
}

export function parseJpeg(b: Uint8Array): JpegInfo | { error: string } {
  if (detectContainer(b) !== 'jpeg') return { error: 'JPEGシグネチャがありません' };
  let o = 2;
  let density: JpegInfo['density'];
  let hasExif = false;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return { error: 'JPEGマーカーが不正です' };
    let marker = b[o + 1];
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1];
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16(b, o + 2);
    const seg = o + 4;
    if (len < 2 || o + 2 + len > b.length) return { error: 'JPEGセグメントが途中で切れています' };
    if (marker === 0xe0 && ascii(b, seg, 5) === 'JFIF\0' && len >= 14) {
      density = { units: b[seg + 7], x: u16(b, seg + 8), y: u16(b, seg + 10) };
    } else if (marker === 0xe1 && ascii(b, seg, 6) === 'Exif\0\0') {
      hasExif = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16(b, seg + 1);
      const width = u16(b, seg + 3);
      const components = b[seg + 5];
      if (!width || !height) return { error: '寸法が読み取れません' };
      return { width, height, components, density, hasExif };
    }
    o += 2 + len;
  }
  return { error: 'JPEGの寸法情報（SOF）が見つかりません' };
}

/** DPI。単位なし・欠落・未対応メタデータは「未確認」。勝手に72dpiと補完しない */
export function dpiFromPng(info: PngInfo): DpiFact {
  if (!info.phys) return { status: 'unknown', reason: 'pHYsチャンクがありません' };
  if (info.phys.unit !== 1) return { status: 'unknown', reason: 'pHYsの単位が未指定（縦横比のみ）です' };
  return {
    status: 'ok',
    x: info.phys.x * 0.0254,
    y: info.phys.y * 0.0254,
    source: 'pHYs',
    raw: `${info.phys.x}×${info.phys.y} px/m`,
  };
}

export function dpiFromJpeg(info: JpegInfo): DpiFact {
  const d = info.density;
  if (d && d.units === 1) return { status: 'ok', x: d.x, y: d.y, source: 'JFIF', raw: `${d.x}×${d.y} dpi` };
  if (d && d.units === 2) return { status: 'ok', x: d.x * 2.54, y: d.y * 2.54, source: 'JFIF', raw: `${d.x}×${d.y} dpcm` };
  if (info.hasExif) return { status: 'unknown', reason: 'EXIFの解像度情報は未対応のため未確認です' };
  if (d && d.units === 0) return { status: 'unknown', reason: 'JFIFの密度単位が未指定です' };
  return { status: 'unknown', reason: '解像度情報がありません' };
}

export const PNG_COLOR_TYPE: Record<number, string> = {
  0: 'グレースケール',
  2: 'RGB',
  3: 'パレット',
  4: 'グレースケール+アルファ',
  6: 'RGBA',
};
