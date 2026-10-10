/**
 * The case file's photos, kept in IndexedDB on this phone only. The server checks a photo
 * and forgets it; this store is the only copy.
 */

const DB = "forking-paths-photos";
const STORE = "photos";

export type StoredPhoto = { key: string; runId: string; placeId: string; blob: Blob; at: number };

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("runId", "runId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        t.oncomplete = () => db.close();
      }),
  );
}

/** One photo per stop: the last one that passed (a retry replaces it). */
export function savePhoto(runId: string, placeId: string, blob: Blob) {
  const row: StoredPhoto = { key: `${runId}:${placeId}`, runId, placeId, blob, at: Date.now() };
  return tx("readwrite", (s) => s.put(row));
}

export async function photosOf(runId: string): Promise<StoredPhoto[]> {
  const rows = await tx<StoredPhoto[]>("readonly", (s) => s.index("runId").getAll(runId));
  return (rows ?? []).sort((a, b) => a.at - b.at);
}

export async function deletePhotos(runId: string): Promise<void> {
  const rows = await photosOf(runId);
  await Promise.all(rows.map((r) => tx("readwrite", (s) => s.delete(r.key))));
}
