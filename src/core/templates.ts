// チェックテンプレートのデータ契約と、同梱のLINE通常静止画テンプレート
import type { CheckRole, CheckTemplate } from './types';
import lineStatic from '../templates-builtin/line-static.json';

export const SUPPORTED_SCHEMA_VERSION = 1;

const ROLE_LABELS: Record<string, string> = {
  sticker: 'スタンプ',
  main: 'メイン画像',
  tab: 'タブ画像',
};

export function roleLabel(role: Pick<CheckRole, 'id' | 'label'>): string {
  return role.label?.trim() || ROLE_LABELS[role.id] || role.id;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function nullablePos(v: unknown): boolean {
  return v === null || isPosInt(v);
}

function validateRole(r: unknown, i: number): string[] {
  const e: string[] = [];
  const p = `roles[${i}]`;
  if (!isObj(r)) return [`${p} がオブジェクトではありません`];
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) e.push(`${p}.id は英数字・-・_ で指定してください`);
  if (!isObj(r.count) || !isNonNegInt(r.count.min) || !(r.count.max === null || isNonNegInt(r.count.max))) {
    e.push(`${p}.count は {min: 0以上の整数, max: 整数またはnull} です`);
  } else if (r.count.max !== null && (r.count.max as number) < (r.count.min as number)) {
    e.push(`${p}.count.max が min より小さいです`);
  }
  if (!Array.isArray(r.formats) || r.formats.length === 0 || !r.formats.every((f) => f === 'png' || f === 'jpeg')) {
    e.push(`${p}.formats は "png" / "jpeg" の配列です`);
  }
  const d = r.dimensions;
  if (!isObj(d) || !['none', 'exact', 'max'].includes(d.mode as string)) e.push(`${p}.dimensions.mode は none / exact / max です`);
  else if (d.mode !== 'none' && (!isPosInt(d.width) || !isPosInt(d.height))) e.push(`${p}.dimensions の width/height は正の整数です`);
  if (!nullablePos(r.maxBytes)) e.push(`${p}.maxBytes は正の整数またはnullです`);
  if (typeof r.evenDimensions !== 'boolean') e.push(`${p}.evenDimensions は true/false です`);
  if (!['required', 'optional', 'forbidden'].includes(r.transparency as string)) e.push(`${p}.transparency は required / optional / forbidden です`);
  if (!nullablePos(r.minDpi)) e.push(`${p}.minDpi は正の整数またはnullです`);
  if (!(r.marginAdvisoryPx === null || isNonNegInt(r.marginAdvisoryPx))) e.push(`${p}.marginAdvisoryPx は0以上の整数またはnullです`);
  if (typeof r.directory !== 'string' || r.directory.split(/[\\/]/).includes('..')) e.push(`${p}.directory が不正です`);
  if (typeof r.namePattern !== 'string' || !r.namePattern.trim() || /[/\\]/.test(r.namePattern)) e.push(`${p}.namePattern が不正です`);
  return e;
}

/** テンプレートJSONの検証。未知の schemaVersion は拒否する */
export function validateCheckTemplate(o: unknown): string[] {
  const e: string[] = [];
  if (!isObj(o)) return ['JSONのトップがオブジェクトではありません'];
  if (!('schemaVersion' in o)) return ['schemaVersion がありません'];
  if (o.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return [`schemaVersion ${JSON.stringify(o.schemaVersion)} は未対応です（対応している版: ${SUPPORTED_SCHEMA_VERSION}）`];
  }
  if (o.kind !== 'check-template') e.push('kind が "check-template" ではありません');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) e.push('id は英数字・-・_ で指定してください');
  if (typeof o.name !== 'string' || !o.name.trim()) e.push('name が空です');
  if (!nullablePos(o.maxArchiveBytes)) e.push('maxArchiveBytes は正の整数またはnullです');
  if (o.allowedStickerCounts !== undefined && (!Array.isArray(o.allowedStickerCounts) || !o.allowedStickerCounts.every(isPosInt))) {
    e.push('allowedStickerCounts は正の整数の配列です');
  }
  if (!Array.isArray(o.roles) || o.roles.length === 0) e.push('roles が1件以上必要です');
  else {
    o.roles.forEach((r, i) => e.push(...validateRole(r, i)));
    const ids = o.roles.map((r) => (isObj(r) ? r.id : null));
    if (new Set(ids).size !== ids.length) e.push('役割IDが重複しています');
  }
  return e;
}

function assertValid(o: unknown): CheckTemplate {
  const e = validateCheckTemplate(o);
  if (e.length) throw new Error(`同梱テンプレートが不正です: ${e.join(' / ')}`);
  return o as CheckTemplate;
}

/** LINE通常静止画スタンプ（2026-11-01確認の公式ガイドラインから作成） */
export const LINE_TEMPLATE: CheckTemplate = assertValid(lineStatic);
export const LINE_TEMPLATE_ID = LINE_TEMPLATE.id;

/** スタンプ数（8/16/24/32/40）の選択を反映した役割一覧。テンプレート自体は変えない */
export function effectiveRoles(t: CheckTemplate, stickerCount?: number): CheckRole[] {
  if (!t.allowedStickerCounts?.length) return t.roles;
  const n =
    stickerCount && t.allowedStickerCounts.includes(stickerCount)
      ? stickerCount
      : (t.selectedStickerCount ?? t.allowedStickerCounts[0]);
  return t.roles.map((r) => (r.id === 'sticker' ? { ...r, count: { min: n, max: n } } : r));
}

export function stickerCountFor(t: CheckTemplate, settings: Record<string, number>): number | undefined {
  if (!t.allowedStickerCounts?.length) return undefined;
  const v = settings[t.id];
  return v && t.allowedStickerCounts.includes(v) ? v : (t.selectedStickerCount ?? t.allowedStickerCounts[0]);
}
