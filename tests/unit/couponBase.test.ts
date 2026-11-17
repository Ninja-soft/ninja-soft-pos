// PRD-62 (ADR-192): el cupón se calcula en create_sale sobre la misma base que
// el POS (subtotal del carrito, sin recargo del medio de pago ni garantía
// extendida). Chequeos estáticos de la migración y del contrato con el POS; el
// comportamiento contra la base está en tests/integration/rls-cupon-base.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSaleItemsAndExtras, type SaleArgsLine } from "@/modules/pending-charges/logic";

const ROOT = join(__dirname, "..", "..");
const DIR = join(ROOT, "supabase", "migrations");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const FILE = "20270129100000_prd62_coupon_base.sql";
const SEC43 = "20270123100000_sec43_create_sale_idempotency.sql";
const MIG = read(`supabase/migrations/${FILE}`);
const ws = (s: string) => s.replace(/\s+/g, " ").trim();

const fnText = (s: string, start: RegExp) => {
  const i = s.search(start);
  expect(i, String(start)).toBeGreaterThanOrEqual(0);
  const rest = s.slice(i);
  const m = rest.match(/\n(AS|as) (\$[a-z]*\$)\n/)!;
  const from = m.index! + m[0].length;
  return { head: rest.slice(0, m.index!), body: rest.slice(from, rest.indexOf(`\n${m[2]}`, from - 1)) };
};
const CS = /create or replace function public\.create_sale\(/;
const mine = fnText(MIG, CS);
const prod = fnText(read(`supabase/migrations/${SEC43}`), CS);
const B = ws(mine.body);
const at = (s: string) => {
  const i = B.indexOf(ws(s));
  expect(i, s).toBeGreaterThanOrEqual(0);
  return i;
};

// Lo que PRD-62 reemplaza de la definición de SEC-43 (y nada más).
const REPLACED = [
  `    if v_subtotal < coalesce(v_coupon.min_amount, 0) then
      raise exception 'coupon_min_amount';
    end if;
`,
  `    v_coupon_disc := case when v_coupon.discount_type = 'percent'
                          then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100
                          else coalesce(v_coupon.discount_value, 0) end;
    v_coupon_disc := least(
      greatest(v_coupon_disc, 0),
      greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)
    );
`,
];
const stripPrd62 = (s: string) =>
  s
    .replace(/[ \t]*-- PRD-62 >>>[\s\S]*?-- <<< PRD-62\n/g, "")
    .split("\n")
    .filter((l) => !l.includes("-- PRD-62"))
    .join("\n");

describe(`migración ${FILE}`, () => {
  it("create_sale es la de producción (SEC-43) más los bloques PRD-62", () => {
    let base = prod.body;
    for (const r of REPLACED) {
      expect(base.split(r).length - 1, r).toBe(1);
      base = base.replace(r, "");
    }
    expect(prod.body.length).toBeGreaterThan(1000);
    expect(ws(stripPrd62(mine.body))).toBe(ws(base));
    // Mismo encabezado: firma de 15 argumentos, SECURITY DEFINER y search_path.
    expect(mine.head).toBe(prod.head);
    expect(mine.head).toContain("p_service jsonb DEFAULT NULL::jsonb, p_client_request_id uuid DEFAULT NULL::uuid)");
    expect(mine.head).toContain(" SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'");
  });

  it("misma firma y grants que producción, sin drop", () => {
    const SIG = "jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb, uuid";
    expect(MIG).not.toMatch(/drop function/i);
    expect(MIG).toContain(`revoke all on function public.create_sale(${SIG}) from public, anon;`);
    expect(MIG).toContain(`grant execute on function public.create_sale(${SIG}) to authenticated, service_role;`);
  });

  it("es la última definición de create_sale", () => {
    const later = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f > FILE);
    for (const f of later) {
      expect(readFileSync(join(DIR, f), "utf8"), f).not.toMatch(/function (public\.)?create_sale\(/);
    }
  });

  it("el cupón (porcentaje, mínimo y tope) usa la base del carrito", () => {
    const coupon = B.slice(at("select * into v_coupon from coupons"), at("v_total_pre :="));
    expect(coupon).not.toContain(ws("then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100"));
    expect(coupon).toContain(ws("then v_coupon_base * coalesce(v_coupon.discount_value, 0) / 100"));
    expect(coupon).toContain(ws("if v_coupon_base < coalesce(v_coupon.min_amount, 0) then raise exception 'coupon_min_amount';"));
    expect(coupon).toContain(ws("greatest(v_coupon_base - coalesce(p_discount_total, 0) - v_promo_disc, 0),"));
    // El tope de F9 · H54 sobre v_subtotal sigue (piso del total).
    expect(coupon).toContain(ws("greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)"));
    // La base se arma antes del mínimo y del cálculo.
    expect(at("v_coupon_base := greatest(v_coupon_base, 0);")).toBeLessThan(at("if v_coupon_base < coalesce(v_coupon.min_amount, 0)"));
    expect(at("if v_coupon_base < coalesce(v_coupon.min_amount, 0)")).toBeLessThan(
      at("then v_coupon_base * coalesce(v_coupon.discount_value, 0) / 100"),
    );
  });

  it("sólo saca de la base las líneas sin producto anunciadas como recargo o garantía", () => {
    const block = B.slice(at("v_coupon_base := v_subtotal;"), at("v_coupon_base := greatest(v_coupon_base, 0);"));
    expect(B).toContain(
      ws(`select coalesce(array_agg(round(e.amount, 2)), '{}') into v_coupon_pool
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, amount numeric)
     where lower(coalesce(e.kind, '')) in ('warranty', 'surcharge') and coalesce(e.amount, 0) > 0;`),
    );
    // Desde el final de p_items (ahí las agrega buildSaleItemsAndExtras).
    expect(block).toContain(ws("for v_i in reverse coalesce(jsonb_array_length(p_items), 0) - 1 .. 0 loop"));
    expect(block).toContain(ws("continue when nullif(v_j ->> 'product_id', '') is not null;"));
    expect(block).toContain(ws("v_k := _amount_index(v_coupon_pool, v_amt);"));
    // Cada extra se consume una sola vez.
    expect(block).toContain(ws("v_coupon_pool := v_coupon_pool[1:v_k - 1] || v_coupon_pool[v_k + 1:];"));
    expect(B).toContain(ws("v_coupon_base numeric := 0; -- PRD-62"));
  });

  it("el total sigue cobrando recargo y garantía enteros", () => {
    expect(B).toContain(ws("v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc - v_coupon_disc;"));
  });

  it("la huella de idempotencia (SEC-43) y el replay no dependen del monto del cupón", () => {
    const hash = B.slice(at("v_req_hash := coalesce("), at("v_replay := _sale_request_replay(v_tenant, p_client_request_id, v_req_hash);"));
    expect(hash).toContain("'coupon_id', p_coupon_id");
    expect(hash).not.toContain("v_coupon");
    // El replay vuelve antes de calcular nada.
    expect(at("return _sale_replay_result(v_tenant, v_replay);")).toBeLessThan(at("v_coupon_base := v_subtotal;"));
    expect(MIG).not.toMatch(/function (public\.)?_sale_replay_result\(/);
  });
});

describe("contrato con el POS", () => {
  const line = (over: Partial<SaleArgsLine>): SaleArgsLine => ({
    productId: "p1",
    name: "Gaseosa",
    quantity: 1,
    unitPrice: 1000,
    discount: 0,
    lineId: "l1",
    ...over,
  });

  it("la hoja de cobro agrega recargo y garantía al final, sin producto, y los anuncia en extras con el mismo monto", () => {
    const { items, extras } = buildSaleItemsAndExtras(
      [line({}), line({ lineId: "l2", productId: null, name: "Venta libre", unitPrice: 500 })],
      [
        { kind: "warranty", name: "Garantía", amount: 300 },
        { kind: "surcharge", name: "Recargo 3 cuotas", amount: 100 },
      ],
    );
    expect(items.map((i) => [i.product_id, i.unit_price * i.quantity])).toEqual([
      ["p1", 1000],
      [null, 500], // venta libre: queda en la base del cupón (no hay extra con su monto)
      [null, 300],
      [null, 100],
    ]);
    expect(extras.filter((e) => e.kind === "warranty" || e.kind === "surcharge")).toEqual([
      { kind: "warranty", amount: 300 },
      { kind: "surcharge", amount: 100 },
    ]);
  });

  it("el POS calcula el cupón sobre cartSubtotal (sin recargo ni garantía)", () => {
    const pricing = read("modules/pos/screen/usePosPricing.ts");
    expect(pricing).toContain("const subtotal = cartSubtotal(lines);");
    expect(pricing).toContain("if (subtotal < (appliedCoupon.min_amount ?? 0)) return 0;");
    expect(pricing).toContain("? (subtotal * appliedCoupon.discount_value) / 100");
    expect(pricing).toContain("Math.max(0, subtotal - discountTotal)");
  });
});
