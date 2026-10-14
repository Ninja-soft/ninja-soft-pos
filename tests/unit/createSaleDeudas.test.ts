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
  // ADR-093 (20261108600000) recrea las dos copiando esta definición y sólo
  // agrega tenant_id explícito en los inserts. ADR-096 (20261109500000) recrea
  // create_sale copiando la de ADR-093 y sólo agrega bloques marcados
  // (reservas de stock y garantía enlazada). Son las únicas posteriores.
  const ADR093 = "20261108600000_perf_f4_create_sale_tenant.sql";
  const ADR096 = "20261109500000_create_sale_reservas_garantia.sql";
  // ADR-116 recrea create_sale copiando la de ADR-096 con un parámetro
  // opcional más (tests/unit/serviciosProfesionales.test.ts lo compara).
  const ADR116 = "20261114100000_servicios_profesionales.sql";
  const later = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && f > MIG && f !== ADR093 && f !== ADR096 && f !== ADR116)
    .map((f) => readFileSync(join(DIR, f), "utf8"));
  const adr093 = readFileSync(join(DIR, ADR093), "utf8");
  const adr096 = readFileSync(join(DIR, ADR096), "utf8");
  const body = (s: string, fn: RegExp) => {
    const i = s.search(fn);
    const end = s.slice(i).search(/\n\$(function)?\$;/);
    return s.slice(i, i + end);
  };
  const norm = (s: string) =>
    s
      .split("\n")
      .filter((l) => !l.includes("ADR-093"))
      .join("\n")
      .replace(/\btenant_id, /g, "")
      .replace(/\bv_tenant, (?=v_|p_)/g, "")
      .replace(/\s+/g, " ");
  // Quita lo agregado por ADR-096: bloques entre marcas, líneas marcadas y el
  // `returning id` del insert de sale_items.
  const strip096 = (s: string) =>
    s
      .replace(/\)\n\s*returning id into v_line_id;[^\n]*/g, ");")
      .replace(/[ \t]*-- ADR-096 >>>[\s\S]*?-- <<< ADR-096\n/g, "")
      .split("\n")
      .filter((l) => !l.includes("ADR-096"))
      .join("\n")
      .replace(/\s+/g, " ");

  it("es la última definición de create_sale y de return_sale_v2 (salvo las copias de ADR-093, ADR-096 y ADR-116)", () => {
    for (const s of later) {
      expect(s).not.toMatch(/function (public\.)?create_sale\(/);
      expect(s).not.toMatch(/function (public\.)?return_sale_v2\(/);
    }
    expect(adr096).not.toMatch(/function (public\.)?return_sale_v2\(/);
    expect(sql).toMatch(/create or replace function public\.create_sale\(p_items jsonb/);
    expect(sql).toMatch(/create or replace function return_sale_v2\(/);
  });

  it("ADR-093 copia estas definiciones y sólo agrega tenant_id en los inserts", () => {
    for (const fn of [/create or replace function public\.create_sale\(/, /create or replace function return_sale_v2\(/]) {
      const a = norm(body(sql, fn));
      const b = norm(body(adr093, fn));
      expect(b.length).toBeGreaterThan(1000);
      expect(b).toBe(a);
    }
  });

  it("ADR-096 copia create_sale de ADR-093 y sólo agrega bloques marcados", () => {
    const fn = /create or replace function public\.create_sale\(/;
    const a = body(adr093, fn).replace(/\s+/g, " ");
    const raw = body(adr096, fn);
    const b = strip096(raw);
    expect(b.length).toBeGreaterThan(1000);
    expect(b).toBe(a);
    // Lo agregado: reservas y garantía enlazada.
    expect(raw).toContain("insufficient_stock_reserved");
    expect(raw).toContain("negative_stock_reserved");
    expect(raw).toContain("'stock_reservation_delivered'");
    expect(raw).toContain("reservation_items_mismatch");
    expect(raw).toContain("reservation_not_verified");
    expect(raw).toMatch(/tenant_has_feature_for\(v_tenant, 'reservas_stock'\)/);
    expect(raw).toMatch(/pg_advisory_xact_lock\(hashtext\('stock_reservation:' \|\| v_store::text\)\)/);
    expect(raw).toContain("warranty_link_invalid");
    expect(raw).toMatch(/warranty_for_item_id = v_line_ids\[v_wl_for \+ 1\]/);
    // tenant_id explícito en todo insert (P8).
    for (const ins of raw.match(/insert into \w+ \([^)]*\)/g) ?? []) expect(ins, ins).toContain("tenant_id");
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
