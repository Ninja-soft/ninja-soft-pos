// ADR-146: atajos de entrega de la hoja de cobro (puros) y contrato de la
// migración que agrega el costo de envío a pos_sale_create_fulfilled.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deliverySummary,
  envioAllocations,
  envioGroupKey,
  fulfillmentErrorMessage,
  groupDeliveries,
  pickupStoreOptions,
  retiroAllocations,
  shippingFeeOf,
  type FulfillmentLine,
  type FulfillmentSource,
} from "@/lib/stock/fulfillment";
import { planForChoice } from "@/components/pos/checkout/CheckoutDeliveryBlock";

const lines: FulfillmentLine[] = [
  { key: "p1|", productId: "p1", variantId: null, name: "Campera", quantity: 3, localOnly: false },
  { key: "k1|", productId: "k1", variantId: null, name: "Combo", quantity: 1, localOnly: true },
];
const src = (product_id: string, store_id: string, available: number, warehouse_id: string | null = null): FulfillmentSource => ({
  product_id,
  variant_id: null,
  store_id,
  store_name: store_id === "B" ? "Norte" : store_id === "C" ? "Oeste" : "Centro",
  warehouse_id,
  warehouse_name: "Salón",
  kind: "principal",
  own_store: store_id === "A",
  sale_priority: 0,
  available,
});
const sources = [src("p1", "A", 10), src("p1", "B", 2, "wb"), src("p1", "C", 5, "wc")];
const stores = [
  { id: "A", name: "Centro" },
  { id: "B", name: "Norte" },
  { id: "C", name: "Oeste" },
  { id: "D", name: "Sur" },
];
const names = (id: string) => stores.find((s) => s.id === id)?.name ?? "?";

describe("retiro en otra sucursal", () => {
  it("sin retiro cruzado: sólo con el stock de esa sucursal y los combos no viajan", () => {
    const r = retiroAllocations(lines, sources, "A", "C", false);
    expect(r.missing).toEqual(["Combo"]);
    const only = retiroAllocations([lines[0]!], sources, "A", "C", false);
    expect(only.missing).toEqual([]);
    expect(only.allocations).toEqual([
      expect.objectContaining({ key: "p1|", qty: 3, sourceStoreId: "C", sourceWarehouseId: "wc", mode: "retiro", fulfillmentStoreId: "C" }),
    ]);
  });

  it("con retiro cruzado: lo que falta sale de acá y se retira allá", () => {
    const r = retiroAllocations(lines, sources, "A", "B", true);
    expect(r.missing).toEqual([]);
    expect(r.allocations.map((a) => [a.key, a.qty, a.sourceStoreId, a.fulfillmentStoreId])).toEqual([
      ["p1|", 2, "B", "B"],
      ["p1|", 1, "A", "B"],
      ["k1|", 1, "A", "B"],
    ]);
  });

  it("opciones: primero las que tienen todo; con retiro cruzado suma las sucursales sin stock", () => {
    const strict = pickupStoreOptions([lines[0]!], sources, "A", stores, false);
    expect(strict.map((o) => [o.storeName, o.complete])).toEqual([
      ["Oeste", true],
      ["Norte", false],
    ]);
    const cross = pickupStoreOptions([lines[0]!], sources, "A", stores, true);
    expect(cross.map((o) => o.storeId)).toEqual(["B", "C", "D"]);
    expect(cross.every((o) => o.complete)).toBe(true);
  });
});

describe("envío y resumen", () => {
  it("todo por envío desde el salón propio, una sola entrega", () => {
    const a = envioAllocations(lines, "A");
    const g = groupDeliveries(a, "A");
    expect(g).toHaveLength(1);
    expect(g[0]!.groupKey).toBe(envioGroupKey("A"));
  });

  it("resumen en una línea con el domicilio", () => {
    const a = [
      { id: "1", key: "p1|", qty: 2, sourceStoreId: "A", sourceWarehouseId: null, mode: "ahora" as const, fulfillmentStoreId: null },
      { id: "2", key: "p1|", qty: 1, sourceStoreId: "A", sourceWarehouseId: null, mode: "envio" as const, fulfillmentStoreId: null },
      { id: "3", key: "k1|", qty: 3, sourceStoreId: "B", sourceWarehouseId: null, mode: "retiro" as const, fulfillmentStoreId: "B" },
    ];
    const g = groupDeliveries(a, "A");
    expect(deliverySummary(g, names, { [envioGroupKey("A")]: { shipAddress: "Calle 12 345" } })).toBe(
      "2 se lleva ahora · 1 envío a Calle 12 345 · 3 retira en Norte",
    );
    expect(deliverySummary(g, names)).toContain("1 por envío desde Centro");
  });

  it("costo de envío en criollo", () => {
    expect(shippingFeeOf("1.500")).toBe(1500);
    expect(shippingFeeOf("1.500,50")).toBe(1500.5);
    expect(shippingFeeOf("$ 2500")).toBe(2500);
    expect(shippingFeeOf("1500.5")).toBe(1500.5);
    expect(shippingFeeOf("")).toBe(0);
    expect(shippingFeeOf("-3")).toBe(0);
    expect(shippingFeeOf("abc")).toBe(0);
  });

  it("planForChoice: envío con costo y retiro sin nombre", () => {
    const rules = { storeId: "A", retiroEnabled: true, envioEnabled: true, retiroCrossBranch: false };
    const ctx = { lines: [lines[0]!], sources, rules, storeName: names, customerName: null, customerId: "cli-1" };
    const envio = planForChoice({ kind: "envio", address: "Calle 12 345", fee: 800 }, ctx);
    expect(envio.error).toBeNull();
    expect(envio.plan).toMatchObject({ shipping_fee: 800, deliveries: [{ mode: "envio", ship_address: "Calle 12 345" }] });
    const retiro = planForChoice({ kind: "retiro", storeId: "C", pickupName: "" }, ctx);
    expect(retiro).toMatchObject({ plan: null, error: "Cargá quién retira (o elegí un cliente)." });
    const ok = planForChoice({ kind: "retiro", storeId: "C", pickupName: "Ana" }, ctx);
    expect(ok.plan?.deliveries[0]).toMatchObject({ mode: "retiro", fulfillment_store_id: "C", pickup_name: "Ana" });
    expect(planForChoice({ kind: "retiro", storeId: "B", pickupName: "Ana" }, ctx).error).toMatch(/No alcanza en Norte/);
    expect(planForChoice({ kind: "ahora" }, ctx)).toEqual({ choice: null, state: null, plan: null, error: null });
    // ADR-157: sin cliente no hay envío.
    const sinCliente = planForChoice({ kind: "envio", address: "Calle 12 345", fee: 0 }, { ...ctx, customerId: null });
    expect(sinCliente).toMatchObject({ plan: null, error: "Para enviar elegí o cargá un cliente." });
  });

  it("errores nuevos del servidor en criollo", () => {
    expect(fulfillmentErrorMessage(new Error("shipping_fee_requires_envio"))).toBe("El costo de envío va con una entrega por envío.");
    expect(fulfillmentErrorMessage(new Error("invalid_shipping_fee"))).toBe("Revisá el costo de envío.");
  });
});

describe("migración 20261215100000_cobro_envio_costo", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261215100000_cobro_envio_costo.sql"), "utf8");

  it("redefine pos_sale_create_fulfilled con la misma firma, sin tocar create_sale", () => {
    expect(sql).toMatch(/create or replace function public\.pos_sale_create_fulfilled\(p_sale jsonb, p_plan jsonb\)/);
    expect(sql).not.toMatch(/create or replace function public\.create_sale/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/tenant_has_feature_for\(v_tenant, 'entregas_remitos'\)/);
    expect(sql).toMatch(/revoke all on function public\.pos_sale_create_fulfilled\(jsonb, jsonb\) from public, anon/);
    expect(sql).toMatch(/grant execute on function public\.pos_sale_create_fulfilled\(jsonb, jsonb\) to authenticated/);
    // Un solo cuerpo, bien cerrado.
    expect(sql.match(/\$\$/g)).toHaveLength(2);
  });

  it("el costo pide un envío, va como renglón Envío y como recargo (no venta libre) y queda auditado", () => {
    expect(sql).toMatch(/raise exception 'shipping_fee_requires_envio'/);
    expect(sql).toMatch(/raise exception 'invalid_shipping_fee'/);
    expect(sql).toMatch(/'product_id', null, 'name', 'Envío', 'quantity', 1, 'unit_price', v_fee/);
    expect(sql).toMatch(/jsonb_build_object\('kind', 'surcharge', 'amount', v_fee\)/);
    expect(sql).toMatch(/p_items\s+=> v_items/);
    expect(sql).toMatch(/p_extras\s+=> v_extras/);
    expect(sql).toMatch(/'shipping_fee', v_fee/);
    // Sin costo, los ítems y extras son los mismos que manda el POS.
    expect(sql).toMatch(/v_items  := coalesce\(p_sale -> 'p_items', '\[\]'::jsonb\);/);
  });
});
