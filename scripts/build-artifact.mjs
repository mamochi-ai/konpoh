// claude.ai に公開する1ファイル版（artifact/konpoh.html）を作る。
// JS・CSS・マスコット画像をすべて埋め込み、外部への読込はしない。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-artifact');
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const js = html.match(/<script[^>]+src="\.\/([^"]+)"/)?.[1];
const css = html.match(/<link[^>]+href="\.\/([^"]+\.css)"/)?.[1];
if (!js || !css) throw new Error('dist-artifact/index.html から JS/CSS を見つけられません');
const jsText = readFileSync(join(DIST, js), 'utf8').replace(/<\/script/gi, '<\\/script');
const cssText = readFileSync(join(DIST, css), 'utf8').replace(/<\/style/gi, '<\\/style');
if (/https?:\/\/(?!www\.w3\.org|creator\.line\.me|booth\.pm)[a-z0-9.-]+\//i.test(jsText.replace(/"https:\/\/creator\.line\.me[^"]*"/g, ''))) {
  console.warn('注意: JSに外部URLらしき文字列があります（読込ではなく文字列の可能性）');
}
const out = `<title>こつこつ梱包室</title>
<meta name="referrer" content="no-referrer">
<style>${cssText}</style>
<div id="root"></div>
<noscript>このアプリはJavaScriptが必要です。</noscript>
<script type="module">${jsText}</script>
`;
mkdirSync(join(ROOT, 'artifact'), { recursive: true });
writeFileSync(join(ROOT, 'artifact', 'konpoh.html'), out);
console.log(`artifact/konpoh.html ${(out.length / 1024).toFixed(0)} KB`);
