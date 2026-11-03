import { describe, expect, it } from 'vitest';
import { imageDims, isLikelySheet, unsplitSheets } from '../../src/core/sheet';
import { LINE_TEMPLATE } from '../../src/core/templates';
import { readFix } from '../helpers/fixtures';
import type { AssetRecord } from '../../src/core/types';

const a = (id: string, derivedFrom?: AssetRecord['derivedFrom']): AssetRecord => ({ id, originalName: `${id}.png`, sourcePath: '', blob: new Blob([]), size: 0, sha256: '', version: 1, addedAt: '', derivedFrom });

describe('一覧画像の見分け', () => {
  it('ヘッダーから寸法', () => {
    expect(imageDims(readFix('sheet-white-2x3.png'))).toEqual({ width: 1250, height: 740 });
    expect(imageDims(readFix('generated/broken.png'))).toBeNull();
  });
  it('上限の1.5倍（555×480）を超えると一覧画像。少し大きいだけの1枚はチェックのサイズ超過扱い', () => {
    expect(isLikelySheet({ width: 370, height: 320 }, LINE_TEMPLATE)).toBe(false);
    expect(isLikelySheet({ width: 400, height: 320 }, LINE_TEMPLATE)).toBe(false);
    expect(isLikelySheet({ width: 555, height: 480 }, LINE_TEMPLATE)).toBe(false);
    expect(isLikelySheet({ width: 556, height: 100 }, LINE_TEMPLATE)).toBe(true);
    expect(isLikelySheet({ width: 300, height: 481 }, LINE_TEMPLATE)).toBe(true);
    expect(isLikelySheet({ width: 1024, height: 1536 }, LINE_TEMPLATE)).toBe(true);
    expect(isLikelySheet(null, LINE_TEMPLATE)).toBe(false);
  });
  it('分割済みの元画像（透過経由も含む）と分割で作った画像は案内しない', () => {
    const big = { width: 1000, height: 1000 };
    const small = { width: 300, height: 300 };
    const assets = [
      a('sheet1'),
      a('sheet1t', { assetId: 'sheet1', originalName: '', op: 'background', detail: '' }),
      a('p1', { assetId: 'sheet1t', originalName: '', op: 'split', detail: '' }),
      a('sheet2'),
      a('s01'),
    ];
    const dims = { sheet1: big, sheet1t: big, p1: small, sheet2: big, s01: small };
    expect(unsplitSheets(assets, dims, LINE_TEMPLATE).map((x) => x.id)).toEqual(['sheet2']);
  });
});
