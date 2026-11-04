// アプリ状態と操作。業務判定は core/ の純粋関数に任せる。
import { useEffect, useState } from 'preact/hooks';
import type { AssetFacts, AssetRecord, CheckTemplate, Project } from '../core/types';
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
import { LINE_TEMPLATE, LINE_TEMPLATE_ID } from '../core/templates';
import { buildBackup, backupFileName, restoreBackup } from '../core/backup';
import * as db from './db';
import { analyzeAsset, makeThumbnail } from './imaging';
import { imageDims, isLikelySheet, type Dims } from '../core/sheet';
import { newTrialData, normalizeTrialData, type TrialData } from '../core/trial';

export type Tab = 'edit' | 'check' | 'trial' | 'pack';
export type EditTool = 'split' | 'background';

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
  blob: Blob;
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
  thumbs: Record<string, { url: string | null; version: number }>;
  lastBackup: { blob: Blob; name: string; bytes: number } | null;
  confirm: ConfirmRequest | null;
  edit: { assetId: string | null; tool: EditTool };
  /** 各画像の寸法（ヘッダーから。一覧画像の案内に使う） */
  dims: Record<string, Dims | null>;
  /** 試し送り（会話・メモ・お題・表示設定）。プロジェクトとは別に保存する */
  trial: TrialData;
  /** 試し送りで読み込んだ画像のBlob（idごと） */
  trialBlobs: Record<string, Blob>;
  trialSave: { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string; at?: string };
  /** 画像追加で編集タブへ切り替えたときの案内 */
  editHint: { names: string[] } | null;
  tab: Tab;
  selectedAssetId: string | null;
  filter: 'all' | 'attention';
  job: Job | null;
  importNotes: Note[];
  toasts: Toast[];
  dirty: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  packResults: Record<string, PackResult>;
  packErrors: Record<string, { mode: ExportMode; message: string }>;
  acks: Record<string, boolean>;
  persistence: boolean | null;
  previewBg: 'checker' | 'white' | 'black';
}

let state: AppState = {
  ready: false,
  project: newProject(),
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
  packResults: {},
  packErrors: {},
  acks: {},
  persistence: null,
  previewBg: 'checker',
  lastBackup: null,
  confirm: null,
  edit: { assetId: null, tool: 'split' },
  dims: {},
  editHint: null,
  trial: newTrialData(),
  trialBlobs: {},
  trialSave: { status: 'idle' },
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

const TEMPLATES = new Map<string, CheckTemplate>([[LINE_TEMPLATE_ID, LINE_TEMPLATE]]);

export function templatesMap(): Map<string, CheckTemplate> {
  return TEMPLATES;
}

/** 以前の版で保存した作品（BOOTH・組合せセットを選んでいたもの）はLINE通常静止画に戻す */
function normalizeProject(p: Project): Project {
  return p.target?.kind === 'template' && p.target.templateId === LINE_TEMPLATE_ID ? p : { ...p, target: { kind: 'template', templateId: LINE_TEMPLATE_ID } };
}

export function evaluation(s: AppState = state): Evaluation {
  const key = [s.project];
  if (evalCache && evalCache.key.every((k, i) => k === key[i])) return evalCache.value;
  const value = evaluateProject(s.project, TEMPLATES);
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

// ---------------------------------------------------------------- 保存（ファイルを端末へ渡す）
// claude.ai上では埋め込みページのダウンロードリンクが動かないため、プラットフォームの保存機能を使う。
// 単独で配信した場合（開発・自前ホスティング）は通常のダウンロードにする。Blob URLはすぐにrevokeしない。

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}
let downloadsApi: Promise<DownloadsApi | null> | null = null;
function getDownloads(): Promise<DownloadsApi | null> {
  if (!downloadsApi) {
    const c = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
    downloadsApi = c?.use ? (c.use('downloads') as Promise<DownloadsApi | null>).catch(() => null) : Promise.resolve(null);
  }
  return downloadsApi;
}

const heldUrls = new Map<string, string>();
function holdUrl(key: string, blob: Blob): string {
  const prev = heldUrls.get(key);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  heldUrls.set(key, url);
  return url;
}

const SAVE_ERRORS: Record<string, string> = {
  declined: '保存をキャンセルしました',
  rejected_extension: 'この種類のファイルはここから保存できません',
  extension_not_enabled: 'この種類のファイルはここから保存できません',
  rate_limited: '保存の確認画面が開いています。閉じてからもう一度押してください',
  too_large: 'ファイルが大きすぎて保存できません',
};

/** ファイルを保存する。成功（または保存画面へ渡せた）なら true */
export async function saveFile(blob: Blob, fileName: string, key: string): Promise<boolean> {
  const api = await getDownloads();
  if (api) {
    try {
      await api.save({ filename: fileName, data: blob });
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? 'unavailable';
      toast(`${fileName}：${SAVE_ERRORS[code] ?? '保存できませんでした（この表示では保存機能が使えません）'}`, code === 'declined' ? 'info' : 'error');
      return false;
    }
  }
  // claude.ai の中で保存機能が使えない表示（共有先の環境など）では、通常のダウンロードも動かないので理由を伝える
  const inViewer = !!(window as unknown as { claude?: { use?: unknown } }).claude?.use;
  if (inViewer) {
    toast(`${fileName}：この表示ではファイルを保存できません。claude.aiにサインインして開き直すか、作品の持ち主に保存を頼んでください。`, 'error');
    return false;
  }
  const url = holdUrl(key, blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => heldUrls.forEach((u) => URL.revokeObjectURL(u)));
}

// ---------------------------------------------------------------- 画面内の確認（confirm()は使わない）

export interface ConfirmRequest {
  message: string;
  okLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export function askConfirm(message: string, okLabel = 'はい', danger = false): Promise<boolean> {
  state.confirm?.resolve(false);
  return new Promise((resolve) => setState({ confirm: { message, okLabel, danger, resolve } }));
}
export function answerConfirm(ok: boolean) {
  const c = state.confirm;
  setState({ confirm: null });
  c?.resolve(ok);
}

// ---------------------------------------------------------------- 起動

export async function init() {
  const patch: Partial<AppState> = { ready: true };
  try {
    const last = await db.loadLastProject();
    if (last) {
      patch.project = normalizeProject(last);
      patch.lastSavedAt = last.updatedAt;
    }
  } catch (e) {
    patch.saveError = `端末内の保存データを読み込めませんでした: ${(e as Error).message}`;
  }
  try {
    const t = await db.loadTrial();
    patch.trial = normalizeTrialData(t.data ?? null);
    patch.trialBlobs = t.images;
    // 本体が見つからない試し送りの画像は一覧から外す（壊れた参照を残さない）
    patch.trial = { ...patch.trial, localImages: patch.trial.localImages.filter((m) => t.images[m.id]) };
  } catch (e) {
    patch.trialSave = { status: 'error', message: `試し送りの保存データを読み込めませんでした: ${(e as Error).message}` };
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
      const { blob, dims } = await makeThumbnail(next);
      const stillThere = state.project.assets.some((a) => a.id === next.id);
      setState((st) => ({ dims: { ...st.dims, [next.id]: dims } }));
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
    const { scopes } = resolveScopes(state.project.target, TEMPLATES, state.project.settings.stickerCounts);
    const { project, added: n } = suggestRoles(state.project, scopes, added.map((a) => a.id));
    if (n) updateProject(() => project);
    // 一覧画像らしい大きい画像（スタンプ上限の1.5倍超）があれば、分割できる編集タブへ案内する
    const dims: Record<string, Dims | null> = {};
    for (const a of added) dims[a.id] = imageDims(new Uint8Array(await a.blob.slice(0, 262144).arrayBuffer())) ?? imageDims(new Uint8Array(await a.blob.arrayBuffer()));
    setState((st) => ({ dims: { ...st.dims, ...dims } }));
    const big = added.filter((a) => isLikelySheet(dims[a.id], LINE_TEMPLATE));
    if (big.length) {
      setState({ tab: 'edit', edit: { assetId: big[0].id, tool: 'split' }, editHint: { names: big.map((a) => a.originalName) }, selectedAssetId: null });
      scrollTop();
      toast(`${added.length}件を追加しました。一覧画像のような大きい画像があるので、分割できる編集タブを開きました。`, 'success');
    } else {
      toast(`${added.length}件を追加しました${n ? `。ファイル名から${n}件の役割候補を付けました（確定してください）` : ''}`, 'success');
    }
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
  saveFile(a.blob, asciiFileName(a.originalName, `original-${a.sha256.slice(0, 8)}.bin`), `original:${assetId}`);
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
    const { scopes } = resolveScopes(state.project.target, TEMPLATES, state.project.settings.stickerCounts);
    const { project, added } = suggestRoles(state.project, scopes);
    updateProject(() => project);
    toast(added ? `${added}件の役割候補を付けました。確認して確定してください。` : '名前から推定できる候補はありませんでした');
  },
};

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
    const result: PackResult = {
      scopeId,
      mode,
      fileName,
      blob,
      bytes: blob.size,
      expectedBytes: s.zipBytes,
      fileCount: back.files.length,
      verified: { ok: true, problems },
      createdAt: new Date().toISOString(),
    };
    setState((st) => ({ packResults: { ...st.packResults, [scopeId]: result } }));
    endJob(job);
    await saveFile(blob, fileName, `pack:${scopeId}`);
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
    const blob = await buildBackup(state.project, {
      signal: job.controller.signal,
      onProgress: () => progress(job, ++n),
    });
    const name = backupFileName(state.project);
    setState({ lastBackup: { blob, name, bytes: blob.size } });
    endJob(job);
    toast(`バックアップZIPを作成しました：${name}`, 'success');
    await saveFile(blob, name, 'backup');
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
    Object.values(state.thumbs).forEach((t) => t.url && URL.revokeObjectURL(t.url));
    setState({
      project: normalizeProject(r.project),
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

// ---------------------------------------------------------------- 編集結果（派生画像）の追加

export interface DerivedItem {
  name: string;
  bytes: Uint8Array;
}

/**
 * 編集結果を新しい画像として追加する。元画像は変更しない。
 * assign: 指定した役割へ順に割り当てる。transferRoles: 元画像の役割を新しい画像へ移す（1枚のとき）。
 */
export async function addDerivedAssets(
  from: AssetRecord,
  items: DerivedItem[],
  op: 'split' | 'background',
  detail: string,
  opts: { assign?: { templateId: string; roleId: string }; transferRoles?: boolean } = {},
): Promise<string[]> {
  const created: AssetRecord[] = [];
  for (const it of items) {
    const a = await makeAsset(it.name, `${from.originalName} › ${op === 'split' ? '分割' : '背景透過'}`, it.bytes, 'image/png');
    a.derivedFrom = { assetId: from.id, originalName: from.originalName, op, detail };
    created.push(a);
  }
  updateProject((p) => {
    let next = addAssets(p, created);
    if (opts.transferRoles && created.length === 1) {
      next = { ...next, refs: next.refs.map((r) => (r.assetId === from.id ? { ...r, assetId: created[0].id, nameOverride: undefined } : r)) };
    }
    if (opts.assign) for (const a of created) next = addRef(next, a.id, opts.assign.templateId, opts.assign.roleId);
    return next;
  });
  refreshThumbnails();
  if (op === 'split') setState({ editHint: null });
  const ids = created.map((a) => a.id);
  await runCheck(ids);
  return ids;
}

/** 大きい画像を編集タブで開く（チェックタブの案内から） */
export function openInEditor(assetId: string) {
  setState({ tab: 'edit', edit: { assetId, tool: 'split' }, selectedAssetId: null, editHint: null });
  scrollTop();
}

function scrollTop() {
  try {
    window.scrollTo({ top: 0 });
  } catch {
    /* 古いブラウザでは無視 */
  }
}

export function setEdit(patch: Partial<AppState['edit']>) {
  setState((s) => ({ edit: { ...s.edit, ...patch } }));
}

// ---------------------------------------------------------------- 試し送りから使うプロジェクト操作

/** Blobを新しい画像としてプロジェクトに追加（チェックは自動で走らせない＝未検査のまま） */
export async function addBlobAsProjectAsset(name: string, blob: Blob, sourcePath: string): Promise<string> {
  const a = await makeAsset(name, sourcePath, new Uint8Array(await blob.arrayBuffer()), blob.type);
  updateProject((p) => addAssets(p, [a]));
  refreshThumbnails();
  return a.id;
}

/** プロジェクトの画像を差し替える（役割と順序は維持）。以前のチェック結果は破棄され「未検査」になる */
export async function replaceAssetWithBlob(assetId: string, name: string, blob: Blob): Promise<void> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const sha = await sha256Hex(data);
  updateProject((p) => replaceAsset(p, assetId, { originalName: name, blob: new Blob([data as BlobPart], { type: blob.type }), size: data.length, sha256: sha, sourcePath: `${name}（試し送りから採用）` }));
  refreshThumbnails();
}

export function showInCheck(assetId: string) {
  setState({ tab: 'check', selectedAssetId: assetId });
  try {
    window.scrollTo({ top: 0 });
  } catch {
    /* 無視 */
  }
}
