// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  OfflineQueue,
  buildEntry,
  canonicalJson,
  entryHash,
  memoryQueueStore,
  provisionalCode,
  verifyEntry,
  type BuildEntryInput,
} from "@/lib/pos/offline/queue";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const U2 = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";

function input(over: Partial<BuildEntryInput> = {}): BuildEntryInput {
  return {
    tenantId: T,
    userId: U,
    shiftId: S,
    storeId: null,
    deviceId: "dev-1",
    snapshotAt: "2026-10-13T10:00:00.000Z",
    total: 1500,
    payload: {
      items: [{ product_id: "p1", quantity: 1, unit_price: 1500, discount: 0 }],
      payments: [{ method: "cash", amount: 1500 }],
      discount_total: 0,
      customer_id: null,
      notes: null,
      extras: [],
      promo_discount: 0,
      promo_id: null,
      promo_name: null,
    },
    lines: [{ name: "Alfajor", quantity: 1, unitPrice: 1500, discount: 0 }],
    change: 0,
    ...over,
  };
}

describe("canonicalJson", () => {
  it("ordena claves y descarta undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("buildEntry", () => {
  it("genera un client_sale_id uuid, asocia usuario y turno y firma el payload", async () => {
    const e = await buildEntry(input());
    expect(e.client_sale_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(e.payload.cash_shift_id).toBe(S);
    expect(e.user_id).toBe(U);
    expect(e.status).toBe("pending");
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.provisional).toBe(provisionalCode(e.client_sale_id));
    expect(e.provisional).toMatch(/^OFF-[0-9A-F]{8}$/);
    expect(await verifyEntry(e)).toBe(true);
  });

  it("el hash cambia si se toca el payload, el turno o el usuario", async () => {
    const e = await buildEntry(input());
    const tampered = { ...e, payload: { ...e.payload, discount_total: 500 } };
    expect(await verifyEntry(tampered)).toBe(false);
    expect(await verifyEntry({ ...e, user_id: U2 })).toBe(false);
    expect(await verifyEntry({ ...e, shift_id: "otro" })).toBe(false);
    expect(await entryHash(e)).toBe(e.hash);
  });

  it("respeta un id dado (reintento del mismo cobro)", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const e = await buildEntry(input({ clientSaleId: id }));
    expect(e.client_sale_id).toBe(id);
  });
});

describe("OfflineQueue", () => {
  it("encola idempotente por client_sale_id", async () => {
    const store = memoryQueueStore();
    const q = new OfflineQueue(store);
    const e = await buildEntry(input());
    await q.enqueue(e);
    const again = await q.enqueue({ ...e, total: 999 });
    expect(again.total).toBe(1500);
    expect(store.size()).toBe(1);
  });

  it("lista por negocio y usuario en orden de venta", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    const late = await buildEntry(input({ soldAt: new Date("2026-10-13T12:00:00Z") }));
    const early = await buildEntry(input({ soldAt: new Date("2026-10-13T11:00:00Z") }));
    const other = await buildEntry(input({ userId: U2 }));
    await q.enqueue(late);
    await q.enqueue(early);
    await q.enqueue(other);
    const mine = await q.list({ tenantId: T, userId: U });
    expect(mine.map((e) => e.client_sale_id)).toEqual([early.client_sale_id, late.client_sale_id]);
    expect(await q.countInShift({ tenantId: T, userId: U }, S)).toBe(2);
    expect((await q.list({ tenantId: T, userId: U2 })).length).toBe(1);
  });

  it("retener y liberar no pierde la venta; sólo remove la saca", async () => {
    const q = new OfflineQueue(memoryQueueStore());
    const e = await buildEntry(input());
    await q.enqueue(e);
    await q.hold(e.client_sale_id, "shift_not_found");
    expect(await q.counts({ tenantId: T, userId: U })).toEqual({ pending: 0, hold: 1 });
    const held = (await q.list({ tenantId: T, userId: U }, "hold"))[0]!;
    expect(held.last_error).toBe("shift_not_found");
    expect(held.attempts).toBe(1);
    await q.release(e.client_sale_id);
    expect(await q.counts({ tenantId: T, userId: U })).toEqual({ pending: 1, hold: 0 });
    await q.remove(e.client_sale_id);
    expect(await q.counts({ tenantId: T, userId: U })).toEqual({ pending: 0, hold: 0 });
  });
});
