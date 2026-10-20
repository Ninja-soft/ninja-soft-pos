// F24 · H163 (ADR-177): catálogo PRO. Códigos alternativos, unidades de venta
// con coeficiente, uso del artículo, duplicar y PLU sin ceros.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  barcodeTakenMessage,
  codeError,
  copyName,
  diffAltCodes,
  diffSaleUnits,
  duplicateCodes,
  expandSaleUnitLine,
  isPurchasable,
  isSellable,
  normalizeCode,
  pluCandidates,
  repriceSaleUnit,
  saleUnitError,
  saleUnitPrice,
  type CartSaleUnit,
  type SaleUnit,
} from "@/lib/products/catalogCodes";
import { findCodeInSnapshot, searchSnapshot } from "@/lib/pos/offline/snapshot";
import { buildSaleItemsAndExtras } from "@/modules/pending-charges/logic";
import { repriceChanges } from "@/lib/pos/priceMismatch";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20270115100000_h163_catalogo.sql"), "utf8");

const unit = (o: Partial<SaleUnit> = {}): SaleUnit => ({
  id: null,
  label: "Caja",
  units: 12,
  price: null,
  discountPct: 0,
  barcode: "",
  isActive: true,
  ...o,
});

describe("Códigos", () => {
  it("normaliza y valida como la base", () => {
    expect(normalizeCode(" 779 123 abc ")).toBe("779123ABC");
    expect(codeError("")).toBe("Escribí el código");
    expect(codeError("7791234567890")).toBeNull();
    expect(codeError("ab/12")).not.toBeNull();
  });

  it("detecta repetidos y el principal", () => {
    const d = duplicateCodes("779", [{ code: "779" }, { code: "a1" }, { code: "A1" }, { code: "b" }]);
    expect([...d].sort()).toEqual(["779", "A1"]);
  });

  it("diff: alta, baja y cambio (baja + alta)", () => {
    const saved = [
      { id: "1", code: "AAA", supplierId: null, variantId: null },
      { id: "2", code: "BBB", supplierId: null, variantId: null },
    ];
    const edited = [
      { id: "1", code: "AAA", supplierId: "s1", variantId: null },
      { id: null, code: "ccc", supplierId: null, variantId: null },
    ];
    const d = diffAltCodes(saved, edited);
    expect(d.remove.sort()).toEqual(["1", "2"]);
    expect(d.insert.map((i) => i.code).sort()).toEqual(["AAA", "CCC"]);
  });

  it("mensaje de código en uso", () => {
    expect(barcodeTakenMessage(new Error("barcode_taken:product"))).toMatch(/principal de otro/);
    expect(barcodeTakenMessage(new Error("barcode_taken:sale_unit"))).toMatch(/unidad de venta/);
    expect(barcodeTakenMessage(new Error("otra cosa"))).toBeNull();
  });

  it("PLU sin ceros a la izquierda", () => {
    expect(pluCandidates("42")).toEqual(["42", "000042"]);
    expect(pluCandidates("123456")).toEqual(["123456"]);
  });
});

describe("Unidades de venta", () => {
  it("precio derivado, explícito y nunca más que las sueltas", () => {
    expect(saleUnitPrice(unit(), 100)).toBe(1200);
    expect(saleUnitPrice(unit({ discountPct: 10 }), 100)).toBe(1080);
    expect(saleUnitPrice(unit({ price: 1000 }), 100)).toBe(1000);
    expect(saleUnitPrice(unit({ price: 5000 }), 100)).toBe(1200);
    // Sin descuentos (no bonificable o sin la feature): N × precio.
    expect(saleUnitPrice(unit({ price: 1000 }), 100, false)).toBe(1200);
  });

  it("no se combina con pesables, variantes ni serializados", () => {
    expect(saleUnitError(unit(), { unit: "kg" })).toMatch(/pesable/);
    expect(saleUnitError(unit(), { has_variants: true })).toMatch(/variantes/);
    expect(saleUnitError(unit({ units: 1 }), { unit: "un" })).toMatch(/2 a 10/);
    expect(saleUnitError(unit(), { unit: "un" })).toBeNull();
  });

  it("diff de unidades", () => {
    const saved = [unit({ id: "u1" }), unit({ id: "u2", label: "Pack", units: 6 })];
    const d = diffSaleUnits(saved, [unit({ id: "u1", price: 900 }), unit({ label: "Bulto", units: 24 })]);
    expect(d.remove).toEqual(["u2"]);
    expect(d.update.map((u) => u.id)).toEqual(["u1"]);
    expect(d.insert).toHaveLength(1);
  });

  const su: CartSaleUnit = { id: "su1", units: 12, basePrice: 100, label: "Caja", price: 1000, discountPct: 0, allowDiscount: true };

  it("el renglón del bulto se expande a unidades con el descuento del bulto", () => {
    expect(expandSaleUnitLine({ quantity: 2, unitPrice: 1000, discount: 0, saleUnit: su })).toEqual({
      quantity: 24,
      unit_price: 100,
      discount: 400,
    });
    const { items } = buildSaleItemsAndExtras(
      [{ productId: "p1", name: "Gaseosa", quantity: 2, unitPrice: 1000, discount: 50, saleUnit: su }],
      [],
    );
    expect(items[0]).toMatchObject({ product_id: "p1", quantity: 24, unit_price: 100, discount: 450, sale_unit_id: "su1" });
    // Sin bulto, igual que siempre.
    const plain = buildSaleItemsAndExtras([{ productId: "p1", name: "G", quantity: 3, unitPrice: 100, discount: 0 }], []);
    expect(plain.items[0]).toMatchObject({ quantity: 3, unit_price: 100, discount: 0 });
    expect(plain.items[0]).not.toHaveProperty("sale_unit_id");
  });

  it("repreciado: el servidor manda el unitario y se recalcula el bulto", () => {
    expect(repriceSaleUnit({ ...su, price: null }, 110).to).toBe(1320);
    const ch = repriceChanges(
      [{ lineId: "l1", productId: "p1", name: "Gaseosa", unitPrice: 1000, saleUnit: { ...su, price: null } }],
      [{ productId: "p1", variantId: null, expected: 110, received: 100 }],
    );
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ to: 1320, saleUnit: { basePrice: 110 } });
  });
});

describe("Uso, duplicar y POS sin conexión", () => {
  it("compra, venta o ambos", () => {
    expect(isSellable({ usage: "purchase" })).toBe(false);
    expect(isSellable({ usage: null })).toBe(true);
    expect(isPurchasable({ usage: "sale" })).toBe(false);
    expect(isPurchasable({})).toBe(true);
  });

  it("nombre de la copia", () => {
    expect(copyName("Yerba 1 kg")).toBe("Yerba 1 kg (COPIA)");
    expect(copyName("Yerba (COPIA)")).toBe("Yerba (COPIA)");
    expect(copyName("x".repeat(130))).toHaveLength(120);
  });

  const snap = [
    { id: "a", name: "Gaseosa", barcode: "779", sku: null, plu: "000042", product_barcodes: [{ code: "OLD1" }], product_sale_units: [{ id: "su1", label: "Caja", units: 12, price: null, discount_pct: 0, barcode: "DUN12", is_active: true }] },
    { id: "b", name: "Harina insumo", barcode: "123", sku: null, plu: null, usage: "purchase" },
  ];

  it("encuentra por alternativo, bulto y PLU sin ceros", () => {
    expect(findCodeInSnapshot(snap, "779")?.product.id).toBe("a");
    expect(findCodeInSnapshot(snap, "old1")?.product.id).toBe("a");
    expect(findCodeInSnapshot(snap, "DUN12")?.saleUnit?.id).toBe("su1");
    expect(findCodeInSnapshot(snap, "42")?.product.id).toBe("a");
    expect(findCodeInSnapshot(snap, "nada")).toBeNull();
  });

  it("la búsqueda local no muestra insumos y busca por alternativos", () => {
    expect(searchSnapshot(snap, "").map((p) => p.id)).toEqual(["a"]);
    expect(searchSnapshot(snap, "OLD").map((p) => p.id)).toEqual(["a"]);
  });
});

describe("Migración H163", () => {
  it("tablas nuevas con tenant_id, RLS e initplan, sin is_internal", () => {
    for (const t of ["product_barcodes", "product_sale_units"]) {
      expect(SQL).toMatch(new RegExp(`create table if not exists public\\.${t} \\([\\s\\S]*?tenant_id\\s+uuid not null`));
      expect(SQL).toContain(`alter table public.${t} enable row level security;`);
    }
    expect(SQL).not.toMatch(/is_internal\(\)/);
    // Toda llamada a current_tenant_id() en policies va envuelta.
    const policies = SQL.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(6);
    for (const p of policies) {
      expect(p.replace(/\(select current_tenant_id\(\)\)/g, "")).not.toMatch(/current_tenant_id\(\)/);
      expect(p).toMatch(/\(select has_capability\('products\.edit'\)\)|for select/);
    }
  });

  it("códigos únicos y sin pisar el principal", () => {
    expect(SQL).toMatch(/create unique index if not exists uq_product_barcodes_code\s+on public\.product_barcodes\(tenant_id, code\) where deleted_at is null/);
    expect(SQL).toMatch(/create trigger products_code_guard\s+before insert or update of barcode/);
    expect(SQL).toMatch(/create trigger product_variants_code_guard/);
    expect(SQL).toMatch(/raise exception 'barcode_taken:%'/);
  });

  it("resolver con alternativos, bultos y PLU sin ceros", () => {
    expect(SQL).toMatch(/create or replace function public\.product_by_code\(p_code text, p_limit int default 10\)/);
    expect(SQL).toMatch(/p\.plu = lpad\(c\.raw, 6, '0'\)/);
    expect(SQL).toMatch(/grant execute on function public\.product_by_code\(text, int\) to authenticated/);
  });

  it("venta: insumo rechazado y bulto validado sin tocar create_sale", () => {
    expect(SQL).toMatch(/create trigger sale_item_for_sale\s+before insert on public\.sale_items/);
    expect(SQL).toMatch(/raise exception 'product_not_for_sale'/);
    expect(SQL).not.toMatch(/function public\.create_sale\(/);
    expect(SQL).toMatch(/create or replace function public\._sale_apply_service\(/);
    expect(SQL).toMatch(/raise exception 'sale_unit_quantity_invalid'/);
    // La copia mantiene el bloque de servicios (ADR-116).
    expect(SQL).toMatch(/raise exception 'service_due_invalid'/);
    expect(SQL).toMatch(/and coalesce\(p\.usage, 'both'\) <> 'purchase'/);
    expect(SQL).not.toContain(String.fromCharCode(0x2014));
  });
});
