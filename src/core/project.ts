// プロジェクト操作（純粋関数）：役割割当・並べ替え・差替え
import type { AssetRecord, CheckTemplate, Project, ProjectTarget, RoleRef } from './types';
import { patternToRegex } from './naming';
import { DEFAULT_ALPHA_THRESHOLD } from './facts';
import type { Scope } from './rules';

let counter = 0;
export function makeId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function newProject(target: ProjectTarget = { kind: 'template', templateId: 'line-static' }): Project {
  return {
    schemaVersion: 1,
    id: makeId('prj'),
    name: '新しい作品',
    target,
    assets: [],
    refs: [],
    settings: { stickerCounts: {}, alphaThreshold: DEFAULT_ALPHA_THRESHOLD },
    facts: {},
    updatedAt: new Date().toISOString(),
  };
}

function touch(p: Project): Project {
  return { ...p, updatedAt: new Date().toISOString() };
}

function nextOrder(p: Project, templateId: string, roleId: string): number {
  const orders = p.refs.filter((r) => r.templateId === templateId && r.roleId === roleId).map((r) => r.order);
  return orders.length ? Math.max(...orders) + 1 : 1;
}

/**
 * ファイル名から役割候補を推定する（候補として付ける。確定は利用者）。
 * 既にそのテンプレートで役割を持つ素材には付けない。
 */
export function suggestRoles(p: Project, scopes: Scope[], assetIds?: string[]): { project: Project; added: number } {
  const target = new Set(assetIds ?? p.assets.map((a) => a.id));
  const refs = [...p.refs];
  let added = 0;
  const templates = new Map<string, CheckTemplate>();
  const rolesByTemplate = new Map<string, Set<string>>();
  for (const s of scopes) {
    templates.set(s.template.id, s.template);
    const set = rolesByTemplate.get(s.template.id) ?? new Set<string>();
    s.roles.forEach((r) => set.add(r.id));
    rolesByTemplate.set(s.template.id, set);
  }
  for (const [tid, t] of templates) {
    const roleIds = rolesByTemplate.get(tid)!;
    const roles = t.roles.filter((r) => roleIds.has(r.id));
    for (const a of p.assets) {
      if (!target.has(a.id)) continue;
      if (refs.some((r) => r.assetId === a.id && r.templateId === tid)) continue;
      const matches: { roleId: string; index: number | null }[] = [];
      for (const role of roles) {
        const re = patternToRegex(role.namePattern);
        if (!re) continue;
        const m = re.exec(a.originalName);
        if (m) matches.push({ roleId: role.id, index: m[1] !== undefined ? Number(m[1]) : null });
      }
      if (matches.length !== 1) continue;
      const { roleId, index } = matches[0];
      const order = index ?? nextOrder({ ...p, refs }, tid, roleId);
      refs.push({ id: makeId('ref'), assetId: a.id, templateId: tid, roleId, order, suggested: true });
      added++;
    }
  }
  return { project: added ? touch({ ...p, refs: normalizeOrders(refs) }) : p, added };
}

/** 役割ごとに順序を1..Nへ詰め直す（相対順は維持） */
export function normalizeOrders(refs: RoleRef[]): RoleRef[] {
  const groups = new Map<string, RoleRef[]>();
  for (const r of refs) {
    const k = `${r.templateId}/${r.roleId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const order = new Map<string, number>();
  for (const list of groups.values()) {
    list
      .slice()
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .forEach((r, i) => order.set(r.id, i + 1));
  }
  return refs.map((r) => (order.get(r.id) === r.order ? r : { ...r, order: order.get(r.id)! }));
}

export function confirmSuggestions(p: Project): Project {
  return touch({ ...p, refs: p.refs.map((r) => (r.suggested ? { ...r, suggested: false } : r)) });
}

export function clearSuggestions(p: Project): Project {
  return touch({ ...p, refs: normalizeOrders(p.refs.filter((r) => !r.suggested)) });
}

export function addRef(p: Project, assetId: string, templateId: string, roleId: string): Project {
  if (p.refs.some((r) => r.assetId === assetId && r.templateId === templateId && r.roleId === roleId)) return p;
  const ref: RoleRef = { id: makeId('ref'), assetId, templateId, roleId, order: nextOrder(p, templateId, roleId) };
  return touch({ ...p, refs: [...p.refs, ref] });
}

export function removeRef(p: Project, refId: string): Project {
  return touch({ ...p, refs: normalizeOrders(p.refs.filter((r) => r.id !== refId)) });
}

/** 役割変更：参照IDは維持し、新しい役割の末尾へ */
export function changeRefRole(p: Project, refId: string, templateId: string, roleId: string): Project {
  const ref = p.refs.find((r) => r.id === refId);
  if (!ref) return p;
  if (ref.templateId === templateId && ref.roleId === roleId) return p;
  if (p.refs.some((r) => r.id !== refId && r.assetId === ref.assetId && r.templateId === templateId && r.roleId === roleId)) {
    return removeRef(p, refId);
  }
  const order = nextOrder(p, templateId, roleId);
  const refs = p.refs.map((r) => (r.id === refId ? { ...r, templateId, roleId, order, suggested: false, nameOverride: undefined } : r));
  return touch({ ...p, refs: normalizeOrders(refs) });
}

/** 前へ(-1)／後へ(+1)。ドラッグ不要の並べ替え */
export function moveRef(p: Project, refId: string, delta: -1 | 1): Project {
  const ref = p.refs.find((r) => r.id === refId);
  if (!ref) return p;
  const group = p.refs
    .filter((r) => r.templateId === ref.templateId && r.roleId === ref.roleId)
    .sort((a, b) => a.order - b.order);
  const i = group.findIndex((r) => r.id === refId);
  const j = i + delta;
  if (j < 0 || j >= group.length) return p;
  const other = group[j];
  const refs = p.refs.map((r) => {
    if (r.id === ref.id) return { ...r, order: other.order };
    if (r.id === other.id) return { ...r, order: ref.order };
    return r;
  });
  return touch({ ...p, refs });
}

export function setNameOverride(p: Project, refId: string, name: string | undefined): Project {
  const v = name?.trim() || undefined;
  return touch({ ...p, refs: p.refs.map((r) => (r.id === refId ? { ...r, nameOverride: v } : r)) });
}

export function addAssets(p: Project, assets: AssetRecord[]): Project {
  return touch({ ...p, assets: [...p.assets, ...assets] });
}

/**
 * 差替え：assetIdと役割参照は維持。元ファイル名・バイト・ハッシュは新しいものへ。
 * 事実（検査結果）は破棄して再計算させる。
 */
export function replaceAsset(p: Project, assetId: string, next: Pick<AssetRecord, 'originalName' | 'blob' | 'size' | 'sha256' | 'sourcePath'>): Project {
  const facts = { ...p.facts };
  delete facts[assetId];
  return touch({
    ...p,
    facts,
    assets: p.assets.map((a) =>
      a.id === assetId
        ? { ...a, ...next, version: a.version + 1, replacedNames: [...(a.replacedNames ?? []), a.originalName] }
        : a,
    ),
  });
}

export function removeAsset(p: Project, assetId: string): Project {
  const facts = { ...p.facts };
  delete facts[assetId];
  return touch({
    ...p,
    facts,
    assets: p.assets.filter((a) => a.id !== assetId),
    refs: normalizeOrders(p.refs.filter((r) => r.assetId !== assetId)),
  });
}
