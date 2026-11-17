// PRD-02: integridad del motor de promociones dentro de la create_sale vigente.
//   1) Guard de linaje: ninguna migración recrea create_sale sin partir de la
//      anterior (renglones y bloques marcados + huellas de cada ADR). Se prueba
//      con un fixture que simula una copia vieja.
//   2) Chequeos estáticos de cómo la última create_sale le pasa al motor el
//      precio libre (ADR-151), la seña (ADR-088), la reserva (ADR-096) y el
//      cupón con tope (F9 · H54), en el mismo orden que el POS.
// La matriz del motor (TS y SQL) está en tests/fixtures/promoMatrix.ts; el
// comportamiento contra la base, en tests/integration/rls-promociones-create-sale.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINGERPRINTS,
  LINEAGE_FROM,
  createSaleDefs,
  lineageProblems,
  oldCopyFixture,
  ws,
} from "../fixtures/createSaleLineage";

const defs = createSaleDefs();
const latest = defs[defs.length - 1]!;
const B = ws(latest.body);
const at = (s: string) => {
  const i = B.indexOf(ws(s));
  expect(i, s).toBeGreaterThanOrEqual(0);
  return i;
};
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\r\n/g, "\n");

describe("create_sale · guard de linaje", () => {
  it("hay una cadena de definiciones desde ADR-074 hasta la vigente", () => {
    const from = defs.findIndex((d) => d.file === LINEAGE_FROM);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(defs.length - from).toBeGreaterThanOrEqual(8);
    // Hoy la vigente es la de SEC-43; una migración nueva la reemplaza acá y
    // tiene que pasar el test siguiente contra ésta.
    expect(defs.map((d) => d.file)).toContain("20270123100000_sec43_create_sale_idempotency.sql");
  });

  it("cada create_sale desde ADR-074 parte de la anterior (no pierde bloques ni huellas)", () => {
    const from = defs.findIndex((d) => d.file === LINEAGE_FROM);
    for (let k = from + 1; k < defs.length; k++) {
      expect(lineageProblems(defs[k - 1]!, defs[k]!), defs[k]!.file).toEqual([]);
    }
  });

  it("la vigente tiene las huellas de todos los ADR", () => {
    for (const [adr, prints] of Object.entries(FINGERPRINTS)) {
      for (const f of prints) expect(B, `${adr}: ${f}`).toContain(ws(f));
    }
  });

  it("detecta una migración nueva que copia una create_sale vieja (fixture: copia de ADR-116)", () => {
    const fake = oldCopyFixture(defs);
    const problems = lineageProblems(latest, fake);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("ADR-151"))).toBe(true);
    expect(problems.some((p) => p.includes("SEC-43"))).toBe(true);
    // Lo que la copia vieja sí tenía no se reporta.
    expect(problems.some((p) => p.startsWith("huella ADR-074"))).toBe(false);
  });

  it("detecta una copia que pierde la exclusión cupón/promo aunque conserve los comentarios", () => {
    const body = latest.body.replace(
      /\n\s*if p_coupon_id is not null then\n\s*v_promo_eval := v_promo_eval \|\| jsonb_build_object\('discount', 0, 'applied', '\[\]'::jsonb\);\n\s*end if;/,
      "",
    );
    expect(body).not.toBe(latest.body);
    const problems = lineageProblems(latest, { file: "20991231000001_sin_exclusion.sql", body });
    expect(problems).toEqual([expect.stringContaining("huella ADR-074")]);
  });

  it("una copia fiel con un bloque marcado nuevo pasa", () => {
    const body = latest.body.replace(
      "  -- <<< SEC-43\n\n  if coalesce(p_discount_total, 0) < 0 then",
      "  -- <<< SEC-43\n  -- PRD-99 >>>\n  perform 1;\n  -- <<< PRD-99\n\n  if coalesce(p_discount_total, 0) < 0 then",
    );
    expect(body).not.toBe(latest.body);
    expect(lineageProblems(latest, { file: "20991231000002_copia_fiel.sql", body })).toEqual([]);
  });
});

describe("create_sale vigente · promos con precio libre, seña, reserva y cupón", () => {
  it("el motor corre una sola vez por intento, después del precio y antes del cupón, la seña y el pago", () => {
    const promo = at("v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);");
    expect(at("raise exception using message = 'price_mismatch:'")).toBeLessThan(promo);
    expect(promo).toBeLessThan(at("select * into v_coupon from coupons"));
    expect(promo).toBeLessThan(at("v_sena_exp := round(least(v_sena_avail, v_total), 2);"));
    expect(promo).toBeLessThan(at("raise exception 'insufficient_payment';"));
  });

  it("precio libre (ADR-151): la línea entra al motor con el precio tipeado, no con el de lista", () => {
    // El renglón de precio libre sale del bucle de precio antes del control de
    // mismatch; el motor arma las líneas desde p_items (lo que cobró el POS).
    expect(at("v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_up, 'reason', null)); continue;")).toBeLessThan(
      at("v_ok := abs(v_up - v_exp) <= 0.01;"),
    );
    expect(B).toContain(
      ws(`'line_total', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                               - coalesce((x.v ->> 'discount')::numeric, 0), 2),`),
    );
    // Los regalos y las sesiones de pack no pasan por el precio libre.
    expect(B).toContain(
      ws("if nullif(v_j ->> 'gift_promo_id', '') is null and nullif(v_j ->> 'pack_credit_id', '') is null then select * into v_or"),
    );
    // Mismo armado en el POS: lineTotal = subtotal de la línea del carrito.
    expect(read("modules/pos/screen/usePosPricing.ts")).toContain("lineTotal: r2(lineSubtotal(l)),");
  });

  it("seña (ADR-088): cuenta como un pago más para las condiciones de cobro, igual que en el POS", () => {
    const ctx = B.slice(at("v_promo_ctx := jsonb_build_object("), at("perform pg_advisory_xact_lock(hashtext('promo_use:'"));
    expect(ctx).toContain(ws("where coalesce(x.amount, 0) > 0));"));
    expect(ctx).not.toContain("sena");
    // En la hoja de cobro la seña es un pago bloqueado y apto para promos.
    const sheet = read("components/pos/checkout/CheckoutSheet.tsx");
    expect(sheet).toMatch(/method: "sena",[\s\S]{0,200}promoEligible: true/);
    // La seña cubre hasta el total YA descontada la promo (y el cupón).
    expect(at("v_promo_disc := v_promo_calc;")).toBeLessThan(at("v_sena_exp := round(least(v_sena_avail, v_total), 2);"));
  });

  it("reserva (ADR-096): se valida antes del motor y la cubren las líneas grabadas (regalos incluidos)", () => {
    const promo = at("v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);");
    expect(at("raise exception 'reservation_not_verified';")).toBeLessThan(promo);
    expect(promo).toBeLessThan(at("raise exception 'reservation_items_mismatch';"));
    // La cobertura suma sale_items sin mirar gift_promo_id.
    const cover = B.slice(at("if v_resv_id is not null then if exists ("), at("raise exception 'reservation_items_mismatch';"));
    expect(cover).not.toContain("gift");
  });

  it("cupón con tope (F9 · H54): anula las promos de descuento antes de validar el tope y conserva los regalos", () => {
    const zero = at(
      "if p_coupon_id is not null then v_promo_eval := v_promo_eval || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb); end if;",
    );
    expect(at("v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);")).toBeLessThan(zero);
    expect(zero).toBeLessThan(at("raise exception 'coupon_usage_exceeded';"));
    // El reintento de los 5 minutos también anula la promo con cupón.
    expect(B).toContain(
      ws("if p_coupon_id is not null then v_gift := v_gift || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb); end if;"),
    );
    // Tope total y por cliente con la fila del cupón bloqueada.
    expect(B).toContain(ws("where id = p_coupon_id and tenant_id = v_tenant and deleted_at is null for update;"));
    expect(B).toContain(ws("if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then"));
    // Los regalos no se tocan: 'gifts' sigue y se valida contra el motor.
    expect(B).toContain(ws("select 1 from jsonb_array_elements(coalesce(v_promo_eval -> 'gifts', '[]'::jsonb)) g"));
    // El POS: con cupón no manda promo de descuento.
    const pricing = read("modules/pos/screen/usePosPricing.ts");
    expect(pricing).toContain("const promoActive = !appliedCoupon;");
    expect(pricing).toMatch(/promoForPayments = useCallback\(\s*\(pays: PromoPayment\[\]\): PricingPromo \| null => \{\s*if \(appliedCoupon\) return null;/);
  });

  // PRD-62 (ADR-192): el cupón % (mínimo y tope incluidos) se calcula en
  // create_sale sobre v_coupon_base, el subtotal sin las líneas sin producto que
  // agrega la hoja de cobro (recargo de cuotas, garantía extendida), igual que
  // el POS (usePosPricing: couponDiscount sobre cartSubtotal). Antes era
  // DIVERGENCIA (it.fails de PRD-02). Ver tests/unit/couponBase.test.ts.
  it("el cupón se calcula sobre la misma base que el POS (sólo el carrito, PRD-62)", () => {
    const coupon = B.slice(at("v_coupon_disc := case when v_coupon.discount_type = 'percent'"), at("v_total_pre :="));
    expect(coupon).not.toContain(ws("then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100"));
    expect(coupon).toContain(ws("then v_coupon_base * coalesce(v_coupon.discount_value, 0) / 100"));
  });
});
