import { describe, expect, it } from "vitest";
import {
  checkReceive,
  groupSuggestionsBySource,
  parseWarehouseKind,
  principalQty,
  qtyIn,
  replenishSuggestions,
  salonStatus,
  sortWarehouses,
  warehouseErrorMessage,
  type Warehouse,
  type WarehouseOverviewRow,
} from "@/lib/stock/warehouses";
import { warehouseImportDefinition, warehouseStockImportDefinition } from "@/modules/imports/warehouses";
import { IMPORT_DEFINITIONS } from "@/modules/imports/registry";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";

const W = (id: string, kind: Warehouse["kind"], sort = 0, name = id): Warehouse => ({
  id,
  store_id: "s1",
  name,
  code: null,
  kind,
  sort,
});

const principal = W("p", "principal", 0, "Salón");
const reserva = W("r", "reserva", 1, "Reserva");
const fondo = W("f", "otro", 2, "Fondo");
const merma = W("m", "merma", 3, "Merma");

const row = (over: Partial<WarehouseOverviewRow> = {}): WarehouseOverviewRow => ({
  product_id: "prod",
  variant_id: null,
  product_name: "Remera",
  variant_label: null,
  sku: "REM",
  unit: "un",
  store_qty: 20,
  principal_qty: 8,
  in_transit: 0,
  min_qty: null,
  max_qty: null,
  by_warehouse: { r: 12 },
  ...over,
});

describe("depósitos: saldo del salón (espejo de warehouse_principal_qty)", () => {
  it("salón = sucursal − otros depósitos − tránsito", () => {
    expect(principalQty(20, { r: 7 }, 5)).toBe(8);
    expect(principalQty(20, {}, 0)).toBe(20);
  });

  it("puede quedar negativo si se vendió más de lo que había en el salón", () => {
    expect(principalQty(3, { r: 5 }, 0)).toBe(-2);
  });

  it("qtyIn toma el principal de la fila y el resto del desglose", () => {
    const r = row();
    expect(qtyIn(r, principal)).toBe(8);
    expect(qtyIn(r, reserva)).toBe(12);
    expect(qtyIn(r, merma)).toBe(0);
  });

  it("estado del salón: negativo, bajo mínimo u ok", () => {
    expect(salonStatus({ principal_qty: -1, min_qty: null })).toBe("negative");
    expect(salonStatus({ principal_qty: 2, min_qty: 5 })).toBe("below_min");
    expect(salonStatus({ principal_qty: 5, min_qty: 5 })).toBe("ok");
    expect(salonStatus({ principal_qty: 0, min_qty: 0 })).toBe("ok");
  });

  it("ordena con el salón primero", () => {
    expect(sortWarehouses([merma, reserva, principal]).map((w) => w.id)).toEqual(["p", "r", "m"]);
  });
});

describe("depósitos: reposición del salón", () => {
  const whs = [principal, reserva, fondo, merma];

  it("trae hasta el máximo desde la reserva", () => {
    const s = replenishSuggestions([row({ principal_qty: 2, min_qty: 5, max_qty: 10 })], whs);
    expect(s).toEqual([
      expect.objectContaining({ from_warehouse_id: "r", qty: 8, principal_after: 10 }),
    ]);
  });

  it("sin máximo repone hasta el mínimo", () => {
    const s = replenishSuggestions([row({ principal_qty: 2, min_qty: 5 })], whs);
    expect(s[0]?.qty).toBe(3);
  });

  it("negativo sin mínimo: lleva el salón a 0", () => {
    const s = replenishSuggestions([row({ principal_qty: -3 })], whs);
    expect(s[0]?.qty).toBe(3);
    expect(s[0]?.principal_after).toBe(0);
  });

  it("reparte entre depósitos de reserva y nunca toma de merma ni devoluciones", () => {
    const s = replenishSuggestions(
      [row({ principal_qty: 0, min_qty: 10, by_warehouse: { r: 4, f: 3, m: 50 } })],
      whs,
    );
    expect(s.map((x) => [x.from_warehouse_id, x.qty])).toEqual([
      ["r", 4],
      ["f", 3],
    ]);
    expect(s.at(-1)?.principal_after).toBe(7);
  });

  it("no sugiere nada si el salón está bien o no hay de dónde traer", () => {
    expect(replenishSuggestions([row({ principal_qty: 6, min_qty: 5 })], whs)).toEqual([]);
    expect(replenishSuggestions([row({ principal_qty: 0, min_qty: 5, by_warehouse: {} })], whs)).toEqual([]);
  });

  it("agrupa por origen (un movimiento por depósito)", () => {
    const s = replenishSuggestions(
      [
        row({ principal_qty: 0, min_qty: 2, by_warehouse: { r: 5 } }),
        row({ product_id: "otro", principal_qty: 0, min_qty: 2, by_warehouse: { r: 5 } }),
      ],
      whs,
    );
    const g = groupSuggestionsBySource(s);
    expect([...g.keys()]).toEqual(["r"]);
    expect(g.get("r")).toHaveLength(2);
  });
});

describe("depósitos: recepción (espejo de warehouse_move_receive)", () => {
  const items = [{ id: "i1", qty_sent: 5, qty_received: 0 }];

  it("recepción parcial sin cerrar no pide motivo", () => {
    const c = checkReceive(items, [{ item_id: "i1", qty: 3 }], false);
    expect(c.errors).toEqual([]);
    expect(c.completes).toBe(false);
  });

  it("recibir todo cierra solo", () => {
    expect(checkReceive(items, [{ item_id: "i1", qty: 5 }], false).completes).toBe(true);
  });

  it("recibir de más sin cerrar se rechaza", () => {
    expect(checkReceive(items, [{ item_id: "i1", qty: 6 }], false).errors[0]).toMatch(/cerrar/);
  });

  it("al cerrar, cada diferencia lleva su motivo y el sobrante sólo para lo de más", () => {
    expect(checkReceive(items, [{ item_id: "i1", qty: 3 }], true).errors[0]).toMatch(/motivo/);
    expect(checkReceive(items, [{ item_id: "i1", qty: 3, reason: "sobrante" }], true).errors[0]).toMatch(/faltante/i);
    expect(checkReceive(items, [{ item_id: "i1", qty: 7, reason: "faltante" }], true).errors[0]).toMatch(/Sobrante/);
    const ok = checkReceive(items, [{ item_id: "i1", qty: 3, reason: "danado" }], true);
    expect(ok.errors).toEqual([]);
    expect(ok.differences).toEqual([{ item_id: "i1", diff: -2 }]);
  });
});

describe("depósitos: textos y errores", () => {
  it("traduce los errores del servidor", () => {
    expect(warehouseErrorMessage(new Error("insufficient_warehouse_stock"))).toMatch(/No hay stock suficiente/);
    expect(warehouseErrorMessage({ message: "forbidden_differences" })).toMatch(/encargado/);
    expect(warehouseErrorMessage(new Error("feature_not_in_plan: depositos"))).toMatch(/plan/);
    expect(warehouseErrorMessage(new Error("different_store"))).toMatch(/traslado/);
  });

  it("entiende el tipo de depósito escrito a mano en la planilla", () => {
    expect(parseWarehouseKind("Devoluciones")).toBe("devolucion");
    expect(parseWarehouseKind(" RESERVA ")).toBe("reserva");
    expect(parseWarehouseKind("merma")).toBe("merma");
    expect(parseWarehouseKind("Principal")).toBeNull();
    expect(parseWarehouseKind("")).toBeNull();
  });
});

describe("depósitos: plan e importación", () => {
  it("feature OPTIONAL desde Pro que requiere stock", () => {
    expect(FEATURE_INFO.depositos?.minPlan).toBe("Pro");
    expect(featureRequires("depositos")).toEqual(["stock"]);
  });

  it("las dos importaciones están registradas, gateadas y mandan el tipo normalizado", () => {
    const entities = IMPORT_DEFINITIONS.map((d) => d.entity);
    expect(entities).toContain("warehouses");
    expect(entities).toContain("warehouse_stock");
    expect(warehouseImportDefinition.feature).toBe("depositos");
    expect(warehouseStockImportDefinition.feature).toBe("depositos");
    expect(warehouseImportDefinition.toPayload?.({ store: null, name: "Fondo", code: "F", kind: "Devoluciones" })).toEqual(
      { store: null, name: "Fondo", code: "F", kind: "devolucion" },
    );
    expect(
      warehouseStockImportDefinition.toPayload?.({
        store: null,
        warehouse: null,
        warehouse_code: "F",
        sku: "A",
        barcode: null,
        product: "ref",
        qty: 2,
      }),
    ).not.toHaveProperty("product");
  });
});
