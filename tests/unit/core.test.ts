import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { assetFrom, factsFor, loadZipFixture, readFix } from '../helpers/fixtures';
import { buildZip, readZip, zipSize, ZipAbortError, ZipError, normalizeZipPath } from '../../src/core/zip';
import { asciiFileName, evaluateRole, evaluateProject, exportGate, exportFileName, resolveScopes } from '../../src/core/rules';
import { BUILTIN_BUNDLES, BUILTIN_CHECK_TEMPLATES, cloneCheckTemplate, parseTemplateJson, templateToJson, validateBundleTemplate } from '../../src/core/templates';
import { addRef, changeRefRole, confirmSuggestions, moveRef, newProject, replaceAsset, setNameOverride, suggestRoles } from '../../src/core/project';
import { headerFacts } from '../../src/core/facts';
import { sha256Hex } from '../../src/core/hash';
import { buildBackup, restoreBackup } from '../../src/core/backup';
import { patternToRegex, renderName } from '../../src/core/naming';
import type { AssetFacts, CheckTemplate, Project } from '../../src/core/types';

const tmap = new Map(BUILTIN_CHECK_TEMPLATES.map((t) => [t.id, t]));
const bmap = new Map(BUILTIN_BUNDLES.map((b) => [b.id, b]));
const line = tmap.get('line-static')!;
const sticker = line.roles[0];
const LIM = { maxEntries: 200, maxTotalBytes: 100_000_000 };

function fakeFacts(over: Partial<AssetFacts>): AssetFacts {
  return {
    sha256: 'x', alphaThreshold: 8, analyzedAt: '', bytes: 1000, container: 'png', extFormat: 'png',
    width: 370, height: 320, hasAlphaChannel: true,
    dpi: { status: 'ok', x: 72, y: 72, source: 'pHYs', raw: '' }, decode: { ok: true },
    alpha: { totalPixels: 100, translucentPixels: 50, zeroAlphaPixels: 50, contentBox: { left: 20, top: 20, right: 300, bottom: 280 }, margins: { left: 20, top: 20, right: 69, bottom: 39 }, threshold: 8 },
    ...over,
  };
}

describe('容量閾値（1,000,000 bytes）', () => {
  it.each([[999_999, false], [1_000_000, false], [1_000_001, true]])('%d bytes → 超過=%s', (bytes, over) => {
    const codes = evaluateRole(fakeFacts({ bytes }), sticker, line).map((f) => f.code);
    expect(codes.includes('bytes')).toBe(over);
  });
});

describe('寸法', () => {
  it('maxは上限一致で合格、exactは一致必須', () => {
    expect(evaluateRole(fakeFacts({ width: 370, height: 320 }), sticker, line).some((f) => f.code === 'dim-max')).toBe(false);
    expect(evaluateRole(fakeFacts({ width: 200, height: 100 }), sticker, line).some((f) => f.code === 'dim-max')).toBe(false);
    const main = line.roles.find((r) => r.id === 'main')!;
    expect(evaluateRole(fakeFacts({ width: 238, height: 240 }), main, line).some((f) => f.code === 'dim-exact')).toBe(true);
  });
  it('DPI 71.9（丸め誤差外）はエラー、pHYs 2834px/m（71.98）は許容', () => {
    expect(evaluateRole(fakeFacts({ dpi: { status: 'ok', x: 71.5, y: 72, source: 'pHYs', raw: '' } }), sticker, line).some((f) => f.code === 'dpi-low')).toBe(true);
    expect(evaluateRole(fakeFacts({ dpi: { status: 'ok', x: 2834 * 0.0254, y: 2834 * 0.0254, source: 'pHYs', raw: '' } }), sticker, line).some((f) => f.code === 'dpi-low')).toBe(false);
  });
});

describe('形式の判定（拡張子を信用しない）', () => {
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0,
    0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200, 1, 1, 0x11, 0,
    0xff, 0xd9,
  ]);
  it('PNG拡張子のJPEG：拡張子不一致の警告＋形式エラー', () => {
    const { facts } = headerFacts(jpeg, 'sticker.png', 'h', 8);
    expect(facts.container).toBe('jpeg');
    expect(facts.width).toBe(200);
    expect(facts.height).toBe(100);
    expect(facts.dpi.status).toBe('ok');
    const p = newProject();
    p.assets.push({ id: 'a', originalName: 'sticker.png', sourcePath: '', blob: new Blob([]), size: jpeg.length, sha256: 'h', version: 1, addedAt: '' });
    p.facts.a = { ...facts, decode: { ok: true }, alpha: { totalPixels: 1, translucentPixels: 0, zeroAlphaPixels: 0, contentBox: { left: 0, top: 0, right: 0, bottom: 0 }, margins: { left: 0, top: 0, right: 0, bottom: 0 }, threshold: 8 } };
    p.refs.push({ id: 'r', assetId: 'a', templateId: 'line-static', roleId: 'sticker', order: 1 });
    const codes = evaluateProject(p, tmap, bmap).assets.a.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['ext-mismatch', 'format', 'transparency-none']));
  });
  it('アニメPNG（acTL）は対象外', () => {
    const png = readFix('generated/12.png');
    const ihdrEnd = 8 + 8 + 13 + 4;
    const actl = new Uint8Array([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    const apng = new Uint8Array(png.length + actl.length);
    apng.set(png.subarray(0, ihdrEnd));
    apng.set(actl, ihdrEnd);
    apng.set(png.subarray(ihdrEnd), ihdrEnd + actl.length);
    const { facts, shouldDecode } = headerFacts(apng, 'a.png', 'h', 8);
    expect(shouldDecode).toBe(false);
    expect(facts.png?.animated).toBe(true);
  });
  it('GIF/SVG/HEICは黙って変換せず非対応', () => {
    expect(headerFacts(strToU8('GIF89a....'), 'x.gif', 'h', 8).facts.container).toBe('gif');
    expect(headerFacts(strToU8('<?xml version="1.0"?><svg></svg>'), 'x.svg', 'h', 8).facts.container).toBe('svg');
    const heic = new Uint8Array([0, 0, 0, 24, ...strToU8('ftypheic'), 0, 0, 0, 0]);
    expect(headerFacts(heic, 'x.heic', 'h', 8).facts.container).toBe('heic');
  });
});

describe('ZIP読込の安全策', () => {
  const png = readFix('generated/12.png');
  it('..・絶対パス・重複正規化パス・ネストZIP・システムファイルを拒否し、有効分は継続', async () => {
    const z = zipSync({
      'ok.png': png,
      '../evil.png': png,
      '/abs.png': png,
      'dir/./a.png': png,
      'dir/A.PNG': png,
      'inner.zip': zipSync({ 'x.png': png }),
      '__MACOSX/._ok.png': strToU8('x'),
    });
    const r = await readZip(z, LIM, { skipExtensions: ['.zip'] });
    expect(r.files.map((f) => f.path).sort()).toEqual(['dir/a.png', 'ok.png']);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    expect(reasons['../evil.png']).toContain('..');
    expect(reasons['/abs.png']).toContain('絶対パス');
    expect(reasons['dir/A.PNG']).toContain('同じパス');
    expect(reasons['inner.zip']).toContain('ZIPの中のZIP');
  });
  it('normalizeZipPath', () => {
    expect(normalizeZipPath('a\\b.png')).toEqual({ path: 'a/b.png' });
    expect('error' in normalizeZipPath('C:/x.png')).toBe(true);
  });
  it('ファイル数上限で中止', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) files[`${i}.png`] = png;
    await expect(readZip(zipSync(files), { maxEntries: 4, maxTotalBytes: 1e9 })).rejects.toThrow(/ファイル数/);
  });
  it('宣言サイズを偽った展開爆弾も実バイト監視で中止', async () => {
    const big = new Uint8Array(5_000_000);
    const z = zipSync({ 'bomb.png': big }, { level: 9 });
    // 中央ディレクトリとローカルヘッダーの宣言サイズを小さく偽装
    const v = new DataView(z.buffer);
    for (let i = 0; i < z.length - 4; i++) {
      const sig = v.getUint32(i, true);
      if (sig === 0x02014b50) v.setUint32(i + 24, 10, true);
    }
    await expect(readZip(z, { maxEntries: 10, maxTotalBytes: 1_000_000 })).rejects.toThrow(/実バイト/);
    // 上限内なら宣言との不一致として個別に除外（全体は継続）
    const r = await readZip(z, { maxEntries: 10, maxTotalBytes: 100_000_000 });
    expect(r.files).toEqual([]);
    expect(r.skipped[0].reason).toContain('宣言サイズ');
  });
  it('暗号化エントリは非対応', async () => {
    const z = zipSync({ 'a.png': png });
    const v = new DataView(z.buffer);
    for (let i = 0; i < z.length - 4; i++) {
      const sig = v.getUint32(i, true);
      if (sig === 0x04034b50) v.setUint16(i + 6, 1, true);
      if (sig === 0x02014b50) v.setUint16(i + 8, 1, true);
    }
    const r = await readZip(z, LIM);
    expect(r.skipped[0].reason).toContain('暗号化');
  });
  it('破損ZIPは明示エラー', async () => {
    await expect(readZip(strToU8('not a zip at all, sorry'), LIM)).rejects.toBeInstanceOf(ZipError);
    const z = await loadZipFixture('valid-line-16.zip');
    expect(z.files.length).toBe(18);
  });
  it('中断できる', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(readZip(readFix('valid-line-16.zip'), LIM, { signal: ac.signal })).rejects.toBeInstanceOf(ZipAbortError);
    await expect(buildZip([{ path: 'a', size: 1, read: async () => new Uint8Array(1) }], { signal: ac.signal })).rejects.toBeInstanceOf(ZipAbortError);
  });
});

describe('梱包：読込→検査→ZIP→再読込でバイトと役割数を維持', () => {
  it('SHA-256一致・サイズ事前計算一致・余計なファイルなし', async () => {
    const zip = await loadZipFixture('valid-line-16.zip');
    let p = newProject();
    for (const f of zip.files) {
      const a = await assetFrom(f.data, f.name);
      p.assets.push(a);
      p.facts[a.id] = await factsFor(f.data, f.name);
    }
    const { scopes } = resolveScopes(p.target, tmap, bmap, {});
    p = confirmSuggestions(suggestRoles(p, scopes).project);
    const s = evaluateProject(p, tmap, bmap).scopes[0];
    const byId = new Map(p.assets.map((a) => [a.id, a]));
    const blob = await buildZip(s.entries.map((e) => ({ path: e.path, size: e.size, read: async () => new Uint8Array(await byId.get(e.assetId)!.blob.arrayBuffer()) })));
    expect(blob.size).toBe(s.zipBytes);
    expect(s.zipBytes).toBe(zipSize(s.entries));
    const back = await readZip(new Uint8Array(await blob.arrayBuffer()), LIM);
    expect(back.files.length).toBe(18);
    for (const e of s.entries) {
      const f = back.files.find((x) => x.path === e.path)!;
      expect(await sha256Hex(f.data)).toBe(e.sha256);
    }
    // 元のバイトも変わっていない
    for (const f of zip.files) {
      const a = p.assets.find((x) => x.originalName === f.name)!;
      expect(await sha256Hex(new Uint8Array(await a.blob.arrayBuffer()))).toBe(await sha256Hex(f.data));
    }
    // 再読込で役割数も維持
    let p2 = newProject();
    for (const f of back.files) p2.assets.push(await assetFrom(f.data, f.name));
    p2 = suggestRoles(p2, scopes).project;
    const s2 = evaluateProject(p2, tmap, bmap).scopes[0];
    expect(s2.roles.map((r) => r.refs.length)).toEqual([16, 1, 1]);
  });
});

describe('書出し可否', () => {
  async function base(): Promise<Project> {
    const p = newProject();
    const bytes = readFix('generated/12.png');
    for (let i = 1; i <= 16; i++) {
      const a = await assetFrom(bytes, `${String(i).padStart(2, '0')}.png`);
      p.assets.push(a);
      p.refs.push({ id: `r${i}`, assetId: a.id, templateId: 'line-static', roleId: 'sticker', order: i });
    }
    for (const [n, role] of [['main.png', 'main'], ['tab.png', 'tab']] as const) {
      const a = await assetFrom(bytes, n);
      p.assets.push(a);
      p.refs.push({ id: `r${n}`, assetId: a.id, templateId: 'line-static', roleId: role, order: 1 });
    }
    return p;
  }
  it('未検査：投稿用は止め、作業用は「未チェック」名で許可', async () => {
    const p = await base();
    const s = evaluateProject(p, tmap, bmap).scopes[0];
    const up = exportGate(s, 'upload');
    expect(up.allowed).toBe(false);
    expect(up.label).toBe('未チェック');
    const work = exportGate(s, 'work');
    expect(work.allowed).toBe(true);
    expect(exportFileName(s, 'work', work)).toBe('WORK-unchecked_line-static.zip');
    expect(exportFileName(s, 'upload', up)).toBe('UPLOAD_line-static.zip');
  });
  it('ASCIIの保存名', () => {
    expect(asciiFileName('日本語 名前.png', 'x.bin')).toBe('x.png');
    expect(asciiFileName('cat 01.png', 'x.bin')).toBe('cat 01.png');
    expect(asciiFileName('ねこ_cat.PNG', 'x.bin')).toBe('cat.PNG');
  });
  it('警告だけなら確認付きで投稿用を許可', async () => {
    const p = await base();
    for (const a of p.assets) p.facts[a.id] = fakeFacts({ sha256: a.sha256, bytes: a.size, width: a.originalName === 'main.png' ? 240 : a.originalName === 'tab.png' ? 96 : 370, height: a.originalName === 'main.png' ? 240 : a.originalName === 'tab.png' ? 74 : 320, dpi: { status: 'unknown', reason: 'pHYsなし' } });
    const s = evaluateProject(p, tmap, bmap).scopes[0];
    const g = exportGate(s, 'upload');
    expect(s.hasErrors).toBe(false);
    expect(g.allowed).toBe(true);
    expect(g.needsAck).toBe(true);
  });
  it('読込不能は作業用でも解決必須', async () => {
    const p = await base();
    for (const a of p.assets) p.facts[a.id] = fakeFacts({ sha256: a.sha256 });
    const a0 = p.assets[0];
    p.facts[a0.id] = fakeFacts({ sha256: a0.sha256, decode: { ok: false, reason: 'x' } });
    const s = evaluateProject(p, tmap, bmap).scopes[0];
    expect(exportGate(s, 'work').allowed).toBe(false);
  });
});

describe('同名ファイル・パス衝突・役割変更・差替え', () => {
  it('同名でも別assetId。{original}の衝突は解決まで書出し停止', async () => {
    const booth = tmap.get('booth-image-pack')!;
    const bytes = readFix('generated/12.png');
    let p = newProject({ kind: 'template', templateId: booth.id });
    const a1 = await assetFrom(bytes, 'image.png');
    const a2 = await assetFrom(bytes, 'image.png');
    expect(a1.id).not.toBe(a2.id);
    p.assets.push(a1, a2);
    p = addRef(addRef(p, a1.id, booth.id, 'product'), a2.id, booth.id, 'product');
    let s = evaluateProject(p, tmap, bmap).scopes[0];
    expect(s.setFindings.some((f) => f.code === 'path-collision')).toBe(true);
    expect(exportGate(s, 'work').allowed).toBe(false);
    const ref2 = p.refs.find((r) => r.assetId === a2.id)!;
    p = setNameOverride(p, ref2.id, 'image-2.png');
    s = evaluateProject(p, tmap, bmap).scopes[0];
    expect(s.setFindings.some((f) => f.code === 'path-collision')).toBe(false);
    expect(s.entries.map((e) => e.path).sort()).toEqual(['product/image-2.png', 'product/image.png']);
  });
  it('大文字小文字違いも衝突', async () => {
    const booth = tmap.get('booth-image-pack')!;
    let p = newProject({ kind: 'template', templateId: booth.id });
    const a1 = await assetFrom(new Uint8Array([1]), 'A.png');
    const a2 = await assetFrom(new Uint8Array([2]), 'a.PNG');
    p.assets.push(a1, a2);
    p = addRef(addRef(p, a1.id, booth.id, 'product'), a2.id, booth.id, 'product');
    expect(evaluateProject(p, tmap, bmap).scopes[0].collisions.length).toBe(1);
  });
  it('差替えでassetIdと役割を維持し、検査結果を無効化', async () => {
    const bytes = readFix('generated/06.png');
    let p = newProject();
    const a = await assetFrom(bytes, '06.png');
    p.assets.push(a);
    p.facts[a.id] = await factsFor(bytes, '06.png');
    p = addRef(p, a.id, 'line-static', 'sticker');
    expect(evaluateProject(p, tmap, bmap).assets[a.id].status).toBe('error');
    const fixed = readFix('generated/12.png');
    p = replaceAsset(p, a.id, { originalName: '06-fixed.png', blob: new Blob([fixed as BlobPart]), size: fixed.length, sha256: await sha256Hex(fixed), sourcePath: '06-fixed.png' });
    expect(p.assets[0].id).toBe(a.id);
    expect(p.assets[0].version).toBe(2);
    expect(p.refs[0].assetId).toBe(a.id);
    expect(evaluateProject(p, tmap, bmap).assets[a.id].status).toBe('unchecked');
    // 古い事実が残っていても sha 不一致で使わない
    p.facts[a.id] = await factsFor(bytes, '06.png');
    expect(evaluateProject(p, tmap, bmap).assets[a.id].status).toBe('unchecked');
    p.facts[a.id] = await factsFor(fixed, '06-fixed.png');
    const ev = evaluateProject(p, tmap, bmap);
    expect(ev.assets[a.id].findings.some((f) => f.code === 'dim-max')).toBe(false);
    expect(ev.scopes[0].entries[0].path).toBe('01.png');
  });
  it('役割変更と前へ/後へ', async () => {
    let p = newProject();
    const as = await Promise.all(['x.png', 'y.png', 'z.png'].map((n, i) => assetFrom(new Uint8Array([i]), n)));
    p.assets.push(...as);
    for (const a of as) p = addRef(p, a.id, 'line-static', 'sticker');
    const rz = p.refs.find((r) => r.assetId === as[2].id)!;
    p = moveRef(p, rz.id, -1);
    let s = evaluateProject(p, tmap, bmap).scopes[0];
    expect(s.roles[0].refs.map((r) => r.asset.originalName)).toEqual(['x.png', 'z.png', 'y.png']);
    expect(s.roles[0].refs.map((r) => r.outputPath)).toEqual(['01.png', '02.png', '03.png']);
    p = changeRefRole(p, rz.id, 'line-static', 'main');
    s = evaluateProject(p, tmap, bmap).scopes[0];
    expect(s.roles[0].refs.map((r) => r.asset.originalName)).toEqual(['x.png', 'y.png']);
    expect(s.roles[1].refs[0].outputPath).toBe('main.png');
  });
  it('スタンプ数の選択で必要枚数が変わる', () => {
    const p = newProject();
    p.settings.stickerCounts['line-static'] = 8;
    const s = evaluateProject(p, tmap, bmap).scopes[0];
    expect(s.roles[0].min).toBe(8);
  });
});

describe('組合せセット（2テンプレート結合）', () => {
  it('選択した役割だけ検査。1つの元画像を複数役割で参照し、ZIPを分けて出力', async () => {
    const zip = await loadZipFixture('valid-line-16.zip');
    let p = newProject({ kind: 'bundle', bundleId: 'sale-and-promotion' });
    for (const f of zip.files) {
      const a = await assetFrom(f.data, f.name);
      p.assets.push(a);
      p.facts[a.id] = await factsFor(f.data, f.name);
    }
    const { scopes } = resolveScopes(p.target, tmap, bmap, {});
    p = confirmSuggestions(suggestRoles(p, scopes).project);
    // main.png を宣伝用表紙にも参照（同じ素材を2役割で）
    const main = p.assets.find((a) => a.originalName === 'main.png')!;
    p = addRef(p, main.id, 'booth-image-pack', 'cover');
    const ev = evaluateProject(p, tmap, bmap);
    expect(ev.scopes.map((s) => s.scope.archiveName)).toEqual(['line-upload.zip', 'promotion.zip']);
    const promo = ev.scopes[1];
    // productの不足は検査しない
    expect(promo.setFindings.filter((f) => f.code.startsWith('count'))).toEqual([]);
    expect(promo.entries.map((e) => e.path)).toEqual(['promotion/cover.png']);
    // 表紙1200×1200（自作ルール）に240×240は違反、出典は自作
    const f = ev.assets[main.id].findings.find((x) => x.code === 'dim-exact')!;
    expect(f.source).toBe('user');
    expect(f.roleLabel).toContain('表紙');
    // LINE側の判定はそのまま（条件を緩和しない）
    expect(ev.scopes[0].entries.length).toBe(18);
    expect(exportGate(ev.scopes[1], 'upload').allowed).toBe(false);
  });
  it('同名roleIdはtemplateIdで名前空間を分ける', async () => {
    const t2: CheckTemplate = { ...cloneCheckTemplate(tmap.get('line-static')!, new Set(['line-static'])), id: 'line-b' };
    const tm = new Map(tmap);
    tm.set(t2.id, t2);
    const bundle = { schemaVersion: 1 as const, kind: 'bundle-template' as const, id: 'b', name: 'b', templates: ['line-static', 'line-b'], outputs: [
      { id: 'o1', templateId: 'line-static', roles: ['main'], archiveName: 'a.zip' },
      { id: 'o2', templateId: 'line-b', roles: ['main'], archiveName: 'b.zip' },
    ] };
    expect(validateBundleTemplate(bundle, tm)).toEqual([]);
    let p = newProject({ kind: 'bundle', bundleId: 'b' });
    const a = await assetFrom(new Uint8Array([1]), 'main.png');
    p.assets.push(a);
    p = addRef(p, a.id, 'line-static', 'main');
    const ev = evaluateProject(p, tm, new Map([['b', bundle]]));
    expect(ev.scopes[0].entries.length).toBe(1);
    expect(ev.scopes[1].entries.length).toBe(0);
  });
});

describe('テンプレート', () => {
  it('複製は自作扱い・JSON往復で同一', () => {
    const c = cloneCheckTemplate(line, new Set(['line-static']));
    expect(c.id).toBe('line-static-copy');
    expect(c.sourceType).toBe('user-workflow');
    const r = parseTemplateJson(templateToJson(c));
    expect(r.ok && r.value).toEqual(c);
    expect(line.sourceType).toBe('official-derived'); // 元は変わらない
  });
  it('不正な役割を詳細に指摘', () => {
    const bad = JSON.parse(templateToJson(line));
    bad.roles[0].count = { min: 5, max: 2 };
    bad.roles[0].directory = '../x';
    bad.roles.push({ ...bad.roles[1] });
    const r = parseTemplateJson(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join('\n')).toMatch(/max が min より小さい/);
      expect(r.errors.join('\n')).toMatch(/\.\./);
      expect(r.errors.join('\n')).toMatch(/重複/);
    }
  });
  it('命名パターン', () => {
    expect(renderName('{index:02}.png', { index: 3, container: 'png', originalName: 'x.png' })).toBe('03.png');
    expect(renderName('cover.{ext}', { index: 1, container: 'jpeg', originalName: 'x.png' })).toBe('cover.jpg');
    expect(patternToRegex('{index:02}.png')!.exec('16.PNG')![1]).toBe('16');
    expect(patternToRegex('{original}')).toBeNull();
  });
});

describe('バックアップ', () => {
  it('素材・役割・順序・設定・自作テンプレートを復元しSHA-256を検証', async () => {
    let p = newProject();
    p.name = '年末年始マーモット';
    p.settings.stickerCounts['line-static'] = 24;
    const bytes = readFix('generated/12.png');
    const a = await assetFrom(bytes, '日本語 名前.png');
    p.assets.push(a);
    p.facts[a.id] = await factsFor(bytes, a.originalName);
    p = addRef(p, a.id, 'line-static', 'sticker');
    const c = cloneCheckTemplate(line, new Set(['line-static']));
    const blob = await buildBackup(p, [c], []);
    const r = await restoreBackup(new Uint8Array(await blob.arrayBuffer()));
    expect(r.warnings).toEqual([]);
    expect(r.project.name).toBe('年末年始マーモット');
    expect(r.project.settings.stickerCounts['line-static']).toBe(24);
    expect(r.project.assets[0].id).toBe(a.id);
    expect(r.project.assets[0].sha256).toBe(a.sha256);
    expect(r.project.refs).toEqual(p.refs);
    expect(r.checkTemplates[0]).toEqual(c);
    expect(r.project.facts[a.id].sha256).toBe(a.sha256);
  });
  it('投稿用ZIPをバックアップとして読むと案内付きで拒否', async () => {
    await expect(restoreBackup(readFix('valid-line-16.zip'))).rejects.toThrow(/バックアップZIPではありません/);
  });
});
