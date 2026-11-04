// 試し送りの受入確認（Chromium）。`npm run build` 後に `node e2e/trial.mjs`。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const T = join(FIX, 'trial');
const OUT = join(ROOT, 'e2e', 'out', 'trial');
mkdirSync(OUT, { recursive: true });
const PORT = 4175;
const ORIGIN = `http://localhost:${PORT}`;

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
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

const server = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe' });
process.on('exit', () => server.kill('SIGKILL'));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview timeout')), 20000);
  server.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && (clearTimeout(t), resolve()));
});

const browser = await chromium.launch();
const requests = [];
const errors = [];
async function newPage(viewport, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, hasTouch: viewport.width < 1100, ...ctxOpts });
  const page = await ctx.newPage();
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => {
    errors.push(`native dialog: ${d.message()}`);
    d.dismiss();
  });
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('text=販売前チェック');
  return { ctx, page };
}
const idle = (page) => page.waitForFunction(() => !document.querySelector('.jobbar'), null, { timeout: 30000 });
const openTrial = (page) => page.getByRole('tab', { name: '試し送り' }).click();
const meCount = (page) => page.locator('[data-testid=chat-frame] .chat-row .chat-sticker').count();
const stampCount = (page) => page.locator('.stamp-item').count();
const confirmDialog = (page, label) => page.getByRole('alertdialog').getByRole('button', { name: label }).click();
async function noHScroll(page, label) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert(sw <= cw, `${label}: 横スクロール scrollWidth=${sw} clientWidth=${cw}`);
}
async function waitImages(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.sticker-img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
}
async function loadTrial(page, files) {
  await page.setInputFiles('[data-testid=trial-input]', files);
  await page.waitForTimeout(300);
}
const set24 = Array.from({ length: 24 }, (_, i) => join(T, 'set24', `trial-${String(i + 1).padStart(2, '0')}.png`));

// ================================================================ iPad横（1180×820）
const { ctx, page } = await newPage({ width: 1180, height: 820 });
await openTrial(page);

await step('8a. 画像なしでも開ける：案内（マーモット）・お題・外部送信しない旨', async () => {
  assert((await page.textContent('.trial-empty')).includes('梱包する前に、ひとこと送ってみる？'), '案内');
  assert(await page.$eval('.trial-empty img', (i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width <= 160), 'マスコット96〜160px');
  assert((await page.textContent('.chat-notice')).includes('アプリ内のプレビューです。LINEへは送信されません'), '注記');
  const msg = await page.textContent('[data-testid=chat-frame] .bubble');
  assert(msg.includes('今日、帰りに牛乳買ってきてもらえる？'), `最初のお題 ${msg}`);
  assert((await page.textContent('.trial-side')).includes('ブラウザのデータを削除すると'), '保存の案内');
  await page.getByRole('button', { name: '最後の送信を取り消す' }).isDisabled();
  await page.screenshot({ path: join(OUT, '1180-empty.png') });
});

await step('1. 24枚を読み込み、順番に試し送り。最新が見える位置までスクロール', async () => {
  await loadTrial(page, set24);
  assert((await stampCount(page)) === 24, `一覧 ${await stampCount(page)}`);
  for (let i = 1; i <= 24; i++) {
    await page.getByRole('button', { name: `trial-${String(i).padStart(2, '0')}.png を送る` }).click();
  }
  assert((await meCount(page)) === 24, `送信 ${await meCount(page)}`);
  await waitImages(page);
  await page.waitForTimeout(200);
  const alts = await page.$$eval('[data-testid=chat-frame] .chat-sticker img', (els) => els.map((e) => e.alt));
  assert(alts.join() === Array.from({ length: 24 }, (_, i) => `trial-${String(i + 1).padStart(2, '0')}.png`).join(), '順番');
  const atBottom = await page.$eval('[data-testid=chat-frame]', (f) => f.scrollTop + f.clientHeight >= f.scrollHeight - 4);
  assert(atBottom, '最新までスクロール');
  const lastVisible = await page.$eval('[data-testid=chat-frame]', (f) => {
    const imgs = f.querySelectorAll('.chat-sticker');
    const r = imgs[imgs.length - 1].getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return r.bottom <= fr.bottom + 2 && r.top >= fr.top - 2;
  });
  assert(lastVisible, '最後のスタンプが見える');
  await page.screenshot({ path: join(OUT, '1180-24-sent.png') });
});

await step('2. 透明PNG：白い四角を付けず、暗い背景でも表示', async () => {
  await page.getByRole('radio', { name: '暗い' }).click();
  const bg = await page.$eval('[data-testid=chat-frame]', (f) => getComputedStyle(f).backgroundColor);
  assert(bg === 'rgb(31, 37, 35)', bg);
  const st = await page.$eval('[data-testid=chat-frame] .chat-sticker', (b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b.querySelector('img')).backgroundColor, getComputedStyle(b).borderTopWidth]);
  assert(st[0] === 'rgba(0, 0, 0, 0)' && st[1] === 'rgba(0, 0, 0, 0)' && st[2] === '0px', `背景なし ${st}`);
  // 実際の描画で、透明な角が背景色のまま（白くない）こと
  const box = await page.locator('[data-testid=chat-frame] .chat-sticker img').last().boundingBox();
  const shot = await page.screenshot({ clip: { x: box.x + 1, y: box.y + 1, width: 3, height: 3 } });
  const { PNG } = await import('./png-mini.mjs');
  const px = PNG(shot);
  assert(px[0] < 60 && px[1] < 60 && px[2] < 60, `角の色が暗い背景のまま ${px}`);
  await page.screenshot({ path: join(OUT, '1180-dark.png') });
});

await step('3. 縦長・横長が変形せず、トーク枠からはみ出さない（3サイズ）', async () => {
  for (const size of ['小さめ', '標準', '大きめ']) {
    await page.getByRole('radio', { name: size }).click();
    await waitImages(page);
    const r = await page.$$eval('[data-testid=chat-frame] .chat-sticker img', (els) => {
      const f = els[0].closest('[data-testid=chat-frame]').getBoundingClientRect();
      return els.map((i) => {
        const b = i.getBoundingClientRect();
        return { alt: i.alt, ratio: b.width / b.height, nat: i.naturalWidth / i.naturalHeight, inside: b.left >= f.left - 1 && b.right <= f.right + 1, w: b.width, h: b.height };
      });
    });
    for (const x of r) assert(Math.abs(x.ratio - x.nat) / x.nat < 0.02 && x.inside, `${size} ${x.alt} 比率 ${x.ratio.toFixed(3)} vs ${x.nat.toFixed(3)} 内側 ${x.inside}`);
    const tall = r.find((x) => x.alt === 'trial-05.png');
    const wide = r.find((x) => x.alt === 'trial-09.png');
    assert(tall.h > tall.w && wide.w > wide.h, '縦長・横長');
  }
  await page.getByRole('radio', { name: '標準' }).click();
});

await step('4. 同名ファイルでもメモが混ざらない（安定IDで管理）', async () => {
  await loadTrial(page, [join(T, 'same-a', 'same.png'), join(T, 'same-b', 'same.png')]);
  const more = page.getByRole('button', { name: 'same.png の詳細とメモ' });
  assert((await more.count()) === 2, '同名2枚');
  await more.nth(0).click();
  await page.getByRole('button', { name: '文字が読みにくい' }).click();
  await page.fill('#trial-note-text', '1枚目：文字を太く');
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  await more.nth(1).click();
  assert((await page.getByRole('button', { name: '文字が読みにくい' }).getAttribute('aria-pressed')) === 'false', '2枚目に目印なし');
  assert((await page.inputValue('#trial-note-text')) === '', '2枚目にメモなし');
  await page.getByRole('button', { name: 'このままでよさそう' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  await more.nth(0).click();
  assert((await page.inputValue('#trial-note-text')) === '1枚目：文字を太く', '1枚目のメモ');
  assert((await page.getByRole('button', { name: 'このままでよさそう' }).getAttribute('aria-pressed')) === 'false', '1枚目にOKは付かない');
  const sec = await page.textContent('.sheet');
  assert(sec.includes('自動チェック') && sec.includes('あなたのメモ（自動チェックの結果とは別）') && sec.includes('チェックの合格にはなりません'), '自動チェックとメモを分けて表示');
  await page.screenshot({ path: join(OUT, '1180-note-sheet.png') });
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
});

await step('お題：切り替え時に「残して続ける／新しく始める」を選べる・自作のお題', async () => {
  const before = await meCount(page);
  await page.selectOption('#trial-topic', { label: '資料の確認をお願いします' });
  assert((await page.textContent('.topic-switch')).includes('送ったスタンプがあります'), '確認が出る');
  await page.getByRole('button', { name: '会話を残して続ける' }).click();
  assert((await meCount(page)) === before, '残す');
  const bubbles = await page.$$eval('[data-testid=chat-frame] .bubble', (els) => els.map((e) => e.textContent));
  assert(bubbles.at(-1) === '資料の確認をお願いします', bubbles.join('|'));
  await page.locator('summary', { hasText: '自作のお題' }).click();
  await page.fill('#trial-new-topic', '週末どこ行く？');
  await page.getByRole('button', { name: '追加', exact: true }).first().click();
  // 送信済みがあるので切り替え確認が出る → やめる（会話は消えない）
  await page.getByRole('button', { name: 'やめる' }).click();
  assert((await meCount(page)) === before, 'やめるで消えない');
  assert((await page.textContent('.custom-topics')).includes('週末どこ行く？'), '自作のお題');
  // 相手のメッセージを編集
  await page.locator('[data-testid=chat-frame] .bubble').first().click();
  await page.fill('.bubble-edit textarea', 'ただいま、牛乳ある？');
  await page.locator('.bubble-edit').getByRole('button', { name: '保存' }).click();
  assert((await page.locator('[data-testid=chat-frame] .bubble').first().textContent()) === 'ただいま、牛乳ある？', '会話文の編集');
});

await step('5. 取り消し・会話リセットで画像やメモは消えない／送信済みの選択操作', async () => {
  const n = await meCount(page);
  await page.getByRole('button', { name: '最後の送信を取り消す' }).click();
  assert((await meCount(page)) === n - 1, '取り消し');
  // 送信済みを選んで削除
  await page.locator('[data-testid=chat-frame] .chat-sticker').first().click();
  assert((await page.textContent('.selected-actions')).includes('選択中'), '選択');
  await page.getByRole('button', { name: 'この送信を削除' }).click();
  assert((await meCount(page)) === n - 2, '選んで削除');
  await page.getByRole('button', { name: '会話をリセット' }).click();
  await confirmDialog(page, '会話をリセット');
  assert((await meCount(page)) === 0, 'リセット');
  assert((await stampCount(page)) === 26, `画像は残る ${await stampCount(page)}`);
  assert((await page.locator('.stamp-item .note-dot').count()) >= 2, 'メモの目印は残る');
});

await step('6. 修正前後の比較（同じ会話・背景・枠）と、採用後の再チェック案内', async () => {
  // プロジェクトに正常セットを読み込む（チェック済みにする）
  await page.getByRole('tab', { name: /チェック/ }).click();
  await page.setInputFiles('[data-testid=input-zip]', join(FIX, 'valid-line-16.zip'));
  await idle(page);
  await page.getByRole('button', { name: '候補を確定' }).click();
  await page.getByRole('button', { name: /^検査を実行/ }).click();
  await page.waitForTimeout(200);
  await idle(page);
  await openTrial(page);
  await page.getByRole('button', { name: 'プロジェクトの画像から選ぶ' }).click();
  await page.getByRole('button', { name: /役割を割り当てた画像をすべて選ぶ（18）/ }).click();
  await page.getByRole('button', { name: '選んだ18枚を一覧に追加' }).click();
  assert((await stampCount(page)) === 44, `一覧 ${await stampCount(page)}`);
  await page.getByRole('button', { name: '06.png を送る', exact: true }).click();
  await page.locator('[data-testid=chat-frame] .chat-sticker').last().click();
  await page.getByRole('button', { name: '比較の修正前にする' }).click();
  await page.setInputFiles('[data-testid=trial-after-input]', join(T, 'fixed.png'));
  await page.waitForSelector('.compare-grid');
  const frames = await page.$$eval('.compare-grid .chat-frame', (fs) => fs.map((f) => ({ bg: getComputedStyle(f).backgroundColor, stk: getComputedStyle(f).getPropertyValue('--stk'), msg: f.querySelector('.bubble')?.textContent })));
  assert(frames.length === 2 && frames[0].bg === frames[1].bg && frames[0].stk === frames[1].stk && frames[0].msg === frames[1].msg, `同じ条件 ${JSON.stringify(frames)}`);
  const visible = await page.$$eval('.compare-grid .compare-col', (cs) => cs.filter((c) => c.offsetParent !== null).length);
  assert(visible === 2, 'iPadは横並び');
  await waitImages(page);
  await page.screenshot({ path: join(OUT, '1180-compare.png') });
  // 採用はチェックの状態を変える明示操作
  await page.getByRole('button', { name: '修正後をプロジェクトに採用' }).click();
  await confirmDialog(page, '採用する');
  await page.waitForSelector('text=採用済みです');
  assert((await page.textContent('.adopt-box')).includes('再チェックが必要です'), '再チェック案内');
  // 修正前は残る
  await waitImages(page);
  const beforeOk = await page.$eval('.compare-grid .compare-col:first-child img', (i) => i.naturalWidth === 370);
  assert(beforeOk, '修正前が残る');
  await page.getByRole('button', { name: 'チェックで再検査する' }).click();
  await page.waitForSelector('.detail .detail-name');
  const d = await page.textContent('.detail');
  assert(d.includes('fixed.png') && d.includes('未検査'), `チェック結果を流用しない: ${d.slice(0, 120)}`);
  const unchecked = await page.$$eval('.sum-item b', (els) => Number(els[3].textContent));
  assert(unchecked === 1, `未検査1 ${unchecked}`);
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
});

await step('7. 再読み込み後に画像・メモ・自作のお題・表示設定・比較の組を復元', async () => {
  await page.locator('.top-actions').getByRole('button', { name: /^保存/ }).click(); // プロジェクトの保存（既存の保存方式）
  await page.waitForSelector('.toast-success >> text=この端末に保存しました');
  await openTrial(page);
  await page.waitForFunction(() => document.querySelector('.trial-save')?.textContent?.includes('この端末に保存しました'), null, { timeout: 5000 });
  await page.reload();
  await page.waitForSelector('text=販売前チェック');
  await openTrial(page);
  await page.waitForSelector('.stamp-item');
  assert((await stampCount(page)) >= 44, `復元 ${await stampCount(page)}`);
  const bg = await page.$eval('[data-testid=chat-frame]', (f) => getComputedStyle(f).backgroundColor);
  assert(bg === 'rgb(31, 37, 35)', '表示設定');
  assert((await page.textContent('.custom-topics')).includes('週末どこ行く？'), '自作のお題');
  const more = page.getByRole('button', { name: 'same.png の詳細とメモ' });
  await more.nth(0).click();
  assert((await page.inputValue('#trial-note-text')) === '1枚目：文字を太く', 'メモ');
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  assert((await page.textContent('.trial-stamps')).includes('比較の組（1）'), '比較の組');
  await waitImages(page);
});

await step('8b. 読み込みに失敗しても他の画像は読み込める', async () => {
  const n = await stampCount(page);
  await loadTrial(page, [join(T, 'broken.png'), join(T, 'fixed.png'), join(FIX, 'generated', '12.png')]);
  await page.waitForSelector('.toast-error');
  assert((await page.textContent('.toast-error')).includes('broken.png'), '失敗の表示');
  assert((await stampCount(page)) === n + 2, '他は追加');
});

await step('メモリ：表示用URLを使い回し、繰り返し送っても増え続けない', async () => {
  const count = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.startsWith('blob:')).length);
  void count;
  const before = await page.$$eval('img[src^="blob:"]', (els) => new Set(els.map((e) => e.src)).size);
  for (let i = 0; i < 20; i++) await page.getByRole('button', { name: 'trial-01.png を送る' }).click();
  const after = await page.$$eval('img[src^="blob:"]', (els) => new Set(els.map((e) => e.src)).size);
  assert(after === before, `URL数 ${before} → ${after}`);
});
await ctx.close();

// ================================================================ 画面幅
for (const vp of [
  { width: 390, height: 844, name: 'iphone' },
  { width: 768, height: 1024, name: 'ipad-portrait' },
  { width: 1024, height: 768, name: 'ipad-landscape-small' },
  { width: 1180, height: 820, name: 'ipad-landscape' },
]) {
  await step(`10. ${vp.width}×${vp.height}：横スクロールなし・主要操作が見える`, async () => {
    const { ctx: c2, page: p } = await newPage(vp);
    await openTrial(p);
    await noHScroll(p, 'empty');
    await loadTrial(p, [set24[0], set24[4], set24[8]]);
    for (const n of ['01', '05', '09']) await p.getByRole('button', { name: `trial-${n}.png を送る` }).click();
    await waitImages(p);
    await noHScroll(p, 'sent');
    for (const sel of ['#trial-topic', '[data-testid=chat-frame]']) {
      const b = await p.locator(sel).boundingBox();
      assert(b && b.width > 100 && b.x >= 0 && b.x + b.width <= vp.width + 1, `${sel} が見える`);
    }
    const frame = await p.locator('[data-testid=chat-frame]').boundingBox();
    assert(frame.height >= 260, `会話が隠れすぎない ${frame.height}`);
    if (vp.width < 700) {
      await p.getByRole('button', { name: '一覧を閉じる' }).click();
      assert((await p.locator('.stamp-grid').count()) === 0 || !(await p.locator('.stamp-grid').isVisible()), '閉じられる');
      await p.getByRole('button', { name: 'スタンプを開く' }).click();
      assert(await p.locator('.stamp-grid').isVisible(), '開ける');
    }
    // 小さなボタンがない（44px）
    const small = await p.$$eval('.trial-ws button, .trial-ws select, .trial-ws input:not([type=file]):not(.sr-only)', (els) =>
      els.filter((e) => e.offsetParent !== null).map((e) => ({ t: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 16), h: e.getBoundingClientRect().height })).filter((r) => r.h < 43.5),
    );
    assert(small.length === 0, `44px未満 ${JSON.stringify(small.slice(0, 4))}`);
    // 比較（狭い画面は前後切り替え）
    await p.locator('[data-testid=chat-frame] .chat-sticker').first().click();
    await p.getByRole('button', { name: '比較の修正前にする' }).click();
    await p.setInputFiles('[data-testid=trial-after-input]', join(T, 'fixed.png'));
    await p.waitForSelector('.compare-grid');
    const vis = await p.$$eval('.compare-grid .compare-col', (cs) => cs.filter((c) => c.offsetParent !== null).length);
    assert(vis === (vp.width < 700 ? 1 : 2), `比較の表示 ${vis}`);
    if (vp.width < 700) {
      await p.getByRole('radio', { name: '修正後' }).click();
      assert((await p.locator('.compare-grid .compare-col').nth(1).isVisible()) && !(await p.locator('.compare-grid .compare-col').nth(0).isVisible()), '前後切り替え');
    }
    await noHScroll(p, 'compare');
    await waitImages(p);
    await p.screenshot({ path: join(OUT, `${vp.name}-compare.png`) });
    await p.getByRole('button', { name: '比較を閉じる' }).click();
    await p.screenshot({ path: join(OUT, `${vp.name}.png`), fullPage: true });
    await c2.close();
  });
}

await step('11. 通信：画像を外部へ送る通信がない（同一オリジン・blob・dataのみ）', async () => {
  const ext = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:'));
  assert(ext.length === 0, ext.join(', '));
});
await step('エラー・ネイティブダイアログなし', async () => {
  assert(errors.length === 0, errors.join('\n'));
});

await browser.close();
server.kill('SIGKILL');
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
