import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  agingBucket,
  describeEvent,
  filterPortfolio,
  filterTimeline,
  ladderState,
  nextStepLabel,
  portfolioTotals,
  portfolioXlsxSheet,
  sortPortfolio,
  timelineXlsxSheet,
  type PortfolioRow,
  type Timeline360Event,
} from "@/lib/billing/collection360";

const row = (o: Partial<PortfolioRow> & { tenant_id: string; name: string }): PortfolioRow => ({
  slug: o.name.toLowerCase().replace(/\s+/g, "-"),
  billing_mode: "account",
  sub_status: "active",
  plan_name: "Pro",
  billing_cycle: "monthly",
  balance_cents: 0,
  overdue_cents: 0,
  upcoming_cents: 0,
  credit_cents: 0,
  oldest_due_date: null,
  days_overdue: 0,
  aging: { d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
  collection: null,
  promise: null,
  broken_promises_90d: 0,
  collector: null,
  last_note: null,
  next_action_at: null,
  notes_count: 0,
  last_payment_at: null,
  open_diffs: 0,
  ...o,
});

const coll = (o: Partial<NonNullable<PortfolioRow["collection"]>> = {}): NonNullable<PortfolioRow["collection"]> => ({
  state: "vencida",
  days_overdue: 5,
  soft_restricted: false,
  last_step_action: null,
  last_step_title: null,
  last_step_at: null,
  next_step_action: null,
  next_step_title: null,
  next_step_date: null,
  suspend_on: null,
  status_by_ladder: null,
  uncollectible_at: null,
  ...o,
});

const ME = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";

const rows: PortfolioRow[] = [
  row({ tenant_id: "a", name: "Olimarket", balance_cents: 9_800_000, overdue_cents: 5_400_000, days_overdue: 12, collection: coll({ next_step_action: "suspend", next_step_date: "2026-10-20" }), collector: { id: ANA, name: "Ana", assigned_at: null } }),
  row({ tenant_id: "b", name: "Kiosco Sol", balance_cents: 0 }),
  row({ tenant_id: "c", name: "Ñandú Almacén", balance_cents: 3_000_000, overdue_cents: 3_000_000, days_overdue: 45, collection: coll({ state: "en_promesa" }), promise: { id: "p", amount_cents: 3_000_000, promised_date: "2026-10-18", channel: "owner", paid_cents: 0 }, collector: { id: ME, name: "Yo", assigned_at: null } }),
  row({ tenant_id: "d", name: "Ferretería", balance_cents: 1_000_000, overdue_cents: 1_000_000, days_overdue: 75, collection: coll({ soft_restricted: true }) }),
  row({ tenant_id: "e", name: "Textil", balance_cents: 500_000, overdue_cents: 500_000, days_overdue: 120, sub_status: "suspended", collection: coll({ status_by_ladder: "suspended" }) }),
  row({ tenant_id: "f", name: "Viejo", balance_cents: 200_000, overdue_cents: 200_000, days_overdue: 200, collection: coll({ state: "incobrable", uncollectible_at: "2026-09-01T00:00:00Z" }) }),
];

describe("agingBucket y ladderState", () => {
  it("tramos por días de la deuda más vieja", () => {
    expect(rows.map(agingBucket)).toEqual(["d1_30", "al_dia", "d31_60", "d61_90", "d90_plus", "d90_plus"]);
    expect(agingBucket({ overdue_cents: 0, days_overdue: 40 })).toBe("al_dia");
    expect(agingBucket({ overdue_cents: 10, days_overdue: 30 })).toBe("d1_30");
    expect(agingBucket({ overdue_cents: 10, days_overdue: 31 })).toBe("d31_60");
    expect(agingBucket({ overdue_cents: 10, days_overdue: 90 })).toBe("d61_90");
  });
  it("estado de la escalera más grave", () => {
    expect(rows.map(ladderState)).toEqual(["vencida", "sin_mora", "en_promesa", "restringida", "suspendida", "incobrable"]);
  });
  it("próximo paso legible", () => {
    expect(nextStepLabel(rows[0]!.collection)).toBe("Suspensión el 20/10/2026");
    expect(nextStepLabel(null)).toBeNull();
  });
});

describe("filterPortfolio", () => {
  const f = (o: Partial<typeof EMPTY_FILTERS>) => filterPortfolio(rows, { ...EMPTY_FILTERS, me: ME, ...o }).map((r) => r.tenant_id);
  it("sin filtros devuelve todo", () => expect(f({})).toHaveLength(6));
  it("busca sin tildes y por cobrador", () => {
    expect(f({ q: "nandu" })).toEqual(["c"]);
    expect(f({ q: "ana" })).toEqual(["a"]);
  });
  it("aging", () => expect(f({ aging: "d90_plus" })).toEqual(["e", "f"]));
  it("monto mínimo y máximo sobre lo vencido o el saldo", () => {
    expect(f({ minCents: 3_000_000 })).toEqual(["a", "c"]);
    expect(f({ maxCents: 500_000 })).toEqual(["b", "e", "f"]);
  });
  it("escalera", () => {
    expect(f({ ladder: "restringida" })).toEqual(["d"]);
    expect(f({ ladder: "sin_mora" })).toEqual(["b"]);
  });
  it("promesa vigente", () => {
    expect(f({ promise: "con" })).toEqual(["c"]);
    expect(f({ promise: "sin" })).toHaveLength(5);
  });
  it("cobrador: sin asignar, míos y una persona", () => {
    expect(f({ collector: "none" })).toEqual(["b", "d", "e", "f"]);
    expect(f({ collector: "me" })).toEqual(["c"]);
    expect(f({ collector: ANA })).toEqual(["a"]);
    expect(filterPortfolio(rows, { ...EMPTY_FILTERS, collector: "me", me: null })).toEqual([]);
  });
});

describe("sortPortfolio y totales", () => {
  it("por defecto, más días de mora primero", () => {
    expect(sortPortfolio(rows).map((r) => r.tenant_id)).toEqual(["f", "e", "d", "c", "a", "b"]);
    expect(sortPortfolio(rows, "vencido")[0]!.tenant_id).toBe("a");
    expect(sortPortfolio(rows, "nombre")[0]!.name).toBe("Ferretería");
  });
  it("totales", () => {
    const t = portfolioTotals(rows);
    expect(t).toEqual({ count: 6, balance_cents: 14_500_000, overdue_cents: 10_100_000, with_promise: 1, unassigned: 4, overdue_count: 5 });
  });
});

const ev = (kind: string, data: Record<string, unknown> = {}, group: Timeline360Event["group"] = "plata", amount: number | null = 100): Timeline360Event => ({
  id: kind,
  at: "2026-10-14T15:00:00Z",
  group,
  kind,
  amount_cents: amount,
  actor: null,
  data,
});

const ALL_KINDS: Timeline360Event[] = [
  ev("charge", { charge_kind: "proration", description: "Diferencia", due_date: "2026-10-31", status: "open" }),
  ev("charge", { charge_kind: "subscription_period", status: "paid" }),
  ev("charge_void", { description: "Cuota", reason: "Error de carga" }),
  ev("payment", { method: "mp_preapproval", status: "approved", external_id: "123", fee_cents: 500 }),
  ev("payment", { method: "transfer", status: "charged_back" }),
  ev("payment_reversal", { reason: "Contracargo de MP" }),
  ev("refund", { description: "Reintegro", reason: "Duplicado" }),
  ev("bonus_credit", { description: "Bonificación", reason: "Gesto comercial" }),
  ev("adjustment_credit", {}),
  ev("adjustment_debit", {}),
  ev("opening_balance", { description: "Saldo inicial" }),
  ev("allocation", { credit: "Pago", debit: "Cuota octubre" }),
  ev("allocation_released", { credit: "Pago", reason: "Contracargo" }),
  ev("interest", { month: "2026-09", movements: 30 }),
  ev("waiver", { status: "applied", reason: "Acuerdo" }),
  ev("waiver", { status: "pending_approval", reason: "Acuerdo" }),
  ev("waiver", { status: "rejected", reason: "No", decision_reason: "Supera" }),
  ev("promise", { promised_date: "2026-10-20", channel: "owner" }, "gestion"),
  ev("promise", { promised_date: "2026-10-20", channel: "staff", note: "Llamó" }, "gestion"),
  ev("promise_kept", { promised_date: "2026-10-20", amount_cents: 1000 }, "gestion"),
  ev("promise_broken", { promised_date: "2026-10-20", amount_cents: 1000 }, "gestion"),
  ev("promise_cancelled", { promised_date: "2026-10-20", amount_cents: 1000, reason: "Pagó todo" }, "gestion"),
  ev("dunning_step", { action: "suspend", days_overdue: 10, notified: true }, "mora"),
  ev("dunning_step", { action: "notify", days_overdue: 1, notified: false, close_reason: "Pagó" }, "mora"),
  ev("notice", { notice_kind: "notice", due_date: "2026-10-10", recipients: ["a@x.com", "b@x.com"] }, "avisos"),
  ev("notice", { notice_kind: "statement" }, "avisos"),
  ev("transfer_reported", { paid_on: "2026-10-12", reference: "NS-1" }, "gestion"),
  ev("transfer_approved", {}, "gestion"),
  ev("transfer_rejected", { reject_reason: "No llegó" }, "gestion"),
  ev("plan_change_applied", { change_kind: "upgrade", from_plan: "Start", to_plan: "Pro", from_cycle: "monthly", to_cycle: "monthly", source: "staff" }, "plan"),
  ev("plan_change_applied", { change_kind: "cycle_up", from_plan: "Pro", to_plan: "Pro", from_cycle: "monthly", to_cycle: "yearly", source: "trigger" }, "plan"),
  ev("plan_change_applied", { change_kind: "addon_add", addon_key: "asistente_ia" }, "plan"),
  ev("plan_change_scheduled", { change_kind: "downgrade", from_plan: "Pro", to_plan: "Start", effective_on: "2026-11-01" }, "plan"),
  ev("plan_change_cancelled", { change_kind: "cycle_down", cancel_reason: "Se arrepintió" }, "plan"),
  ev("plan_changed", { plan: "pro", cycle: "yearly" }, "plan", null),
  ev("plan_change_requested", { plan_key: "business" }, "plan", null),
  ev("addon_activated", { addon: "asistente_ia" }, "plan", null),
  ev("addon_set", { addon: "asistente_ia", status: "active" }, "plan", null),
  ev("addon_cancelled", { addon: "asistente_ia" }, "plan", null),
  ev("mode_change", { from_mode: "mp_subscription", to_mode: "account", status: "applied", reason: "Pide transferir" }, "plan", null),
  ev("note", { note_kind: "call", outcome: "promised", body: "Paga el viernes", next_action_at: "2026-10-17" }, "gestion", null),
  ev("note", { note_kind: "whatsapp", body: "Sin respuesta", voided_at: "2026-10-14", void_reason: "Era otro negocio" }, "gestion", null),
  ev("collector_assigned", { from: null, to: "Ana" }, "gestion", null),
  ev("collector_assigned", { from: "Ana", to: null, reason: "Reparto" }, "gestion", null),
  ev("recon_diff", { diff_kind: "missing_local", status: "open", mp_payment_id: "999" }),
  ev("recon_diff", { diff_kind: "chargeback", status: "resolved", resolution: "chargeback_registered" }),
  ev("kind_que_no_existe", {}),
];

describe("describeEvent", () => {
  it("cubre todos los tipos sin textos rotos ni rayas largas", () => {
    for (const e of ALL_KINDS) {
      const d = describeEvent(e);
      const text = `${d.title} ${d.detail ?? ""}`;
      expect(d.title.length, e.kind).toBeGreaterThan(3);
      expect(text, e.kind).not.toMatch(/undefined|null|NaN|\[object|—/);
    }
  });
  it("textos puntuales", () => {
    expect(describeEvent(ALL_KINDS[0]!).title).toBe("Prorrateo por cambio de plan generado");
    expect(describeEvent(ALL_KINDS[3]!).title).toBe("Pago con débito automático de Mercado Pago");
    expect(describeEvent(ALL_KINDS[3]!).detail).toContain("operación 123");
    expect(describeEvent(ev("dunning_step", { action: "suspend", days_overdue: 10, notified: true })).title).toBe("Escalera de mora: Suspensión");
    expect(describeEvent(ev("collector_assigned", { to: "Ana" })).title).toBe("Cobrador asignado: Ana");
    expect(describeEvent(ev("plan_change_scheduled", { change_kind: "downgrade", effective_on: "2026-11-01" })).detail).toContain("rige el 01/11/2026");
    expect(describeEvent(ev("note", { note_kind: "call", body: "x", voided_at: "2026-10-14", void_reason: "mal" })).title).toContain("(anulada)");
  });
  it("filtra por grupo", () => {
    expect(filterTimeline(ALL_KINDS, "mora")).toHaveLength(2);
    expect(filterTimeline(ALL_KINDS, "all")).toHaveLength(ALL_KINDS.length);
  });
});

describe("export XLSX", () => {
  it("hoja de la cartera con las columnas pedidas y totales", () => {
    const s = portfolioXlsxSheet(rows, "2026-10-14");
    expect(s.columns.map((c) => c.header)).toEqual([
      "Negocio",
      "Modalidad",
      "Plan",
      "Saldo",
      "Vencido",
      "Días de mora",
      "Antigüedad",
      "Estado de la escalera",
      "Próximo paso",
      "Fecha del próximo paso",
      "Promesa (monto)",
      "Promesa (fecha)",
      "Cobrador",
      "Última gestión",
      "Próxima acción",
      "Último pago",
    ]);
    expect(s.rows).toHaveLength(6);
    expect(s.rows[0]).toMatchObject({ negocio: "Olimarket", saldo: 98000, vencido: 54000, escalera: "Vencida", proximo: "Suspensión", cobrador: "Ana" });
    expect(s.totals).toEqual({ saldo: 145000, vencido: 101000 });
  });
  it("hoja de la historia", () => {
    const s = timelineXlsxSheet(ALL_KINDS.slice(0, 3), "Olimarket");
    expect(s.columns.map((c) => c.key)).toEqual(["fecha", "grupo", "hecho", "detalle", "importe", "quien"]);
    expect(s.rows[0]).toMatchObject({ grupo: "Plata", quien: "Sistema", importe: 1 });
  });
});
