import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CartLine } from "@/modules/pos/store";
import {
  PAUSED_TTL_HOURS,
  hasLivePayments,
  isPausedVisible,
  leftLabel,
  pausedExpiresAt,
  pausedExpiry,
  pausedPreview,
  type PausedPayment,
  type PausedSale,
} from "@/modules/paused-sales/logic";

// ADR-108: las ventas pausadas vencen a las 24 h; con pagos no se borran.

const H = 3_600_000;
const NOW = new Date("2026-10-13T20:00:00.000Z");

function sale(over: Partial<PausedSale> = {}): PausedSale {
  return {
    id: "s1",
    tenant_id: "t",
    store_id: "st",
    register_id: null,
    cash_shift_id: null,
    created_by: null,
    resumed_by: null,
    customer_id: null,
    customer_name: null,
    label: null,
    cart: {
      v: 1,
      lines: [],
      discountTotal: 0,
      couponCode: null,
      customer: null,
      offeredWarrantyId: "",
      pricing: { listId: null, termId: null },
      notes: null,
    },
    checkout: null,
    total: 100,
    paid_amount: 0,
    item_count: 1,
    status: "paused",
    carry_over: false,
    needs_review: false,
    source: "online",
    paused_at: new Date(NOW.getTime() - H).toISOString(),
    resumed_at: null,
    version: 1,
    payments: [],
    ...over,
  };
}

const pay = (status: PausedPayment["status"], kind: PausedPayment["kind"] = "intent"): PausedPayment => ({
  kind,
  method: kind === "line" ? "cash" : "qr",
  amount: 10,
  line: {},
  status,
  credited: false,
});

describe("vencimiento de ventas pausadas (ADR-108)", () => {
  it("PAUSED_TTL_HOURS espeja paused_sale_ttl() del SQL", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261111100100_pausadas_vencen_24h.sql"),
      "utf8",
    );
    const fn = sql.slice(sql.indexOf("create or replace function paused_sale_ttl"));
    expect(fn.slice(0, 300)).toContain(`interval '${PAUSED_TTL_HOURS} hours'`);
  });

  it("sin expires_at del servidor: último movimiento (pausar o retomar) + 24 h", () => {
    const paused = "2026-10-13T10:00:00.000Z";
    expect(pausedExpiresAt({ paused_at: paused, resumed_at: null }).toISOString()).toBe("2026-10-14T10:00:00.000Z");
    expect(
      pausedExpiresAt({ paused_at: paused, resumed_at: "2026-10-13T12:00:00.000Z" }).toISOString(),
    ).toBe("2026-10-14T12:00:00.000Z");
    // Manda el del servidor.
    expect(
      pausedExpiresAt({ paused_at: paused, resumed_at: null, expires_at: "2026-10-13T21:00:00.000Z" }).toISOString(),
    ).toBe("2026-10-13T21:00:00.000Z");
  });

  it("falta mucho: 'ok'; menos de 2 h: 'soon' (se resalta)", () => {
    const ok = pausedExpiry(sale({ expires_at: new Date(NOW.getTime() + 3 * H + 5 * 60_000).toISOString() }), NOW);
    expect(ok).toMatchObject({ kind: "ok", label: "Vence en 3 h" });
    const soon = pausedExpiry(sale({ expires_at: new Date(NOW.getTime() + 80 * 60_000).toISOString() }), NOW);
    expect(soon).toMatchObject({ kind: "soon", label: "Vence en 1 h 20 min" });
    const minutes = pausedExpiry(sale({ expires_at: new Date(NOW.getTime() + 12 * 60_000).toISOString() }), NOW);
    expect(minutes).toMatchObject({ kind: "soon", label: "Vence en 12 min" });
  });

  it("vencida sin pagos: 'expired' y no se muestra; con pagos vivos: 'held' y sí", () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    const gone = sale({ expires_at: past, payments: [pay("cancelled"), pay("expired"), pay("rejected")] });
    expect(pausedExpiry(gone, NOW).kind).toBe("expired");
    expect(isPausedVisible(gone, NOW)).toBe(false);

    for (const p of [pay("confirmed", "line"), pay("pending"), pay("approved")]) {
      const held = sale({ expires_at: past, payments: [p] });
      expect(pausedExpiry(held, NOW).kind).toBe("held");
      expect(isPausedVisible(held, NOW)).toBe(true);
    }
  });

  it("sólo las abiertas se muestran", () => {
    expect(isPausedVisible(sale({ status: "expired" }), NOW)).toBe(false);
    expect(isPausedVisible(sale({ status: "discarded" }), NOW)).toBe(false);
    expect(isPausedVisible(sale({ status: "resumed" }), NOW)).toBe(true);
  });

  it("hasLivePayments: intents muertos no cuentan", () => {
    expect(hasLivePayments([])).toBe(false);
    expect(hasLivePayments([pay("cancelled"), pay("rejected"), pay("expired")])).toBe(false);
    expect(hasLivePayments([pay("used")])).toBe(true);
  });

  it("leftLabel", () => {
    expect(leftLabel(30_000)).toBe("en menos de 1 min");
    expect(leftLabel(59 * 60_000)).toBe("en 59 min");
    expect(leftLabel(60 * 60_000)).toBe("en 1 h");
    expect(leftLabel(23 * H + 59 * 60_000)).toBe("en 23 h");
  });
});

describe("contenido de la tarjeta", () => {
  const line = (i: number, over: Partial<CartLine> = {}): CartLine => ({
    lineId: `l${i}`,
    productId: `p${i}`,
    name: `Producto ${i}`,
    sku: null,
    unitPrice: 100,
    quantity: 2,
    discount: 10,
    unit: "un",
    ...over,
  });

  it("muestra las primeras 3 y deja el resto para '+N más'", () => {
    const r = pausedPreview([line(1), line(2), line(3), line(4), line(5)]);
    expect(r.shown.map((l) => l.lineId)).toEqual(["l1", "l2", "l3"]);
    expect(r.hidden.map((l) => l.lineId)).toEqual(["l4", "l5"]);
    expect(r.shown[0]).toMatchObject({ quantity: 2, subtotal: 190, detail: null });
  });

  it("subtotal 0 para una línea cubierta por pack; detalle con variante y modificadores", () => {
    const r = pausedPreview([
      line(1, { packCreditId: "pc" }),
      line(2, { variantLabel: "M / Rojo", modifiersLabel: "Extra queso" }),
      line(3, { unit: "kg", quantity: 0.5, discount: 0 }),
    ]);
    expect(r.shown[0]!.subtotal).toBe(0);
    expect(r.shown[1]!.detail).toBe("M / Rojo · Extra queso");
    expect(r.shown[2]).toMatchObject({ unit: "kg", quantity: 0.5, subtotal: 50 });
    expect(r.units).toBe(5);
  });
});
