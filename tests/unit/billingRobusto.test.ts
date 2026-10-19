// ADR-167: cobro SaaS robusto (B-3, B-2, M-b). La lógica vive en SQL; estos
// tests fijan las garantías de la migración para que una redefinición futura
// no las pierda. Los escenarios se verificaron en un dry-run contra producción
// (transacción revertida): un negocio con error no frena el excedente del
// resto, el bonificado no paga excedente, MRR y acceso a la IA sin cambios en
// los negocios actuales, y un pago por transferencia encola la sincronización
// del monto de MP mientras que el débito de MP no.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20270106100000_billing_robusto.sql"),
  "utf8",
);

function fn(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `falta ${name}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$function$;", start);
  return sql.slice(start, end);
}

describe("B-3 · excedente de emails fila por fila", () => {
  const body = fn("email_addon_bill_overage");

  it("cada negocio corre en su propio bloque con exception y se audita el error", () => {
    const loop = body.slice(body.indexOf("loop"));
    expect(loop).toMatch(/begin[\s\S]*exception when others then[\s\S]*email_overage_bill_failed/);
    expect(body).toContain("'failed', v_failed");
  });

  it("sin suscripción no se crea el cargo", () => {
    expect(body).toMatch(/if v_sub\.id is null then[\s\S]*email_overage_bill_skipped[\s\S]*continue;/);
  });

  it("el complemento bonificado no paga excedente", () => {
    expect(body).toMatch(/source = 'granted'[\s\S]*email_overage_waived/);
  });

  it("conserva la idempotencia del cargo por negocio y período", () => {
    expect(body).toContain("'email_overage:' || r.tenant_id::text || ':' || v_period");
  });
});

describe("B-2 · misma regla que el gating y la facturación", () => {
  it("ai_available usa platform_addon_usable con la fecha de Argentina", () => {
    const body = fn("ai_available");
    expect(body).toContain("platform_addon_usable(sa.status, sa.cancel_at_period_end, sa.current_period_end");
    expect(body).toContain("platform_ar_date(now())");
    expect(body).not.toMatch(/current_date/);
  });

  it("platform_mrr_cents usa billable y el precio del día (prueba y escalón pendiente)", () => {
    const body = fn("platform_mrr_cents");
    expect(body).toContain("platform_addon_billable(sa.status, sa.cancel_at_period_end, sa.current_period_end, p_day)");
    expect(body).toContain("platform_addon_price_on(sa.source, sa.monthly_price_ars, pa.monthly_price_ars, sa.trial_ends_at");
    expect(body).not.toMatch(/sa\.status = 'active'\s+or/);
  });
});

describe("M-b · pago por otro medio re-sincroniza el débito de MP", () => {
  const trg = fn("trg_platform_payments_mp_amount_sync");

  it("ignora el propio débito de MP y los pagos no aprobados", () => {
    expect(trg).toContain("new.method = 'mp_preapproval' or new.status <> 'approved'");
  });

  it("sólo con débito automático vigente", () => {
    expect(trg).toContain("platform_effective_billing_mode(new.tenant_id) <> 'mp_subscription'");
    expect(trg).toContain("mp_preapproval_id");
  });

  it("nunca hace fallar el pago", () => {
    expect(trg).toMatch(/exception when others then[\s\S]*platform_mp_amount_sync_failed/);
  });

  it("dispara al insertar y al aprobar un pago pendiente", () => {
    expect(sql).toMatch(/after insert or update of status on public\.platform_payments/);
  });

  it("el pedido HTTP es el modo cron de la Edge y no lo puede llamar nadie más", () => {
    const req = fn("platform_request_mp_amount_sync");
    expect(req).toContain("mp_update_subscription_amount");
    expect(req).toContain("'X-Cron-Secret'");
    expect(sql).toContain(
      "revoke all on function public.platform_request_mp_amount_sync(text) from public, anon, authenticated;",
    );
  });
});
