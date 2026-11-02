// 実ブラウザ（Chromium）での受入確認。`npm run build` 後に `npm run e2e`。
// - 全リクエストが同一オリジン（またはblob:/data:）であることを記録・検証
// - キットのテストデータで 読込→検査→ZIP→再読込 と各異常ケースを確認
// - 1024×768 / 768×1024 / 390×844 で横スクロールがないことを確認しスクリーンショット保存
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const OUT = join(ROOT, 'e2e', 'out');
const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sha = (b) => createHash('sha256').update(b).digest('hex');
const results = [];
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    results.push(`✅ ${name}`);
  } catch (e) {
    failed++;
    results.push(`❌ ${name}\n   ${String(e?.stack || e).split('\n').slice(0, 4).join('\n   ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// テスト用ファイルを用意
const validZip = readFileSync(join(FIX, 'valid-line-16.zip'));
const validFiles = unzipSync(new Uint8Array(validZip));
const fixed06 = join(OUT, '06-fixed.png');
writeFileSync(fixed06, validFiles['06.png']);
// APNG（acTL挿入）
{
  const png = readFileSync(join(FIX, 'generated', '12.png'));
  const at = 8 + 8 + 13 + 4;
  const actl = Buffer.from([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
  writeFileSync(join(OUT, 'anim.png'), Buffer.concat([png.subarray(0, at), actl, png.subarray(at)]));
}
// PNG拡張子のJPEG
writeFileSync(join(OUT, 'fake-jpeg.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 10, 0, 10, 1, 1, 0x11, 0, 0xff, 0xd9]));
writeFileSync(join(OUT, 'note.txt'), 'hello');

const server = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe' });
process.on('exit', () => server.kill('SIGKILL'));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
  server.stderr.on('data', (d) => process.stderr.write(d));
  server.on('exit', (code) => reject(new Error(`preview server exited (${code}). ポート${PORT}が使用中の可能性があります`)));
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
});

const browser = await chromium.launch();
const requests = [];
const consoleErrors = [];

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, deviceScaleFactor: 1, hasTouch: viewport.width < 1100 });
  const page = await ctx.newPage();
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('dialog', (d) => { consoleErrors.push(`native dialog used: ${d.message()}`); d.dismiss(); });
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('text=販売前チェック');
  return { ctx, page };
}

const idle = (page) => page.waitForFunction(() => !document.querySelector('.jobbar'), null, { timeout: 30000 });
async function loadZip(page, file) {
  await page.setInputFiles('[data-testid=input-zip]', file);
  await idle(page);
  await page.waitForTimeout(150);
}
async function addImages(page, files) {
  await page.setInputFiles('[data-testid=input-images]', files);
  await idle(page);
  await page.waitForTimeout(150);
}
async function runCheck(page) {
  await page.getByRole('button', { name: /^検査を実行/ }).click();
  await page.waitForTimeout(100);
  await idle(page);
}
async function counts(page) {
  return page.$$eval('.sum-item b', (els) => els.map((e) => Number(e.textContent)));
}
async function noHScroll(page, label) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert(sw <= cw, `${label}: 横スクロールあり scrollWidth=${sw} clientWidth=${cw}`);
}
async function card(page, label) {
  return page.locator('.thumb-card', { has: page.locator('.thumb-label', { hasText: new RegExp(`^${label}$`) }) }).first();
}
async function newProject(page) {
  await page.getByRole('tab', { name: /梱包/ }).click();
  await page.getByRole('button', { name: '新しい作品を始める' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '新しい作品を始める' }).click();
  await page.getByRole('tab', { name: /チェック/ }).click();
}

// ================================================================ 1024×768（iPad横）
const { ctx, page } = await newPage({ width: 1024, height: 768 });
await page.screenshot({ path: join(OUT, '1024-empty.png') });

await step('空状態で待機マスコットを表示', async () => {
  const src = await page.getAttribute('.mascot-card img', 'src');
  assert(src.includes('mascot-waiting'), src);
  assert(await page.$eval('.mascot-card img', (i) => i.complete && i.naturalWidth > 0), 'マスコット画像が読めない');
  await noHScroll(page, '1024 empty');
});

await step('valid-line-16.zip：読込→候補確定→検査（寸法/形式/容量/透過/偶数/DPIにエラーなし）', async () => {
  await loadZip(page, join(FIX, 'valid-line-16.zip'));
  assert((await page.locator('.thumb-card').count()) === 18, 'カード18枚');
  assert(await page.locator('.badge-suggest').count() === 18, '候補バッジ18');
  // 未検査のまま
  const c0 = await counts(page);
  assert(c0[3] === 18, `未検査18: ${c0}`);
  await page.getByRole('button', { name: '候補を確定' }).click();
  await runCheck(page);
  const c = await counts(page);
  // [合格, 要確認, エラー, 未検査, 画像違反, セット違反]
  assert(c[2] === 0 && c[3] === 0, `エラー0・未検査0: ${c}`);
  assert(c[0] + c[1] === 18, `合計18: ${c}`);
  const heads = await page.$$eval('.role-head', (els) => els.map((e) => e.textContent));
  assert(heads.some((h) => h.includes('スタンプ') && h.includes('16/16')), heads.join('|'));
  assert(heads.some((h) => h.includes('メイン画像') && h.includes('1/1')), heads.join('|'));
  assert(heads.some((h) => h.includes('タブ画像') && h.includes('1/1')), heads.join('|'));
  writeFileSync(join(OUT, 'valid-counts.json'), JSON.stringify({ pass: c[0], warn: c[1], error: c[2], unchecked: c[3], imageViolations: c[4], setViolations: c[5] }));
  await page.screenshot({ path: join(OUT, '1024-valid-checked.png') });
});

await step('要確認だけの絞込みと詳細パネル（実測・要求・出典）', async () => {
  await page.getByRole('button', { name: /要確認だけ/ }).click();
  const n = await page.locator('.thumb-card').count();
  const c = await counts(page);
  assert(n === c[1] + c[2], `絞込み件数 ${n} vs ${c}`);
  await page.getByRole('button', { name: /^すべて/ }).click();
  await (await card(page, 'tab')).click();
  await page.waitForSelector('.detail .preview img');
  const txt = await page.textContent('.detail');
  assert(txt.includes('96 × 74 px'), '寸法表示');
  assert(txt.includes('72.01'), 'DPI表示');
  assert(txt.includes('透明画素あり・見た目の確認は必要'), '透過の説明');
  await page.getByRole('radio', { name: '黒' }).click();
  await page.screenshot({ path: join(OUT, '1024-detail-tab.png') });
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  assert((await page.locator('.detail .preview').count()) === 0, '閉じる');
});

let uploadSha = {};
await step('梱包：ツリー確認→投稿用ZIP→再展開でSHA-256一致・余計なファイルなし', async () => {
  await page.getByRole('button', { name: /梱包へ進む/ }).click();
  const tree = await page.textContent('.tree');
  assert(tree.includes('01.png') && tree.includes('main.png') && tree.includes('tab.png'), 'ツリー');
  const ack = page.locator('.ack input');
  if (await ack.count()) await ack.check();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '投稿用ZIPを作成' }).click()]);
  assert(dl.suggestedFilename() === 'UPLOAD_line-static.zip', dl.suggestedFilename());
  const p = join(OUT, 'upload.zip');
  await dl.saveAs(p);
  await idle(page);
  const files = unzipSync(new Uint8Array(readFileSync(p)));
  const names = Object.keys(files).sort();
  const expected = [...Array.from({ length: 16 }, (_, i) => `${String(i + 1).padStart(2, '0')}.png`), 'main.png', 'tab.png'].sort();
  assert(JSON.stringify(names) === JSON.stringify(expected), names.join(','));
  for (const n of names) {
    assert(sha(files[n]) === sha(validFiles[n]), `SHA不一致 ${n}`);
    uploadSha[n] = sha(files[n]);
  }
  await page.waitForSelector('.result img[src*="mascot-packed"]');
  await page.screenshot({ path: join(OUT, '1024-packed.png') });
});

await step('出力ZIPを再読込しても役割数とバイトを維持', async () => {
  await newProject(page);
  await loadZip(page, join(OUT, 'upload.zip'));
  await page.getByRole('button', { name: '候補を確定' }).click();
  const heads = await page.$$eval('.role-head', (els) => els.map((e) => e.textContent));
  assert(heads.some((h) => h.includes('16/16')) && heads.filter((h) => h.includes('1/1')).length === 2, heads.join('|'));
  await page.getByRole('tab', { name: /梱包/ }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '作業用として保存' }).click()]);
  await idle(page);
  const p = join(OUT, 'work.zip');
  await dl.saveAs(p);
  assert(dl.suggestedFilename() === 'WORK-unchecked_line-static.zip', dl.suggestedFilename());
  const files = unzipSync(new Uint8Array(readFileSync(p)));
  for (const [n, h] of Object.entries(uploadSha)) assert(sha(files[n]) === h, `再梱包SHA ${n}`);
  await page.getByRole('tab', { name: /チェック/ }).click();
});

await step('invalid-two-images.zip：06は幅400で上限超過、12は完全不透明。投稿用は停止', async () => {
  await newProject(page);
  await loadZip(page, join(FIX, 'invalid-two-images.zip'));
  await page.getByRole('button', { name: '候補を確定' }).click();
  await runCheck(page);
  const c = await counts(page);
  assert(c[2] === 2, `エラー2枚: ${c}`);
  await (await card(page, '06')).click();
  let t = await page.textContent('.detail');
  assert(t.includes('400 × 320 px') && t.includes('最大 370 × 320 px') && t.includes('幅が30px') && t.includes('公式条件'), '06の指摘');
  await page.screenshot({ path: join(OUT, '1024-invalid-06.png') });
  await (await card(page, '12')).click();
  t = await page.textContent('.detail');
  assert(t.includes('背景が透過していません') && t.includes('完全不透明'), '12の指摘');
  await page.getByRole('tab', { name: /梱包/ }).click();
  assert(await page.getByRole('button', { name: '投稿用ZIPを作成' }).isDisabled(), '投稿用停止');
  assert(!(await page.getByRole('button', { name: '作業用として保存' }).isDisabled()), '作業用は可');
  await page.getByRole('tab', { name: /チェック/ }).click();
});

await step('差替え：06を正しい画像へ→同じ役割・順序のまま再検査でエラー解消', async () => {
  await (await card(page, '06')).click();
  await page.setInputFiles('[data-testid=input-replace]', fixed06);
  await page.waitForTimeout(200);
  await idle(page);
  const t = await page.textContent('.detail');
  assert(t.includes('06-fixed.png') && t.includes('370 × 320 px'), '差替え後の実測');
  assert(t.includes('差替え') && t.includes('前：06.png'), '差替え履歴');
  const c = await counts(page);
  assert(c[2] === 1, `エラーは12の1枚: ${c}`);
  const label = await (await card(page, '06')).getAttribute('aria-label');
  assert(label.includes('06-fixed.png'), '出力名06のまま');
  // 連続差替え
  await page.setInputFiles('[data-testid=input-replace]', join(FIX, 'generated', '06.png'));
  await page.waitForTimeout(200);
  await idle(page);
  assert((await counts(page))[2] === 2, '再び400px→エラー2');
});

await step('missing-main-and-sticker.zip：スタンプ1枚不足・main1枚不足', async () => {
  await newProject(page);
  await loadZip(page, join(FIX, 'missing-main-and-sticker.zip'));
  await page.getByRole('button', { name: '候補を確定' }).click();
  const txt = await page.textContent('.main-col');
  assert(txt.includes('スタンプが1枚不足') && txt.includes('メイン画像が1枚不足'), 'セット指摘');
  assert((await page.locator('.slot-empty').count()) === 2, '空き枠2つ');
  const heads = await page.$$eval('.role-head', (els) => els.map((e) => e.textContent));
  assert(heads.some((h) => h.includes('タブ画像') && h.includes('1/1')), 'tabあり');
  assert(heads.filter((h) => h.includes('不足1')).length === 2, '不足1表示');
  await page.screenshot({ path: join(OUT, '1024-missing.png'), fullPage: false });
});

await step('generated/：odd-size・no-dpi・empty・broken・APNG・偽JPEG・非画像', async () => {
  await newProject(page);
  const g = (n) => join(FIX, 'generated', n);
  await addImages(page, [g('odd-size.png'), g('no-dpi.png'), g('empty.png'), g('broken.png'), join(OUT, 'anim.png'), join(OUT, 'fake-jpeg.png'), join(OUT, 'note.txt')]);
  const notes = await page.textContent('.import-notes');
  assert(notes.includes('note.txt'), '非画像は取り込まず理由表示');
  // 全部を sticker に割り当て
  for (const name of ['odd-size.png', 'no-dpi.png', 'empty.png', 'broken.png', 'anim.png', 'fake-jpeg.png']) {
    await page.locator('.thumb-card', { hasText: name }).first().click();
    await page.locator('.add-role select').selectOption({ label: 'スタンプ' });
    await page.getByRole('button', { name: '追加', exact: true }).click();
  }
  await runCheck(page);
  const expect = {
    'odd-size.png': ['寸法が奇数です', '幅369・高さ319'],
    'no-dpi.png': ['DPI未確認'],
    'empty.png': ['完全透明'],
    'broken.png': ['読込不能'],
    'anim.png': ['アニメーションPNGは対象外'],
    'fake-jpeg.png': ['拡張子と中身が違います', '形式が条件と違います'],
  };
  for (const [name, words] of Object.entries(expect)) {
    await page.locator('.thumb-card', { hasText: name }).first().click();
    const t = await page.textContent('.detail');
    for (const w of words) assert(t.includes(w), `${name}: 「${w}」がない`);
  }
  const t = await page.locator('.thumb-card', { hasText: 'no-dpi.png' }).first().getAttribute('aria-label');
  assert(t.includes('要確認'), 'no-dpiは要確認');
  await page.screenshot({ path: join(OUT, '1024-generated.png') });
  await page.getByRole('tab', { name: /梱包/ }).click();
  assert(await page.getByRole('button', { name: '作業用として保存' }).isDisabled(), '読込不能があると作業用も停止');
  await page.getByRole('tab', { name: /チェック/ }).click();
});

await step('bad-template.json：未対応schemaVersionを明示して拒否', async () => {
  await page.getByRole('button', { name: /ルールを編集/ }).click();
  await page.setInputFiles('[data-testid=input-template-json]', join(FIX, 'bad-template.json'));
  await page.waitForSelector('.toast-error');
  const t = await page.textContent('.toast-error');
  assert(t.includes('schemaVersion 999 は未対応'), t);
});

await step('自作テンプレート：標準を複製→編集→保存→JSON書出し→再読込', async () => {
  await page.locator('.tm-item', { hasText: 'BOOTH向け' }).click();
  await page.getByRole('button', { name: '複製して編集' }).click();
  await page.waitForSelector('.tm-item.on >> text=自作');
  await page.locator('.editor label:has-text("名前") input').first().fill('マイBOOTH表紙ルール');
  // 表紙の寸法を 1000×1000 に
  const cover = page.locator('fieldset.role-form').nth(1);
  await cover.locator('label:has-text("幅 px") input').fill('1000');
  await cover.locator('label:has-text("高さ px") input').fill('1000');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForSelector('.toast-success >> text=テンプレートを保存しました');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /JSON書出し/ }).click()]);
  const p = join(OUT, 'my-template.json');
  await dl.saveAs(p);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  assert(j.schemaVersion === 1 && j.kind === 'check-template' && j.name === 'マイBOOTH表紙ルール' && j.roles[1].dimensions.width === 1000, 'JSON内容');
  assert(j.sourceType === 'user-workflow', '自作扱い');
  await page.setInputFiles('[data-testid=input-template-json]', p);
  await page.waitForSelector('.toast >> text=として取り込みました');
  assert((await page.locator('.tm-item', { hasText: 'マイBOOTH表紙ルール' }).count()) === 2, '再読込で別IDの2件目');
  // 標準は上書きできない
  await page.locator('.tm-item', { hasText: 'LINE通常静止画' }).click();
  assert(await page.locator('.editor fieldset.form').first().locator('input').first().isDisabled(), '標準は編集不可');
  await page.screenshot({ path: join(OUT, '1024-template-manager.png') });
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
});

await step('組合せセット：LINE投稿＋宣伝表紙を別ZIPで。product不足は検査しない', async () => {
  await newProject(page);
  await page.selectOption('#target-select', { label: 'スタンプ投稿＋宣伝画像' });
  await loadZip(page, join(FIX, 'valid-line-16.zip'));
  await page.getByRole('button', { name: '候補を確定' }).click();
  // main.png を表紙にも使う
  await (await card(page, 'main')).click();
  await page.locator('.add-role select').selectOption({ label: 'BOOTH向け画像素材集（自主ルール）／表紙' });
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await runCheck(page);
  const t = await page.textContent('.main-col');
  assert(t.includes('line-upload.zip') && t.includes('promotion.zip'), '2出力');
  assert(!t.includes('商品画像'), 'product役割は対象外');
  const d = await page.textContent('.detail');
  assert(d.includes('1200 × 1200 px（一致）') && d.includes('自作ルール'), '表紙の自作ルール指摘');
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  await page.getByRole('tab', { name: /梱包/ }).click();
  const cards = await page.$$eval('.pack-card h2', (els) => els.map((e) => e.textContent));
  assert(JSON.stringify(cards) === JSON.stringify(['line-upload.zip', 'promotion.zip']), cards.join(','));
  const promoTree = await page.locator('.pack-card').nth(1).locator('.tree').textContent();
  assert(promoTree.includes('promotion/') && promoTree.includes('cover.png'), promoTree);
  await page.screenshot({ path: join(OUT, '1024-bundle-pack.png'), fullPage: true });
  await page.getByRole('tab', { name: /チェック/ }).click();
});

await step('バックアップZIP保存→新規→復元（素材・役割・設定を維持）', async () => {
  await page.getByRole('tab', { name: /梱包/ }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'バックアップZIPを保存' }).click()]);
  assert(/^BACKUP_konpoh_\d{8}-\d{4}\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  const p = join(OUT, 'backup.zip');
  await dl.saveAs(p);
  await page.getByRole('button', { name: '新しい作品を始める' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '新しい作品を始める' }).click();
  assert((await page.locator('.thumb-card').count()) === 0, '新規で空');
  await page.setInputFiles('[data-testid=input-restore]', p);
  await page.waitForSelector('.toast >> text=バックアップを復元しました');
  await page.getByRole('tab', { name: /チェック/ }).click();
  const v = await page.$eval('#target-select', (e) => e.value);
  assert(v === 'b:sale-and-promotion', v);
  const c = await counts(page);
  assert(c[3] === 0, `検査結果も復元: ${c}`);
  const t = await page.textContent('.main-col');
  assert(t.includes('16/16') && t.includes('promotion.zip'), '役割復元');
});

await step('端末内保存（IndexedDB）→再読込で復元', async () => {
  await page.locator('.top-actions').getByRole('button', { name: /^保存/ }).click();
  await page.waitForSelector('.toast-success >> text=この端末に保存しました');
  await page.reload();
  await page.waitForSelector('.thumb-card');
  assert((await page.locator('.thumb-card').count()) >= 18, 'カード復元');
});

await step('編集タブは準備中と明示し、元画像書出しのみ', async () => {
  await page.getByRole('tab', { name: /編集/ }).click();
  const t = await page.textContent('.main-col');
  assert(t.includes('画像編集機能はまだありません') && t.includes('準備中'), '準備中表示');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /01\.png の元画像を書き出す/ }).click()]);
  const p = join(OUT, 'orig-01.png');
  await dl.saveAs(p);
  assert(sha(readFileSync(p)) === sha(validFiles['01.png']), '元画像のバイト一致');
  await page.screenshot({ path: join(OUT, '1024-edit.png') });
  await page.getByRole('tab', { name: /チェック/ }).click();
  await noHScroll(page, '1024');
});
await ctx.close();

// ================================================================ 768×1024（iPad縦）と 390×844（スマホ）
for (const vp of [
  { width: 768, height: 1024, name: '768' },
  { width: 390, height: 844, name: '390' },
]) {
  await step(`${vp.width}×${vp.height}：横スクロールなし・詳細は下部パネル・閉じられる`, async () => {
    const { ctx: c2, page: p2 } = await newPage({ width: vp.width, height: vp.height });
    await noHScroll(p2, `${vp.name} empty`);
    await p2.screenshot({ path: join(OUT, `${vp.name}-empty.png`) });
    await p2.setInputFiles('[data-testid=input-zip]', join(FIX, 'invalid-two-images.zip'));
    await idle(p2);
    await p2.getByRole('button', { name: '候補を確定' }).click();
    await runCheck(p2);
    await noHScroll(p2, `${vp.name} checked`);
    if (vp.width <= 700) {
      const cols = await p2.$eval('.grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
      assert(cols === 2, `2列: ${cols}`);
    }
    await p2.screenshot({ path: join(OUT, `${vp.name}-checked.png`) });
    await (await card(p2, '06')).click();
    const pos = await p2.$eval('.detail', (e) => getComputedStyle(e).position);
    assert(pos === 'fixed', `下部パネル: ${pos}`);
    await noHScroll(p2, `${vp.name} detail`);
    await p2.screenshot({ path: join(OUT, `${vp.name}-detail.png`) });
    await p2.getByRole('button', { name: '詳細を閉じる' }).click();
    // タッチ領域44px以上（表示中のボタン）
    const small = await p2.$$eval('button, select, input:not([type=file]):not(.sr-only)', (els) =>
      els
        .filter((e) => e.offsetParent !== null && !e.classList.contains('sr-only'))
        .map((e) => ({ t: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 20), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }))
        .filter((r) => r.type !== 'checkbox' && (r.h < 43.5 || r.w < 43.5)),
    );
    assert(small.length === 0, `44px未満: ${JSON.stringify(small.slice(0, 5))}`);
    await p2.getByRole('tab', { name: /梱包/ }).click();
    await noHScroll(p2, `${vp.name} pack`);
    await p2.screenshot({ path: join(OUT, `${vp.name}-pack.png`), fullPage: true });
    await p2.getByRole('tab', { name: /チェック/ }).click();
    await p2.getByRole('button', { name: /ルールを編集/ }).click();
    await noHScroll(p2, `${vp.name} templates`);
    await p2.screenshot({ path: join(OUT, `${vp.name}-templates.png`) });
    await c2.close();
  });
}

await step('通信検証：全リクエストが同一オリジン/blob/dataのみ（外部送信なし）', async () => {
  const external = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:'));
  writeFileSync(join(OUT, 'requests.txt'), [...new Set(requests)].join('\n'));
  assert(external.length === 0, `外部通信: ${external.join(', ')}`);
  assert(requests.length > 0, 'リクエスト記録');
});

await step('コンソールエラーなし', async () => {
  const errs = consoleErrors.filter((e) => !e.includes('favicon'));
  assert(errs.length === 0, errs.join('\n'));
});

await browser.close();
server.kill('SIGKILL');
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${OUT}`);
console.log(`requests: ${new Set(requests).size} unique URLs`);
process.exit(failed ? 1 : 0);
