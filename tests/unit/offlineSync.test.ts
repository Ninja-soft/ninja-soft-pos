// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OfflineQueue, buildEntry, memoryQueueStore, type OfflineQueueEntry } from "@/lib/pos/offline/queue";
import {
  classifySyncError,
  conflictLabel,
  offlineErrorLabel,
  reasonLabel,
  syncQueue,
  type SyncMeta,
  type SyncServerResult,
} from "@/lib/pos/offline/sync";
import { offlineRowNeedsAttention } from "@/modules/pos/offline/api";
import {
  buildSnapshot,
  findByCodeInSnapshot,
  searchSnapshot,
  snapshotMatches,
  snapshotWithMeta,
  toSnapshotProduct,
} from "@/lib/pos/offline/snapshot";
import { OFFLINE_POLICY_DEFAULTS } from "@/lib/pos/offline/policy";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const S = "44444444-4444-4444-8444-444444444444";
const scope = { tenantId: T, userId: U };

function entry(at: string) {
  return buildEntry({
    tenantId: T,
    userId: U,
    shiftId: S,
    storeId: null,
    deviceId: null,
    snapshotAt: null,
    soldAt: new Date(at),
    total: 100,
    payload: {
      items: [{ product_id: "p1", quantity: 1, unit_price: 100, discount: 0 }],
      payments: [{ method: "cash", amount: 100 }],
      discount_total: 0,
      customer_id: null,
      notes: null,
      extras: [],
      promo_discount: 0,
      promo_id: null,
      promo_name: null,
    },
    lines: [],
    change: 0,
  });
}

function ok(e: OfflineQueueEntry, over: Partial<SyncServerResult> = {}): SyncServerResult {
  return {
    id: "row-" + e.client_sale_id,
    client_sale_id: e.client_sale_id,
    status: "synced",
    sale_id: "sale-1",
    sale_number: 7,
    sale_total: 100,
    conflicts: [],
    reasons: [],
    error: null,
    duplicate: false,
    ...over,
  };
}

/** Servidor falso idempotente por client_sale_id. */
function fakeServer() {
  const seen = new Map<string, SyncServerResult>();
  const calls: { id: string; meta: SyncMeta }[] = [];
  const rpc = vi.fn(async (e: OfflineQueueEntry, meta: SyncMeta) => {
    calls.push({ id: e.client_sale_id, meta });
    const prev = seen.get(e.client_sale_id);
    if (prev) return { ...prev, duplicate: true };
    const r = ok(e, { sale_number: seen.size + 1 });
    seen.set(e.client_sale_id, r);
    return r;
  });
  return { rpc, seen, calls };
}

describe("classifySyncError", () => {
  it("red → reintentar; sesión → auth; resto → retener", () => {
    expect(classifySyncError(new TypeError("Failed to fetch"))).toBe("retry");
    expect(classifySyncError({ message: "TypeError: NetworkError when attempting to fetch resource." })).toBe("retry");
    expect(classifySyncError({ message: "Load failed" })).toBe("retry");
    expect(classifySyncError({ message: "boom", status: 503 })).toBe("retry");
    expect(classifySyncError({ message: "JWT expired", code: "PGRST301" })).toBe("auth");
    expect(classifySyncError({ message: "no_tenant" })).toBe("auth");
    expect(classifySyncError({ message: "shift_not_found", code: "42501" })).toBe("hold");
    expect(classifySyncError({ message: "offline_user_mismatch" })).toBe("hold");
  });
});

describe("syncQueue", () => {
  it("envía en orden de venta y vacía la cola", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    const b = await entry("2026-10-13T11:00:00Z");
    const a = await entry("2026-10-13T10:00:00Z");
    await q.enqueue(b);
    await q.enqueue(a);
    const srv = fakeServer();
    const r = await syncQueue(q, scope, srv.rpc);
    expect(srv.calls.map((c) => c.id)).toEqual([a.client_sale_id, b.client_sale_id]);
    expect(srv.calls[0]!.meta).toMatchObject({ user_id: U, integrity: "ok", sold_at: a.sold_at });
    expect(r).toMatchObject({ synced: 2, review: 0, held: 0, stopped: null });
    expect(await q.counts(scope)).toEqual({ pending: 0, hold: 0 });
  });

  it("idempotencia: si se reenvía la misma venta, el servidor no la duplica", async () => {
    const srv = fakeServer();
    const e = await entry("2026-10-13T10:00:00Z");
    // Primer envío: la respuesta se pierde (corte justo después del commit).
    const q1 = new OfflineQueue(memoryQueueStore());
    await q1.enqueue(e);
    let first = true;
    const flaky = vi.fn(async (x: OfflineQueueEntry, m: SyncMeta) => {
      const res = await srv.rpc(x, m);
      if (first) {
        first = false;
        throw new TypeError("Failed to fetch");
      }
      return res;
    });
    const r1 = await syncQueue(q1, scope, flaky);
    expect(r1.stopped).toBe("network");
    expect((await q1.counts(scope)).pending).toBe(1);
    const r2 = await syncQueue(q1, scope, flaky);
    expect(r2.synced).toBe(1);
    expect(r2.results[0]!.duplicate).toBe(true);
    expect(srv.seen.size).toBe(1);
    expect(await q1.counts(scope)).toEqual({ pending: 0, hold: 0 });
  });

  it("sin red corta y deja todo pendiente con el intento sumado", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    const a = await entry("2026-10-13T10:00:00Z");
    const b = await entry("2026-10-13T11:00:00Z");
    await q.enqueue(a);
    await q.enqueue(b);
    const rpc = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await syncQueue(q, scope, rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(r.stopped).toBe("network");
    const left = await q.list(scope);
    expect(left).toHaveLength(2);
    expect(left[0]!.attempts).toBe(1);
  });

  it("sesión vencida: no toca la cola", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    await q.enqueue(await entry("2026-10-13T10:00:00Z"));
    const r = await syncQueue(q, scope, async () => {
      throw { message: "JWT expired", code: "PGRST301" };
    });
    expect(r.stopped).toBe("auth");
    expect(await q.counts(scope)).toEqual({ pending: 1, hold: 0 });
  });

  it("rechazo duro: queda retenida en el dispositivo y sigue con las demás", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    const a = await entry("2026-10-13T10:00:00Z");
    const b = await entry("2026-10-13T11:00:00Z");
    await q.enqueue(a);
    await q.enqueue(b);
    const rpc = vi.fn(async (e: OfflineQueueEntry) => {
      if (e.client_sale_id === a.client_sale_id) throw { message: "shift_not_found", code: "42501" };
      return ok(e);
    });
    const r = await syncQueue(q, scope, rpc);
    expect(r).toMatchObject({ synced: 1, held: 1 });
    expect(await q.counts(scope)).toEqual({ pending: 0, hold: 1 });
  });

  it("en revisión o con diferencias: el servidor la tiene, sale de la cola", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    const a = await entry("2026-10-13T10:00:00Z");
    const b = await entry("2026-10-13T11:00:00Z");
    await q.enqueue(a);
    await q.enqueue(b);
    const rpc = vi.fn(async (e: OfflineQueueEntry) =>
      e.client_sale_id === a.client_sale_id
        ? ok(e, { status: "needs_review", sale_id: null, reasons: ["over_amount_limit"] })
        : ok(e, { conflicts: [{ kind: "price_changed", product_id: "p1", expected: 120, received: 100 }] }),
    );
    const r = await syncQueue(q, scope, rpc);
    expect(r).toMatchObject({ synced: 1, review: 1, conflicts: 1 });
    expect(await q.counts(scope)).toEqual({ pending: 0, hold: 0 });
  });

  it("payload tocado en el dispositivo: viaja marcado como integridad fallida", async () => {
    const store = memoryQueueStore();
    const q = new OfflineQueue(store);
    const e = await entry("2026-10-13T10:00:00Z");
    await store.put({ ...e, payload: { ...e.payload, discount_total: 99 } });
    const srv = fakeServer();
    await syncQueue(q, scope, srv.rpc);
    expect(srv.calls[0]!.meta.integrity).toBe("failed");
  });
});

describe("conflictos y revisión", () => {
  it("textos de diferencias, motivos y errores (sin em dash)", () => {
    const price = conflictLabel({ kind: "price_changed", expected: 1200, received: 1000 }, "Alfajor");
    expect(price).toContain("Alfajor");
    expect(price).toContain("1.000");
    expect(price).toContain("1.200");
    expect(conflictLabel({ kind: "negative_stock" })).toContain("stock negativo");
    const promo = conflictLabel({ kind: "promo_changed", promo_name: "2x1", charged: 500, expected: 0 });
    expect(promo).toContain("2x1");
    expect(promo).toContain("$500");
    expect(promo).not.toContain("—");
    expect(conflictLabel({ kind: "promo_changed", gift: true }, "Alfajor")).toContain("regalo");
    expect(reasonLabel("over_count_limit")).toContain("cantidad");
    expect(reasonLabel("desconocido")).toBe("desconocido");
    expect(offlineErrorLabel("shift_not_open")).toContain("cerrado");
    expect(offlineErrorLabel(null)).toBeNull();
    for (const s of [price, reasonLabel("integrity_failed"), offlineErrorLabel("shift_not_owned")!]) {
      expect(s).not.toContain("—");
    }
  });

  it("qué necesita atención del dueño", () => {
    expect(offlineRowNeedsAttention({ status: "needs_review", reviewed_at: null, conflicts: [] })).toBe(true);
    expect(
      offlineRowNeedsAttention({ status: "synced", reviewed_at: null, conflicts: [{ kind: "negative_stock" }] }),
    ).toBe(true);
    expect(
      offlineRowNeedsAttention({ status: "synced", reviewed_at: "2026-10-13", conflicts: [{ kind: "negative_stock" }] }),
    ).toBe(false);
    expect(offlineRowNeedsAttention({ status: "synced", reviewed_at: null, conflicts: [] })).toBe(false);
    expect(offlineRowNeedsAttention({ status: "discarded", reviewed_at: null, conflicts: [] })).toBe(false);
  });
});

describe("foto local", () => {
  const products = [
    { id: "1", name: "Café con leche", sku: "CAF1", barcode: "779000", plu: "000123", price: 100, cost: 40, created_by: "u" },
    { id: "2", name: "Medialuna", sku: "MED", barcode: null, plu: null, price: 50, cost: 10, created_by: "u" },
  ];

  it("no guarda costos ni datos de auditoría", () => {
    const p = toSnapshotProduct(products[0]!);
    expect(p).not.toHaveProperty("cost");
    expect(p).not.toHaveProperty("created_by");
    const snap = buildSnapshot({ tenantId: T, userId: U, products, policy: OFFLINE_POLICY_DEFAULTS, shift: null });
    expect(JSON.stringify(snap)).not.toContain('"cost"');
    expect(snapshotMatches(snap, T, U)).toBe(true);
    expect(snapshotMatches(snap, T, "otro")).toBe(false);
  });

  it("busca por nombre sin acentos, SKU, código y PLU", () => {
    expect(searchSnapshot(products, "cafe").map((p) => p.id)).toEqual(["1"]);
    expect(searchSnapshot(products, "med").map((p) => p.id)).toEqual(["2"]);
    expect(searchSnapshot(products, "").length).toBe(2);
    expect(findByCodeInSnapshot(products, "779000")?.id).toBe("1");
    expect(findByCodeInSnapshot(products, "000123")?.id).toBe("1");
    expect(findByCodeInSnapshot(products, "nada")).toBeNull();
  });

  // El POS ya no vuelve a bajar el catálogo cuando llega el turno o la
  // sucursal: ajusta la foto guardada (useOfflinePos).
  it("ajusta turno, sucursal y política sin tocar el catálogo", () => {
    const snap = buildSnapshot({ tenantId: T, userId: U, products, policy: OFFLINE_POLICY_DEFAULTS, shift: null });
    const shift = { id: "s1", storeId: "st1" };
    const withShift = snapshotWithMeta(snap, { shift, policy: OFFLINE_POLICY_DEFAULTS });
    expect(withShift?.shift).toEqual(shift);
    expect(withShift?.products).toBe(snap.products);
    expect(withShift?.at).toBe(snap.at);
    // Mismo turno y política: nada que escribir.
    expect(snapshotWithMeta(withShift!, { shift: { ...shift }, policy: { ...OFFLINE_POLICY_DEFAULTS } })).toBeNull();
    // Otra sucursal, turno cerrado o política nueva: cambia.
    expect(snapshotWithMeta(withShift!, { shift: { id: "s1", storeId: "st2" }, policy: OFFLINE_POLICY_DEFAULTS })?.shift?.storeId).toBe("st2");
    expect(snapshotWithMeta(withShift!, { shift: null, policy: OFFLINE_POLICY_DEFAULTS })?.shift).toBeNull();
    const policy = { ...OFFLINE_POLICY_DEFAULTS, maxSales: 5 };
    expect(snapshotWithMeta(withShift!, { shift, policy })?.policy).toEqual(policy);
  });
});
