import { describe, expect, it } from "vitest";
import {
  customerSegments,
  dateRange,
  describeItem,
  mergePages,
  normalizeSummary,
  showsAmount,
  timelineXlsxRows,
  type C360Kpis,
  type C360Summary,
  type TimelineItem,
} from "@/lib/customers/c360";

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

const kpis = (over: Partial<C360Kpis> = {}): C360Kpis => ({
  purchases: 5,
  total: 50_000,
  avg_ticket: 10_000,
  first_at: iso(200),
  last_at: iso(5),
  days_since_last: 5,
  frequency_days: 40,
  purchases_90d: 1,
  total_365d: 50_000,
  returns: 0,
  returns_total: 0,
  account_balance: 0,
  account_overdue: 0,
  account_next_due: null,
  credit_limit: 0,
  store_credit: 0,
  pending_charges: 0,
  pending_charges_total: 0,
  open_disputes: 0,
  ...over,
});

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  kind: "sale",
  sub: "completed",
  id: "x",
  at: "2026-10-01T15:00:00Z",
  amount: 100,
  ref: "12",
  status: "completed",
  store_id: null,
  store_name: null,
  sale_id: "s1",
  detail: null,
  ...over,
});

describe("cliente 360 · segmentos", () => {
  it("sin compras", () => {
    expect(customerSegments(kpis({ purchases: 0, first_at: null, last_at: null, days_since_last: null }), null)).toEqual([
      "sin_compras",
    ]);
  });

  it("nuevo, frecuente y VIP", () => {
    const s = customerSegments(kpis({ first_at: iso(10), purchases_90d: 3, total_365d: 90_000 }), 80_000);
    expect(s).toEqual(["vip", "nuevo", "frecuente"]);
  });

  it("VIP sólo con umbral", () => {
    expect(customerSegments(kpis({ total_365d: 1e9 }), null)).not.toContain("vip");
  });

  it("en riesgo: compraba seguido y no vuelve hace más del doble", () => {
    expect(customerSegments(kpis({ days_since_last: 90, frequency_days: 30 }), null)).toContain("en_riesgo");
    expect(customerSegments(kpis({ days_since_last: 50, frequency_days: 30 }), null)).not.toContain("en_riesgo");
    // Pocas compras: no hay hábito para comparar.
    expect(customerSegments(kpis({ purchases: 2, days_since_last: 90, frequency_days: 30 }), null)).not.toContain(
      "en_riesgo",
    );
  });

  it("inactivo pisa a en riesgo", () => {
    const s = customerSegments(kpis({ days_since_last: 200, frequency_days: 30 }), null);
    expect(s).toContain("inactivo");
    expect(s).not.toContain("en_riesgo");
  });

  it("deuda y devoluciones", () => {
    expect(customerSegments(kpis({ account_balance: 100 }), null)).toContain("con_deuda");
    const late = customerSegments(kpis({ account_balance: 100, account_overdue: 50 }), null);
    expect(late).toContain("deuda_vencida");
    expect(late).not.toContain("con_deuda");
    expect(customerSegments(kpis({ returns_total: 15_000 }), null)).toContain("devuelve_mucho");
  });
});

describe("cliente 360 · línea de tiempo", () => {
  it("títulos por tipo", () => {
    expect(describeItem(item({})).title).toBe("Venta #12");
    expect(describeItem(item({ status: "voided" })).title).toBe("Venta #12 (anulada)");
    expect(describeItem(item({ kind: "return", sub: "mercadopago", amount: -50 })).title).toBe(
      "Devolución #12 por Mercado Pago",
    );
    expect(describeItem(item({ kind: "account", sub: "payment", ref: "7", amount: -500 })).title).toBe(
      "Cobro de cuenta corriente · recibo 7",
    );
    expect(describeItem(item({ kind: "mp_refund", status: "failed", ref: "" })).tone).toBe("danger");
    expect(describeItem(item({ kind: "dispute", sub: "refund", detail: "pos" })).title).toBe(
      "Devolución en Mercado Pago (desde el POS)",
    );
    // El detalle de la venta muestra los medios legibles, no la key de payments.method.
    expect(describeItem(item({ kind: "sale", detail: "cash, account" })).detail).toBe(
      "Cobro: Efectivo, Cuenta corriente",
    );
    expect(describeItem(item({ kind: "sale", detail: "medio_nuevo" })).detail).toBe("Cobro: medio_nuevo");
    expect(describeItem(item({ kind: "pending_charge", sub: "qr", status: "waiting" })).title).toBe(
      "Cobro en espera (QR) · esperando el pago",
    );
  });

  it("monto visible", () => {
    expect(showsAmount(item({ kind: "note" }))).toBe(false);
    expect(showsAmount(item({ kind: "collection", sub: "promise", amount: 100 }))).toBe(true);
    expect(showsAmount(item({ kind: "collection", sub: "note", amount: 0 }))).toBe(false);
    expect(showsAmount(item({}))).toBe(true);
  });

  it("une páginas sin repetir", () => {
    const merged = mergePages([
      { items: [item({ id: "a" }), item({ id: "b" })], next_cursor: { at: "x", id: "b" } },
      { items: [item({ id: "b" }), item({ id: "c", amount: "30" as unknown as number })], next_cursor: null },
    ]);
    expect(merged.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(merged[2]!.amount).toBe(30);
  });

  it("rango de fechas en hora argentina, hasta inclusive", () => {
    expect(dateRange("2026-10-01", "2026-10-31")).toEqual({
      from: "2026-10-01T03:00:00.000Z",
      to: "2026-11-01T03:00:00.000Z",
    });
    expect(dateRange(null, null)).toEqual({ from: null, to: null });
  });

  it("filas para Excel", () => {
    const rows = timelineXlsxRows([item({}), item({ kind: "note", detail: "Llamar", id: "n" })]);
    expect(rows[0]).toMatchObject({ tipo: "Ventas", movimiento: "Venta #12", monto: 100 });
    expect(rows[1]).toMatchObject({ tipo: "Notas", detalle: "Llamar", monto: null });
  });
});

describe("cliente 360 · normalización", () => {
  it("convierte numerics que llegan como texto", () => {
    const raw = {
      profile: { id: "c", name: "Ana" },
      kpis: { purchases: "3", total: "1500.50", days_since_last: null, frequency_days: "12.5" },
      vip_threshold: "9000",
      is_manager: true,
      by_store: [{ store_id: "s", name: "Centro", count: "3", total: "1500.5", avg_ticket: "500.17", last_at: "x" }],
      monthly: [{ month: "2026-10", total: "100", count: "1" }],
      top_products: [],
      payment_methods: [{ method: "cash", total: "100", count: "1" }],
      pinned_notes: [],
    } as unknown as C360Summary;
    const s = normalizeSummary(raw);
    expect(s.kpis.purchases).toBe(3);
    expect(s.kpis.total).toBe(1500.5);
    expect(s.kpis.days_since_last).toBeNull();
    expect(s.kpis.frequency_days).toBe(12.5);
    expect(s.vip_threshold).toBe(9000);
    expect(s.by_store[0]!.total).toBe(1500.5);
    expect(s.payment_methods[0]!.total).toBe(100);
  });
});
