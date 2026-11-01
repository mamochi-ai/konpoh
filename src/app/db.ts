// 端末内保存（IndexedDB）。保存失敗は呼び出し側に例外として返す（握りつぶさない）
import type { BundleTemplate, CheckTemplate, Project } from '../core/types';

const DB_NAME = 'konpoh';
const DB_VERSION = 1;
// チェックテンプレートと組合せセットは別ストア。将来の編集テンプレートはここに混ぜず別ストアを追加する。
const STORES = ['projects', 'checkTemplates', 'bundleTemplates', 'meta'] as const;
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

async function getAll<T>(store: StoreName): Promise<T[]> {
  return (await tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? [];
}

export const loadCheckTemplates = () => getAll<CheckTemplate>('checkTemplates');
export const loadBundleTemplates = () => getAll<BundleTemplate>('bundleTemplates');

export async function putCheckTemplate(t: CheckTemplate): Promise<void> {
  await tx('checkTemplates', 'readwrite', (s) => s.put(t, t.id));
}
export async function deleteCheckTemplate(id: string): Promise<void> {
  await tx('checkTemplates', 'readwrite', (s) => s.delete(id));
}
export async function putBundleTemplate(t: BundleTemplate): Promise<void> {
  await tx('bundleTemplates', 'readwrite', (s) => s.put(t, t.id));
}
export async function deleteBundleTemplate(id: string): Promise<void> {
  await tx('bundleTemplates', 'readwrite', (s) => s.delete(id));
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* 判定できない場合は null */
  }
  return null;
}
