// アプリ状態と操作。業務判定は core/ の純粋関数に任せる。
import { useEffect, useState } from 'preact/hooks';
import type { AssetFacts, AssetRecord, BundleTemplate, CheckTemplate, Project, ProjectTarget } from '../core/types';
import { APP_LIMITS, factsValid } from '../core/facts';
import { sha256Hex } from '../core/hash';
import { detectContainer, extFormat, IMAGE_LIKE_EXTS } from '../core/sniff';
import { buildZip, readZip, ZipAbortError } from '../core/zip';
import {
  addAssets,
  addRef,
  changeRefRole,
  clearSuggestions,
  confirmSuggestions,
  makeId,
  moveRef,
  newProject,
  removeAsset,
  removeRef,
  replaceAsset,
  setNameOverride,
  suggestRoles,
} from '../core/project';
import { asciiFileName, evaluateProject, exportFileName, exportGate, resolveScopes, type Evaluation, type ExportMode } from '../core/rules';
import { BUILTIN_BUNDLES, BUILTIN_CHECK_TEMPLATES, isBuiltin } from '../core/templates';
import { buildBackup, backupFileName, restoreBackup } from '../core/backup';
import * as db from './db';
import { analyzeAsset, makeThumbnail } from './imaging';

export type Tab = 'edit' | 'check' | 'pack';

export interface Job {
  kind: 'import' | 'check' | 'pack' | 'backup' | 'restore';
  label: string;
  done: number;
  total: number;
  detail?: string;
  controller: AbortController;
}

export interface Note {
  name: string;
  reason: string;
}

export interface PackResult {
  scopeId: string;
  mode: ExportMode;
  fileName: string;
  url: string;
  bytes: number;
  expectedBytes: number;
  fileCount: number;
  verified: { ok: boolean; problems: string[] };
  createdAt: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface AppState {
  ready: boolean;
  project: Project;
  userTemplates: CheckTemplate[];
  userBundles: BundleTemplate[];
  thumbs: Record<string, { url: string | null; version: number }>;
  lastBackup: { url: string; name: string; bytes: number } | null;
  tab: Tab;
  selectedAssetId: string | null;
  filter: 'all' | 'attention';
  job: Job | null;
  importNotes: Note[];
  toasts: Toast[];
  dirty: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  templateManager: { open: boolean; selectedId: string | null };
  packResults: Record<string, PackResult>;
  packErrors: Record<string, { mode: ExportMode; message: string }>;
  acks: Record<string, boolean>;
  persistence: boolean | null;
  previewBg: 'checker' | 'white' | 'black';
}

let state: AppState = {
  ready: false,
  project: newProject(),
  userTemplates: [],
  userBundles: [],
  thumbs: {},
  tab: 'check',
  selectedAssetId: null,
  filter: 'all',
  job: null,
  importNotes: [],
  toasts: [],
  dirty: false,
  lastSavedAt: null,
  saveError: null,
  templateManager: { open: false, selectedId: null },
  packResults: {},
  packErrors: {},
  acks: {},
  persistence: null,
  previewBg: 'checker',
  lastBackup: null,
};

const listeners = new Set<() => void>();
let evalCache: { key: unknown[]; value: Evaluation } | null = null;

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useApp(): AppState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

export function templatesMap(s: AppState = state): Map<string, CheckTemplate> {
  return new Map([...BUILTIN_CHECK_TEMPLATES, ...s.userTemplates].map((t) => [t.id, t]));
}
export function bundlesMap(s: AppState = state): Map<string, BundleTemplate> {
  return new Map([...BUILTIN_BUNDLES, ...s.userBundles].map((t) => [t.id, t]));
}

export function evaluation(s: AppState = state): Evaluation {
  const key = [s.project, s.userTemplates, s.userBundles];
  if (evalCache && evalCache.key.every((k, i) => k === key[i])) return evalCache.value;
  const value = evaluateProject(s.project, templatesMap(s), bundlesMap(s));
  evalCache = { key, value };
  return value;
}

function updateProject(fn: (p: Project) => Project) {
  setState((s) => {
    const next = fn(s.project);
    return next === s.project ? {} : { project: next, dirty: true };
  });
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-3) }));
  if (kind !== 'error') setTimeout(() => dismissToast(id), 5000);
}
export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------------------------------------------------------------- ダウンロード（Blob URLはすぐにrevokeしない）

const heldUrls = new Map<string, string>();
export function holdUrl(key: string, blob: Blob): string {
  const prev = heldUrls.get(key);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  heldUrls.set(key, url);
  return url;
}

export function triggerDownload(url: string, fileName: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => heldUrls.forEach((u) => URL.revokeObjectURL(u)));
}

// ---------------------------------------------------------------- 起動

export async function init() {
  const patch: Partial<AppState> = { ready: true };
  try {
    const [tpls, bundles, last] = await Promise.all([db.loadCheckTemplates(), db.loadBundleTemplates(), db.loadLastProject()]);
    patch.userTemplates = tpls.filter((t) => !isBuiltin(t.id));
    patch.userBundles = bundles.filter((t) => !isBuiltin(t.id));
    if (last) {
      patch.project = last;
      patch.lastSavedAt = last.updatedAt;
    }
  } catch (e) {
    patch.saveError = `端末内の保存データを読み込めませんでした: ${(e as Error).message}`;
  }
  setState(patch);
  db.requestPersistence().then((v) => setState({ persistence: v }));
  refreshThumbnails();
}

// ---------------------------------------------------------------- サムネイル（逐次・縮小）

let thumbRunning = false;
async function refreshThumbnails() {
  if (thumbRunning) return;
  thumbRunning = true;
  try {
    for (;;) {
      const s = state;
      const next = s.project.assets.find((a) => s.thumbs[a.id]?.version !== a.version);
      if (!next) break;
      const blob = await makeThumbnail(next);
      const stillThere = state.project.assets.some((a) => a.id === next.id);
      setState((st) => {
        const prev = st.thumbs[next.id];
        if (prev?.url) URL.revokeObjectURL(prev.url);
        const thumbs = { ...st.thumbs };
        if (!stillThere) delete thumbs[next.id];
        else thumbs[next.id] = { url: blob ? URL.createObjectURL(blob) : null, version: next.version };
        return { thumbs };
      });
    }
  } finally {
    thumbRunning = false;
  }
}

function dropThumb(assetId: string) {
  setState((s) => {
    const prev = s.thumbs[assetId];
    if (prev?.url) URL.revokeObjectURL(prev.url);
    const thumbs = { ...s.thumbs };
    delete thumbs[assetId];
    return { thumbs };
  });
}

// ---------------------------------------------------------------- 取込

function isZipName(name: string) {
  return /\.zip$/i.test(name);
}

async function makeAsset(name: string, sourcePath: string, data: Uint8Array, type: string): Promise<AssetRecord> {
  return {
    id: makeId('ast'),
    originalName: name,
    sourcePath,
    blob: new Blob([data as BlobPart], { type }),
    size: data.length,
    sha256: await sha256Hex(data),
    version: 1,
    addedAt: new Date().toISOString(),
  };
}

function looksLikeImage(name: string, data: Uint8Array): boolean {
  const c = detectContainer(data.subarray(0, 64));
  if (c !== 'unknown' && c !== 'zip' && c !== 'pdf') return true;
  const ext = extFormat(name);
  return !!ext && IMAGE_LIKE_EXTS.has(ext);
}

function startJob(kind: Job['kind'], label: string, total: number): Job {
  const job: Job = { kind, label, done: 0, total, controller: new AbortController() };
  setState({ job });
  return job;
}
function progress(job: Job, done: number, total = job.total, detail?: string) {
  if (state.job?.controller !== job.controller) return;
  setState({ job: { ...job, done, total, detail } });
}
function endJob(job: Job) {
  if (state.job?.controller === job.controller) setState({ job: null });
}
export function abortJob() {
  state.job?.controller.abort();
}

export async function importFiles(files: File[]) {
  if (!files.length || state.job) return;
  const job = startJob('import', '読み込み中', files.length);
  const notes: Note[] = [];
  const added: AssetRecord[] = [];
  try {
    let i = 0;
    for (const file of files) {
      if (job.controller.signal.aborted) throw new ZipAbortError();
      progress(job, i, files.length, file.name);
      try {
        const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
        if (isZipName(file.name) || detectContainer(head) === 'zip') {
          const buf = new Uint8Array(await file.arrayBuffer());
          const r = await readZip(buf, { maxEntries: APP_LIMITS.zipMaxEntries, maxTotalBytes: APP_LIMITS.zipMaxTotalBytes }, {
            signal: job.controller.signal,
            skipExtensions: ['.zip'],
            onProgress: (d, t) => progress(job, i, files.length, `${file.name}（${d}/${t}）`),
          });
          for (const s of r.skipped) notes.push({ name: `${file.name} › ${s.path}`, reason: s.reason });
          for (const f of r.files) {
            if (detectContainer(f.data.subarray(0, 8)) === 'zip') {
              notes.push({ name: `${file.name} › ${f.path}`, reason: 'ZIPの中のZIPは展開しません' });
              continue;
            }
            if (!looksLikeImage(f.name, f.data)) {
              notes.push({ name: `${file.name} › ${f.path}`, reason: '画像ではないため取り込みません' });
              continue;
            }
            added.push(await makeAsset(f.name, `${file.name}/${f.path}`, f.data, ''));
          }
        } else {
          const data = new Uint8Array(await file.arrayBuffer());
          if (!looksLikeImage(file.name, data)) {
            notes.push({ name: file.name, reason: '画像でもZIPでもないため取り込みません' });
          } else {
            added.push(await makeAsset(file.name, file.name, data, file.type));
          }
        }
      } catch (e) {
        if (e instanceof ZipAbortError) throw e;
        notes.push({ name: file.name, reason: (e as Error).message });
      }
      i++;
    }
  } catch (e) {
    if (e instanceof ZipAbortError) {
      toast('読み込みを中止しました。追加された画像はありません。');
      endJob(job);
      setState({ importNotes: notes });
      return;
    }
    throw e;
  } finally {
    endJob(job);
  }
  if (added.length) {
    updateProject((p) => addAssets(p, added));
    const { scopes } = resolveScopes(state.project.target, templatesMap(), bundlesMap(), state.project.settings.stickerCounts);
    const { project, added: n } = suggestRoles(state.project, scopes, added.map((a) => a.id));
    if (n) updateProject(() => project);
    toast(`${added.length}件を追加しました${n ? `。ファイル名から${n}件の役割候補を付けました（確定してください）` : ''}`, 'success');
  }
  setState({ importNotes: notes });
  if (!added.length && notes.length) toast('取り込める画像がありませんでした。下の一覧で理由を確認してください。', 'error');
  refreshThumbnails();
}

// ---------------------------------------------------------------- 検査

export async function runCheck(onlyIds?: string[]) {
  if (state.job) return;
  const th = state.project.settings.alphaThreshold;
  const todo = state.project.assets.filter(
    (a) => (!onlyIds || onlyIds.includes(a.id)) && !factsValid(state.project.facts[a.id], a.sha256, th),
  );
  if (!todo.length) {
    toast('検査済みです（未検査の画像はありません）');
    return;
  }
  const job = startJob('check', '検査中', todo.length);
  let done = 0;
  try {
    for (const a of todo) {
      if (job.controller.signal.aborted) break;
      progress(job, done, todo.length, a.originalName);
      let facts: AssetFacts;
      try {
        facts = await analyzeAsset(a, th);
      } catch (e) {
        facts = {
          sha256: a.sha256,
          alphaThreshold: th,
          analyzedAt: new Date().toISOString(),
          bytes: a.size,
          container: 'unknown',
          extFormat: extFormat(a.originalName),
          hasAlphaChannel: false,
          dpi: { status: 'unknown', reason: '検査できませんでした' },
          decode: { ok: false, reason: (e as Error).message },
        };
      }
      // 検査中に差替え・削除された場合は結果を捨てる
      const cur = state.project.assets.find((x) => x.id === a.id);
      if (cur && cur.sha256 === a.sha256) {
        updateProject((p) => ({ ...p, facts: { ...p.facts, [a.id]: facts } }));
      }
      done++;
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    endJob(job);
  }
  if (job.controller.signal.aborted) toast(`検査を中止しました（${done}/${todo.length}枚は検査済み）`);
}

// ---------------------------------------------------------------- 素材の操作

export function selectAsset(id: string | null) {
  setState({ selectedAssetId: id });
}

export async function replaceAssetFile(assetId: string, file: File) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (detectContainer(data.subarray(0, 8)) === 'zip') {
    toast('差替えには画像ファイルを選んでください（ZIPは不可）', 'error');
    return;
  }
  const sha = await sha256Hex(data);
  updateProject((p) =>
    replaceAsset(p, assetId, { originalName: file.name, blob: new Blob([data as BlobPart], { type: file.type }), size: data.length, sha256: sha, sourcePath: file.name }),
  );
  toast(`差し替えました：${file.name}。再検査します。`, 'success');
  refreshThumbnails();
  await runCheck([assetId]);
}

export function deleteAsset(assetId: string) {
  updateProject((p) => removeAsset(p, assetId));
  dropThumb(assetId);
  if (state.selectedAssetId === assetId) setState({ selectedAssetId: null });
}

export function exportOriginal(assetId: string) {
  const a = state.project.assets.find((x) => x.id === assetId);
  if (!a) return;
  const url = holdUrl(`original:${assetId}`, a.blob);
  triggerDownload(url, asciiFileName(a.originalName, `original-${a.sha256.slice(0, 8)}.bin`));
}

export const roleOps = {
  add: (assetId: string, templateId: string, roleId: string) => updateProject((p) => addRef(p, assetId, templateId, roleId)),
  remove: (refId: string) => updateProject((p) => removeRef(p, refId)),
  change: (refId: string, templateId: string, roleId: string) => updateProject((p) => changeRefRole(p, refId, templateId, roleId)),
  move: (refId: string, d: -1 | 1) => updateProject((p) => moveRef(p, refId, d)),
  rename: (refId: string, name: string | undefined) => updateProject((p) => setNameOverride(p, refId, name)),
  confirmAll: () => updateProject(confirmSuggestions),
  clearSuggested: () => updateProject(clearSuggestions),
  suggest: () => {
    const { scopes } = resolveScopes(state.project.target, templatesMap(), bundlesMap(), state.project.settings.stickerCounts);
    const { project, added } = suggestRoles(state.project, scopes);
    updateProject(() => project);
    toast(added ? `${added}件の役割候補を付けました。確認して確定してください。` : '名前から推定できる候補はありませんでした');
  },
};

export function setTarget(target: ProjectTarget) {
  updateProject((p) => ({ ...p, target, updatedAt: new Date().toISOString() }));
  setState({ packResults: {}, packErrors: {}, acks: {} });
}
export function setStickerCount(templateId: string, n: number) {
  updateProject((p) => ({ ...p, settings: { ...p.settings, stickerCounts: { ...p.settings.stickerCounts, [templateId]: n } } }));
}
export function setAlphaThreshold(n: number) {
  updateProject((p) => ({ ...p, settings: { ...p.settings, alphaThreshold: n } }));
}
export function renameProject(name: string) {
  updateProject((p) => ({ ...p, name: name.slice(0, 80) }));
}

export function newEmptyProject() {
  Object.values(state.thumbs).forEach((t) => t.url && URL.revokeObjectURL(t.url));
  setState({
    project: newProject(state.project.target),
    thumbs: {},
    selectedAssetId: null,
    importNotes: [],
    packResults: {},
    packErrors: {},
    acks: {},
    dirty: false,
  });
}

// ---------------------------------------------------------------- 端末内保存

export async function saveNow(): Promise<boolean> {
  try {
    await db.saveProject(state.project);
    setState({ dirty: false, lastSavedAt: new Date().toISOString(), saveError: null });
    toast('この端末に保存しました', 'success');
    return true;
  } catch (e) {
    const msg = `端末内に保存できませんでした: ${(e as Error).message || e}。バックアップZIPの保存を検討してください。`;
    setState({ saveError: msg });
    toast(msg, 'error');
    return false;
  }
}

// ---------------------------------------------------------------- 梱包

export async function pack(scopeId: string, mode: ExportMode) {
  if (state.job) return;
  const ev = evaluation();
  const s = ev.scopes.find((x) => x.scope.id === scopeId);
  if (!s) return;
  const gate = exportGate(s, mode);
  if (!gate.allowed) {
    toast(gate.blockers.join(' / '), 'error');
    return;
  }
  if (gate.needsAck && !state.acks[scopeId]) {
    toast('要確認の内容を確認したら、チェックを入れてください', 'error');
    return;
  }
  const fileName = exportFileName(s, mode, gate);
  const assets = new Map(state.project.assets.map((a) => [a.id, a]));
  const job = startJob('pack', `${fileName} を作成中`, s.entries.length);
  setState((st) => {
    const errs = { ...st.packErrors };
    delete errs[scopeId];
    return { packErrors: errs };
  });
  try {
    let n = 0;
    const blob = await buildZip(
      s.entries.map((e) => ({
        path: e.path,
        size: e.size,
        read: async () => {
          const a = assets.get(e.assetId)!;
          const data = new Uint8Array(await a.blob.arrayBuffer());
          // 元ファイルが取込時から変わっていないこと
          if ((await sha256Hex(data)) !== e.sha256) throw new Error(`${a.originalName} の内容が取込時と一致しません`);
          return data;
        },
      })),
      { signal: job.controller.signal, onProgress: (_d, _t, path) => progress(job, ++n, s.entries.length, path) },
    );
    // 書出し後の検証：再展開してSHA-256一致・余計なファイルなし
    progress(job, s.entries.length, s.entries.length, '検証中');
    const problems: string[] = [];
    if (blob.size !== s.zipBytes) problems.push(`サイズが事前計算と違います（${blob.size} / ${s.zipBytes}）`);
    const back = await readZip(new Uint8Array(await blob.arrayBuffer()), { maxEntries: 100000, maxTotalBytes: Number.MAX_SAFE_INTEGER }, { signal: job.controller.signal });
    if (back.files.length !== s.entries.length) problems.push(`ファイル数が違います（${back.files.length} / ${s.entries.length}）`);
    for (const e of s.entries) {
      const f = back.files.find((x) => x.path === e.path);
      if (!f) problems.push(`${e.path} がZIPにありません`);
      else if ((await sha256Hex(f.data)) !== e.sha256) problems.push(`${e.path} のSHA-256が元画像と一致しません`);
    }
    const max = s.scope.template.maxArchiveBytes;
    if (mode === 'upload' && max !== null && blob.size > max) problems.push(`完成ZIPが上限${max.toLocaleString()} bytesを超えました`);
    if (problems.length) throw new Error(`検証に失敗したため保存を止めました：${problems.join(' / ')}`);
    const url = holdUrl(`pack:${scopeId}`, blob);
    const result: PackResult = {
      scopeId,
      mode,
      fileName,
      url,
      bytes: blob.size,
      expectedBytes: s.zipBytes,
      fileCount: back.files.length,
      verified: { ok: true, problems },
      createdAt: new Date().toISOString(),
    };
    setState((st) => ({ packResults: { ...st.packResults, [scopeId]: result } }));
    triggerDownload(url, fileName);
  } catch (e) {
    const message = e instanceof ZipAbortError ? '中止しました' : (e as Error).message;
    setState((st) => ({ packErrors: { ...st.packErrors, [scopeId]: { mode, message } } }));
  } finally {
    endJob(job);
  }
}

// ---------------------------------------------------------------- バックアップ

export async function saveBackup() {
  if (state.job) return;
  const job = startJob('backup', 'バックアップZIPを作成中', state.project.assets.length + 1);
  try {
    let n = 0;
    const blob = await buildBackup(state.project, state.userTemplates, state.userBundles, {
      signal: job.controller.signal,
      onProgress: () => progress(job, ++n),
    });
    const name = backupFileName(state.project);
    const url = holdUrl('backup', blob);
    triggerDownload(url, name);
    setState({ lastBackup: { url, name, bytes: blob.size } });
    toast(`バックアップZIPを作成しました：${name}`, 'success');
  } catch (e) {
    toast(e instanceof ZipAbortError ? 'バックアップを中止しました' : `バックアップに失敗しました: ${(e as Error).message}`, 'error');
  } finally {
    endJob(job);
  }
}

export async function restoreFromBackup(file: File) {
  if (state.job) return;
  const job = startJob('restore', 'バックアップを復元中', 1);
  try {
    const r = await restoreBackup(new Uint8Array(await file.arrayBuffer()), job.controller.signal);
    const userTemplates = [...state.userTemplates];
    for (const t of r.checkTemplates) {
      if (isBuiltin(t.id)) continue;
      const i = userTemplates.findIndex((x) => x.id === t.id);
      if (i >= 0) userTemplates[i] = t;
      else userTemplates.push(t);
      await db.putCheckTemplate(t);
    }
    const userBundles = [...state.userBundles];
    for (const t of r.bundleTemplates) {
      if (isBuiltin(t.id)) continue;
      const i = userBundles.findIndex((x) => x.id === t.id);
      if (i >= 0) userBundles[i] = t;
      else userBundles.push(t);
      await db.putBundleTemplate(t);
    }
    Object.values(state.thumbs).forEach((t) => t.url && URL.revokeObjectURL(t.url));
    setState({
      project: r.project,
      userTemplates,
      userBundles,
      thumbs: {},
      selectedAssetId: null,
      packResults: {},
      packErrors: {},
      acks: {},
      dirty: true,
      importNotes: r.warnings.map((w) => ({ name: 'バックアップ', reason: w })),
    });
    toast(`バックアップを復元しました（画像${r.project.assets.length}件）${r.warnings.length ? `。注意${r.warnings.length}件` : ''}`, r.warnings.length ? 'error' : 'success');
    refreshThumbnails();
  } catch (e) {
    toast(e instanceof ZipAbortError ? '復元を中止しました' : `復元できませんでした: ${(e as Error).message}`, 'error');
  } finally {
    endJob(job);
  }
}

// ---------------------------------------------------------------- テンプレート保存

export async function saveUserTemplate(t: CheckTemplate): Promise<boolean> {
  if (isBuiltin(t.id)) {
    toast('標準テンプレートは上書きできません。複製してから編集してください。', 'error');
    return false;
  }
  try {
    await db.putCheckTemplate(t);
  } catch (e) {
    toast(`テンプレートを保存できませんでした: ${(e as Error).message}`, 'error');
    return false;
  }
  setState((s) => {
    const list = s.userTemplates.some((x) => x.id === t.id) ? s.userTemplates.map((x) => (x.id === t.id ? t : x)) : [...s.userTemplates, t];
    return { userTemplates: list };
  });
  return true;
}

export async function removeUserTemplate(id: string): Promise<void> {
  try {
    await db.deleteCheckTemplate(id);
    setState((s) => ({ userTemplates: s.userTemplates.filter((x) => x.id !== id) }));
  } catch (e) {
    toast(`削除できませんでした: ${(e as Error).message}`, 'error');
  }
}

export async function saveUserBundle(t: BundleTemplate): Promise<boolean> {
  if (isBuiltin(t.id)) {
    toast('標準の組合せセットは上書きできません。複製してから編集してください。', 'error');
    return false;
  }
  try {
    await db.putBundleTemplate(t);
  } catch (e) {
    toast(`組合せセットを保存できませんでした: ${(e as Error).message}`, 'error');
    return false;
  }
  setState((s) => {
    const list = s.userBundles.some((x) => x.id === t.id) ? s.userBundles.map((x) => (x.id === t.id ? t : x)) : [...s.userBundles, t];
    return { userBundles: list };
  });
  return true;
}

export async function removeUserBundle(id: string): Promise<void> {
  try {
    await db.deleteBundleTemplate(id);
    setState((s) => ({ userBundles: s.userBundles.filter((x) => x.id !== id) }));
  } catch (e) {
    toast(`削除できませんでした: ${(e as Error).message}`, 'error');
  }
}

export function downloadText(text: string, fileName: string, key: string) {
  const url = holdUrl(key, new Blob([text], { type: 'application/json' }));
  triggerDownload(url, fileName);
}
