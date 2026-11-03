// プロジェクトバックアップZIP（投稿用ZIPとは別の種類・別の名前）
import type { AssetRecord, BundleTemplate, CheckTemplate, Project } from './types';
import { buildZip, readZip, ZipError, type BuildZipOptions } from './zip';
import { validateBundleTemplate, validateCheckTemplate } from './templates';
import { sha256Hex } from './hash';

export const BACKUP_MANIFEST = 'konpoh-backup.json';
export const BACKUP_KIND = 'konpoh-project-backup';

export interface BackupManifest {
  schemaVersion: 1;
  kind: typeof BACKUP_KIND;
  createdAt: string;
  project: Omit<Project, 'assets'> & {
    assets: { id: string; originalName: string; sourcePath: string; size: number; sha256: string; version: number; addedAt: string; replacedNames?: string[]; derivedFrom?: AssetRecord['derivedFrom']; file: string; type: string }[];
  };
  checkTemplates: CheckTemplate[];
  bundleTemplates: BundleTemplate[];
}

function safeSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

export function backupFileName(_p: Project, d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  // ASCII名（日本語のdownload名を捨てるブラウザがあるため）。投稿用ZIPと区別できる接頭辞
  return `BACKUP_konpoh_${stamp}.zip`;
}

export async function buildBackup(
  p: Project,
  checkTemplates: CheckTemplate[],
  bundleTemplates: BundleTemplate[],
  opts: BuildZipOptions = {},
): Promise<Blob> {
  const assets = p.assets.map((a) => ({
    id: a.id,
    originalName: a.originalName,
    sourcePath: a.sourcePath,
    size: a.size,
    sha256: a.sha256,
    version: a.version,
    addedAt: a.addedAt,
    replacedNames: a.replacedNames,
    derivedFrom: a.derivedFrom,
    file: `files/${a.id}/${safeSegment(a.originalName)}`,
    type: a.blob.type,
  }));
  const manifest: BackupManifest = {
    schemaVersion: 1,
    kind: BACKUP_KIND,
    createdAt: new Date().toISOString(),
    project: { ...p, assets },
    checkTemplates,
    bundleTemplates,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return buildZip(
    [
      { path: BACKUP_MANIFEST, size: json.length, read: async () => json },
      ...p.assets.map((a, i) => ({
        path: assets[i].file,
        size: a.size,
        read: async () => new Uint8Array(await a.blob.arrayBuffer()),
      })),
    ],
    opts,
  );
}

export interface RestoredBackup {
  project: Project;
  checkTemplates: CheckTemplate[];
  bundleTemplates: BundleTemplate[];
  warnings: string[];
}

export async function restoreBackup(bytes: Uint8Array, signal?: AbortSignal): Promise<RestoredBackup> {
  const zip = await readZip(bytes, { maxEntries: 2000, maxTotalBytes: 1_000_000_000 }, { signal });
  const mf = zip.files.find((f) => f.path === BACKUP_MANIFEST);
  if (!mf) throw new ZipError('バックアップZIPではありません（konpoh-backup.json がありません）。投稿用ZIPは「ZIPを読み込む」から読み込んでください。');
  let m: BackupManifest;
  try {
    m = JSON.parse(new TextDecoder().decode(mf.data));
  } catch {
    throw new ZipError('バックアップの目録JSONが読めません');
  }
  if (m.kind !== BACKUP_KIND) throw new ZipError('バックアップの種類が違います');
  if (m.schemaVersion !== 1) throw new ZipError(`バックアップの schemaVersion ${JSON.stringify(m.schemaVersion)} は未対応です`);
  const warnings: string[] = [];
  const files = new Map(zip.files.map((f) => [f.path, f]));
  const assets = [];
  for (const a of m.project.assets) {
    const f = files.get(a.file);
    if (!f) {
      warnings.push(`${a.originalName}: ファイルがバックアップ内にありません`);
      continue;
    }
    const sha = await sha256Hex(f.data);
    if (sha !== a.sha256) {
      warnings.push(`${a.originalName}: SHA-256が一致しないため復元しませんでした`);
      continue;
    }
    assets.push({
      id: a.id,
      originalName: a.originalName,
      sourcePath: a.sourcePath,
      size: f.data.length,
      sha256: sha,
      version: a.version,
      addedAt: a.addedAt,
      replacedNames: a.replacedNames,
      derivedFrom: a.derivedFrom,
      blob: new Blob([f.data as BlobPart], { type: a.type || 'application/octet-stream' }),
    });
  }
  const ids = new Set(assets.map((a) => a.id));
  const checkTemplates = (m.checkTemplates ?? []).filter((t) => {
    const e = validateCheckTemplate(t);
    if (e.length) warnings.push(`テンプレート「${t?.name ?? '?'}」を復元できません: ${e[0]}`);
    return !e.length;
  });
  const bundleTemplates = (m.bundleTemplates ?? []).filter((t) => {
    const e = validateBundleTemplate(t);
    if (e.length) warnings.push(`組合せセット「${t?.name ?? '?'}」を復元できません: ${e[0]}`);
    return !e.length;
  });
  for (const s of zip.skipped) warnings.push(`${s.path}: ${s.reason}`);
  const project: Project = {
    ...m.project,
    assets,
    refs: (m.project.refs ?? []).filter((r) => ids.has(r.assetId)),
    facts: Object.fromEntries(Object.entries(m.project.facts ?? {}).filter(([id]) => ids.has(id))),
  };
  return { project, checkTemplates, bundleTemplates, warnings };
}
