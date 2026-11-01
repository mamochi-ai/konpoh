// 出力名（命名プリセット）。元ファイル名とは別に管理する
import type { Container } from './types';

export interface NameContext {
  index: number;
  container: Container | null;
  originalName: string;
}

function extFor(container: Container | null, originalName: string): string {
  if (container === 'png') return 'png';
  if (container === 'jpeg') return 'jpg';
  const m = /\.([A-Za-z0-9]+)$/.exec(originalName);
  return m ? m[1].toLowerCase() : 'bin';
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1];
}

export function renderName(pattern: string, ctx: NameContext): string {
  const orig = baseName(ctx.originalName);
  return pattern.replace(/\{(index|ext|original|stem)(?::(\d{1,2}))?\}/g, (_, key: string, pad?: string) => {
    switch (key) {
      case 'index':
        return pad ? String(ctx.index).padStart(Number(pad), '0') : String(ctx.index);
      case 'ext':
        return extFor(ctx.container, orig);
      case 'original':
        return orig;
      case 'stem':
        return orig.replace(/\.[^.]*$/, '');
      default:
        return '';
    }
  });
}

export function joinPath(directory: string, name: string): string {
  const dir = directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${name}` : name;
}

/** 衝突判定用キー。大文字小文字・Unicode正規化の違いを同一視（iPad/Mac/Windowsで同じ扱い） */
export function pathKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

export function validateOutputPath(p: string): string | null {
  if (!p) return '出力名が空です';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return '絶対パスは使えません';
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) return 'パスに .. や空のフォルダ名は使えません';
  // eslint-disable-next-line no-control-regex
  if (/[\\:*?"<>|\u0000-\u001f]/.test(p)) return '使えない文字（\\ : * ? " < > | 制御文字）が含まれています';
  if (segs.some((s) => /[. ]$/.test(s))) return '末尾がピリオドや空白の名前は使えません';
  return null;
}

/** 名前パターン→ファイル名から役割候補を推定するための正規表現。{original}/{stem}は推定しない */
export function patternToRegex(pattern: string): RegExp | null {
  if (/\{(original|stem)\}/.test(pattern)) return null;
  let src = '';
  let last = 0;
  const re = /\{(index|ext)(?::\d{1,2})?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern))) {
    src += pattern.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    src += m[1] === 'index' ? '(\\d{1,3})' : '(?:png|jpe?g)';
    last = m.index + m[0].length;
  }
  src += pattern.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${src}$`, 'i');
}
