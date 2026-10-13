// @vitest-environment node
// F14 primer corte (ADR-092): maker-checker comercial (H63), alertas de
// margen (H67), conteo cíclico ABC y garantías por serie (H64). Helpers puros
// y chequeo estático de las migraciones 20261109200000 a 20261109200400.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GOVERNANCE,
  changedFields,
  effectiveStatus,
  formatValue,
  isCosmeticOnly,
  isHighImpactPromo,
  needsApproval,
  promoImpactPct,
} from "@/lib/commercial/governance";
import { crossesBelow, marginLevel, marginPct, suggestedPrice } from "@/lib/commercial/margins";
import {
  DEFAULT_CYCLE_POLICY,
  classifyAbc,
  countSummary,
  isDue,
  overdueDays,
  policyError,
} from "@/lib/stock/cycleCount";
import {
  addMonths,
  daysLeft,
  nextClaimStatuses,
  normalizeSerial,
  warrantyState,
  warrantyUntil,
} from "@/lib/stock/serialWarranty";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";

const ROOT = join(__dirname, "..", "..");
const MIG = (f: string) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8");
const MIGRATIONS = [
  "20261109200000_features_f14_comercial.sql",
  "20261109200100_gobierno_comercial.sql",
  "20261109200200_alertas_margen.sql",
  "20261109200300_conteo_ciclico.sql",
  "20261109200400_garantias_serie.sql",
];

const g = { ...DEFAULT_GOVERNANCE, enabled: true, has_feature: true };

describe("H63 · impacto de una promoción", () => {
  it("estima el % por tipo de beneficio", () => {
    expect(promoImpactPct({ action_type: "percent", action_value: 25 })).toBe(25);
    expect(promoImpactPct({ action_type: "percent", action_value: 140 })).toBe(100);
    expect(promoImpactPct({ action_type: "second_item", action_value: 50 })).toBe(25);
    expect(promoImpactPct({ action_type: "nxm", buy_qty: 2, pay_qty: 1 })).toBe(50);
    expect(promoImpactPct({ action_type: "nxm", buy_qty: 3, pay_qty: 2 })).toBe(33.33);
    expect(promoImpactPct({ action_type: "nxm", buy_qty: 2, pay_qty: 2 })).toBe(0);
    expect(promoImpactPct({ action_type: "volume_tier", volume_tiers: [{ min_qty: 3, pct: 5 }, { min_qty: 6, pct: 12 }] })).toBe(12);
    expect(promoImpactPct({ action_type: "amount", action_value: 500 })).toBeNull();
    expect(promoImpactPct({ action_type: "bundle", action_value: 900 })).toBeNull();
  });

  it("alto impacto según la política", () => {
    expect(isHighImpactPromo({ action_type: "percent", action_value: 20 }, g)).toBe(true);
    expect(isHighImpactPromo({ action_type: "percent", action_value: 19.99 }, g)).toBe(false);
    // 2x1 es 50 %: se revisa.
    expect(isHighImpactPromo({ action_type: "nxm", buy_qty: 2, pay_qty: 1 }, g)).toBe(true);
    // Sin estimación y sin umbral en pesos: se revisa.
    expect(isHighImpactPromo({ action_type: "gift" }, g)).toBe(true);
    // Un tope por ticket chico la acota.
    expect(isHighImpactPromo({ action_type: "percent", action_value: 50, max_discount: 1000 }, { ...g, promo_amount: 2000 })).toBe(false);
    expect(isHighImpactPromo({ action_type: "amount", action_value: 1500 }, { ...g, promo_amount: 2000 })).toBe(false);
    expect(isHighImpactPromo({ action_type: "amount", action_value: 2500 }, { ...g, promo_amount: 2000 })).toBe(true);
    expect(isHighImpactPromo({ action_type: "percent", action_value: 1 }, { ...g, promo_mode: "all" })).toBe(true);
    expect(isHighImpactPromo({ action_type: "percent", action_value: 90 }, { ...g, promo_mode: "off" })).toBe(false);
  });

  it("sólo el encargado con el circuito prendido y lo que queda activo", () => {
    const promo = { action_type: "percent", action_value: 30 };
    expect(needsApproval({ role: "manager", governance: g, entity: "promotions", willBeActive: true, promo })).toBe(true);
    expect(needsApproval({ role: "owner", governance: g, entity: "promotions", willBeActive: true, promo })).toBe(false);
    expect(needsApproval({ role: "manager", governance: g, entity: "promotions", willBeActive: false, promo })).toBe(false);
    expect(needsApproval({ role: "manager", governance: { ...g, enabled: false }, entity: "promotions", willBeActive: true, promo })).toBe(false);
    expect(needsApproval({ role: "manager", governance: { ...g, has_feature: false }, entity: "promotions", willBeActive: true, promo })).toBe(false);
    // Criterio H63: un encargado crea un recargo nuevo y queda para el dueño.
    expect(needsApproval({ role: "manager", governance: g, entity: "payment_plans", willBeActive: true })).toBe(true);
    expect(needsApproval({ role: "manager", governance: { ...g, surcharge_mode: "off" }, entity: "payment_plans", willBeActive: true })).toBe(false);
  });

  it("diferencias y cambios cosméticos", () => {
    const before = { id: "1", name: "A", action_value: 10, updated_at: "x", is_active: true };
    const after = { id: "1", name: "B", action_value: 10, updated_at: "y", is_active: true };
    expect(changedFields(before, after)).toEqual(["name"]);
    expect(isCosmeticOnly("promotions", true, ["name"])).toBe(true);
    expect(isCosmeticOnly("promotions", false, ["name"])).toBe(false);
    expect(isCosmeticOnly("payment_plans", true, ["surcharge_pct"])).toBe(false);
    expect(changedFields({ volume_tiers: [{ pct: 5 }] }, { volume_tiers: [{ pct: 6 }] })).toEqual(["volume_tiers"]);
  });

  it("una pendiente vencida se muestra vencida", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(effectiveStatus("pending", "2026-10-13T11:00:00Z", now)).toBe("expired");
    expect(effectiveStatus("pending", "2026-10-14T11:00:00Z", now)).toBe("pending");
    expect(effectiveStatus("approved", "2026-10-01T00:00:00Z", now)).toBe("approved");
    expect(formatValue(true)).toBe("Sí");
    expect(formatValue(18.5)).toBe("18,5");
    expect(formatValue(null)).toBe("Sin valor");
  });
});

describe("H67 · márgenes", () => {
  it("margen sobre el precio y niveles", () => {
    expect(marginPct(100, 80)).toBe(20);
    expect(marginPct(100, 0)).toBeNull();
    expect(marginLevel(100, 120, 20)).toBe("negative");
    expect(marginLevel(100, 90, 20, 110)).toBe("below_min_price");
    expect(marginLevel(100, 85, 20)).toBe("low");
    expect(marginLevel(100, 80, 20)).toBe("ok");
    expect(marginLevel(100, null, 20)).toBe("no_cost");
  });

  it("precio sugerido para volver al mínimo", () => {
    expect(suggestedPrice(80, 20)).toBe(100);
    expect(suggestedPrice(70, 30)).toBe(100);
    expect(suggestedPrice(80, 20, 150)).toBe(150);
  });

  it("el aviso sólo dispara al cruzar el mínimo hacia abajo", () => {
    expect(crossesBelow({ price: 100, cost: 70 }, { price: 100, cost: 85 }, 20)).toBe(true);
    expect(crossesBelow({ price: 100, cost: 85 }, { price: 100, cost: 90 }, 20)).toBe(false);
    expect(crossesBelow({ price: 100, cost: null }, { price: 100, cost: 90 }, 20)).toBe(true);
    expect(crossesBelow({ price: 100, cost: 70 }, { price: 100, cost: 75 }, 20)).toBe(false);
  });
});

describe("H64 · conteo cíclico ABC", () => {
  it("clasifica por participación en la venta", () => {
    const cls = classifyAbc([
      { key: "a", value: 700 },
      { key: "b", value: 150 },
      { key: "c", value: 100 },
      { key: "d", value: 50 },
      { key: "e", value: 0 },
    ]);
    // Antes de a: 0 % → A. Antes de b: 70 % → A. Antes de c: 85 % → B.
    // Antes de d: 95 % → C (el corte B es < 95). e no vendió → C.
    expect(Object.fromEntries(cls)).toEqual({ a: "A", b: "A", c: "B", d: "C", e: "C" });
  });

  it("sin ventas todo es C", () => {
    expect([...classifyAbc([{ key: "x", value: 0 }, { key: "y", value: 0 }]).values()]).toEqual(["C", "C"]);
  });

  it("toca contar según los días de la clase", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(isDue(null, "A", DEFAULT_CYCLE_POLICY, now)).toBe(true);
    expect(isDue("2026-10-08T12:00:00Z", "A", DEFAULT_CYCLE_POLICY, now)).toBe(false);
    expect(isDue("2026-10-06T12:00:00Z", "A", DEFAULT_CYCLE_POLICY, now)).toBe(true);
    expect(isDue("2026-10-06T12:00:00Z", "B", DEFAULT_CYCLE_POLICY, now)).toBe(false);
    expect(overdueDays("2026-10-01T12:00:00Z", "A", DEFAULT_CYCLE_POLICY, now)).toBe(5);
  });

  it("exactitud y diferencias del conteo", () => {
    const s = countSummary([
      { expected: 10, counted: 10, unitCost: 100 },
      { expected: 5, counted: 3, unitCost: 50 },
      { expected: 0, counted: 1, unitCost: 20 },
      { expected: 4, counted: 4 },
    ]);
    expect(s).toEqual({ lines: 4, exact: 2, accuracyPct: 50, unitsDiff: -1, valueDiff: -80 });
    expect(countSummary([]).accuracyPct).toBeNull();
  });

  it("valida la política como los CHECK", () => {
    expect(policyError(DEFAULT_CYCLE_POLICY)).toBeNull();
    expect(policyError({ ...DEFAULT_CYCLE_POLICY, a_days: 40 })).toMatch(/más seguido/);
    expect(policyError({ ...DEFAULT_CYCLE_POLICY, a_share: 96 })).toMatch(/corte/);
    expect(policyError({ ...DEFAULT_CYCLE_POLICY, daily_items: 0 })).toMatch(/Por día/);
  });
});

describe("H64 · garantías por serie", () => {
  it("suma meses como Postgres (fin de mes acotado)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-13", 12)).toBe("2027-10-13");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("vencimiento = fábrica + extendida", () => {
    expect(warrantyUntil("2026-01-10", 6, 12)).toBe("2027-07-10");
    expect(warrantyUntil("2026-01-10", 0, 0)).toBeNull();
  });

  it("estado de la garantía", () => {
    const base = { sale_status: "completed", returned: false, warranty_until: "2026-12-01" };
    expect(warrantyState(base, "2026-10-13")).toBe("vigente");
    expect(warrantyState({ ...base, warranty_until: "2026-10-12" }, "2026-10-13")).toBe("vencida");
    expect(warrantyState({ ...base, warranty_until: null }, "2026-10-13")).toBe("sin_garantia");
    expect(warrantyState({ ...base, sale_status: "voided" }, "2026-10-13")).toBe("anulada");
    expect(warrantyState({ ...base, returned: true }, "2026-10-13")).toBe("devuelta");
    expect(daysLeft("2026-10-20", "2026-10-13")).toBe(7);
  });

  it("serie normalizada y reclamos que no se reabren", () => {
    expect(normalizeSerial("  imei-35a ")).toBe("IMEI-35A");
    expect(nextClaimStatuses("open")).toEqual(["in_repair", "resolved", "rejected"]);
    expect(nextClaimStatuses("resolved")).toEqual([]);
  });
});

describe("F14 · migraciones y plan", () => {
  const all = MIGRATIONS.map(MIG).join("\n");

  it("cuatro features con su categoría y copy (checklist §6)", () => {
    const sql = MIG(MIGRATIONS[0]!);
    expect(sql).toMatch(/\('aprobaciones_comerciales',[\s\S]*?'ventas', false, \d+\)/);
    expect(sql).toMatch(/\('alertas_margen',[\s\S]*?'catalogo', true, \d+\)/);
    expect(sql).toMatch(/\('conteo_ciclico',[\s\S]*?'catalogo', false, \d+\)/);
    expect(sql).toMatch(/\('garantias_serie',[\s\S]*?'catalogo', false, \d+\)/);
    expect(sql).toMatch(/'aprobaciones_comerciales', \(p\.key in \('business', 'enterprise'\)\)/);
    expect(FEATURE_INFO.aprobaciones_comerciales?.minPlan).toBe("Business");
    expect(FEATURE_INFO.alertas_margen?.minPlan).toBe("Start");
    expect(FEATURE_INFO.conteo_ciclico?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.garantias_serie?.minPlan).toBe("Pro");
    expect(featureRequires("conteo_ciclico")).toEqual(["stock"]);
  });

  it("gating real en el servidor", () => {
    for (const key of ["aprobaciones_comerciales", "alertas_margen", "conteo_ciclico", "garantias_serie"]) {
      expect(all, key).toMatch(new RegExp(`tenant_has_feature_for\\((v_tenant|new\\.tenant_id), '${key}'\\)`));
    }
  });

  it("policies con (select ...), nunca is_internal()", () => {
    const policies = all.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(8);
    for (const p of policies) {
      expect(p).not.toMatch(/is_internal\(\)/);
      expect(p.replace(/\(select current_tenant_id\(\)\)/g, "")).not.toMatch(/current_tenant_id\(\)/);
      expect(p.replace(/\(select internal_scope\(\)\)/g, "")).not.toMatch(/internal_scope\(\)/);
      expect(p.replace(/\(select member_role_in\(\(select current_tenant_id\(\)\)\)\)/g, "")).not.toMatch(/member_role_in\(/);
    }
  });

  it("toda escritura por RPC auditada, sin borrar audit_logs", () => {
    for (const fn of [
      "commercial_governance_save",
      "commercial_change_decide",
      "commercial_change_cancel",
      "margin_settings_save",
      "cycle_count_policy_save",
      "cycle_count_submit",
      "serial_claim_open",
      "serial_claim_update",
    ]) {
      const body = all.split(`create or replace function ${fn}(`)[1]!.split("$$;")[0]!;
      expect(body, fn).toMatch(/insert into audit_logs/);
    }
    expect(all).not.toMatch(/delete from audit_logs/i);
    expect(all).toMatch(/'commercial_change_requested'/);
  });

  it("tablas nuevas sin escritura por REST y con role_write_guard en stock", () => {
    for (const t of [
      "commercial_governance",
      "commercial_change_requests",
      "margin_alert_settings",
      "cycle_count_policy",
      "serial_warranty_claims",
    ]) {
      expect(all, t).toMatch(new RegExp(`revoke insert, update, delete on ${t}`));
    }
    expect(all).toMatch(/revoke insert, update, delete on cycle_counts, cycle_count_lines/);
    expect(all).toMatch(/'cycle_count_policy', 'cycle_counts', 'cycle_count_lines'/);
    expect(all).toMatch(/trg_role_write_guard\('operate'\)/);
  });

  it("no recrea create_sale y el aviso de margen no corre en la venta", () => {
    expect(all).not.toMatch(/function (public\.)?create_sale\(/);
    expect(all).toMatch(/after update of cost, price on products/);
    expect(all).toMatch(/when \(old\.cost is distinct from new\.cost or old\.price is distinct from new\.price\)/);
  });

  it("el maker-checker sólo frena al encargado y respeta el upsert de planes", () => {
    const sql = MIG(MIGRATIONS[1]!);
    expect(sql).toMatch(/member_role_in\(v_tenant\) is distinct from 'manager' then return new/);
    expect(sql).toMatch(/Upsert que va a chocar/);
    expect(sql).toMatch(/new := old;/);
    expect(sql).toMatch(/before insert or update on promotions/);
    expect(sql).toMatch(/before insert or update on payment_plans/);
    // Aprobar: sólo el dueño.
    const decide = sql.split("create or replace function commercial_change_decide(")[1]!.split("$$;")[0]!;
    expect(decide).toMatch(/member_role_in\(v_tenant\) is distinct from 'owner'/);
  });

  it("el tipo de notificación conserva los anteriores", () => {
    expect(MIG(MIGRATIONS[0]!)).toMatch(
      /'news','plan','billing','usage','security','afip','maintenance','support',\s*'cobros','disputas','comercial'/,
    );
  });
});
