// ADR-096: create_sale con reservas de stock (ADR-091) y garantía extendida
// enlazada (ADR-092). Helpers del front y chequeos estáticos de la migración
// (la lógica SQL la cubre tests/integration/create-sale-reservas-garantia.test.ts;
// la copia fiel de create_sale, tests/unit/createSaleDeudas.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildSaleItemsAndExtras, warrantyLink, type SaleArgsLine } from "@/modules/pending-charges/logic";
import { saleErrorTitle } from "@/modules/pos/screen/usePosSale";

const MIG = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261109500000_create_sale_reservas_garantia.sql"),
  "utf8",
);

const line = (p: Partial<SaleArgsLine>): SaleArgsLine => ({
  productId: "p1",
  name: "Celular",
  quantity: 1,
  unitPrice: 1000,
  discount: 0,
  ...p,
});

describe("garantía enlazada: payload del POS", () => {
  it("la línea de garantía apunta al índice de la línea que cubre", () => {
    const lines = [line({ lineId: "a" }), line({ lineId: "b", productId: "p2", name: "Tablet" })];
    const { items, extras } = buildSaleItemsAndExtras(lines, [
      { kind: "warranty", name: "Garantía Max", amount: 500, planId: "plan-max", forLineId: "b" },
    ]);
    expect(items[2]).toEqual({
      product_id: null,
      name: "Garantía Max",
      quantity: 1,
      unit_price: 500,
      discount: 0,
      warranty_plan_id: "plan-max",
      warranty_for: 1,
    });
    // El extra sigue siendo sólo la señal de gating (sin plan ni línea).
    expect(extras).toEqual([{ kind: "warranty", amount: 500 }]);
    // Las líneas de producto no llevan el id local del carrito.
    expect(items[0]).not.toHaveProperty("lineId");
  });

  it("sin plan, sin línea o con una línea sin producto va sin vínculo (fallback por nombre)", () => {
    const lines = [line({ lineId: "a" }), line({ lineId: "free", productId: null, name: "Varios" })];
    expect(warrantyLink(lines, { planId: "x" })).toEqual({});
    expect(warrantyLink(lines, { forLineId: "a" })).toEqual({});
    expect(warrantyLink(lines, { planId: "x", forLineId: "zzz" })).toEqual({});
    expect(warrantyLink(lines, { planId: "x", forLineId: "free" })).toEqual({});
    expect(warrantyLink(lines, { planId: "x", forLineId: "a" })).toEqual({ warranty_plan_id: "x", warranty_for: 0 });
    const { items } = buildSaleItemsAndExtras(lines, [{ kind: "surcharge", name: "Recargo", amount: 50, planId: "x", forLineId: "a" }]);
    expect(items[2]).not.toHaveProperty("warranty_plan_id");
  });
});

describe("mensajes del POS", () => {
  it("errores nuevos de create_sale", () => {
    expect(saleErrorTitle("insufficient_stock_reserved")).toMatch(/reservado/);
    expect(saleErrorTitle("reservation_not_verified")).toMatch(/Validá/);
    expect(saleErrorTitle("reservation_items_mismatch")).toMatch(/todos los productos/);
    expect(saleErrorTitle("reservation_wrong_store")).toMatch(/otra sucursal/);
    expect(saleErrorTitle("reservation_not_open")).toMatch(/vigente/);
    expect(saleErrorTitle("warranty_link_invalid")).toMatch(/garantía/);
    // insufficient_stock_reserved no cae en el mensaje genérico de sucursal o salón.
    expect(saleErrorTitle("insufficient_stock_reserved")).not.toMatch(/sucursal|salón/);
  });
});

describe("migración 20261109500000", () => {
  it("identidad validada antes de cobrar, con los intentos contados como en la entrega", () => {
    expect(MIG).toMatch(/create or replace function stock_reservation_pickup_verify\(/);
    expect(MIG).toContain("'stock_reservation_pickup_failed'");
    expect(MIG).toContain("'stock_reservation_pickup_verified'");
    expect(MIG).toContain("override_requires_manager");
    expect(MIG).toMatch(/failed_attempts < 5/);
    expect(MIG).toMatch(/pickup_verified_at < now\(\) - interval '2 hours'/);
  });

  it("FKs nuevas con índice", () => {
    expect(MIG).toMatch(/on stock_reservations\(pickup_verified_by\)/);
    expect(MIG).toMatch(/on sale_items\(warranty_plan_id\)/);
    expect(MIG).toMatch(/on sale_items\(warranty_for_item_id\)/);
  });

  it("sin policies nuevas, audit_logs sólo con inserts y SECURITY DEFINER con search_path", () => {
    expect(MIG).not.toMatch(/create policy/i);
    expect(MIG).not.toMatch(/is_internal\(\)/);
    expect(MIG).not.toMatch(/(update|delete from) audit_logs/i);
    const fns = MIG.split(/create or replace function /i).slice(1);
    expect(fns.length).toBe(4);
    for (const f of fns) {
      const head = f.slice(0, f.search(/\$(function)?\$/));
      if (/security definer/i.test(head)) expect(head.toLowerCase()).toMatch(/set search_path/);
    }
    expect(MIG).toMatch(/revoke all on function _sale_reserved_short\([^)]*\) from public, anon, authenticated/);
    expect(MIG).toMatch(/grant execute on function stock_reservation_pickup_verify\([^)]*\) to authenticated/);
  });

  it("serial_lookup usa el vínculo y cae al nombre sólo en ventas sin vínculo", () => {
    expect(MIG).toMatch(/gi\.warranty_for_item_id = so\.line_id/);
    expect(MIG).toMatch(/not exists \(select 1 from sale_items gx\s+where gx\.sale_id = so\.sale_id and gx\.warranty_for_item_id is not null\)/);
    expect(MIG).toContain("'extended_link'");
  });

  it("sin em dash", () => {
    expect(MIG).not.toContain("—");
  });
});
