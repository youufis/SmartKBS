/** 探索画布本地草稿：断网时把快照暂存 IndexedDB，回线自动找回
 *  （快照可达 MB 级，localStorage 装不下，故用原生 IndexedDB 不加新依赖） */

const DB_NAME = 'explore-draft'
const STORE = 'drafts'

export interface DraftRecord { snapshot: string; ts: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = run(tx.objectStore(STORE))
    req.onsuccess = () => { db.close(); resolve(req.result) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

export function saveDraft(key: string, snapshot: string): Promise<unknown> {
  return withStore('readwrite', (s) => s.put({ snapshot, ts: Date.now() } as DraftRecord, key))
}

export async function loadDraft(key: string): Promise<DraftRecord | null> {
  const v = await withStore<DraftRecord | undefined>('readonly', (s) => s.get(key) as IDBRequest<DraftRecord | undefined>)
  return v ?? null
}

export function clearDraft(key: string): Promise<unknown> {
  return withStore('readwrite', (s) => s.delete(key))
}