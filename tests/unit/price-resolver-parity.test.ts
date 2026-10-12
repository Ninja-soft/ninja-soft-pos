import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { resolveUnitPrice } from "@/lib/prices/resolve";
import {
  ASSIGNMENTS,
  BREAKS,
  CASES,
  CUSTOMERS,
  FX,
  GROUPS,
  ITEMS,
  LISTS,
  MATRIX_NOW,
  PRODUCTS,
  SCHEDULES,
  TERMS,
  worldFor,
} from "../fixtures/priceMatrix";

// Paridad TS ↔ SQL del resolver (ADR-058): el lado TS de la matriz. El lado SQL
// corre la MISMA matriz en tests/integration/rls-listas-precios-pro.test.ts.

function run(c: (typeof CASES)[number]) {
  const p = PRODUCTS.find((x) => x.id === c.product)!;
  const v = p.variants?.find((x) => x.id === c.variant);
  return resolveUnitPrice(worldFor(c.pro, c.customer ?? null), {
    productId: c.product,
    variantId: c.variant ?? null,
    basePrice: p.price,
    variantPrice: v?.price_override ?? null,
    qty: c.qty ?? 1,
    at: c.at ?? MATRIX_NOW,
    listId: c.list ?? null,
    selectedListId: c.posList ?? null,
    termId: c.term ?? null,
  }).price;
}

describe("resolveUnitPrice · matriz de paridad", () => {
  for (const c of CASES) {
    it(`${c.pro ? "PRO" : "simple"} · ${c.name}`, () => {
      expect(run(c)).toBe(c.expected);
    });
  }

  it("informa la lista y la condición aplicadas", () => {
    const p = PRODUCTS[0]!;
    const r = resolveUnitPrice(worldFor(true, CUSTOMERS[0].id), {
      productId: p.id,
      basePrice: p.price,
      at: MATRIX_NOW,
    });
    expect(r.listId).toBe(LISTS.find((l) => l.name === "Matriz grupo")!.id);
    expect(r.termId).toBe(TERMS[0]!.id);
  });
});

// Generador del sembrado SQL para correr la matriz en PGlite a mano:
//   PRICE_MATRIX_SQL=ruta.sql pnpm exec vitest run tests/unit/price-resolver-parity.test.ts
const out = process.env.PRICE_MATRIX_SQL;
if (out) {
  const q = (v: unknown) =>
    v == null ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const T = "99999999-0000-4000-8000-000000000001";
  const lines: string[] = [
    `insert into tenants(id, name, slug, status) values ('${T}', 'Matriz', 'matriz', 'active');`,
    `insert into subscription_addons(tenant_id, addon_key, status, source) values ('${T}', 'listas_precios', 'active', 'granted'), ('${T}', 'listas_precios_pro', 'active', 'granted'), ('${T}', 'variantes', 'active', 'granted'), ('${T}', 'grupos_clientes', 'active', 'granted');`,
  ];
  for (const p of PRODUCTS) {
    const c = p.costs;
    lines.push(
      `insert into products(id, tenant_id, name, price, cost, last_cost, avg_cost, replacement_cost, min_price, has_variants) values (${q(p.id)}, '${T}', ${q(p.name)}, ${p.price}, ${q(c.cost)}, ${q(c.last_cost)}, ${q(c.avg_cost)}, ${q(c.replacement_cost)}, ${q(c.min_price)}, ${p.variants ? "true" : "false"});`,
    );
    for (const v of p.variants ?? []) {
      lines.push(
        `insert into product_variants(id, tenant_id, product_id, option1, price_override) values (${q(v.id)}, '${T}', ${q(p.id)}, ${q(v.option1)}, ${q(v.price_override)});`,
      );
    }
  }
  for (const l of LISTS) {
    lines.push(
      `insert into price_lists(id, tenant_id, name, channel, adjustment_pct, adjustment_amount, kind, base_list_id, cost_basis, markup_mode, markup_value, currency, fx_source, rounding, min_margin_pct, valid_from, valid_to, is_active, pos_selectable, created_at) values (${q(l.id)}, '${T}', ${q(l.name)}, ${q(l.channel)}, ${q(l.adjustment_pct)}, ${q(l.adjustment_amount)}, ${q(l.base_list_id ? "fixed" : l.kind)}, null, ${q(l.cost_basis)}, ${q(l.markup_mode)}, ${q(l.markup_value)}, ${q(l.currency)}, ${q(l.fx_source)}, ${l.rounding ? q(JSON.stringify(l.rounding)) : "null"}, ${q(l.min_margin_pct)}, ${q(l.valid_from)}, ${q(l.valid_to)}, ${l.is_active !== false}, ${Boolean(l.pos_selectable)}, ${q(l.created_at)});`,
    );
  }
  for (const l of LISTS.filter((x) => x.base_list_id)) {
    lines.push(`update price_lists set base_list_id = ${q(l.base_list_id)}, kind = ${q(l.kind)} where id = ${q(l.id)};`);
  }
  for (const i of ITEMS) {
    lines.push(
      `insert into price_list_items(tenant_id, price_list_id, product_id, variant_id, price) values ('${T}', ${q(i.price_list_id)}, ${q(i.product_id)}, ${q(i.variant_id)}, ${i.price});`,
    );
  }
  for (const b of BREAKS) {
    lines.push(
      `insert into price_list_breaks(tenant_id, price_list_id, product_id, variant_id, min_qty, kind, value) values ('${T}', ${q(b.price_list_id)}, ${q(b.product_id)}, ${q(b.variant_id)}, ${b.min_qty}, ${q(b.kind)}, ${b.value});`,
    );
  }
  for (const t of TERMS) {
    lines.push(
      `insert into payment_terms(id, tenant_id, name, days, surcharge_pct, is_active, sort) values (${q(t.id)}, '${T}', ${q(t.name)}, ${t.days}, ${t.surcharge_pct}, ${t.is_active}, ${t.sort});`,
    );
  }
  for (const r of FX) {
    lines.push(
      `insert into fx_rates(tenant_id, currency, source, rate_date, rate) values ('${T}', ${q(r.currency)}, ${q(r.source)}, ${q(r.rate_date)}, ${r.rate});`,
    );
  }
  for (const s of SCHEDULES) {
    lines.push(
      `insert into price_schedules(id, tenant_id, list_id, product_id, variant_id, price, effective_at, status, created_at) values (${q(s.id)}, '${T}', ${q(s.list_id)}, ${q(s.product_id)}, ${q(s.variant_id)}, ${s.price}, ${q(s.effective_at)}, ${q(s.status)}, ${q(s.created_at)});`,
    );
  }
  for (const g of GROUPS) lines.push(`insert into customer_groups(id, tenant_id, name) values (${q(g.id)}, '${T}', ${q(g.name)});`);
  for (const c of CUSTOMERS) {
    lines.push(
      `insert into customers(id, tenant_id, name, group_id, payment_term_id) values (${q(c.id)}, '${T}', ${q(c.name)}, ${q(c.group_id)}, ${q(c.payment_term_id)});`,
    );
  }
  for (const a of ASSIGNMENTS) {
    lines.push(
      `insert into price_list_assignments(tenant_id, price_list_id, scope, scope_id) values ('${T}', ${q(a.price_list_id)}, ${q(a.scope)}, ${q(a.scope_id)});`,
    );
  }
  lines.push("create temp table matrix_out(i int, pro boolean, got numeric, expected numeric);");
  for (const pro of [true, false]) {
    if (!pro) lines.push(`update subscription_addons set status = 'cancelled' where tenant_id = '${T}' and addon_key = 'listas_precios_pro';`);
    CASES.forEach((c, i) => {
      if (c.pro !== pro) return;
      lines.push(
        `insert into matrix_out values (${i}, ${pro}, _resolve_unit_price('${T}', ${q(c.product)}, ${q(c.variant ?? null)}, ${c.qty ?? 1}, ${q(c.customer ?? null)}, null, ${q(c.list ?? null)}, ${q(c.at ?? MATRIX_NOW)}, ${q(c.term ?? null)}, ${q(c.posList ?? null)}), ${c.expected});`,
      );
    });
  }
  lines.push("select count(*) as total, count(*) filter (where got is distinct from expected) as bad, jsonb_agg(jsonb_build_array(i, got, expected)) filter (where got is distinct from expected) as diffs from matrix_out;");
  writeFileSync(out, lines.join("\n") + "\n");
}
