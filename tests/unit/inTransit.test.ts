import { describe, expect, it } from "vitest";
import {
  inTransitByProduct,
  inTransitRows,
  inTransitSummary,
  pendingQty,
  type InTransitSourceLine,
} from "@/lib/stock/inTransit";

const NOW = new Date("2026-11-05T15:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function line(p: Partial<InTransitSourceLine> = {}): InTransitSourceLine {
  return {
    transfer_id: "t1",
    number: 12,
    status: "in_transit",
    origin_store_id: "centro",
    dest_store_id: "norte",
    dispatched_at: daysAgo(2),
    product_id: "p1",
    variant_id: null,
    product_name: "Yerba 1 kg",
    variant_label: null,
    sku: "YER1",
    unit: "un",
    unit_cost: 1000,
    qty_dispatched: 10,
    qty_received: 0,
    ...p,
  };
}

describe("artículos en tránsito (H95)", () => {
  it("pendiente = despachado menos recibido, sin negativos (como stock_by_store)", () => {
    expect(pendingQty({ qty_dispatched: 10, qty_received: 9 })).toBe(1);
    expect(pendingQty({ qty_dispatched: 10, qty_received: 11 })).toBe(0);
    expect(pendingQty({ qty_dispatched: null, qty_received: 0 })).toBe(0);
    expect(pendingQty({ qty_dispatched: 0.3, qty_received: 0.1 })).toBe(0.2);
  });

  it("criterio H95: Centro manda 10 a Norte; en camino 10, tras recibir 9 queda 1", () => {
    const sent = inTransitRows([line()], { now: NOW });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pending: 10, value: 10_000, days: 2 });

    const partial = inTransitRows([line({ status: "partially_received", qty_received: 9 })], { now: NOW });
    expect(partial[0]).toMatchObject({ pending: 1, value: 1000 });

    // Norte cierra el faltante con motivo: el traslado queda recibido y sale del reporte.
    expect(inTransitRows([line({ status: "received", qty_received: 9 })], { now: NOW })).toEqual([]);
  });

  it("filtra por sucursal y dirección", () => {
    const lines = [
      line(),
      line({ transfer_id: "t2", number: 13, origin_store_id: "norte", dest_store_id: "sur" }),
      line({ transfer_id: "t3", number: 14, origin_store_id: "sur", dest_store_id: "centro" }),
    ];
    expect(inTransitRows(lines, { storeId: "norte", now: NOW }).map((r) => r.number)).toEqual([12, 13]);
    expect(inTransitRows(lines, { storeId: "norte", direction: "incoming", now: NOW }).map((r) => r.number)).toEqual([12]);
    expect(inTransitRows(lines, { storeId: "norte", direction: "outgoing", now: NOW }).map((r) => r.number)).toEqual([13]);
    expect(inTransitRows(lines, { now: NOW })).toHaveLength(3);
  });

  it("ignora borradores, programados y cancelados; ordena por antigüedad", () => {
    const rows = inTransitRows(
      [
        line({ status: "draft" }),
        line({ status: "scheduled" }),
        line({ status: "cancelled" }),
        line({ transfer_id: "t9", number: 20, dispatched_at: daysAgo(5) }),
        line({ transfer_id: "t8", number: 19, dispatched_at: daysAgo(1) }),
      ],
      { now: NOW },
    );
    expect(rows.map((r) => r.number)).toEqual([20, 19]);
  });

  it("resumen y agrupado por producto, con ítems sin costo", () => {
    const rows = inTransitRows(
      [
        line(),
        line({ transfer_id: "t2", number: 13, qty_dispatched: 5, dispatched_at: daysAgo(6) }),
        line({ transfer_id: "t2", number: 13, product_id: "p2", product_name: "Azúcar", unit_cost: null, qty_dispatched: 3 }),
      ],
      { now: NOW },
    );
    expect(inTransitSummary(rows)).toEqual({
      transfers: 2,
      items: 3,
      units: 18,
      value: 15_000,
      uncosted: 1,
      oldestDays: 6,
    });
    const byProduct = inTransitByProduct(rows);
    expect(byProduct[0]).toMatchObject({ product_name: "Yerba 1 kg", pending: 15, value: 15_000, transfers: [13, 12] });
    expect(byProduct[1]).toMatchObject({ product_name: "Azúcar", pending: 3, value: null });
    expect(inTransitSummary([])).toEqual({ transfers: 0, items: 0, units: 0, value: 0, uncosted: 0, oldestDays: null });
  });
});
