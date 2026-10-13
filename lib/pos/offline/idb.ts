// IndexedDB sin dependencias para la venta offline (ADR-077).
//   queue: ventas guardadas sin conexión (clave client_sale_id).
//   kv:    foto del catálogo, política y turno; contadores por turno.
// Si IndexedDB no está (modo privado viejo, SSR), todo devuelve vacío y la
// venta offline queda deshabilitada: nunca se pierde una venta en memoria
// porque el POS no deja guardarla.

import type { OfflineQueueEntry, QueueStore } from "./queue";

const DB_NAME = "ninja-pos-offline";
const DB_VERSION = 1;
const QUEUE = "queue";
const KV = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: "client_sale_id" });
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb_open_failed"));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error("idb_tx_failed"));
        tx.onabort = () => reject(tx.error ?? new Error("idb_tx_aborted"));
      }),
  );
}

export function idbQueueStore(): QueueStore {
  return {
    getAll: () => run<OfflineQueueEntry[]>(QUEUE, "readonly", (s) => s.getAll() as IDBRequest<OfflineQueueEntry[]>),
    get: (id) => run<OfflineQueueEntry | undefined>(QUEUE, "readonly", (s) => s.get(id)),
    put: (e) => run(QUEUE, "readwrite", (s) => s.put(e)).then(() => undefined),
    delete: (id) => run(QUEUE, "readwrite", (s) => s.delete(id)).then(() => undefined),
  };
}

export const idbKv = {
  get: <T>(key: string): Promise<T | undefined> => run<T | undefined>(KV, "readonly", (s) => s.get(key)),
  set: (key: string, value: unknown): Promise<void> =>
    run(KV, "readwrite", (s) => s.put(value, key)).then(() => undefined),
};
