// @vitest-environment node
// ADR-156: auditoría del cobro de la suscripción y de los complementos.
// Cálculo (espejo de platform_addon_billable / _usable / _price_on y
// platform_mp_expected_amount; los mismos escenarios corren en PGlite contra
// la migración 20261224100000_addon_email_cobro) y guardas estáticas sobre la
// migración y las Edges de cobro.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addonBillable,
  addonPriceOn,
  addonUsable,
  authorizedPaymentKey,
  debitStartDate,
  expectedAmount,
  needsAmountSync,
} from "@/lib/billing/mpAmount";
import { billingTotal } from "@/lib/billing/ledger";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIG = read("supabase/migrations/20261224100000_addon_email_cobro.sql");

describe("C1 · baja de un complemento", () => {
  it("se cobra en los cobros anteriores al fin del período, no en el que arranca ese día", () => {
    expect(addonBillable("active", true, "2026-11-04", "2026-10-15")).toBe(true);
    expect(addonBillable("active", true, "2026-11-04", "2026-11-04")).toBe(false);
    expect(addonBillable("active", true, "2026-11-04", "2026-12-04")).toBe(false);
    expect(addonBillable("active", false, null, "2030-01-01")).toBe(true);
    expect(addonBillable("cancelled", false, null, "2026-10-15")).toBe(false);
  });

  it("se puede usar hasta el fin del período inclusive", () => {
    expect(addonUsable("active", true, "2026-11-04", "2026-11-04")).toBe(true);
    expect(addonUsable("active", true, "2026-11-04", "2026-11-05")).toBe(false);
  });

  it("billingTotal deja de cobrarlo en el período siguiente (antes lo cobraba para siempre)", () => {
    const addons = [
      { status: "active", source: "purchased", monthly_price_ars: 15000, cancel_at_period_end: true, current_period_end: "2026-11-04" },
    ];
    const base = { cycle: "monthly", planMonthly: 90000, planYearly: 0, discounts: [] };
    expect(billingTotal({ ...base, addons, at: "2026-10-15" }).total).toBe(105000);
    expect(billingTotal({ ...base, addons, at: "2026-11-04" }).total).toBe(90000);
  });
});

describe("M1 · prueba del complemento y escalones programados", () => {
  it("en prueba no se cobra; después sí", () => {
    const a = { source: "purchased", monthly_price_ars: 15000, trial_ends_at: "2026-10-22" };
    expect(addonPriceOn(a, "2026-10-15")).toBe(0);
    expect(addonPriceOn(a, "2026-10-22")).toBe(15000);
  });

  it("bonificado nunca; escalón nuevo desde su fecha", () => {
    expect(addonPriceOn({ source: "granted", monthly_price_ars: 15000 }, "2026-10-15")).toBe(0);
    const a = { source: "purchased", monthly_price_ars: 12000, pending_price_ars: 5000, pending_from: "2026-11-04" };
    expect(addonPriceOn(a, "2026-10-15")).toBe(12000);
    expect(addonPriceOn(a, "2026-11-04")).toBe(5000);
  });

  it("billingTotal usa el precio del día del cobro", () => {
    const addons = [
      { status: "active", source: "purchased", monthly_price_ars: 12000, pending_price_ars: 5000, pending_from: "2026-11-04" },
      { status: "active", source: "purchased", monthly_price_ars: 15000, trial_ends_at: "2026-10-22" },
    ];
    const base = { cycle: "monthly", planMonthly: 90000, planYearly: 0, discounts: [] };
    expect(billingTotal({ ...base, addons, at: "2026-10-15" }).total).toBe(102000);
    expect(billingTotal({ ...base, addons, at: "2026-11-04" }).total).toBe(110000);
  });
});

describe("H1/H2 · monto del próximo débito de Mercado Pago", () => {
  it("período + ajustes abiertos, al centavo", () => {
    expect(expectedAmount(95000, 333333)).toBe(98333.33);
    expect(expectedAmount(95000, 0)).toBe(95000);
    expect(expectedAmount(0.1, 20)).toBe(0.3);
    expect(expectedAmount(95000, -50)).toBe(95000);
  });

  it("sincroniza sólo si cambia al centavo o nunca se sincronizó", () => {
    expect(needsAmountSync(98333.33, 98333.33)).toBe(false);
    expect(needsAmountSync(98333.33, 98333.3)).toBe(true);
    expect(needsAmountSync(95000, null)).toBe(true);
    expect(needsAmountSync(0, null)).toBe(false);
  });
});

describe("Prueba del plan · el débito arranca al terminarla", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("difiere el primer cobro si queda prueba", () => {
    expect(debitStartDate({ status: "trial", trialEndsAt: "2026-10-29T12:00:00Z", now })).toBe("2026-10-29T12:00:00.000Z");
  });
  it("cobro inmediato si no hay prueba, ya terminó o falta menos de una hora", () => {
    expect(debitStartDate({ status: "active", trialEndsAt: "2026-10-29T12:00:00Z", now })).toBeNull();
    expect(debitStartDate({ status: "trial", trialEndsAt: "2026-10-15T12:30:00Z", now })).toBeNull();
    expect(debitStartDate({ status: "trial", trialEndsAt: null, now })).toBeNull();
  });
});

describe("C2 · un débito se acredita una sola vez", () => {
  it("la clave del cobro es la misma venga por la notificación o por la búsqueda", () => {
    expect(authorizedPaymentKey({ id: 77, payment: { id: 123 } })).toBe("authpay:123");
    expect(authorizedPaymentKey({ id: 77, payment: null })).toBe("authpay:77");
    expect(authorizedPaymentKey({ id: null })).toBeNull();
  });

  it("la autorización del preapproval ya no acredita plata", () => {
    const wh = read("supabase/functions/mp_billing_webhook/index.ts");
    expect(wh).not.toMatch(/kind:\s*"preapproval_authorized"/);
    expect(wh).not.toMatch(/eventKey = `preapproval_authorized:/);
    expect(wh).toMatch(/authorized_payments\/search\?preapproval_id=/);
    // 'pending' no pasa la suscripción a prueba.
    expect(wh).toMatch(/if \(pre\.status === "pending"\)/);
    // Después de acreditar se recalcula el monto del débito.
    expect(wh).toMatch(/syncPreapprovalAmount\(admin, tenantId/);
  });

  it("el checkout difiere el débito en la prueba y usa el monto esperado", () => {
    const co = read("supabase/functions/mp_subscription_checkout/index.ts");
    expect(co).toMatch(/platform_mp_expected_amount/);
    expect(co).toMatch(/start_date: startDate/);
  });
});

describe("Migración 20261224100000 · guardas", () => {
  it("sin is_internal() suelto ni OR is_internal()", () => {
    const code = MIG.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/or\s+\(?\s*(select\s+)?is_internal\(\)/i);
    expect(code).not.toMatch(/\bis_internal\(\)/i);
  });

  it("tablas nuevas con RLS y sin policies (todo por RPC)", () => {
    for (const t of ["email_addon_settings", "email_addon_tiers", "email_addon_usage"]) {
      expect(MIG).toMatch(new RegExp(`alter table ${t} enable row level security`));
      expect(MIG).not.toMatch(new RegExp(`create policy [a-z_]+ on ${t}\\b`));
    }
  });

  it("las puertas de envío y de cobro son sólo de service_role", () => {
    const block = MIG.slice(MIG.indexOf("foreach f in array array[\n    'email_addon_consume"));
    for (const f of [
      "email_addon_consume(uuid, int)",
      "email_addon_release(uuid, int)",
      "platform_mp_expected_amount(uuid)",
      "platform_mp_amount_targets(int)",
      "platform_addons_daily()",
      "email_addon_set_provider_state(jsonb, uuid)",
    ]) {
      expect(block).toContain(`'${f}'`);
    }
    expect(block).toMatch(/revoke all on function %s from public, anon, authenticated/);
  });

  it("el staff entra por platform_staff_billing_role (internal_scope) y audita", () => {
    expect(MIG).toMatch(/platform_staff_billing_role\(\), ''\) not in \('admin', 'super_admin'\)/);
    for (const a of ["email_addon_settings_saved", "email_addon_tier_created", "addon_email_activated", "email_addon_quota_warning"]) {
      expect(MIG).toContain(`'${a}'`);
    }
  });

  it("el alta exige el precio que vio el dueño", () => {
    expect(MIG).toMatch(/raise exception 'price_changed'/);
  });

  it("los crons nuevos se programan sólo si hay pg_cron / pg_net", () => {
    expect(MIG).toMatch(/cron\.schedule\('platform-addons-daily'/);
    expect(MIG).toMatch(/cron\.schedule\('email-addon-overage'/);
    expect(MIG).toMatch(/cron\.schedule\('platform-mp-amount-sync'/);
    expect(MIG).toMatch(/pg_extension where extname = 'pg_net'/);
  });
});
