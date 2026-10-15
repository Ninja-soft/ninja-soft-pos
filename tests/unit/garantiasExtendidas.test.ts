// ADR-139: garantías extendidas por tipo. Precio (%, fija, mínimo, máximo,
// redondeo), precedencia del alcance (producto > categoría más específica >
// todos), editor del árbol con herencia, opciones del POS, vencimiento en
// fecha de Argentina, renglones del comprobante y chequeos estáticos de la
// migración. La paridad SQL = TS se verificó en PGlite (1152 casos de precio
// y todas las combinaciones tipo x producto); la integración con Supabase está
// en tests/integration/rls-garantias-extendidas.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  categoryChain,
  formatDateAr,
  offersForProduct,
  pricingSummary,
  resolvePlanScope,
  warrantyExpiry,
  warrantyLinePrice,
  warrantyUnitPrice,
  type CategoryNodeLike,
  type WarrantyScopeLike,
  type WarrantyTypeLike,
} from "@/lib/warranty/pricing";
import {
  categoryMixed,
  categoryOn,
  draftFromScopes,
  draftToRows,
  emptyDraft,
  flattenTree,
  normalizeDraft,
  setAppliesToAll,
  setProductScope,
  summarizeDraft,
  toggleCategory,
} from "@/lib/warranty/scopes";
import { buildWarrantyTargets, pickOption } from "@/lib/warranty/pos";
import { warrantyDetailLines, warrantyOfItem, warrantyStatus } from "@/lib/warranty/ticket";
import { invoiceFromTicket } from "@/lib/invoices/fromTicket";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const MIG_FILE = readdirSync(MIG_DIR).find((f) => f.endsWith("_garantias_extendidas_tipos.sql"))!;
const MIG = readFileSync(join(MIG_DIR, MIG_FILE), "utf8");

// Árbol: Electro > TV > Smart, Electro > Pilas, Hogar; Borrada (con baja) > Bajo.
const CATS: CategoryNodeLike[] = [
  { id: "electro", parent_id: null, name: "Electro" },
  { id: "tv", parent_id: "electro", name: "TV" },
  { id: "smart", parent_id: "tv", name: "Smart" },
  { id: "pilas", parent_id: "electro", name: "Pilas" },
  { id: "hogar", parent_id: null, name: "Hogar" },
  { id: "borrada", parent_id: "electro", name: "Borrada", deleted_at: "2026-01-01" },
  { id: "bajo", parent_id: "borrada", name: "Bajo borrada" },
];

const plan = (over: Partial<WarrantyTypeLike> = {}): WarrantyTypeLike => ({
  id: "p",
  label: "+12 meses",
  months: 12,
  price_pct: 10,
  price: 0,
  applies_to_all: true,
  is_active: true,
  sort: 0,
  ...over,
});
const scope = (planId: string, target: { category_id?: string; product_id?: string }, effect: "include" | "exclude"): WarrantyScopeLike => ({
  plan_id: planId,
  category_id: target.category_id ?? null,
  product_id: target.product_id ?? null,
  effect,
});

describe("precio de la garantía", () => {
  it("12% de un producto de $100.000 = $12.000", () => {
    expect(warrantyUnitPrice({ price_pct: 12, price: 0 }, 100_000)).toBe(12_000);
  });
  it("el % gana a la prima fija; sin % usa la fija por unidad", () => {
    expect(warrantyUnitPrice({ price_pct: 10, price: 999 }, 50_000)).toBe(5_000);
    expect(warrantyUnitPrice({ price_pct: 0, price: 15_000 }, 50_000)).toBe(15_000);
    expect(warrantyLinePrice({ price_pct: 0, price: 15_000 }, 50_000, 3)).toBe(45_000);
  });
  it("redondea al múltiplo más cercano y después aplica mínimo y máximo", () => {
    expect(warrantyUnitPrice({ price_pct: 18, price: 0, rounding_step: 100 }, 87_650)).toBe(15_800);
    expect(warrantyUnitPrice({ price_pct: 18, price: 0, rounding_step: 1000 }, 87_650)).toBe(16_000);
    expect(warrantyUnitPrice({ price_pct: 10, price: 0, min_price: 5_000 }, 20_000)).toBe(5_000);
    expect(warrantyUnitPrice({ price_pct: 10, price: 0, max_price: 30_000 }, 900_000)).toBe(30_000);
    expect(warrantyUnitPrice({ price_pct: 10, price: 0, min_price: 1000, max_price: 1500, rounding_step: 1000 }, 16_000)).toBe(1_500);
  });
  it("centavos como Postgres (half away from zero)", () => {
    expect(warrantyUnitPrice({ price_pct: 7.5, price: 0 }, 1234.56)).toBe(92.59);
    expect(warrantyUnitPrice({ price_pct: 33.33, price: 0 }, 999.99)).toBe(333.3);
  });
  it("producto a $0 (regalo o pack) no tiene garantía, ni con mínimo", () => {
    expect(warrantyUnitPrice({ price_pct: 10, price: 0, min_price: 5000 }, 0)).toBe(0);
    expect(warrantyUnitPrice({ price_pct: 0, price: 15_000 }, -1)).toBe(0);
  });
  it("resumen legible del precio", () => {
    const money = (n: number) => `$${n}`;
    expect(pricingSummary({ price_pct: 12.5, price: 0, min_price: 5000, max_price: 90000, rounding_step: 100 }, money)).toBe(
      "12,5% del precio · mín. $5000 · máx. $90000 · redondeo a $100",
    );
    expect(pricingSummary({ price_pct: 0, price: 15000 }, money)).toBe("$15000 por unidad");
  });
});

describe("alcance: producto > categoría más específica > todos", () => {
  const P24 = plan({ id: "p24", applies_to_all: false });
  const scopes = [
    scope("p24", { category_id: "electro" }, "include"),
    scope("p24", { category_id: "tv" }, "exclude"),
    scope("p24", { product_id: "smart-tv" }, "include"),
    scope("p12", { category_id: "pilas" }, "exclude"),
  ];
  it("el producto puntual gana a la categoría", () => {
    expect(resolvePlanScope(P24, scopes, { id: "smart-tv", categoryId: "smart" }, CATS)).toEqual({ applies: true, reason: "product_include" });
  });
  it("la categoría más específica gana a la de arriba", () => {
    expect(resolvePlanScope(P24, scopes, { id: "otro-tv", categoryId: "smart" }, CATS)).toEqual({
      applies: false,
      reason: "category_exclude",
      categoryId: "tv",
    });
    expect(resolvePlanScope(P24, scopes, { id: "celu", categoryId: "electro" }, CATS)).toMatchObject({ applies: true, reason: "category_include" });
  });
  it("sin marca decide 'todos los productos'", () => {
    expect(resolvePlanScope(P24, scopes, { id: "silla", categoryId: "hogar" }, CATS)).toEqual({ applies: false, reason: "not_assigned" });
    expect(resolvePlanScope(plan({ id: "p12" }), scopes, { id: "x", categoryId: null }, CATS)).toEqual({ applies: true, reason: "all" });
  });
  it("una categoría borrada corta la herencia (igual que el CTE de SQL)", () => {
    expect(categoryChain("bajo", CATS)).toEqual(["bajo"]);
    expect(resolvePlanScope(P24, scopes, { id: "y", categoryId: "bajo" }, CATS).reason).toBe("not_assigned");
  });
  it("las marcas con baja lógica no cuentan", () => {
    const dead = [{ ...scope("p24", { product_id: "silla" }, "include"), deleted_at: "2026-01-01" }];
    expect(resolvePlanScope(P24, dead, { id: "silla", categoryId: "hogar" }, CATS).applies).toBe(false);
  });
  it("ofertas: sólo activas y alcanzadas, en el orden del negocio y con precio", () => {
    const plans = [
      plan({ id: "b", label: "+24", months: 24, price_pct: 18, sort: 2 }),
      plan({ id: "a", label: "+12", sort: 1 }),
      plan({ id: "c", label: "Pausada", is_active: false }),
      plan({ id: "d", label: "Archivada", deleted_at: "2026-01-01" }),
      plan({ id: "e", label: "Sin hogar", sort: 3 }),
    ];
    const sc = [scope("e", { category_id: "hogar" }, "exclude")];
    const offers = offersForProduct(plans, sc, CATS, { id: "silla", categoryId: "hogar" }, 80_000, 2);
    expect(offers.map((o) => o.plan.id)).toEqual(["a", "b"]);
    expect(offers[1]).toMatchObject({ unitPrice: 14_400, total: 28_800 });
  });
});

describe("editor del árbol con herencia", () => {
  it("tildar un rubro en 'sólo lo elegido' lo hereda todo lo de abajo", () => {
    let d = emptyDraft(false);
    d = toggleCategory(d, "electro", CATS);
    expect(d.categories).toEqual({ electro: "include" });
    expect(categoryOn(d, "smart", CATS)).toBe(true);
    expect(categoryOn(d, "hogar", CATS)).toBe(false);
  });
  it("destildar una subcategoría deja una exclusión y el rubro queda mixto", () => {
    let d = toggleCategory(emptyDraft(false), "electro", CATS);
    d = toggleCategory(d, "tv", CATS);
    expect(d.categories).toEqual({ electro: "include", tv: "exclude" });
    expect(categoryOn(d, "smart", CATS)).toBe(false);
    expect(categoryMixed(d, "electro", CATS)).toBe(true);
    // Volver a tildarla limpia la marca redundante.
    d = toggleCategory(d, "tv", CATS);
    expect(d.categories).toEqual({ electro: "include" });
  });
  it("en 'todos', destildar excluye; re-tildar el padre limpia lo de abajo que repite", () => {
    let d = toggleCategory(emptyDraft(true), "pilas", CATS);
    expect(d.categories).toEqual({ pilas: "exclude" });
    d = toggleCategory(d, "electro", CATS);
    expect(d.categories).toEqual({ electro: "exclude" });
  });
  it("cambiar el alcance general normaliza las marcas", () => {
    const d = setAppliesToAll({ appliesToAll: false, categories: { electro: "include", hogar: "exclude" }, products: {} }, true, CATS);
    expect(d.categories).toEqual({ hogar: "exclude" });
    expect(normalizeDraft({ appliesToAll: true, categories: { bajo: "exclude", borrada: "exclude" }, products: {} }, CATS).categories).toEqual({
      bajo: "exclude",
    });
  });
  it("productos puntuales, filas para la RPC y resumen", () => {
    let d = draftFromScopes("p", true, [scope("p", { category_id: "pilas" }, "exclude"), scope("otro", { category_id: "tv" }, "include")]);
    d = setProductScope(d, "silla", "exclude");
    d = setProductScope(d, "tv1", "include");
    d = setProductScope(d, "tv1", null);
    expect(draftToRows(d)).toEqual([
      { category_id: "pilas", effect: "exclude" },
      { product_id: "silla", effect: "exclude" },
    ]);
    expect(summarizeDraft(d)).toEqual({ included: [], excluded: ["pilas"], productsIncluded: 0, productsExcluded: 1 });
  });
  it("árbol plano con buscador (sin acentos) que conserva los ancestros", () => {
    // Una categoría viva bajo una borrada queda como raíz (así resuelve SQL).
    expect(flattenTree(CATS).map((r) => `${r.depth}${r.name}`)).toEqual(["0Bajo borrada", "0Electro", "1Pilas", "1TV", "2Smart", "0Hogar"]);
    expect(flattenTree(CATS, { query: "smárt" }).map((r) => r.id)).toEqual(["electro", "tv", "smart"]);
    expect(flattenTree(CATS, { collapsed: new Set(["electro"]) }).map((r) => r.id)).toEqual(["bajo", "electro", "hogar"]);
  });
});

describe("POS: opciones por línea", () => {
  const plans = [plan({ id: "p12" }), plan({ id: "p24", label: "+24 meses", months: 24, price_pct: 18, sort: 1 })];
  const lines = [
    { lineId: "a", productId: "yerba", categoryId: "hogar", name: "Yerba", unitPrice: 3000, quantity: 1 },
    { lineId: "b", productId: "tv", categoryId: "smart", name: "Smart TV", unitPrice: 500_000, quantity: 2, warrantyMonths: 12 },
    { lineId: "c", productId: "celu", categoryId: "electro", name: "Celular", unitPrice: 300_000, quantity: 1, serial: "IMEI1" },
    { lineId: "d", productId: "regalo", categoryId: "electro", name: "Funda", unitPrice: 0, quantity: 1, giftPromoId: "x" },
    { lineId: "e", productId: null, name: "Varios", unitPrice: 1000, quantity: 1 },
    { lineId: "f", productId: "pack", categoryId: "electro", name: "Sesión", unitPrice: 9000, quantity: 1, packCreditId: "k" },
  ];
  const scopes = [scope("p12", { category_id: "hogar" }, "exclude"), scope("p24", { category_id: "hogar" }, "exclude")];
  const targets = buildWarrantyTargets(lines, plans, scopes, CATS);
  it("sólo líneas con producto, precio y alguna garantía; serie primero, después la más cara", () => {
    expect(targets.map((t) => t.lineId)).toEqual(["c", "b"]);
    expect(targets[0]!.label).toBe("Celular · IMEI1");
  });
  it("cada opción trae el precio por unidad y el total de la línea", () => {
    const tv = targets.find((t) => t.lineId === "b")!;
    expect(tv.factoryMonths).toBe(12);
    expect(tv.options.map((o) => [o.planId, o.unitPrice, o.total])).toEqual([
      ["p12", 50_000, 100_000],
      ["p24", 90_000, 180_000],
    ]);
  });
  it("elegir: la línea pedida o la primera; tipo que no se ofrece = nada", () => {
    expect(pickOption(targets, "b", "p24")?.option.total).toBe(180_000);
    expect(pickOption(targets, "", "p12")?.target.lineId).toBe("c");
    expect(pickOption(targets, "b", "otro")).toBeNull();
    expect(pickOption(targets, "b", "")).toBeNull();
    expect(buildWarrantyTargets(lines, [], [], CATS)).toEqual([]);
  });
});

describe("vencimiento y comprobante", () => {
  it("fecha de la venta en Argentina + fábrica + tipo, con fin de mes como Postgres", () => {
    // 31/01 02:00 UTC = 30/01 23:00 en Argentina.
    expect(warrantyExpiry("2026-01-31T02:00:00Z", 12, 24)).toBe("2029-01-30");
    expect(warrantyExpiry("2026-01-31T15:00:00Z", 0, 1)).toBe("2026-02-28");
    expect(warrantyExpiry("2027-12-15T12:00:00Z", 0, 12)).toBe("2028-12-15");
    expect(formatDateAr("2029-01-30")).toBe("30/01/2029");
  });
  it("estado: vigente hasta el día del vencimiento inclusive", () => {
    expect(warrantyStatus("2026-10-15", "2026-10-15")).toBe("vigente");
    expect(warrantyStatus("2026-10-14", "2026-10-15")).toBe("vencida");
    expect(warrantyStatus("2030-01-01", "2026-10-15", true)).toBe("anulada");
  });
  it("la línea de garantía lleva hasta cuándo cubre y sus condiciones en la factura", () => {
    expect(warrantyOfItem({ warranty_expires_on: "2029-01-30", warranty_terms: "  No cubre golpes.  " })).toEqual({
      warranty_expires_on: "2029-01-30",
      warranty_terms: "No cubre golpes.",
    });
    expect(warrantyOfItem({ warranty_expires_on: null })).toEqual({});
    expect(warrantyDetailLines({ warranty_expires_on: "2029-01-30" })).toEqual([{ bullet: false, text: "Cubre hasta el 30/01/2029" }]);
    const doc = invoiceFromTicket(
      {
        sale: { number: 1, created_at: "2026-10-15T15:00:00Z", subtotal: 590_000, discount_total: 0, total: 590_000, status: "completed" },
        items: [
          { id: "1", product_name: "Smart TV", quantity: 1, unit_price: 500_000, subtotal: 500_000 },
          {
            id: "2",
            product_name: "Garantía +24 meses",
            quantity: 1,
            unit_price: 90_000,
            subtotal: 90_000,
            warranty_expires_on: "2029-10-15",
            warranty_terms: "No cubre golpes.",
          },
        ],
        payments: [{ id: "p", method: "cash", amount: 590_000 }],
      } as never,
    );
    const line = doc.lines[1]!;
    expect(line.detailLines?.map((l) => l.text)).toEqual(["Cubre hasta el 15/10/2029", "No cubre golpes."]);
  });
});

describe("migración 20261205100000_garantias_extendidas_tipos", () => {
  const code = MIG.replace(/--.*$/gm, "");
  it("versión desde 20261205100000", () => {
    expect(Number(MIG_FILE.slice(0, 14))).toBeGreaterThanOrEqual(20261205100000);
  });
  it("no recrea create_sale ni usa is_internal() suelto", () => {
    expect(code).not.toMatch(/function\s+(public\.)?create_sale\s*\(/i);
    expect(code).not.toMatch(/is_internal\(\)/);
  });
  it("policies con initplan y escrituras directas cerradas", () => {
    expect(code).toMatch(/tenant_id = \(select current_tenant_id\(\)\)/);
    expect(code).toMatch(/revoke insert, update, delete on warranty_plans from anon, authenticated/);
    expect(code).toMatch(/drop policy if exists warranty_plans_delete/);
    expect(code).toMatch(/revoke all on warranty_plan_scopes from anon, authenticated/);
  });
  it("gating server-side, rol y auditoría en cada RPC", () => {
    expect(code).toMatch(/tenant_has_feature_for\(v_tenant, 'garantias'\)/);
    expect(code).toMatch(/is_tenant_manager\(\)/);
    for (const fn of ["warranty_plan_save", "warranty_plan_set_active", "warranty_plan_archive", "warranty_plan_reorder"]) {
      const body = code.slice(code.indexOf(`function ${fn}(`), code.indexOf("$$;", code.indexOf(`function ${fn}(`)));
      expect(body, fn).toMatch(/_warranty_plan_guard\(\)/);
      expect(body, fn).toMatch(/insert into audit_logs/);
    }
  });
  it("baja lógica (deleted_at) y UUID en la tabla nueva", () => {
    expect(code).toMatch(/alter table warranty_plans add column if not exists deleted_at/);
    expect(code).toMatch(/id\s+uuid primary key default gen_random_uuid\(\)/);
    expect(code).not.toMatch(/delete from warranty_plan/i);
  });
  it("el trigger de sale_items no busca el negocio por fila y usa hora de Argentina", () => {
    const trg = code.slice(code.indexOf("function _sale_item_warranty_apply"), code.indexOf("create trigger sale_items_warranty_apply"));
    expect(trg).not.toMatch(/current_tenant_id\(\)/);
    expect(trg).toMatch(/America\/Argentina\/Buenos_Aires/);
    expect(trg).toMatch(/ninja\.offline_sync/);
    expect(trg).toMatch(/ninja\.pc_complete/);
    // El error no choca con el parser de price_mismatch del POS.
    expect(trg).not.toMatch(/price_mismatch/);
  });
});
