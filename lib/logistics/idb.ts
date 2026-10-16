// IndexedDB de la app del repartidor (ADR-161), mismo patrón que
// lib/pos/offline/idb.ts, en una base aparte:
//   queue: acciones sin enviar (clave id del evento) con sus fotos como Blob.
//   kv:    copia de "mis hojas" y del detalle de cada hoja para abrirlas sin señal.
// Sin IndexedDB (modo privado viejo) cae a memoria: la cola dura mientras la
// pantalla esté abierta y la app lo avisa.

import { memoryStore, type ActionStore, type QueuedAction } from "./offline";

const DB_NAME = "ninja-reparto-offline";
const DB_VERSION = 1;
const QUEUE = "queue";
const KV = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;
const fallback = memoryStore();
const fallbackKv = new Map<string, unknown>();

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
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: "id" });
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

export function repartoQueueStore(): ActionStore {
  if (!idbAvailable()) return fallback;
  return {
    getAll: () => run<QueuedAction[]>(QUEUE, "readonly", (s) => s.getAll() as IDBRequest<QueuedAction[]>).catch(() => fallback.getAll()),
    put: (a) => run(QUEUE, "readwrite", (s) => s.put(a)).then(() => undefined),
    delete: (id) => run(QUEUE, "readwrite", (s) => s.delete(id)).then(() => undefined),
  };
}

export const repartoKv = {
  get: async <T>(key: string): Promise<T | undefined> => {
    if (!idbAvailable()) return fallbackKv.get(key) as T | undefined;
    try {
      return await run<T | undefined>(KV, "readonly", (s) => s.get(key));
    } catch {
      return fallbackKv.get(key) as T | undefined;
    }
  },
  set: async (key: string, value: unknown): Promise<void> => {
    fallbackKv.set(key, value);
    if (!idbAvailable()) return;
    try {
      await run(KV, "readwrite", (s) => s.put(value, key));
    } catch {
      /* queda en memoria */
    }
  },
};
