// ADR-088: create_sale con depósitos, seña de turnos y devoluciones con promo.
// Helpers puros del front y chequeos estáticos de la migración (la lógica SQL
// la cubre tests/integration/rls-create-sale-deudas.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  depositAvailable,
  depositErrorMessage,
  depositLeft,
  depositToApply,
  type AppointmentDeposit,
} from "@/modules/agenda/deposits";
import { saleErrorTitle } from "@/modules/pos/screen/usePosSale";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";

const DIR = join(process.cwd(), "supabase", "migrations");
const MIG = "20261108200000_create_sale_deudas.sql";
const sql = readFileSync(join(DIR, MIG), "utf8");

const dep = (p: Partial<AppointmentDeposit>): AppointmentDeposit => ({
  id: "d",
  appointment_id: "a",
  method: "cash",
  reference: null,
  amount: 0,
  applied_amount: 0,
  refunded_amount: 0,
  status: "held",
  sale_id: null,
  refund_reason: null,
  created_at: "",
  ...p,
});

describe("seña de turnos: helpers", () => {
  it("lo disponible es lo que queda de las señas sin aplicar ni devolver", () => {
    expect(depositLeft(dep({ amount: 5000, applied_amount: 4000 }))).toBe(1000);
    expect(
      depositAvailable([
        dep({ amount: 1000 }),
        dep({ amount: 500, refunded_amount: 200 }),
        dep({ amount: 900, applied_amount: 900, status: "applied" }),
      ]),
    ).toBe(1300);
  });

  it("el pago 'sena' es la seña hasta el total (espejo de create_sale)", () => {
    expect(depositToApply(1000, 4000)).toBe(1000);
    expect(depositToApply(5000, 4000)).toBe(4000);
    expect(depositToApply(0, 4000)).toBe(0);
    expect(depositToApply(1000, 0)).toBe(0);
  });

  it("mensajes claros para los errores del servidor", () => {
    expect(depositErrorMessage("feature_not_in_plan: agenda_senas")).toMatch(/plan/);
    expect(depositErrorMessage("no_open_shift")).toMatch(/caja/);
    expect(depositErrorMessage("deposit_not_refundable")).toMatch(/saldo/);
    expect(saleErrorTitle("deposit_mismatch:{}")).toMatch(/seña/);
    expect(saleErrorTitle("appointment_already_charged")).toMatch(/ya se cobró/);
    expect(saleErrorTitle("insufficient_stock_salon")).toMatch(/salón/);
    expect(PAYMENT_METHOD_LABELS.sena).toBe("Seña");
  });

  it("feature agenda_senas: OPTIONAL desde Pro, requiere agenda", () => {
    expect(FEATURE_INFO.agenda_senas?.minPlan).toBe("Pro");
    expect(featureRequires("agenda_senas")).toEqual(["agenda"]);
    expect(sql).toMatch(/'agenda_senas'[\s\S]*'ventas', false/);
    expect(sql).toMatch(/'agenda_senas', \(p\.key in \('pro', 'business', 'enterprise'\)\)/);
  });
});

describe("migración 20261108200000", () => {
  const later = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && f > MIG)
    .map((f) => readFileSync(join(DIR, f), "utf8"));

  it("es la última definición de create_sale y de return_sale_v2", () => {
    for (const s of later) {
      expect(s).not.toMatch(/function (public\.)?create_sale\(/);
      expect(s).not.toMatch(/function (public\.)?return_sale_v2\(/);
    }
    expect(sql).toMatch(/create or replace function public\.create_sale\(p_items jsonb/);
    expect(sql).toMatch(/create or replace function return_sale_v2\(/);
  });

  it("conserva los bloques de impuestos, promociones, offline y precio en el servidor", () => {
    for (const marker of [
      "ninja.offline_sync",
      "ninja.offline_sold_at",
      "ninja.pc_complete",
      "_sale_tax_compute",
      "_promo_evaluate",
      "promo_mismatch",
      "price_mismatch",
      "resolve_sale_shift(p_cash_shift_id, true)",
      "insufficient_stock_branch",
      "negative_stock_branch",
      "sale_promotions",
      "'offline_conflicts'",
    ]) {
      expect(sql, marker).toContain(marker);
    }
  });

  it("depósitos: valida el salón y sólo toma de reserva u 'otro'", () => {
    expect(sql).toContain("insufficient_stock_salon");
    expect(sql).toContain("negative_stock_salon");
    expect(sql).toMatch(/w\.kind in \('reserva', 'otro'\)/);
    expect(sql).toMatch(/sell_from_reserve boolean not null default false/);
    expect(sql).toMatch(/tenant_has_feature_for\(v_tenant, 'depositos'\)/);
  });

  it("seña: pago 'sena' exacto, turno bloqueado y enlazado en la misma venta", () => {
    expect(sql).toContain("deposit_mismatch:");
    expect(sql).toContain("deposit_needs_appointment");
    expect(sql).toMatch(/from appointments\s+where id = v_appt_id and tenant_id = v_tenant\s+for update/);
    expect(sql).toMatch(/'directo','sena'/);
  });

  it("policies nuevas con (select current_tenant_id()) y sin is_internal()", () => {
    const policies = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p).not.toMatch(/is_internal\(\)/);
      if (p.includes("current_tenant_id")) expect(p).toContain("(select current_tenant_id())");
    }
    expect(sql).toMatch(/revoke insert, update, delete on appointment_deposits from anon, authenticated/);
  });

  it("toda función SECURITY DEFINER fija search_path", () => {
    const fns = sql.split(/create or replace function /i).slice(1);
    for (const f of fns) {
      const head = f.slice(0, f.search(/\$(function)?\$/));
      if (/security definer/i.test(head)) expect(head.toLowerCase()).toMatch(/set search_path/);
    }
  });
});
