// =============================================================================
// ADR-136: depósitos vendibles por sucursal, venta de otras sucursales y
// entregas partidas. Lógica pura (reparto, agrupado, validación, plan),
// helpers de depósitos y contratos de las migraciones (gating, RLS, auditoría,
// sin recrear create_sale).
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlan,
  checkAllocations,
  fulfillmentErrorMessage,
  fulfillmentLines,
  groupDeliveries,
  isTrivialPlan,
  lineKey,
  shortInSalon,
  sourceLabel,
  sourcesFor,
  suggestAllocations,
  type Allocation,
  type FulfillmentRules,
  type FulfillmentSource,
} from "@/lib/stock/fulfillment";
import {
  defaultVisibleWarehouses,
  isSellable,
  sellableQty,
  warehouseErrorMessage,
  warehouseUsedBy,
  type Warehouse,
  type WarehouseOverviewRow,
} from "@/lib/stock/warehouses";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const FEAT = readFileSync(join(MIG_DIR, "20261202100000_features_entregas_remitos.sql"), "utf8");
const MAIN = readFileSync(join(MIG_DIR, "20261202100100_depositos_venta_entregas.sql"), "utf8");

const A = "store-a";
const B = "store-b";
const CAMP = "p-campera";
const KIT = "p-combo";

const src = (p: Partial<FulfillmentSource>): FulfillmentSource => ({
  product_id: CAMP,
  variant_id: null,
  store_id: A,
  store_name: "Centro",
  warehouse_id: null,
  warehouse_name: "Salón de ventas",
  kind: "principal",
  own_store: true,
  sale_priority: 0,
  available: 0,
  ...p,
});

const SOURCES: FulfillmentSource[] = [
  src({ available: 2 }),
  src({ warehouse_id: "w-central", warehouse_name: "Central", kind: "reserva", sale_priority: 10, available: 1 }),
  src({ warehouse_id: "w-altillo", warehouse_name: "Altillo", kind: "otro", sale_priority: 50, available: 5 }),
  src({ store_id: B, store_name: "Norte", warehouse_id: "w-norte", warehouse_name: "Depósito", kind: "reserva", own_store: false, sale_priority: 10, available: 6 }),
  src({ store_id: B, store_name: "Norte", warehouse_id: "w-salon-b", warehouse_name: "Salón de ventas", kind: "principal", own_store: false, sale_priority: 50, available: 4 }),
];

const RULES: FulfillmentRules = { storeId: A, retiroEnabled: true, envioEnabled: true, retiroCrossBranch: false };

describe("ADR-136 · renglones del reparto", () => {
  it("suma por producto y variante, sin servicios ni ítems libres", () => {
    const lines = fulfillmentLines(
      [
        { productId: CAMP, name: "Campera", quantity: 2 },
        { productId: CAMP, name: "Campera", quantity: 3 },
        { productId: CAMP, variantId: "v-m", variantLabel: "M", name: "Campera", quantity: 1 },
        { productId: "p-serv", name: "Instalación", quantity: 1 },
        { productId: null, name: "Varios", quantity: 1 },
        { productId: KIT, name: "Combo", quantity: 1 },
      ],
      (id) => (id === "p-serv" ? { service: true, localOnly: true } : { service: false, localOnly: id === KIT }),
    );
    expect(lines.map((l) => [l.key, l.quantity, l.localOnly])).toEqual([
      [lineKey(CAMP, null), 5, false],
      [lineKey(CAMP, "v-m"), 1, false],
      [lineKey(KIT, null), 1, true],
    ]);
    expect(lines[1]!.name).toBe("Campera (M)");
  });

  it("orden de los orígenes: salón propio, depósitos propios por prioridad, otras sucursales", () => {
    const line = { productId: CAMP, variantId: null, localOnly: false };
    expect(sourcesFor(SOURCES, line).map((s) => s.warehouse_id)).toEqual([null, "w-central", "w-altillo", "w-norte", "w-salon-b"]);
    expect(sourcesFor(SOURCES, { ...line, localOnly: true }).map((s) => s.warehouse_id)).toEqual([null]);
  });

  it("etiquetas de origen", () => {
    expect(sourceLabel(SOURCES[0]!)).toBe("Salón de ventas");
    expect(sourceLabel(SOURCES[1]!)).toBe("Central");
    expect(sourceLabel(SOURCES[3]!)).toBe("Norte · Depósito");
    expect(sourceLabel(SOURCES[4]!)).toBe("Norte · Salón");
  });
});

describe("ADR-136 · reparto sugerido", () => {
  const lines = fulfillmentLines([{ productId: CAMP, name: "Campera", quantity: 10 }], () => ({ service: false, localOnly: false }));

  it("toma el salón, los depósitos propios y después otra sucursal (retiro allá)", () => {
    const a = suggestAllocations(lines, SOURCES, A);
    expect(a.map((x) => [x.qty, x.sourceStoreId, x.sourceWarehouseId, x.mode, x.fulfillmentStoreId])).toEqual([
      [2, A, null, "ahora", null],
      [1, A, "w-central", "ahora", null],
      [5, A, "w-altillo", "ahora", null],
      [2, B, "w-norte", "retiro", B],
    ]);
    expect(a.reduce((t, x) => t + x.qty, 0)).toBe(10);
  });

  it("si no alcanza en ningún lado, lo que falta queda en el salón propio (decide el servidor)", () => {
    const a = suggestAllocations(fulfillmentLines([{ productId: CAMP, name: "Campera", quantity: 30 }], () => ({ service: false, localOnly: false })), SOURCES, A);
    const own = a.find((x) => x.sourceStoreId === A && x.sourceWarehouseId === null)!;
    expect(own.qty).toBe(2 + (30 - 18));
    expect(a.reduce((t, x) => t + x.qty, 0)).toBe(30);
  });

  it("todo del salón propio es una venta normal (sin plan)", () => {
    const one = suggestAllocations(fulfillmentLines([{ productId: CAMP, name: "Campera", quantity: 2 }], () => ({ service: false, localOnly: false })), SOURCES, A);
    expect(isTrivialPlan(one, A)).toBe(true);
    expect(isTrivialPlan(suggestAllocations(lines, SOURCES, A), A)).toBe(false);
  });

  it("detecta lo que no alcanza en el salón", () => {
    expect(shortInSalon(lines, SOURCES).map((l) => l.productId)).toEqual([CAMP]);
  });
});

describe("ADR-136 · entregas y validación", () => {
  const lines = fulfillmentLines([{ productId: CAMP, name: "Campera", quantity: 5 }], () => ({ service: false, localOnly: false }));
  const alloc = (p: Partial<Allocation>): Allocation => ({
    id: Math.random().toString(36),
    key: lineKey(CAMP, null),
    qty: 1,
    sourceStoreId: A,
    sourceWarehouseId: null,
    mode: "ahora",
    fulfillmentStoreId: null,
    ...p,
  });

  it("agrupa por modalidad, origen y lugar de retiro; ahora primero", () => {
    const g = groupDeliveries(
      [
        alloc({ qty: 3, sourceStoreId: B, sourceWarehouseId: "w-norte", mode: "retiro", fulfillmentStoreId: B }),
        alloc({ qty: 2 }),
        alloc({ qty: 1, sourceStoreId: B, sourceWarehouseId: "w-salon-b", mode: "retiro", fulfillmentStoreId: B }),
      ],
      A,
    );
    expect(g.map((x) => [x.mode, x.originStoreId, x.fulfillmentStoreId, x.allocations.length])).toEqual([
      ["ahora", A, A, 1],
      ["retiro", B, B, 2],
    ]);
  });

  it("la suma de cada renglón tiene que ser lo vendido", () => {
    expect(checkAllocations(lines, [alloc({ qty: 2 })], RULES)).toContain("Campera: repartiste 2 de 5.");
    expect(checkAllocations(lines, [alloc({ qty: 2 }), alloc({ qty: 3, mode: "retiro", fulfillmentStoreId: A })], RULES)).toEqual([]);
  });

  it("lo de otra sucursal no se lleva ahora; retiro en otra sucursal sólo con cross-branch; envío con domicilio", () => {
    expect(checkAllocations(lines, [alloc({ qty: 5, sourceStoreId: B })], RULES).join()).toMatch(/no se lo lleva ahora/);
    const cross = [alloc({ qty: 5, sourceStoreId: B, mode: "retiro", fulfillmentStoreId: A })];
    expect(checkAllocations(lines, cross, RULES).join()).toMatch(/otra sucursal que la de origen/);
    expect(checkAllocations(lines, cross, { ...RULES, retiroCrossBranch: true })).toEqual([]);
    const envio = [alloc({ qty: 5, mode: "envio" })];
    expect(checkAllocations(lines, envio, RULES).join()).toMatch(/domicilio/);
    expect(checkAllocations(lines, envio, RULES, { [`envio|${A}|${A}`]: { shipAddress: "Calle 9 123" } })).toEqual([]);
    expect(checkAllocations(lines, envio, { ...RULES, envioEnabled: false }).join()).toMatch(/envío está apagado/);
  });

  it("combos y productos sin control: sólo del salón propio", () => {
    const kit = fulfillmentLines([{ productId: KIT, name: "Combo", quantity: 1 }], () => ({ service: false, localOnly: true }));
    expect(checkAllocations(kit, [alloc({ key: lineKey(KIT, null), qty: 1, sourceStoreId: B, mode: "retiro" })], RULES).join()).toMatch(/combos/);
  });

  it("arma el payload de pos_sale_create_fulfilled", () => {
    const allocs = [
      alloc({ qty: 2, sourceWarehouseId: "w-central" }),
      alloc({ qty: 3, sourceStoreId: B, sourceWarehouseId: "w-norte", mode: "retiro", fulfillmentStoreId: B }),
    ];
    const plan = buildPlan(lines, allocs, A, { [`retiro|${B}|${B}`]: { pickupName: " Ana " } });
    expect(plan).toEqual({
      deliveries: [
        {
          mode: "ahora",
          fulfillment_store_id: null,
          pickup_name: null,
          ship_address: null,
          notes: null,
          items: [{ product_id: CAMP, variant_id: null, qty: 2, source_store_id: A, source_warehouse_id: "w-central" }],
        },
        {
          mode: "retiro",
          fulfillment_store_id: B,
          pickup_name: "Ana",
          ship_address: null,
          notes: null,
          items: [{ product_id: CAMP, variant_id: null, qty: 3, source_store_id: B, source_warehouse_id: "w-norte" }],
        },
      ],
    });
  });

  it("traduce los errores del servidor", () => {
    expect(fulfillmentErrorMessage(new Error("insufficient_source_stock: Campera"))).toBe(
      "No alcanza el stock en el origen elegido (Campera). Actualizá y volvé a repartir.",
    );
    expect(fulfillmentErrorMessage({ message: "source_not_available" })).toMatch(/no está habilitado para esta sucursal/);
    expect(fulfillmentErrorMessage("feature_not_in_plan: entregas_remitos")).toMatch(/Tu plan/);
    expect(fulfillmentErrorMessage("price_mismatch")).toBeNull();
  });
});

describe("ADR-136 · depósitos vendibles", () => {
  const wh = (p: Partial<Warehouse>): Warehouse => ({ id: "x", store_id: A, name: "X", code: null, kind: "reserva", sort: 0, ...p });
  const row: WarehouseOverviewRow = {
    product_id: CAMP,
    variant_id: null,
    product_name: "Campera",
    variant_label: null,
    sku: null,
    unit: "un",
    store_qty: 10,
    principal_qty: 3,
    in_transit: 0,
    min_qty: null,
    max_qty: null,
    by_warehouse: { c: 4, m: 1, a: 2 },
  };

  it("vendible por columna o, sin la migración, por tipo", () => {
    expect(isSellable(wh({ kind: "merma" }))).toBe(false);
    expect(isSellable(wh({ kind: "devolucion" }))).toBe(false);
    expect(isSellable(wh({ kind: "reserva" }))).toBe(true);
    expect(isSellable(wh({ kind: "reserva", sellable: false }))).toBe(false);
    expect(isSellable(wh({ kind: "principal", sellable: false }))).toBe(true);
  });

  it("vendible de la sucursal: salón + depósitos que se venden", () => {
    const list = [wh({ id: "p", kind: "principal" }), wh({ id: "c" }), wh({ id: "m", kind: "merma" }), wh({ id: "a", kind: "otro", sellable: false })];
    expect(sellableQty(row, list)).toBe(3 + 4);
  });

  it("quién más vende un depósito y columnas por defecto con muchos depósitos", () => {
    const names: Record<string, string> = { b: "Norte", c: "Sur" };
    expect(warehouseUsedBy({ id: "c" }, [{ warehouse_id: "c", store_id: "c" }, { warehouse_id: "c", store_id: "b" }, { warehouse_id: "z", store_id: "b" }], (id) => names[id])).toEqual([
      "Norte",
      "Sur",
    ]);
    const many = Array.from({ length: 7 }, (_, i) => wh({ id: `w${i}`, name: `D${i}`, sort: 7 - i, kind: i === 3 ? "principal" : "reserva" }));
    const vis = defaultVisibleWarehouses(many, 4);
    expect(vis).toHaveLength(4);
    expect(vis[0]).toBe("w3");
  });

  it("errores de la configuración", () => {
    expect(warehouseErrorMessage(new Error("invalid_priority"))).toBe("La prioridad va de 0 a 999.");
    expect(warehouseErrorMessage(new Error("feature_not_in_plan: stock_sucursales"))).toMatch(/stock por sucursal/);
  });
});

describe("ADR-136 · contratos de las migraciones", () => {
  it("feature OPTIONAL entregas_remitos en Pro, Business y Enterprise, con su copy", () => {
    expect(FEAT).toMatch(/'entregas_remitos'[\s\S]*'ventas', false/);
    expect(FEAT).toMatch(/p\.key in \('pro', 'business', 'enterprise'\)/);
    expect(FEATURE_INFO.entregas_remitos?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.entregas_remitos?.requires).toEqual(["pedidos_despacho", "depositos"]);
  });

  it("no recrea create_sale: la llama con argumentos con nombre", () => {
    expect(MAIN).not.toMatch(/create or replace function (public\.)?create_sale\(/i);
    expect(MAIN).toMatch(/v_res := create_sale\(\s*p_items\s*=>/);
  });

  it("gating real en el servidor", () => {
    for (const k of ["entregas_remitos", "stock_sucursales", "depositos", "pedidos_despacho"]) {
      expect(MAIN).toContain(`tenant_has_feature_for(v_tenant, '${k}')`);
    }
    expect(MAIN).toMatch(/warehouse_config_save[\s\S]*warehouse_assert\(v_wh\.store_id\)/);
  });

  it("la venta toma de los depósitos vendibles por prioridad", () => {
    expect(MAIN).toMatch(/w\.kind <> 'principal' and w\.sellable\s+order by w\.sale_priority/);
  });

  it("RLS: (select current_tenant_id()), internal_scope, nunca is_internal(); sin escritura por REST", () => {
    const code = MAIN.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/is_internal\(\)/);
    expect(MAIN).toMatch(/warehouse_store_links_select[\s\S]*\(select current_tenant_id\(\)\) or \(select internal_scope\(\)\)/);
    expect(MAIN).toMatch(/dispatch_items_branch_scope[\s\S]*as restrictive/);
    expect(MAIN).toMatch(/revoke all on dispatch_items from anon, authenticated;\s*grant select on dispatch_items to authenticated;/);
    expect(MAIN).not.toMatch(/create policy \w+ on \w+\s+for (insert|update|delete)/i);
  });

  it("auditoría de cada operación", () => {
    for (const a of ["warehouse_config_saved", "warehouse_principal_created", "sale_delivery_split", "sale_cross_store", "sale_from_warehouse", "dispatch_created"]) {
      expect(MAIN).toContain(a);
    }
  });
});
