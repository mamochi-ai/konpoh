// 試し送りの操作。画像は端末内（IndexedDB）だけで扱い、外部へ送らない。
import {
  addBlobAsProjectAsset,
  getState,
  replaceAssetWithBlob,
  saveFile,
  setState,
  toast,
} from './store';
import * as db from './db';
import {
  addLocalImages,
  addPair,
  convertLocalToProject,
  localKey,
  markAdopted,
  newId,
  parseKey,
  removeFromList,
  type ImageKey,
  type LocalImageMeta,
  type TrialData,
} from '../core/trial';
import { detectContainer } from '../core/sniff';
import { imageDims } from '../core/sheet';
import { sha256Hex } from '../core/hash';
import { asciiFileName } from '../core/rules';

// ---------------------------------------------------------------- 自動保存（失敗を成功に見せない）

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveChain: Promise<void> = Promise.resolve();

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  setState({ trialSave: { status: 'saving' } });
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = getState().trial;
    saveChain = saveChain.then(async () => {
      try {
        await db.saveTrialData(snapshot);
        if (getState().trial === snapshot) setState({ trialSave: { status: 'saved', at: new Date().toISOString() } });
      } catch (e) {
        setState({ trialSave: { status: 'error', message: `この端末に保存できませんでした：${(e as Error).message || e}` } });
      }
    });
  }, 350);
}

/** 保存が終わるまで待つ（テストや画面を閉じる前用） */
export async function flushTrialSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const snapshot = getState().trial;
    saveChain = saveChain.then(() => db.saveTrialData(snapshot)).then(
      () => setState({ trialSave: { status: 'saved', at: new Date().toISOString() } }),
      (e) => setState({ trialSave: { status: 'error', message: `この端末に保存できませんでした：${(e as Error).message || e}` } }),
    );
  }
  await saveChain;
}

export function updateTrial(fn: (d: TrialData) => TrialData) {
  const cur = getState().trial;
  const next = fn(cur);
  if (next === cur) return;
  setState({ trial: next });
  scheduleSave();
}

// ---------------------------------------------------------------- 画像の表示用URL（使い回し、不要になったら解放）

const urls = new Map<ImageKey, { blob: Blob; url: string }>();

export interface TrialImageView {
  key: ImageKey;
  name: string;
  blob: Blob | null;
  kind: 'project' | 'local';
  /** プロジェクトの画像の版（差し替えで増える） */
  version?: number;
  origin?: string;
}

export function imageFor(key: ImageKey): TrialImageView | null {
  const k = parseKey(key);
  if (!k) return null;
  const s = getState();
  if (k.kind === 'project') {
    const a = s.project.assets.find((x) => x.id === k.id);
    return a ? { key, name: a.originalName, blob: a.blob, kind: 'project', version: a.version } : null;
  }
  const m = s.trial.localImages.find((x) => x.id === k.id);
  if (!m) return null;
  return { key, name: m.name, blob: s.trialBlobs[k.id] ?? null, kind: 'local', origin: m.origin };
}

export function urlFor(key: ImageKey): string | null {
  const img = imageFor(key);
  if (!img?.blob) return null;
  const cur = urls.get(key);
  if (cur && cur.blob === img.blob) return cur.url;
  if (cur) URL.revokeObjectURL(cur.url);
  const url = URL.createObjectURL(img.blob);
  urls.set(key, { blob: img.blob, url });
  return url;
}

/** 一覧・会話・比較で使っていない画像のURLを解放する */
export function releaseUnusedUrls(activeKeys: Set<ImageKey>) {
  for (const [k, v] of urls) {
    if (!activeKeys.has(k) || imageFor(k)?.blob !== v.blob) {
      URL.revokeObjectURL(v.url);
      urls.delete(k);
    }
  }
}

export function urlCount(): number {
  return urls.size;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const v of urls.values()) URL.revokeObjectURL(v.url);
    urls.clear();
  });
}

// ---------------------------------------------------------------- 画像の読み込み（PNG・JPEG。元画像は変更しない）

async function canDecode(blob: Blob, type: string): Promise<boolean> {
  if (typeof createImageBitmap === 'undefined') return true;
  try {
    const bmp = await createImageBitmap(new Blob([blob], { type }));
    const ok = bmp.width > 0 && bmp.height > 0;
    bmp.close();
    return ok;
  } catch {
    return false;
  }
}

export interface LoadResult {
  keys: ImageKey[];
  failed: { name: string; reason: string }[];
}

/** 試し送りで画像を読み込む。1件失敗しても他は続ける */
export async function loadTrialFiles(files: File[], origin?: string): Promise<LoadResult> {
  const metas: LocalImageMeta[] = [];
  const blobs: Record<string, Blob> = {};
  const failed: LoadResult['failed'] = [];
  let saveFailed = false;
  for (const f of files) {
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      const c = detectContainer(data.subarray(0, 64));
      if (c !== 'png' && c !== 'jpeg') {
        failed.push({ name: f.name, reason: c === 'unknown' ? '画像として読めません' : 'PNG・JPEG以外は読み込めません' });
        continue;
      }
      const type = c === 'png' ? 'image/png' : 'image/jpeg';
      const blob = new Blob([data as BlobPart], { type });
      if (!(await canDecode(blob, type))) {
        failed.push({ name: f.name, reason: '画像が壊れているため表示できません' });
        continue;
      }
      const id = newId('timg');
      const dims = imageDims(data);
      metas.push({ id, name: f.name, size: data.length, sha256: await sha256Hex(data), addedAt: new Date().toISOString(), origin, width: dims?.width, height: dims?.height });
      blobs[id] = blob;
      try {
        await db.putTrialImage(id, blob);
      } catch {
        saveFailed = true;
      }
    } catch (e) {
      failed.push({ name: f.name, reason: (e as Error).message || '読み込めませんでした' });
    }
  }
  if (metas.length) {
    setState((s) => ({ trialBlobs: { ...s.trialBlobs, ...blobs } }));
    updateTrial((d) => addLocalImages(d, metas));
  }
  if (saveFailed) {
    setState({ trialSave: { status: 'error', message: '画像をこの端末に保存できませんでした。再読み込みすると消えます（容量不足の可能性があります）。' } });
  }
  if (failed.length) {
    toast(`${failed.length}件を読み込めませんでした：${failed.map((x) => `${x.name}（${x.reason}）`).join('、')}`, 'error');
  }
  return { keys: metas.map((m) => localKey(m.id)), failed };
}

/** 試し送りの一覧から外す。読み込んだ画像は端末からも削除（プロジェクトの画像は参照を外すだけ） */
export async function removeTrialImage(key: ImageKey) {
  const k = parseKey(key);
  const before = getState().trial;
  updateTrial((d) => removeFromList(d, key));
  const after = getState().trial;
  if (k?.kind === 'local' && after.localImages.length < before.localImages.length) {
    setState((s) => {
      const b = { ...s.trialBlobs };
      delete b[k.id];
      return { trialBlobs: b };
    });
    try {
      await db.deleteTrialImage(k.id);
    } catch (e) {
      setState({ trialSave: { status: 'error', message: `画像を端末から削除できませんでした：${(e as Error).message}` } });
    }
  }
}

export function exportTrialImage(key: ImageKey) {
  const img = imageFor(key);
  if (!img?.blob) return;
  const ext = img.blob.type === 'image/jpeg' ? 'jpg' : 'png';
  saveFile(img.blob, asciiFileName(img.name, `sticker.${ext}`), `trial:${key}`);
}

/** 試し送りで読み込んだ画像をプロジェクトに追加（未検査の画像として。重複しないよう参照を付け替える） */
export async function addLocalToProject(key: ImageKey): Promise<string | null> {
  const k = parseKey(key);
  if (k?.kind !== 'local') return null;
  const img = imageFor(key);
  if (!img?.blob) return null;
  const assetId = await addBlobAsProjectAsset(img.name, img.blob, `${img.name}（試し送りから追加）`);
  updateTrial((d) => convertLocalToProject(d, k.id, assetId));
  setState((s) => {
    const b = { ...s.trialBlobs };
    delete b[k.id];
    return { trialBlobs: b };
  });
  db.deleteTrialImage(k.id).catch(() => {});
  toast(`「${img.name}」をプロジェクトに追加しました（未検査）。役割の割り当てと検査はチェックタブで行えます。上の「保存」で作品を保存してください。`, 'success');
  return assetId;
}

// ---------------------------------------------------------------- 修正前後の比較

/** 修正後の画像を読み込み、修正前と組にする */
export async function loadAfterImage(beforeKey: ImageKey, file: File): Promise<string | null> {
  const r = await loadTrialFiles([file], '修正後');
  if (!r.keys.length) return null;
  let pairId = '';
  updateTrial((d) => {
    const { data, pair } = addPair(d, beforeKey, r.keys[0]);
    pairId = pair.id;
    return data;
  });
  return pairId;
}

/**
 * 修正後をプロジェクトに採用する（比較とは別の明示操作）。
 * - 修正前がプロジェクトの画像：その画像を修正後に差し替える。役割と順序は維持し、チェック結果は破棄（未検査）。
 *   差し替えで消える修正前は、比較用に試し送り側へ残す。
 * - 修正前が試し送りの画像：修正後を新しい画像としてプロジェクトに追加する（未検査）。
 */
export async function adoptPair(pairId: string): Promise<{ assetId: string; replaced: boolean } | null> {
  const s = getState();
  const pair = s.trial.pairs.find((p) => p.id === pairId);
  if (!pair) return null;
  const after = imageFor(pair.afterKey);
  if (!after?.blob) {
    toast('修正後の画像が見つかりません', 'error');
    return null;
  }
  const before = parseKey(pair.beforeKey);
  if (before?.kind === 'project') {
    const asset = s.project.assets.find((a) => a.id === before.id);
    if (!asset) {
      toast('修正前の画像がプロジェクトに見つかりません', 'error');
      return null;
    }
    // 修正前を比較用に残す
    const copyId = newId('timg');
    const meta: LocalImageMeta = {
      id: copyId,
      name: asset.originalName,
      size: asset.size,
      sha256: asset.sha256,
      addedAt: new Date().toISOString(),
      origin: '修正前（採用時に保存）',
    };
    try {
      await db.putTrialImage(copyId, asset.blob);
    } catch {
      setState({ trialSave: { status: 'error', message: '修正前の画像をこの端末に保存できませんでした。再読み込みすると比較の修正前が消えます。' } });
    }
    setState((st) => ({ trialBlobs: { ...st.trialBlobs, [copyId]: asset.blob } }));
    await replaceAssetWithBlob(asset.id, after.name, after.blob);
    updateTrial((d) => markAdopted(d, pairId, asset.id, { meta, key: localKey(copyId) }));
    return { assetId: asset.id, replaced: true };
  }
  const assetId = await addBlobAsProjectAsset(after.name, after.blob, `${after.name}（試し送りから採用）`);
  updateTrial((d) => markAdopted(d, pairId, assetId));
  return { assetId, replaced: false };
}
