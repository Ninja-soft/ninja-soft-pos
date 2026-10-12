import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_QUERY_CATALOG,
  DEFAULT_LIMIT,
  FORBIDDEN_COLUMN_PATTERN,
  FORBIDDEN_TABLES,
  MAX_FILTERS,
  MAX_IN_VALUES,
  MAX_LIMIT,
  aggAlias,
  catalogForSql,
  describeEntities,
  groupAlias,
  resolveColumn,
  schemaIndex,
  validateQuery,
} from "@/supabase/functions/_shared/aiQuery";

const MIGRATION = "supabase/migrations/20261011220000_ai_acceso_total_historial.sql";

function ok(input: unknown) {
  const r = validateQuery(input);
  if (!r.ok) throw new Error(`esperaba ok, vino: ${r.error}`);
  return r.spec;
}
function err(input: unknown): string {
  const r = validateQuery(input);
  if (r.ok) throw new Error("esperaba error");
  return r.error;
}

describe("aiQuery · catálogo", () => {
  it("no expone tablas sensibles", () => {
    for (const t of FORBIDDEN_TABLES) {
      expect(AI_QUERY_CATALOG[t]).toBeUndefined();
    }
  });

  it("no expone columnas sensibles (secretos, hashes, tokens, jsonb internos)", () => {
    for (const [name, e] of Object.entries(AI_QUERY_CATALOG)) {
      for (const col of Object.keys(e.cols)) {
        expect(FORBIDDEN_COLUMN_PATTERN.test(col), `${name}.${col}`).toBe(false);
      }
    }
    expect(AI_QUERY_CATALOG.cashier_profiles?.cols.pin_hash).toBeUndefined();
    expect(AI_QUERY_CATALOG.tenant_payment_methods?.cols.config).toBeUndefined();
    expect(AI_QUERY_CATALOG.store_credit_vouchers?.cols.code).toBeUndefined();
    expect(AI_QUERY_CATALOG.payments?.cols.metadata).toBeUndefined();
  });

  it("nunca whitelistea tenant_id (el tenant lo fuerza SQL)", () => {
    for (const e of Object.values(AI_QUERY_CATALOG)) {
      expect(e.cols.tenant_id).toBeUndefined();
    }
  });

  it("identificadores en snake_case seguro y refs consistentes", () => {
    const ident = /^[a-z_][a-z0-9_]*$/;
    for (const [name, e] of Object.entries(AI_QUERY_CATALOG)) {
      expect(name).toMatch(ident);
      for (const col of Object.keys(e.cols)) expect(col).toMatch(ident);
      for (const [rk, r] of Object.entries(e.refs ?? {})) {
        expect(rk).toMatch(ident);
        const target = AI_QUERY_CATALOG[r.to];
        expect(target, `${name}.${rk} → ${r.to}`).toBeDefined();
        expect(target!.cols[r.target ?? "id"], `${name}.${rk} target`).toBeDefined();
        if (r.via) {
          const via = e.refs![r.via];
          expect(via, `${name}.${rk} via`).toBeDefined();
          expect(via!.via).toBeUndefined(); // un solo nivel extra
          expect(AI_QUERY_CATALOG[via!.to]!.cols[r.col]).toBeDefined();
        } else {
          expect(e.cols[r.col], `${name}.${rk} col`).toBeDefined();
        }
      }
      for (const d of e.def ?? []) {
        expect(resolveColumn(name, d), `${name} def ${d}`).not.toBeNull();
      }
    }
  });

  it("cubre los dominios del negocio", () => {
    for (const t of [
      "products",
      "categories",
      "product_variants",
      "stock_movements",
      "price_lists",
      "customers",
      "customer_groups",
      "customer_account_movements",
      "sales",
      "sale_items",
      "payments",
      "sale_returns",
      "cash_shifts",
      "cash_movements",
      "promotions",
      "coupons",
      "warranty_plans",
      "appointments",
      "professionals",
      "dining_tables",
      "table_orders",
      "delivery_orders",
      "tenant_users",
      "payment_plans",
      "subscriptions",
    ]) {
      expect(AI_QUERY_CATALOG[t], t).toBeDefined();
    }
  });

  it("la copia SQL de la migración coincide con el catálogo TS", () => {
    const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
    const m = /\$catalog\$([\s\S]*?)\$catalog\$/.exec(sql);
    expect(m, "bloque $catalog$ en la migración").not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(catalogForSql());
  });

  it("schemaIndex lista entidades raíz y omite las refOnly", () => {
    const idx = schemaIndex();
    expect(idx).toContain("• categories:");
    expect(idx).not.toContain("• plans:");
  });

  it("describeEntities devuelve columnas y relaciones", () => {
    const r = describeEntities(["products", "plans", "nope"]);
    const e = r.entities as Record<string, Record<string, unknown>>;
    expect(Object.keys(e.products!.columnas as object)).toContain("price");
    expect(e.products!.relaciones).toBeDefined();
    expect(e.plans!.error).toBeDefined();
    expect(e.nope!.error).toBeDefined();
    expect(describeEntities([]).error).toBeDefined();
  });
});

describe("aiQuery · validateQuery básico", () => {
  it("cuenta categorías cargadas", () => {
    const s = ok({ entity: "categories", aggregates: [{ op: "count" }] });
    expect(s.aggregates).toEqual([{ op: "count" }]);
    expect(s.limit).toBe(DEFAULT_LIMIT);
  });

  it("listado con select, filtros y orden", () => {
    const s = ok({
      entity: "products",
      select: ["name", "price", "category.name"],
      filters: [
        { col: "name", op: "ilike", value: "coca" },
        { col: "price", op: "gte", value: "1000" },
        { col: "category.name", op: "eq", value: "Bebidas" },
      ],
      order_by: [{ col: "price", dir: "desc" }],
      limit: 10,
    });
    expect(s.select).toEqual(["name", "price", "category.name"]);
    expect(s.filters).toHaveLength(3);
    expect(s.order_by).toEqual([{ col: "price", dir: "desc" }]);
  });

  it("agregados con group_by por mes y por ref de 2 niveles", () => {
    const s = ok({
      entity: "sale_items",
      filters: [
        { col: "sale.status", op: "eq", value: "completed" },
        { col: "created_at", op: "between", values: ["2026-09-01", "2026-09-30"] },
      ],
      group_by: [{ col: "created_at", trunc: "month" }, "product_category.name"],
      aggregates: [{ op: "sum", col: "subtotal" }, { op: "sum", col: "quantity" }],
      order_by: [{ col: "sum_subtotal", dir: "desc" }],
    });
    expect(s.group_by.map(groupAlias)).toEqual(["created_at_month", "product_category_name"]);
    expect(s.aggregates.map(aggAlias)).toEqual(["sum_subtotal", "sum_quantity"]);
    expect(s.order_by[0]).toEqual({ col: "sum_subtotal", dir: "desc" });
  });

  it("group_by sin agregados agrega count por defecto", () => {
    const s = ok({ entity: "sales", group_by: ["status"] });
    expect(s.aggregates).toEqual([{ op: "count" }]);
  });

  it("en modo agregado ignora select y ordena por la columna agrupada", () => {
    const s = ok({
      entity: "payments",
      select: ["amount"],
      group_by: ["method"],
      aggregates: [{ op: "sum", col: "amount" }],
      order_by: ["method"],
    });
    expect(s.select).toBeUndefined();
    expect(s.order_by).toEqual([{ col: "method", dir: "asc" }]);
  });

  it("acepta in, is_null, not_null y booleanos", () => {
    ok({
      entity: "customers",
      filters: [
        { col: "iva_condition", op: "in", values: ["RI", "MT"] },
        { col: "email", op: "not_null" },
        { col: "group_id", op: "is_null" },
        { col: "is_active", op: "eq", value: true },
      ],
    });
  });
});

describe("aiQuery · whitelist e inyección", () => {
  it("rechaza entidades fuera del catálogo o refOnly", () => {
    expect(err({ entity: "payment_secrets" })).toMatch(/no existe/);
    expect(err({ entity: "platform_secrets" })).toMatch(/no existe/);
    expect(err({ entity: "users" })).toMatch(/no existe/);
    expect(err({ entity: "plans" })).toMatch(/no existe/);
    expect(err({ entity: "__proto__" })).toMatch(/no existe/);
    expect(err({ entity: "constructor" })).toMatch(/no existe/);
  });

  it("rechaza identificadores con SQL", () => {
    expect(err({ entity: "products; drop table products" })).toMatch(/entity/);
    expect(err({ entity: 'products"' })).toMatch(/entity/);
    expect(err({ entity: "public.products" })).toMatch(/entity/);
    expect(
      err({ entity: "products", select: ["name, (select secrets from payment_secrets)"] }),
    ).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ['name"--'] })).toMatch(/no permitida/);
    expect(err({ entity: "products", filters: [{ col: "1=1 or name", op: "eq", value: "x" }] })).toMatch(
      /no permitida/,
    );
    expect(err({ entity: "products", order_by: [{ col: "price desc; --" }] })).toMatch(/inválido/);
    expect(err({ entity: "products", order_by: [{ col: "price", dir: "desc nulls first" }] })).toMatch(
      /dir/,
    );
    expect(err({ entity: "products", group_by: [{ col: "created_at", trunc: "day') --" }] })).toMatch(
      /trunc/,
    );
  });

  it("rechaza columnas sensibles o inexistentes", () => {
    expect(err({ entity: "cashier_profiles", select: ["pin_hash"] })).toMatch(/no permitida/);
    expect(err({ entity: "tenant_payment_methods", select: ["config"] })).toMatch(/no permitida/);
    expect(err({ entity: "payments", select: ["metadata"] })).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ["tenant_id"] })).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ["deleted_at"] })).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ["__proto__"] })).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ["category.tenant_id"] })).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ["nope.name"] })).toMatch(/no permitida/);
    expect(err({ entity: "products", select: ["category.name.x"] })).toMatch(/no permitida/);
  });

  it("rechaza operadores y agregados desconocidos", () => {
    expect(err({ entity: "products", filters: [{ col: "name", op: "~*", value: "x" }] })).toMatch(
      /Operador/,
    );
    expect(err({ entity: "products", filters: [{ col: "name", op: "eq or 1=1", value: "x" }] })).toMatch(
      /Operador/,
    );
    expect(err({ entity: "products", aggregates: [{ op: "string_agg", col: "name" }] })).toMatch(
      /Agregado/,
    );
    expect(err({ entity: "products", aggregates: [{ op: "pg_sleep", col: "price" }] })).toMatch(
      /Agregado/,
    );
  });

  it("valida tipos de valores (sin casts arbitrarios)", () => {
    expect(err({ entity: "products", filters: [{ col: "price", op: "gt", value: "1; drop" }] })).toMatch(
      /Valor inválido/,
    );
    expect(err({ entity: "products", filters: [{ col: "id", op: "eq", value: "abc" }] })).toMatch(
      /Valor inválido/,
    );
    expect(err({ entity: "sales", filters: [{ col: "created_at", op: "gte", value: "ayer" }] })).toMatch(
      /Valor inválido/,
    );
    expect(err({ entity: "products", filters: [{ col: "name", op: "eq", value: { a: 1 } }] })).toMatch(
      /Valor inválido/,
    );
    expect(err({ entity: "products", filters: [{ col: "name", op: "eq", value: "x".repeat(201) }] })).toMatch(
      /Valor inválido/,
    );
    expect(err({ entity: "products", filters: [{ col: "price", op: "ilike", value: "1" }] })).toMatch(
      /ilike/,
    );
    expect(err({ entity: "products", filters: [{ col: "is_active", op: "gt", value: "true" }] })).toMatch(
      /no aplica/,
    );
    // Las comillas en valores son válidas: SQL las pasa por quote_literal.
    ok({ entity: "products", filters: [{ col: "name", op: "eq", value: "O'Higgins'); --" }] });
  });

  it("valida agregados según el tipo", () => {
    expect(err({ entity: "products", aggregates: [{ op: "sum", col: "name" }] })).toMatch(/numérica/);
    expect(err({ entity: "products", aggregates: [{ op: "avg" }] })).toMatch(/requiere 'col'/);
    expect(err({ entity: "products", aggregates: [{ op: "max", col: "is_active" }] })).toMatch(
      /no aplica/,
    );
    expect(err({ entity: "products", group_by: [{ col: "name", trunc: "month" }] })).toMatch(
      /sólo aplica a fechas/,
    );
    expect(
      err({ entity: "products", aggregates: [{ op: "count" }, { op: "count" }] }),
    ).toMatch(/repetidos/);
  });

  it("en modo agregado no deja ordenar por columnas no agrupadas", () => {
    expect(
      err({ entity: "sales", group_by: ["status"], order_by: [{ col: "total" }] }),
    ).toMatch(/sólo podés ordenar/);
  });
});

describe("aiQuery · límites", () => {
  it("clampa limit a [1, MAX_LIMIT]", () => {
    expect(ok({ entity: "products", limit: 5000 }).limit).toBe(MAX_LIMIT);
    expect(ok({ entity: "products", limit: -5 }).limit).toBe(1);
    expect(ok({ entity: "products", limit: 0 }).limit).toBe(1);
    expect(ok({ entity: "products" }).limit).toBe(DEFAULT_LIMIT);
    expect(err({ entity: "products", limit: "mucho" })).toMatch(/limit/);
  });

  it("topes de filtros, in, group_by, agregados y orden", () => {
    const f = Array.from({ length: MAX_FILTERS + 1 }, () => ({ col: "name", op: "not_null" }));
    expect(err({ entity: "products", filters: f })).toMatch(/Máximo/);
    const vals = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `v${i}`);
    expect(err({ entity: "products", filters: [{ col: "name", op: "in", values: vals }] })).toMatch(/'in'/);
    expect(err({ entity: "products", filters: [{ col: "name", op: "in", values: [] }] })).toMatch(/'in'/);
    expect(
      err({ entity: "sales", group_by: ["status", "customer_id", "store_id"] }),
    ).toMatch(/Máximo 2/);
    expect(
      err({ entity: "sales", aggregates: Array.from({ length: 7 }, () => ({ op: "count" })) }),
    ).toMatch(/Máximo/);
    expect(
      err({ entity: "products", order_by: ["name", "price", "cost", "stock"] }),
    ).toMatch(/Máximo/);
    expect(
      err({ entity: "products", filters: [{ col: "price", op: "between", values: [1] }] }),
    ).toMatch(/between/);
  });

  it("rechaza formas inválidas del pedido", () => {
    expect(err(null)).toMatch(/objeto/);
    expect(err([])).toMatch(/objeto/);
    expect(err("select * from products")).toMatch(/objeto/);
    expect(err({ entity: "products", filters: "name = 'x'" })).toMatch(/lista/);
    expect(err({ entity: "products", select: "name" })).toMatch(/lista/);
  });
});
