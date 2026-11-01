// チェックテンプレート／組合せセットのデータ契約と検証
import type { BundleTemplate, CheckRole, CheckTemplate, ImageFormat } from './types';
import lineStatic from '../templates-builtin/line-static.json';
import boothWorkflow from '../templates-builtin/booth-workflow.json';
import combinedExample from '../templates-builtin/combined-example.json';

export const SUPPORTED_SCHEMA_VERSION = 1;

const ROLE_LABELS: Record<string, string> = {
  sticker: 'スタンプ',
  main: 'メイン画像',
  tab: 'タブ画像',
  product: '商品画像',
  cover: '表紙',
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

function checkSchemaVersion(o: Record<string, unknown>, errors: string[]): boolean {
  if (!('schemaVersion' in o)) {
    errors.push('schemaVersion がありません');
    return false;
  }
  if (o.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${JSON.stringify(o.schemaVersion)} は未対応です（対応している版: ${SUPPORTED_SCHEMA_VERSION}）`);
    return false;
  }
  return true;
}

export function validateRole(r: unknown, i: number): string[] {
  const e: string[] = [];
  const p = `roles[${i}]`;
  if (!isObj(r)) return [`${p} がオブジェクトではありません`];
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) e.push(`${p}.id は英数字・-・_ で指定してください`);
  if (r.label !== undefined && typeof r.label !== 'string') e.push(`${p}.label は文字列です`);
  if (!isObj(r.count) || !isNonNegInt(r.count.min) || !(r.count.max === null || isNonNegInt(r.count.max))) {
    e.push(`${p}.count は {min: 0以上の整数, max: 整数またはnull} です`);
  } else if (r.count.max !== null && (r.count.max as number) < (r.count.min as number)) {
    e.push(`${p}.count.max が min より小さいです`);
  }
  if (!Array.isArray(r.formats) || r.formats.length === 0 || !r.formats.every((f) => f === 'png' || f === 'jpeg')) {
    e.push(`${p}.formats は "png" / "jpeg" の配列です`);
  }
  const d = r.dimensions;
  if (!isObj(d) || !['none', 'exact', 'max'].includes(d.mode as string)) {
    e.push(`${p}.dimensions.mode は none / exact / max です`);
  } else if (d.mode !== 'none' && (!isPosInt(d.width) || !isPosInt(d.height))) {
    e.push(`${p}.dimensions の width/height は正の整数です`);
  }
  if (!nullablePos(r.maxBytes)) e.push(`${p}.maxBytes は正の整数またはnullです`);
  if (typeof r.evenDimensions !== 'boolean') e.push(`${p}.evenDimensions は true/false です`);
  if (!['required', 'optional', 'forbidden'].includes(r.transparency as string)) {
    e.push(`${p}.transparency は required / optional / forbidden です`);
  }
  if (!nullablePos(r.minDpi)) e.push(`${p}.minDpi は正の整数またはnullです`);
  if (!(r.marginAdvisoryPx === null || isNonNegInt(r.marginAdvisoryPx))) e.push(`${p}.marginAdvisoryPx は0以上の整数またはnullです`);
  if (typeof r.directory !== 'string') e.push(`${p}.directory は文字列です`);
  else {
    const dir = r.directory.replace(/\\/g, '/');
    if (dir.startsWith('/') || dir.split('/').some((s) => s === '..')) e.push(`${p}.directory に絶対パスや .. は使えません`);
  }
  if (typeof r.namePattern !== 'string' || r.namePattern.trim() === '') e.push(`${p}.namePattern は空にできません`);
  else if (/[/\\]/.test(r.namePattern)) e.push(`${p}.namePattern にフォルダ区切りは使えません（directoryを使用）`);
  return e;
}

export function validateCheckTemplate(o: unknown): string[] {
  const e: string[] = [];
  if (!isObj(o)) return ['JSONのトップがオブジェクトではありません'];
  if (!checkSchemaVersion(o, e)) return e;
  if (o.kind !== 'check-template') e.push('kind が "check-template" ではありません');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) e.push('id は英数字・-・_ で指定してください');
  if (typeof o.name !== 'string' || !o.name.trim()) e.push('name が空です');
  if (!['official-derived', 'user-workflow'].includes(o.sourceType as string)) e.push('sourceType は official-derived / user-workflow です');
  if (!nullablePos(o.maxArchiveBytes)) e.push('maxArchiveBytes は正の整数またはnullです');
  if (o.allowedStickerCounts !== undefined) {
    if (!Array.isArray(o.allowedStickerCounts) || !o.allowedStickerCounts.every(isPosInt)) e.push('allowedStickerCounts は正の整数の配列です');
    else if (o.selectedStickerCount !== undefined && !o.allowedStickerCounts.includes(o.selectedStickerCount as number)) {
      e.push('selectedStickerCount が allowedStickerCounts に含まれていません');
    }
  }
  if (!Array.isArray(o.roles) || o.roles.length === 0) e.push('roles が1件以上必要です');
  else {
    o.roles.forEach((r, i) => e.push(...validateRole(r, i)));
    const ids = o.roles.map((r) => (isObj(r) ? r.id : null));
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) e.push(`役割IDが重複しています: ${[...new Set(dup)].join(', ')}`);
  }
  return e;
}

export function validateBundleTemplate(o: unknown, known?: Map<string, CheckTemplate>): string[] {
  const e: string[] = [];
  if (!isObj(o)) return ['JSONのトップがオブジェクトではありません'];
  if (!checkSchemaVersion(o, e)) return e;
  if (o.kind !== 'bundle-template') e.push('kind が "bundle-template" ではありません');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) e.push('id は英数字・-・_ で指定してください');
  if (typeof o.name !== 'string' || !o.name.trim()) e.push('name が空です');
  if (!Array.isArray(o.templates) || !o.templates.every((t) => typeof t === 'string')) e.push('templates は文字列の配列です');
  if (!Array.isArray(o.outputs) || o.outputs.length === 0) {
    e.push('outputs が1件以上必要です');
    return e;
  }
  const outIds = new Set<string>();
  const archives = new Set<string>();
  o.outputs.forEach((out, i) => {
    const p = `outputs[${i}]`;
    if (!isObj(out)) return e.push(`${p} がオブジェクトではありません`);
    if (typeof out.id !== 'string' || !ID_RE.test(out.id)) e.push(`${p}.id は英数字・-・_ で指定してください`);
    else if (outIds.has(out.id)) e.push(`${p}.id "${out.id}" が重複しています`);
    else outIds.add(out.id);
    if (typeof out.templateId !== 'string') e.push(`${p}.templateId がありません`);
    if (!Array.isArray(out.roles) || out.roles.length === 0 || !out.roles.every((r) => typeof r === 'string')) {
      e.push(`${p}.roles は1件以上の役割IDの配列です`);
    }
    if (typeof out.archiveName !== 'string' || !/^[^/\\:*?"<>|]+\.zip$/i.test(out.archiveName)) {
      e.push(`${p}.archiveName は「名前.zip」の形式です`);
    } else if (archives.has(out.archiveName.toLowerCase())) e.push(`${p}.archiveName "${out.archiveName}" が重複しています`);
    else archives.add(out.archiveName.toLowerCase());
    if (known && typeof out.templateId === 'string') {
      const t = known.get(out.templateId);
      if (!t) e.push(`${p}.templateId "${out.templateId}" のテンプレートが見つかりません`);
      else if (Array.isArray(out.roles)) {
        for (const r of out.roles) if (!t.roles.some((x) => x.id === r)) e.push(`${p}: テンプレート "${t.name}" に役割 "${r}" がありません`);
      }
    }
    if (Array.isArray(o.templates) && typeof out.templateId === 'string' && !o.templates.includes(out.templateId)) {
      e.push(`${p}.templateId "${out.templateId}" が templates に含まれていません`);
    }
  });
  return e;
}

export type ParsedTemplate =
  | { ok: true; kind: 'check-template'; value: CheckTemplate }
  | { ok: true; kind: 'bundle-template'; value: BundleTemplate }
  | { ok: false; errors: string[] };

export function parseTemplateJson(text: string, known?: Map<string, CheckTemplate>): ParsedTemplate {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`JSONとして読めません: ${(err as Error).message}`] };
  }
  if (!isObj(o)) return { ok: false, errors: ['JSONのトップがオブジェクトではありません'] };
  const vErr: string[] = [];
  if (!checkSchemaVersion(o, vErr)) return { ok: false, errors: vErr };
  if (o.kind === 'check-template') {
    const errors = validateCheckTemplate(o);
    return errors.length ? { ok: false, errors } : { ok: true, kind: 'check-template', value: o as unknown as CheckTemplate };
  }
  if (o.kind === 'bundle-template') {
    const errors = validateBundleTemplate(o, known);
    return errors.length ? { ok: false, errors } : { ok: true, kind: 'bundle-template', value: o as unknown as BundleTemplate };
  }
  return { ok: false, errors: [`kind ${JSON.stringify(o.kind)} は未対応です（check-template / bundle-template）`] };
}

function assertValid<T>(o: unknown, validate: (x: unknown) => string[]): T {
  const e = validate(o);
  if (e.length) throw new Error(`同梱テンプレートが不正です: ${e.join(' / ')}`);
  return o as T;
}

export const BUILTIN_CHECK_TEMPLATES: CheckTemplate[] = [
  assertValid<CheckTemplate>(lineStatic, validateCheckTemplate),
  assertValid<CheckTemplate>(boothWorkflow, validateCheckTemplate),
];
const builtinMap = new Map(BUILTIN_CHECK_TEMPLATES.map((t) => [t.id, t]));
export const BUILTIN_BUNDLES: BundleTemplate[] = [
  assertValid<BundleTemplate>(combinedExample, (x) => validateBundleTemplate(x, builtinMap)),
];
export const BUILTIN_IDS = new Set<string>([...BUILTIN_CHECK_TEMPLATES, ...BUILTIN_BUNDLES].map((t) => t.id));

export function isBuiltin(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** スタンプ数（8/16/24/32/40など）の選択を反映した役割一覧。テンプレート自体は変えない */
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

export function uniqueId(base: string, taken: Set<string>): string {
  const clean = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 48) || 'template';
  let id = clean;
  let i = 2;
  while (taken.has(id)) id = `${clean}-${i++}`;
  return id;
}

/** 標準テンプレートは直接上書きできないので複製して編集する */
export function cloneCheckTemplate(t: CheckTemplate, taken: Set<string>): CheckTemplate {
  const copy: CheckTemplate = JSON.parse(JSON.stringify(t));
  copy.id = uniqueId(`${t.id}-copy`, taken);
  copy.name = `${t.name}（複製）`;
  copy.sourceType = 'user-workflow';
  copy.basedOn = t.id;
  copy.notice = t.sourceType === 'official-derived'
    ? `「${t.name}」を元にした自作ルールです。編集後の条件は公式条件として扱いません。`
    : t.notice;
  return copy;
}

export function cloneBundle(b: BundleTemplate, taken: Set<string>): BundleTemplate {
  const copy: BundleTemplate = JSON.parse(JSON.stringify(b));
  copy.id = uniqueId(`${b.id}-copy`, taken);
  copy.name = `${b.name}（複製）`;
  return copy;
}

export function newRole(taken: Set<string>): CheckRole {
  return {
    id: uniqueId('role', taken),
    label: '新しい役割',
    count: { min: 1, max: null },
    formats: ['png'] as ImageFormat[],
    dimensions: { mode: 'none' },
    maxBytes: null,
    evenDimensions: false,
    transparency: 'optional',
    minDpi: null,
    marginAdvisoryPx: null,
    directory: '',
    namePattern: '{original}',
  };
}

export function newCheckTemplate(taken: Set<string>): CheckTemplate {
  return {
    schemaVersion: 1,
    kind: 'check-template',
    id: uniqueId('my-template', taken),
    name: '自作テンプレート',
    sourceType: 'user-workflow',
    checkedOn: null,
    sourceUrl: null,
    notice: '自作ルールです。販売サイトの公式条件ではありません。',
    maxArchiveBytes: null,
    roles: [newRole(new Set())],
  };
}

/** 保存用JSON（UI用の付加情報を持たない） */
export function templateToJson(t: CheckTemplate | BundleTemplate): string {
  return JSON.stringify(t, null, 2);
}
