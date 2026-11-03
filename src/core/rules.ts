// 規則評価（純粋関数）。事実（AssetFacts）×テンプレート → 指摘
import type {
  AssetFacts,
  AssetRecord,
  CheckRole,
  CheckTemplate,
  Finding,
  ImageStatus,
  Project,
  ProjectTarget,
  RoleRef,
  RuleSource,
} from './types';
import { APP_LIMITS, factsValid } from './facts';
import { CONTAINER_LABEL, PNG_COLOR_TYPE } from './sniff';
import { effectiveRoles, roleLabel, stickerCountFor } from './templates';
import { joinPath, pathKey, renderName, validateOutputPath } from './naming';
import { zipSize } from './zip';

export const DPI_TOLERANCE = 0.1;
export const UNREADABLE_CODES = new Set(['unreadable', 'unsupported-format', 'apng', 'pixel-limit']);

export function fmtBytes(n: number): string {
  return `${n.toLocaleString('ja-JP')} bytes`;
}

export function fmtMB(n: number): string {
  return `${(n / 1_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} MB`;
}

const FORMAT_LABEL: Record<string, string> = { png: 'PNG', jpeg: 'JPEG' };

export function templateSources(t: CheckTemplate): { rule: RuleSource; advisory: RuleSource } {
  return t.sourceType === 'official-derived' ? { rule: 'official', advisory: 'app' } : { rule: 'user', advisory: 'user' };
}

/** 形式・読込可否など、役割に依らない指摘 */
export function containerFindings(f: AssetFacts, name: string): Finding[] {
  const out: Finding[] = [];
  const isImage = f.container === 'png' || f.container === 'jpeg';
  if (!isImage) {
    if (f.container === 'unknown') {
      out.push({ code: 'unreadable', severity: 'error', title: '読込不能', detail: `画像として読み込めません（${f.decode.ok ? '' : f.decode.reason}）`, source: 'app' });
    } else {
      out.push({
        code: 'unsupported-format',
        severity: 'error',
        title: `非対応の形式（${CONTAINER_LABEL[f.container]}）`,
        detail: '静止PNG/JPEGのみ対応しています。自動変換はしません。外部で変換してから差し替えてください。',
        measured: CONTAINER_LABEL[f.container],
        required: 'PNG または JPEG',
        source: 'app',
      });
    }
    return out;
  }
  if (f.extFormat && f.extFormat !== f.container) {
    out.push({
      code: 'ext-mismatch',
      severity: 'warning',
      title: '拡張子と中身が違います',
      detail: `${name} の拡張子は${CONTAINER_LABEL[(f.extFormat as never)] ?? f.extFormat}ですが、中身は${CONTAINER_LABEL[f.container]}です。`,
      measured: `中身: ${CONTAINER_LABEL[f.container]}`,
      required: `拡張子どおりの形式`,
      source: 'app',
    });
  }
  if (f.png?.animated) {
    out.push({ code: 'apng', severity: 'error', title: 'アニメーションPNGは対象外', detail: 'acTLチャンクを検出しました。静止画のみ対応しています。', source: 'app' });
  } else if (f.pixelLimitExceeded) {
    out.push({
      code: 'pixel-limit',
      severity: 'error',
      title: 'アプリの画素数上限を超えています',
      measured: `${f.width}×${f.height}`,
      required: `${APP_LIMITS.maxPixels / 1_000_000}メガピクセル以下（アプリ上限・販売先の上限とは別）`,
      source: 'app',
    });
  } else if (!f.decode.ok) {
    out.push({ code: 'unreadable', severity: 'error', title: '読込不能', detail: `画像をデコードできません: ${f.decode.reason}`, source: 'app' });
  }
  return out;
}

export function evaluateRole(f: AssetFacts, role: CheckRole, t: CheckTemplate): Finding[] {
  const src = templateSources(t);
  const out: Finding[] = [];
  const w = f.width ?? 0;
  const h = f.height ?? 0;
  const fmt = f.container;
  if (fmt === 'png' || fmt === 'jpeg') {
    if (!role.formats.includes(fmt)) {
      out.push({
        code: 'format',
        severity: 'error',
        title: '形式が条件と違います',
        measured: FORMAT_LABEL[fmt],
        required: role.formats.map((x) => FORMAT_LABEL[x]).join(' / '),
        source: src.rule,
      });
    }
  }
  if (!f.decode.ok) return out; // 寸法以外はデコードできないと判定できない
  const d = role.dimensions;
  if (d.mode === 'exact' && (w !== d.width || h !== d.height)) {
    out.push({
      code: 'dim-exact',
      severity: 'error',
      title: 'サイズが指定と違います',
      measured: `${w} × ${h} px`,
      required: `${d.width} × ${d.height} px（一致）`,
      source: src.rule,
    });
  } else if (d.mode === 'max' && (w > d.width || h > d.height)) {
    const parts: string[] = [];
    if (w > d.width) parts.push(`幅が${w - d.width}px`);
    if (h > d.height) parts.push(`高さが${h - d.height}px`);
    out.push({
      code: 'dim-max',
      severity: 'error',
      title: 'サイズが上限を超えています',
      detail: `${parts.join('、')}大きい画像です。`,
      measured: `${w} × ${h} px`,
      required: `最大 ${d.width} × ${d.height} px`,
      source: src.rule,
    });
  }
  if (role.evenDimensions && (w % 2 !== 0 || h % 2 !== 0)) {
    const odd = [w % 2 ? `幅${w}` : '', h % 2 ? `高さ${h}` : ''].filter(Boolean).join('・');
    out.push({
      code: 'even',
      severity: 'error',
      title: '寸法が奇数です',
      detail: `${odd}が奇数です。`,
      measured: `${w} × ${h} px`,
      required: '幅・高さとも偶数',
      source: src.rule,
    });
  }
  if (role.maxBytes !== null && f.bytes > role.maxBytes) {
    out.push({
      code: 'bytes',
      severity: 'error',
      title: 'ファイル容量が上限を超えています',
      measured: fmtBytes(f.bytes),
      required: `${fmtBytes(role.maxBytes)} 以下`,
      detail: t.byteConvention ? `換算方針: ${t.byteConvention}` : undefined,
      source: src.rule,
    });
  }
  const a = f.alpha;
  if (a) {
    const fullyTransparent = a.zeroAlphaPixels === a.totalPixels;
    const noContent = a.contentBox === null;
    const opaque = a.translucentPixels === 0;
    if (role.transparency === 'required') {
      if (!f.hasAlphaChannel || opaque) {
        out.push({
          code: 'transparency-none',
          severity: 'error',
          title: '背景が透過していません',
          detail: f.hasAlphaChannel ? 'すべての画素が完全不透明です。' : 'アルファチャンネルがない形式です。',
          measured: '透明画素 0',
          required: '背景透過',
          source: src.rule,
        });
      } else if (fullyTransparent || noContent) {
        out.push({
          code: 'transparency-empty',
          severity: 'error',
          title: fullyTransparent ? '完全透明の画像です（内容なし）' : `見える内容がありません（alpha>${a.threshold}の画素なし）`,
          detail: '透明画素があっても、内容がない画像は合格にしません。',
          measured: `不透明画素 0 / ${a.totalPixels.toLocaleString()}`,
          required: '透過背景＋絵柄',
          source: src.rule,
        });
      } else {
        out.push({
          code: 'transparency-note',
          severity: 'info',
          title: '透明画素あり・見た目の確認は必要',
          detail: `透明・半透明の画素 ${a.translucentPixels.toLocaleString()} / ${a.totalPixels.toLocaleString()}。背景処理が正しいかは白・黒・市松の背景で目視確認してください。`,
          source: 'app',
        });
      }
    } else if (role.transparency === 'forbidden' && !opaque) {
      out.push({
        code: 'transparency-forbidden',
        severity: 'error',
        title: '透明な画素があります',
        measured: `透明・半透明 ${a.translucentPixels.toLocaleString()} 画素`,
        required: '透過なし',
        source: src.rule,
      });
    } else if (noContent) {
      out.push({ code: 'transparency-empty', severity: 'warning', title: '見える内容がありません（完全透明）', source: 'app' });
    }
    if (role.marginAdvisoryPx !== null && a.margins) {
      const m = a.margins;
      const low = (['left', 'top', 'right', 'bottom'] as const).filter((k) => m[k] < role.marginAdvisoryPx!);
      if (low.length) {
        const jp = { left: '左', top: '上', right: '右', bottom: '下' };
        out.push({
          code: 'margin',
          severity: 'warning',
          title: '余白が目安より狭い可能性があります',
          detail: `alpha>${a.threshold}の範囲で測った推定です（閾値は設定で変更可）。${low.map((k) => `${jp[k]}${m[k]}px`).join('、')}。`,
          measured: `上${m.top} 右${m.right} 下${m.bottom} 左${m.left} px`,
          required: `各辺 約${role.marginAdvisoryPx}px（目安）`,
          source: src.advisory,
        });
      }
    }
  }
  if (role.minDpi !== null) {
    if (f.dpi.status === 'unknown') {
      out.push({
        code: 'dpi-unknown',
        severity: 'unknown',
        title: 'DPI未確認',
        detail: `${f.dpi.reason}。勝手に72dpiと補完しません。`,
        measured: '情報なし',
        required: `${role.minDpi}dpi以上`,
        source: src.rule,
      });
    } else {
      const lowAxis = Math.min(f.dpi.x, f.dpi.y);
      if (lowAxis + DPI_TOLERANCE < role.minDpi) {
        out.push({
          code: 'dpi-low',
          severity: 'error',
          title: 'DPIが不足しています',
          measured: `${f.dpi.x.toFixed(1)} × ${f.dpi.y.toFixed(1)} dpi（${f.dpi.raw}）`,
          required: `${role.minDpi}dpi以上`,
          source: src.rule,
        });
      }
    }
  }
  if (f.png && (f.png.colorType === 0 || f.png.colorType === 4) && role.minDpi !== null) {
    out.push({
      code: 'color-gray',
      severity: 'warning',
      title: 'グレースケールのPNGです',
      detail: 'RGBの指定がある場合は外部で変換してください。',
      measured: PNG_COLOR_TYPE[f.png.colorType],
      source: 'app',
    });
  }
  return out;
}

export function statusOf(findings: Finding[]): Exclude<ImageStatus, 'unchecked'> {
  if (findings.some((x) => x.severity === 'error')) return 'error';
  if (findings.some((x) => x.severity === 'warning' || x.severity === 'unknown')) return 'warn';
  return 'pass';
}

export function isProblem(f: Finding): boolean {
  return f.severity === 'error' || f.severity === 'warning' || f.severity === 'unknown';
}

// ---------------------------------------------------------------- 範囲（出力単位）

export interface Scope {
  id: string;
  label: string;
  template: CheckTemplate;
  roles: CheckRole[];
  archiveName: string;
}

export function resolveScopes(
  target: ProjectTarget,
  templates: Map<string, CheckTemplate>,
  stickerCounts: Record<string, number>,
): { scopes: Scope[]; errors: string[] } {
  const t = templates.get(target.templateId);
  if (!t) return { scopes: [], errors: [`テンプレート "${target.templateId}" が見つかりません`] };
  return {
    scopes: [{ id: t.id, label: t.name, template: t, roles: effectiveRoles(t, stickerCountFor(t, stickerCounts)), archiveName: `${t.id}.zip` }],
    errors: [],
  };
}

/** 役割参照のキー（テンプレートIDで名前空間を分ける） */
export function scopedRoleKey(templateId: string, roleId: string): string {
  return `${templateId}/${roleId}`;
}

// ---------------------------------------------------------------- 全体評価

export interface PackEntry {
  path: string;
  assetId: string;
  refId: string;
  originalName: string;
  roleLabel: string;
  size: number;
  sha256: string;
  pathError: string | null;
}

export interface RoleEval {
  role: CheckRole;
  label: string;
  refs: (RoleRef & { asset: AssetRecord; outputPath: string })[];
  min: number;
  max: number | null;
}

export interface ScopeEval {
  scope: Scope;
  roles: RoleEval[];
  setFindings: Finding[];
  entries: PackEntry[];
  excluded: { assetId: string; originalName: string; reason: string }[];
  collisions: string[][];
  zipBytes: number;
  uncheckedCount: number;
  unreadableCount: number;
  assetIds: string[];
  hasErrors: boolean;
  hasWarnings: boolean;
}

export interface AssetEval {
  status: ImageStatus;
  findings: Finding[];
  inScope: boolean;
}

export interface Evaluation {
  scopes: ScopeEval[];
  scopeErrors: string[];
  assets: Record<string, AssetEval>;
  imageCounts: Record<ImageStatus, number> & { total: number };
  violationCount: number;
  setViolationCount: number;
  allChecked: boolean;
  allClear: boolean;
  suggestedCount: number;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.code}|${f.roleLabel ?? ''}|${f.measured ?? ''}|${f.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function evaluateProject(project: Project, templates: Map<string, CheckTemplate>): Evaluation {
  const { scopes, errors: scopeErrors } = resolveScopes(project.target, templates, project.settings.stickerCounts);
  const assetById = new Map(project.assets.map((a) => [a.id, a]));
  const th = project.settings.alphaThreshold;
  const validFacts = (a: AssetRecord) => {
    const f = project.facts[a.id];
    return factsValid(f, a.sha256, th) ? f : undefined;
  };

  const assetFindings = new Map<string, Finding[]>();
  const inScope = new Set<string>();
  const evaluatedRole = new Set<string>();
  const scopeEvals: ScopeEval[] = [];
  let suggestedCount = 0;

  for (const scope of scopes) {
    const roles: RoleEval[] = [];
    const entries: PackEntry[] = [];
    const setFindings: Finding[] = [];
    const src = templateSources(scope.template);
    const scopeAssetIds = new Set<string>();
    for (const role of scope.roles) {
      const label = roleLabel(role);
      const refs = project.refs
        .filter((r) => r.templateId === scope.template.id && r.roleId === role.id && assetById.has(r.assetId))
        .sort((a, b) => a.order - b.order);
      const withPath = refs.map((r, i) => {
        const asset = assetById.get(r.assetId)!;
        const f = validFacts(asset);
        const container = f?.container ?? null;
        const name = r.nameOverride?.trim() || renderName(role.namePattern, { index: i + 1, container, originalName: asset.originalName });
        const outputPath = joinPath(role.directory, name);
        return { ...r, asset, outputPath };
      });
      roles.push({ role, label, refs: withPath, min: role.count.min, max: role.count.max });
      const n = refs.length;
      if (n < role.count.min) {
        setFindings.push({
          code: 'count-short',
          severity: 'error',
          title: `${label}が${role.count.min - n}枚不足`,
          measured: `${n}枚`,
          required: role.count.max === role.count.min ? `${role.count.min}枚` : `${role.count.min}枚以上`,
          source: src.rule,
          roleLabel: label,
        });
      }
      if (role.count.max !== null && n > role.count.max) {
        setFindings.push({
          code: 'count-over',
          severity: 'error',
          title: `${label}が${n - role.count.max}枚多い`,
          measured: `${n}枚`,
          required: `${role.count.max}枚以下`,
          source: src.rule,
          roleLabel: label,
        });
      }
      for (const r of withPath) {
        if (r.suggested) suggestedCount++;
        scopeAssetIds.add(r.assetId);
        inScope.add(r.assetId);
        const f = validFacts(r.asset);
        entries.push({
          path: r.outputPath,
          assetId: r.assetId,
          refId: r.id,
          originalName: r.asset.originalName,
          roleLabel: label,
          size: r.asset.size,
          sha256: r.asset.sha256,
          pathError: validateOutputPath(r.outputPath),
        });
        const roleKey = `${r.assetId}|${scopedRoleKey(scope.template.id, role.id)}`;
        if (f && !evaluatedRole.has(roleKey)) {
          evaluatedRole.add(roleKey);
          const list = assetFindings.get(r.assetId) ?? [];
          list.push(...containerFindings(f, r.asset.originalName));
          const multi = project.refs.filter((x) => x.assetId === r.assetId).length > 1;
          for (const x of evaluateRole(f, role, scope.template)) list.push(multi ? { ...x, roleLabel: `${scope.template.name}／${label}` } : x);
          assetFindings.set(r.assetId, list);
        }
      }
    }
    // 出力パス衝突（大文字小文字・正規化を同一視）
    const byKey = new Map<string, PackEntry[]>();
    for (const e of entries) {
      const k = pathKey(e.path);
      byKey.set(k, [...(byKey.get(k) ?? []), e]);
    }
    const collisions: string[][] = [];
    for (const list of byKey.values()) {
      if (list.length > 1) {
        collisions.push(list.map((e) => `${e.originalName} → ${e.path}`));
        setFindings.push({
          code: 'path-collision',
          severity: 'error',
          title: `出力パスが衝突しています: ${list[0].path}`,
          detail: `${list.map((e) => e.originalName).join('、')} が同じ名前で出力されます。出力名を変更して解決してください。`,
          source: 'app',
        });
      }
    }
    for (const e of entries) {
      if (e.pathError) {
        setFindings.push({ code: 'path-invalid', severity: 'error', title: `出力名が不正です: ${e.path}`, detail: e.pathError, source: 'app' });
      }
    }
    const zipBytes = zipSize(entries);
    if (scope.template.maxArchiveBytes !== null && zipBytes > scope.template.maxArchiveBytes) {
      setFindings.push({
        code: 'archive-size',
        severity: 'error',
        title: '完成ZIPの容量が上限を超えます',
        measured: fmtBytes(zipBytes),
        required: `${fmtBytes(scope.template.maxArchiveBytes)} 以下`,
        detail: scope.template.byteConvention ? `換算方針: ${scope.template.byteConvention}` : undefined,
        source: src.rule,
      });
    }
    const excluded = project.assets
      .filter((a) => !scopeAssetIds.has(a.id))
      .map((a) => ({
        assetId: a.id,
        originalName: a.originalName,
        reason: project.refs.some((r) => r.assetId === a.id) ? 'このZIPの対象役割ではありません' : '役割が未割当です',
      }));
    const uncheckedCount = [...scopeAssetIds].filter((id) => !validFacts(assetById.get(id)!)).length;
    scopeEvals.push({
      scope,
      roles,
      setFindings,
      entries,
      excluded,
      collisions,
      zipBytes,
      uncheckedCount,
      unreadableCount: 0,
      assetIds: [...scopeAssetIds],
      hasErrors: false,
      hasWarnings: false,
    });
  }

  const assets: Record<string, AssetEval> = {};
  const counts = { pass: 0, warn: 0, error: 0, unchecked: 0, total: project.assets.length };
  let violationCount = 0;
  for (const a of project.assets) {
    const f = validFacts(a);
    const isIn = inScope.has(a.id);
    let findings: Finding[] = [];
    if (f) {
      findings = isIn ? dedupe(assetFindings.get(a.id) ?? []) : containerFindings(f, a.originalName);
    }
    if (!isIn) {
      findings.push({ code: 'unassigned', severity: 'warning', title: '役割が未割当です', detail: 'どの出力ZIPにも入りません。必要なら役割を割り当ててください。', source: 'app' });
    }
    const status: ImageStatus = f ? statusOf(findings) : 'unchecked';
    counts[status]++;
    violationCount += findings.filter(isProblem).length;
    assets[a.id] = { status, findings, inScope: isIn };
  }
  let setViolationCount = 0;
  for (const s of scopeEvals) {
    if (s.roles.some((r) => r.refs.some((x) => x.suggested))) {
      s.setFindings.push({
        code: 'suggested',
        severity: 'warning',
        title: '名前から推定した役割候補が未確定です',
        detail: '内容を確認して「候補を確定」を押してください。',
        source: 'app',
      });
    }
    setViolationCount += s.setFindings.filter(isProblem).length;
    const scoped = s.assetIds.map((id) => assets[id]);
    s.unreadableCount = scoped.filter((x) => x.findings.some((f) => UNREADABLE_CODES.has(f.code))).length;
    s.hasErrors = s.setFindings.some((x) => x.severity === 'error') || scoped.some((x) => x.status === 'error');
    s.hasWarnings = s.setFindings.some((x) => x.severity === 'warning' || x.severity === 'unknown') || scoped.some((x) => x.status === 'warn');
  }
  const allChecked = project.assets.length > 0 && counts.unchecked === 0;
  return {
    scopes: scopeEvals,
    scopeErrors,
    assets,
    imageCounts: counts,
    violationCount,
    setViolationCount,
    allChecked,
    allClear: allChecked && violationCount === 0 && setViolationCount === 0 && scopeErrors.length === 0,
    suggestedCount,
  };
}

// ---------------------------------------------------------------- 書出し可否

export type ExportMode = 'upload' | 'work';

export interface ExportGate {
  allowed: boolean;
  needsAck: boolean;
  blockers: string[];
  label: '未チェック' | '指摘あり' | '要確認あり' | 'チェック済み';
}

export function exportGate(s: ScopeEval, mode: ExportMode): ExportGate {
  const blockers: string[] = [];
  const collisions = s.setFindings.filter((f) => f.code === 'path-collision' || f.code === 'path-invalid');
  if (s.entries.length === 0) blockers.push('出力するファイルがありません');
  if (collisions.length) blockers.push('出力パスの衝突・不正を解決してください');
  const label: ExportGate['label'] =
    s.uncheckedCount > 0 ? '未チェック' : s.hasErrors ? '指摘あり' : s.hasWarnings ? '要確認あり' : 'チェック済み';
  if (mode === 'upload') {
    if (s.uncheckedCount > 0) blockers.push(`未チェックの画像が${s.uncheckedCount}枚あります（作業用として保存は可能）`);
    if (s.hasErrors) blockers.push('エラーがあるため投稿用には書き出せません（作業用として保存は可能）');
  }
  // デコード不能（判明分）は作業用でも解決必須
  if (s.unreadableCount > 0) blockers.push(`読込不能・非対応の画像が${s.unreadableCount}枚あります。差し替えるか役割から外してください`);
  return {
    allowed: blockers.length === 0,
    needsAck: mode === 'upload' && blockers.length === 0 && s.hasWarnings,
    blockers,
    label,
  };
}

const WORK_TAG: Record<ExportGate['label'], string> = {
  未チェック: 'unchecked',
  指摘あり: 'has-issues',
  要確認あり: 'needs-review',
  チェック済み: 'checked',
};

/** 保存ファイル名。ブラウザによっては日本語のdownload名が捨てられるため、ASCIIで種類が分かる名前にする */
export function exportFileName(s: ScopeEval, mode: ExportMode, gate: ExportGate): string {
  const base = asciiFileName(s.scope.archiveName, 'archive.zip');
  if (mode === 'upload') return `UPLOAD_${base}`;
  return `WORK-${WORK_TAG[gate.label]}_${base}`;
}

/** 非ASCIIを含む名前は拡張子を残して置き換える */
export function asciiFileName(name: string, fallback: string): string {
  if (/^[\x21-\x7e][\x20-\x7e]*$/.test(name) && !/[\\/:*?"<>|]/.test(name)) return name;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1];
  const ascii = name
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const stem = ascii || fallback.replace(/\.[^.]*$/, '');
  return ext ? `${stem}.${ext}` : stem || fallback;
}
