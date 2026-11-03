// 実装キット tests/README.md の受入ケース
import { describe, expect, it } from 'vitest';
import { assetFrom, factsFor, loadZipFixture, readFix } from '../helpers/fixtures';
import { evaluateProject, exportGate, resolveScopes } from '../../src/core/rules';
import { LINE_TEMPLATE, validateCheckTemplate } from '../../src/core/templates';
import { confirmSuggestions, newProject, suggestRoles } from '../../src/core/project';
import type { Project } from '../../src/core/types';

const tmap = new Map([[LINE_TEMPLATE.id, LINE_TEMPLATE]]);

async function projectFromZip(zipName: string, opts: { check?: boolean } = {}): Promise<Project> {
  const zip = await loadZipFixture(zipName);
  let p = newProject({ kind: 'template', templateId: 'line-static' });
  p.settings.stickerCounts['line-static'] = 16;
  for (const f of zip.files) {
    const a = await assetFrom(f.data, f.name);
    p.assets.push(a);
    if (opts.check !== false) p.facts[a.id] = await factsFor(f.data, f.name);
  }
  const { scopes } = resolveScopes(p.target, tmap, p.settings.stickerCounts);
  p = confirmSuggestions(suggestRoles(p, scopes).project);
  return p;
}

const byName = (p: Project, ev: ReturnType<typeof evaluateProject>, name: string) =>
  ev.assets[p.assets.find((a) => a.originalName === name)!.id];

describe('valid-line-16.zip', () => {
  it('スタンプ16・main1・tab1で、寸法/形式/容量/透過/偶数/DPIにエラーなし', async () => {
    const p = await projectFromZip('valid-line-16.zip');
    const ev = evaluateProject(p, tmap);
    const s = ev.scopes[0];
    expect(s.roles.map((r) => [r.role.id, r.refs.length])).toEqual([['sticker', 16], ['main', 1], ['tab', 1]]);
    expect(s.setFindings.filter((f) => f.severity === 'error')).toEqual([]);
    for (const a of p.assets) {
      const codes = ev.assets[a.id].findings.map((f) => f.code);
      for (const bad of ['dim-max', 'dim-exact', 'format', 'bytes', 'even', 'transparency-none', 'transparency-empty', 'dpi-low', 'dpi-unknown', 'unreadable']) {
        expect(codes, `${a.originalName}`).not.toContain(bad);
      }
      expect(codes).toContain('transparency-note');
      // 指摘があっても余白（目安）だけ
      expect(ev.assets[a.id].findings.filter((f) => f.severity !== 'info').every((f) => f.code === 'margin')).toBe(true);
    }
    expect(s.entries.map((e) => e.path).sort()).toEqual(
      [...Array.from({ length: 16 }, (_, i) => `${String(i + 1).padStart(2, '0')}.png`), 'main.png', 'tab.png'].sort(),
    );
    // 余白警告があれば allClear にしない
    const marginWarn = Object.values(ev.assets).some((a) => a.findings.some((f) => f.code === 'margin'));
    expect(ev.allClear).toBe(!marginWarn);
  });

  it('DPIはpHYs 2835px/m（72.009dpi）を丸め誤差として許容', async () => {
    const f = await factsFor(readFix('generated/12.png'), '12.png');
    expect(f.dpi.status).toBe('ok');
  });
});

describe('invalid-two-images.zip', () => {
  it('06.pngは幅400で上限370超過、12.pngは完全不透明。他にエラーなし', async () => {
    const p = await projectFromZip('invalid-two-images.zip');
    const ev = evaluateProject(p, tmap);
    const f06 = byName(p, ev, '06.png');
    expect(f06.status).toBe('error');
    const dim = f06.findings.find((f) => f.code === 'dim-max')!;
    expect(dim.measured).toBe('400 × 320 px');
    expect(dim.required).toBe('最大 370 × 320 px');
    expect(dim.detail).toContain('幅が30px');
    expect(dim.source).toBe('official');
    const f12 = byName(p, ev, '12.png');
    expect(f12.status).toBe('error');
    expect(f12.findings.map((f) => f.code)).toContain('transparency-none');
    const errored = p.assets.filter((a) => ev.assets[a.id].status === 'error').map((a) => a.originalName).sort();
    expect(errored).toEqual(['06.png', '12.png']);
    expect(exportGate(ev.scopes[0], 'upload').allowed).toBe(false);
    expect(exportGate(ev.scopes[0], 'work').allowed).toBe(true);
  });
});

describe('missing-main-and-sticker.zip', () => {
  it('スタンプ1枚不足・main1枚不足、tabは存在', async () => {
    const p = await projectFromZip('missing-main-and-sticker.zip');
    const ev = evaluateProject(p, tmap);
    const s = ev.scopes[0];
    const short = s.setFindings.filter((f) => f.code === 'count-short').map((f) => f.title).sort();
    expect(short).toEqual(['スタンプが1枚不足', 'メイン画像が1枚不足'].sort());
    expect(s.roles.find((r) => r.role.id === 'tab')!.refs.length).toBe(1);
    expect(s.roles.find((r) => r.role.id === 'sticker')!.refs.length).toBe(15);
  });
});

describe('generated/', () => {
  const line = tmap.get('line-static')!;
  const sticker = line.roles.find((r) => r.id === 'sticker')!;
  async function evalSingle(file: string) {
    let p = newProject();
    const bytes = readFix(`generated/${file}`);
    const a = await assetFrom(bytes, file);
    p.assets.push(a);
    p.facts[a.id] = await factsFor(bytes, file);
    p.refs.push({ id: 'r1', assetId: a.id, templateId: 'line-static', roleId: sticker.id, order: 1 });
    return evaluateProject(p, tmap).assets[a.id];
  }
  it('odd-size: 寸法上限内だが奇数', async () => {
    const r = await evalSingle('odd-size.png');
    expect(r.findings.map((f) => f.code)).toContain('even');
    expect(r.findings.map((f) => f.code)).not.toContain('dim-max');
    expect(r.findings.find((f) => f.code === 'even')!.detail).toBe('幅369・高さ319が奇数です。');
  });
  it('no-dpi: DPI未確認（72dpiと補完しない）', async () => {
    const r = await evalSingle('no-dpi.png');
    const d = r.findings.find((f) => f.code === 'dpi-unknown')!;
    expect(d.severity).toBe('unknown');
    expect(r.status).toBe('warn');
  });
  it('empty: 完全透明は単純合格にしない', async () => {
    const r = await evalSingle('empty.png');
    expect(r.status).toBe('error');
    expect(r.findings.find((f) => f.code === 'transparency-empty')!.title).toContain('完全透明');
  });
  it('broken: デコード不能、他ファイルの処理は継続できる', async () => {
    const r = await evalSingle('broken.png');
    expect(r.status).toBe('error');
    expect(r.findings[0].code).toBe('unreadable');
    const ok = await evalSingle('12.png');
    expect(ok.status).toBe('error'); // 12は不透明。処理自体は継続
  });
});

describe('bad-template.json', () => {
  it('未対応schemaVersionを明示して拒否', () => {
    const e = validateCheckTemplate(JSON.parse(new TextDecoder().decode(readFix('bad-template.json'))));
    expect(e[0]).toContain('schemaVersion 999 は未対応');
  });
});
