// 端末内保存（IndexedDB）。保存失敗は呼び出し側に例外として返す（握りつぶさない）
import type { Project } from '../core/types';
import type { TrialData } from '../core/trial';

const DB_NAME = 'konpoh';
const DB_VERSION = 2;
// 以前の版で作ったテンプレート用ストアは互換のため残す（現在は使わない）
// 版2で試し送り用（trialState: 会話・メモ・お題・表示設定、trialImages: 試し送りで読み込んだ画像のBlob）を追加
const STORES = ['projects', 'checkTemplates', 'bundleTemplates', 'meta', 'trialState', 'trialImages'] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('このブラウザでは端末内保存（IndexedDB）が使えません'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDBを開けません'));
    req.onblocked = () => reject(new Error('別のタブがデータベースを使用中です'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let result: T | undefined;
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error('保存に失敗しました'));
        t.onabort = () => reject(t.error ?? new Error('保存が中断されました（容量不足の可能性があります）'));
      }),
  );
}

export async function saveProject(p: Project): Promise<void> {
  await tx('projects', 'readwrite', (s) => s.put(p, p.id));
  await tx('meta', 'readwrite', (s) => s.put(p.id, 'lastProjectId'));
}

export async function loadLastProject(): Promise<Project | null> {
  const id = await tx<string>('meta', 'readonly', (s) => s.get('lastProjectId') as IDBRequest<string>);
  if (!id) return null;
  const p = await tx<Project>('projects', 'readonly', (s) => s.get(id) as IDBRequest<Project>);
  return p ?? null;
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* 判定できない場合は null */
  }
  return null;
}

// ---------------------------------------------------------------- 試し送り（画像Blobは IndexedDB に保存。localStorage は使わない）

export async function loadTrial(): Promise<{ data: unknown; images: Record<string, Blob> }> {
  const data = await tx<unknown>('trialState', 'readonly', (s) => s.get('current') as IDBRequest<unknown>);
  const keys = (await tx<IDBValidKey[]>('trialImages', 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>)) ?? [];
  const values = (await tx<Blob[]>('trialImages', 'readonly', (s) => s.getAll() as IDBRequest<Blob[]>)) ?? [];
  const images: Record<string, Blob> = {};
  keys.forEach((k, i) => {
    if (typeof k === 'string' && values[i] instanceof Blob) images[k] = values[i];
  });
  return { data, images };
}

export async function saveTrialData(d: TrialData): Promise<void> {
  await tx('trialState', 'readwrite', (s) => s.put(d, 'current'));
}

export async function putTrialImage(id: string, blob: Blob): Promise<void> {
  await tx('trialImages', 'readwrite', (s) => s.put(blob, id));
}

export async function deleteTrialImage(id: string): Promise<void> {
  await tx('trialImages', 'readwrite', (s) => s.delete(id));
}
