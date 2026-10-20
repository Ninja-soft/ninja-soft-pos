// F24 · H158 (ADR-171): IA con permisos, letra de compra, no bonificable y
// cheque repetido. Lógica pura; los controles del servidor se prueban en la
// migración 20270109100000 (dry-run) y estos tests fijan el espejo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_ENTITY_CAPS,
  AI_QUERY_CATALOG,
  aiToolDenied,
  checkQueryScope,
  describeEntities,
  entityCapsForSql,
  redactCosts,
  schemaIndex,
  scopeResult,
  validateQuery,
  type AiScope,
} from "@/supabase/functions/_shared/aiQuery";
import { allowedLetters, suggestedLetter } from "@/lib/purchases/invoices";
import { discountableSubtotal, maxGeneralDiscount } from "@/lib/pos/discount";
import { chequeDuplicates, normalizeBankName, normalizeChequeNumber } from "@/lib/treasury/cheques";

const MIGRATION = "supabase/migrations/20270109100000_h158_integridad.sql";

const CASHIER = new Set([
  "sales.view", "sales.create", "cash.view", "products.view", "stock.view",
  "customers.view", "reports.view", "team.view",
]);
const OWNER = new Set([...CASHIER, "reports.costs", "stock.valuation", "billing.manage", "config.edit"]);

function spec(input: unknown) {
  const r = validateQuery(input);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

describe("IA con permisos: catálogo de ai_query", () => {
  it("toda entidad del catálogo que no es básica tiene capacidad", () => {
    const basic = new Set(["stores", "cash_registers"]);
    for (const name of Object.keys(AI_QUERY_CATALOG)) {
      if (basic.has(name)) continue;
      expect(AI_ENTITY_CAPS[name], name).toBeTruthy();
    }
  });

  it("la copia SQL de la migración coincide con el mapa TS", () => {
    const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
    const m = /\$caps\$([\s\S]*?)\$caps\$/.exec(sql);
    expect(m, "bloque $caps$ en la migración").not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(entityCapsForSql());
  });

  it("sin reports.costs no se puede pedir el costo, ni directo ni por ref", () => {
    expect(checkQueryScope(spec({ entity: "products", select: ["name", "cost"] }), CASHIER)).toMatch(/costos/);
    expect(checkQueryScope(spec({ entity: "products", aggregates: [{ op: "sum", col: "cost" }] }), CASHIER)).toMatch(/costos/);
    expect(checkQueryScope(spec({ entity: "sale_items", select: ["product.cost"] }), CASHIER)).toMatch(/costos/);
    // Sin select, las columnas por defecto de productos traen el costo.
    expect(checkQueryScope(spec({ entity: "products" }), CASHIER)).toMatch(/costos/);
    expect(checkQueryScope(spec({ entity: "products", select: ["name", "price"] }), CASHIER)).toBeNull();
    expect(checkQueryScope(spec({ entity: "products", select: ["name", "cost"] }), OWNER)).toBeNull();
  });

  it("sin la capacidad de la entidad no se consulta (raíz ni ref)", () => {
    expect(checkQueryScope(spec({ entity: "subscriptions" }), CASHIER)).toMatch(/permiso/);
    const noCustomers = new Set([...CASHIER].filter((c) => c !== "customers.view"));
    expect(checkQueryScope(spec({ entity: "sales", select: ["number", "customer.name"] }), noCustomers)).toMatch(/permiso/);
    expect(checkQueryScope(spec({ entity: "sales", select: ["number", "total"] }), noCustomers)).toBeNull();
  });

  it("los alias de salida en order_by no se confunden con columnas", () => {
    const s = spec({ entity: "sales", aggregates: [{ op: "sum", col: "total" }], order_by: [{ col: "sum_total", dir: "desc" }] });
    expect(checkQueryScope(s, CASHIER)).toBeNull();
  });

  it("ai_schema y el índice ocultan lo que no puede ver", () => {
    const d = describeEntities(["products", "subscriptions"], CASHIER).entities!;
    expect(Object.keys((d.products as { columnas: object }).columnas)).not.toContain("cost");
    expect(d.subscriptions).toEqual({ error: "tu usuario no tiene permiso para consultarla" });
    expect(schemaIndex(CASHIER)).not.toContain("• subscriptions:");
    expect(schemaIndex(OWNER)).toContain("• subscriptions:");
  });
});

describe("IA con permisos: tools curadas", () => {
  const all: AiScope = { caps: OWNER, allStores: true };
  const branch: AiScope = { caps: CASHIER, allStores: false };

  it("las que suman todo el negocio, sólo con todas las sucursales", () => {
    expect(aiToolDenied("sales_summary", all)).toBeNull();
    expect(aiToolDenied("sales_summary", branch)).toMatch(/ai_query/);
    expect(aiToolDenied("cash_status", branch)).toMatch(/ai_query/);
    expect(aiToolDenied("search_products", branch)).toBeNull();
    expect(aiToolDenied("ai_query", branch)).toBeNull();
  });

  it("sin la capacidad, no", () => {
    const seller: AiScope = { caps: new Set(["products.view"]), allStores: true };
    expect(aiToolDenied("list_customers", seller)).toMatch(/permiso/);
    expect(aiToolDenied("search_products", seller)).toBeNull();
  });

  it("recorta costos y valorización", () => {
    const stock = { inventory_value_cost: 100, inventory_value_sale: 200, products: [{ name: "A", cost: 5, price: 9 }] };
    expect(scopeResult(stock, branch)).toEqual({ products: [{ name: "A", price: 9 }] });
    expect(scopeResult(stock, all)).toEqual(stock);
    const viewer: AiScope = { caps: new Set(["stock.valuation"]), allStores: true };
    expect(scopeResult(stock, viewer)).toEqual({ inventory_value_sale: 200, products: [{ name: "A", price: 9 }] });
    expect(redactCosts({ margin_pct: 3, costo: 1, x: 1 })).toEqual({ x: 1 });
  });
});

describe("Letra de la factura de compra", () => {
  it("según el proveedor y el negocio", () => {
    expect(allowedLetters("monotributo", "responsable_inscripto")).toEqual(["C"]);
    expect(allowedLetters("exento", "monotributo")).toEqual(["C"]);
    expect(allowedLetters("exterior", "responsable_inscripto")).toEqual(["E"]);
    expect(allowedLetters("responsable_inscripto", "responsable_inscripto")).toEqual(["A", "M"]);
    expect(allowedLetters("responsable_inscripto", "monotributo")).toEqual(["A", "B"]);
    expect(allowedLetters("responsable_inscripto", "exento")).toEqual(["B"]);
    expect(allowedLetters("responsable_inscripto", null)).toEqual(["A", "B", "M"]);
    expect(allowedLetters("consumidor_final", "responsable_inscripto")).toBeNull();
    expect(suggestedLetter("responsable_inscripto", "monotributo")).toBe("A");
  });

  it("el espejo SQL tiene las mismas reglas", () => {
    const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
    expect(sql).toMatch(/when p_supplier_iva = 'exterior' then array\['E'\]/);
    expect(sql).toMatch(/when p_buyer_iva = 'responsable_inscripto' then array\['A', 'M'\]/);
    expect(sql).toMatch(/when p_buyer_iva in \('monotributo', 'monotributo_social'\) then array\['A', 'B'\]/);
    expect(sql).toMatch(/when p_buyer_iva in \('exento', 'no_alcanzado'\) then array\['B'\]/);
  });
});

describe("Producto no bonificable", () => {
  it("el descuento general sólo sobre lo bonificable", () => {
    const lines = [
      { productId: "a", amount: 1000 },
      { productId: "b", amount: 500 },
      { productId: null, amount: 100 },
    ];
    expect(discountableSubtotal(lines, [])).toEqual({ amount: 1600, hasBlocked: false });
    expect(discountableSubtotal(lines, ["b"])).toEqual({ amount: 1100, hasBlocked: true });
    expect(maxGeneralDiscount(1100, 10)).toBe(110);
    expect(maxGeneralDiscount(0, 10)).toBe(0);
  });
});

describe("Cheque repetido", () => {
  const list = [
    { id: "1", number: "00012345", bank_name: "Banco Galicia", status: "en_cartera" },
    { id: "2", number: "12345", bank_name: "Banco de la Nación", status: "anulado" },
    { id: "3", number: "777", bank_name: null, status: "entregado" },
  ];

  it("normaliza número y banco", () => {
    expect(normalizeChequeNumber(" 0001-2345 ")).toBe("12345");
    expect(normalizeBankName("Banco Galicia")).toBe("galicia");
    expect(normalizeBankName("BCO. GALICIA")).toBe("galicia");
    expect(normalizeBankName("Banco del Sol")).toBe("sol");
  });

  it("avisa con el mismo número y banco, no con anulados ni otro banco", () => {
    expect(chequeDuplicates(list, "12345", "galicia").map((c) => c.id)).toEqual(["1"]);
    expect(chequeDuplicates(list, "12345", "Santander")).toEqual([]);
    expect(chequeDuplicates(list, "12345", null).map((c) => c.id)).toEqual(["1"]);
    expect(chequeDuplicates(list, "777", "Macro").map((c) => c.id)).toEqual(["3"]);
    expect(chequeDuplicates(list, "12345", "galicia", "1")).toEqual([]);
    expect(chequeDuplicates(list, "12", null)).toEqual([]);
  });
});
