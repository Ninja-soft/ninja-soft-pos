// Cola local de ventas offline (ADR-077). Cada venta guardada sin conexión
// lleva un id generado en el cliente (client_sale_id, uuid) que es la clave de
// idempotencia en el servidor: reenviarla nunca duplica la venta. La entrada
// queda asociada al negocio, usuario y turno, y lleva el hash SHA-256 del
// payload para detectar que se tocó en el dispositivo (el servidor igual
// revalida todo). El almacenamiento es intercambiable: IndexedDB en el POS
// (lib/pos/offline/idb.ts) y memoria en los tests.

/** Parámetros de create_sale tal como los arma el POS (sin secretos). */
export interface OfflineSalePayload {
  items: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  discount_total: number;
  customer_id: string | null;
  notes: string | null;
  extras: Record<string, unknown>[];
  promo_discount: number;
  promo_id: string | null;
  promo_name: string | null;
  cash_shift_id: string;
}

/** Resumen para el ticket provisorio. */
export interface OfflineTicketLine {
  name: string;
  quantity: number;
  unitPrice: number;
  discount: number;
}

/**
 * pending: espera conexión · hold: el servidor la rechazó de forma dura (otro
 * usuario, turno inexistente) y queda guardada para revisarla; nunca se borra
 * sola.
 */
export type OfflineEntryStatus = "pending" | "hold";

export interface OfflineQueueEntry {
  client_sale_id: string;
  tenant_id: string;
  user_id: string;
  shift_id: string;
  store_id: string | null;
  device_id: string | null;
  /** ISO: momento real de la venta. */
  sold_at: string;
  /** ISO: foto del catálogo con la que se vendió (null = datos en memoria). */
  snapshot_at: string | null;
  total: number;
  payload: OfflineSalePayload;
  /** SHA-256 (hex) del payload canónico. */
  hash: string;
  status: OfflineEntryStatus;
  attempts: number;
  last_error: string | null;
  /** Código del ticket provisorio. */
  provisional: string;
  lines: OfflineTicketLine[];
  paymentsSummary: { method: string; amount: number }[];
  change: number;
}

export interface OfflineScope {
  tenantId: string;
  userId: string;
}

/** Almacenamiento de la cola (IndexedDB o memoria). */
export interface QueueStore {
  getAll(): Promise<OfflineQueueEntry[]>;
  get(id: string): Promise<OfflineQueueEntry | undefined>;
  put(e: OfflineQueueEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export function memoryQueueStore(seed: OfflineQueueEntry[] = []): QueueStore & { size(): number } {
  const m = new Map(seed.map((e) => [e.client_sale_id, e]));
  return {
    getAll: async () => [...m.values()].map((e) => structuredClone(e)),
    get: async (id) => {
      const e = m.get(id);
      return e ? structuredClone(e) : undefined;
    },
    put: async (e) => {
      m.set(e.client_sale_id, structuredClone(e));
    },
    delete: async (id) => {
      m.delete(id);
    },
    size: () => m.size,
  };
}

/** JSON con claves ordenadas (mismo texto para el mismo dato). */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** SHA-256 hex de un texto (Web Crypto: navegador y Node 20). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash de integridad: el payload junto con negocio, usuario, turno y momento. */
export function entryHash(e: Pick<OfflineQueueEntry, "tenant_id" | "user_id" | "shift_id" | "sold_at" | "payload">) {
  return sha256Hex(
    canonicalJson({ t: e.tenant_id, u: e.user_id, s: e.shift_id, at: e.sold_at, p: e.payload }),
  );
}

export async function verifyEntry(e: OfflineQueueEntry): Promise<boolean> {
  if (e.payload.cash_shift_id !== e.shift_id) return false;
  return (await entryHash(e)) === e.hash;
}

/** "OFF-1A2B3C4D": código corto para el ticket provisorio. */
export function provisionalCode(clientSaleId: string): string {
  return `OFF-${clientSaleId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function newClientSaleId(): string {
  return globalThis.crypto.randomUUID();
}

export interface BuildEntryInput {
  clientSaleId?: string;
  tenantId: string;
  userId: string;
  shiftId: string;
  storeId: string | null;
  deviceId: string | null;
  soldAt?: Date;
  snapshotAt: string | null;
  total: number;
  payload: Omit<OfflineSalePayload, "cash_shift_id">;
  lines: OfflineTicketLine[];
  change: number;
}

export async function buildEntry(i: BuildEntryInput): Promise<OfflineQueueEntry> {
  const id = i.clientSaleId ?? newClientSaleId();
  const payload: OfflineSalePayload = { ...i.payload, cash_shift_id: i.shiftId };
  const base = {
    tenant_id: i.tenantId,
    user_id: i.userId,
    shift_id: i.shiftId,
    sold_at: (i.soldAt ?? new Date()).toISOString(),
    payload,
  };
  return {
    client_sale_id: id,
    ...base,
    store_id: i.storeId,
    device_id: i.deviceId,
    snapshot_at: i.snapshotAt,
    total: Math.round(i.total * 100) / 100,
    hash: await entryHash(base),
    status: "pending",
    attempts: 0,
    last_error: null,
    provisional: provisionalCode(id),
    lines: i.lines,
    paymentsSummary: payload.payments.map((p) => ({ method: String(p.method), amount: Number(p.amount) || 0 })),
    change: i.change,
  };
}

const inScope = (e: OfflineQueueEntry, s: OfflineScope) => e.tenant_id === s.tenantId && e.user_id === s.userId;

export class OfflineQueue {
  constructor(private readonly store: QueueStore) {}

  /** Idempotente: si el id ya está en la cola, devuelve la entrada guardada. */
  async enqueue(e: OfflineQueueEntry): Promise<OfflineQueueEntry> {
    const prev = await this.store.get(e.client_sale_id);
    if (prev) return prev;
    await this.store.put(e);
    return e;
  }

  /** Del usuario y negocio, en orden de venta. */
  async list(scope: OfflineScope, status?: OfflineEntryStatus): Promise<OfflineQueueEntry[]> {
    const all = await this.store.getAll();
    return all
      .filter((e) => inScope(e, scope) && (!status || e.status === status))
      .sort((a, b) => a.sold_at.localeCompare(b.sold_at));
  }

  async counts(scope: OfflineScope): Promise<{ pending: number; hold: number }> {
    const all = await this.list(scope);
    return {
      pending: all.filter((e) => e.status === "pending").length,
      hold: all.filter((e) => e.status === "hold").length,
    };
  }

  /** Ventas offline de este usuario en el turno que siguen en la cola. */
  async countInShift(scope: OfflineScope, shiftId: string): Promise<number> {
    return (await this.list(scope)).filter((e) => e.shift_id === shiftId).length;
  }

  async bumpAttempt(id: string, error: string | null): Promise<void> {
    const e = await this.store.get(id);
    if (!e) return;
    await this.store.put({ ...e, attempts: e.attempts + 1, last_error: error });
  }

  async hold(id: string, error: string): Promise<void> {
    const e = await this.store.get(id);
    if (!e) return;
    await this.store.put({ ...e, status: "hold", attempts: e.attempts + 1, last_error: error });
  }

  /** Vuelve a intentar una retenida (por ejemplo, después de iniciar sesión). */
  async release(id: string): Promise<void> {
    const e = await this.store.get(id);
    if (!e) return;
    await this.store.put({ ...e, status: "pending" });
  }

  /** Sólo cuando el servidor ya la tiene (registrada o en revisión). */
  async remove(id: string): Promise<void> {
    await this.store.delete(id);
  }
}
