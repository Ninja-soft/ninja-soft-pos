// F20-9 (H135 · ADR-128): escalera de mora, días hábiles, restricción blanda y
// promesas. Espejo de platform_mora_evaluate / platform_next_business_day /
// owner_promise_create (la prueba de PGlite compara la escalera con dueSteps).
import { describe, expect, it } from "vitest";
import {
  dueSteps,
  isBusinessDay,
  nextBusinessDay,
  nextStep,
  promiseWindow,
  renderStepText,
  restrictedAreaFor,
  stepDate,
  validatePromise,
  type DunningStep,
} from "@/lib/billing/mora";

const H = new Set(["2026-10-12", "2026-11-23"]);

// La escalera por defecto de la migración (§22 #6).
const LADDER: DunningStep[] = [
  { id: "s1", position: 1, offset_days: 1, action: "past_due", channels: ["email", "in_app"], requires_no_promise: false, min_debt_cents: 0, title: "", body: "", is_active: true },
  { id: "s2", position: 2, offset_days: 3, action: "notify", channels: ["email", "in_app"], requires_no_promise: false, min_debt_cents: 0, title: "", body: "", is_active: true },
  { id: "s3", position: 3, offset_days: 7, action: "soft_restrict", channels: ["email", "in_app"], requires_no_promise: true, min_debt_cents: 0, title: "", body: "", is_active: true },
  { id: "s4", position: 4, offset_days: 8, action: "notify", channels: ["email", "in_app"], requires_no_promise: true, min_debt_cents: 0, title: "", body: "", is_active: true },
  { id: "s5", position: 5, offset_days: 10, action: "suspend", channels: ["email", "in_app"], requires_no_promise: true, min_debt_cents: 0, title: "", body: "", is_active: true },
  { id: "s6", position: 6, offset_days: 60, action: "mark_uncollectible", channels: [], requires_no_promise: true, min_debt_cents: 0, title: "", body: "", is_active: true },
];

const st = (over: Partial<Parameters<typeof dueSteps>[1]> = {}) => ({
  effectiveDue: "2026-10-01",
  dueCents: 5_000_000,
  today: "2026-10-13",
  promiseOpen: false,
  executed: new Set<string>(),
  holidays: H,
  ...over,
});

describe("días hábiles", () => {
  it("sábado, domingo y feriado no son hábiles", () => {
    expect(isBusinessDay("2026-10-10", H)).toBe(false);
    expect(isBusinessDay("2026-10-11", H)).toBe(false);
    expect(isBusinessDay("2026-10-12", H)).toBe(false);
    expect(isBusinessDay("2026-10-13", H)).toBe(true);
  });
  it("un vencimiento en sábado antes de un feriado corre al martes", () => {
    expect(nextBusinessDay("2026-10-10", H)).toBe("2026-10-13");
    expect(nextBusinessDay("2026-10-14", H)).toBe("2026-10-14");
  });
  it("un paso que cae en día no hábil se ejecuta el próximo hábil", () => {
    // 01/10 + 10 = 11/10 (domingo) → 12/10 feriado → 13/10.
    expect(stepDate("2026-10-01", 10, H)).toBe("2026-10-13");
  });
});

describe("dueSteps", () => {
  it("con 12 días de atraso corresponden los pasos hasta el día 10, en orden", () => {
    expect(dueSteps(LADDER, st()).run.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });
  it("una promesa vigente frena la restricción y la suspensión, no los avisos", () => {
    const r = dueSteps(LADDER, st({ promiseOpen: true }));
    expect(r.run.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(r.held.map((s) => s.id)).toEqual(["s3", "s4", "s5"]);
  });
  it("no repite lo ejecutado y retoma donde estaba", () => {
    expect(dueSteps(LADDER, st({ executed: new Set(["s1", "s2"]) })).run.map((s) => s.id)).toEqual(["s3", "s4", "s5"]);
  });
  it("en un día no hábil la escalera no avanza", () => {
    expect(dueSteps(LADDER, st({ today: "2026-10-12" })).run).toEqual([]);
    expect(dueSteps(LADDER, st({ today: "2026-10-11" })).run).toEqual([]);
  });
  it("sin deuda, o debajo del mínimo del paso, nada", () => {
    expect(dueSteps(LADDER, st({ effectiveDue: null })).run).toEqual([]);
    expect(dueSteps(LADDER, st({ dueCents: 0 })).run).toEqual([]);
    const conMinimo = LADDER.map((s) => (s.id === "s5" ? { ...s, min_debt_cents: 10_000_000 } : s));
    expect(dueSteps(conMinimo, st()).run.map((s) => s.id)).not.toContain("s5");
  });
  it("los pasos inactivos no corren", () => {
    const sinSuspension = LADDER.map((s) => (s.id === "s5" ? { ...s, is_active: false } : s));
    expect(dueSteps(sinSuspension, st()).run.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });
});

describe("nextStep", () => {
  it("el próximo paso con su fecha (corrida si no es hábil)", () => {
    const n = nextStep(LADDER, st({ today: "2026-10-02", executed: new Set(["s1"]) }));
    expect(n?.step.id).toBe("s2");
    expect(n?.date).toBe("2026-10-05"); // 04/10 es domingo.
  });
  it("con promesa salta los pasos que frena", () => {
    // Desde el día 7 todos los pasos frenan con promesa: no hay próximo paso.
    expect(nextStep(LADDER, st({ today: "2026-10-05", executed: new Set(["s1", "s2"]), promiseOpen: true }))).toBeNull();
    const conAviso = LADDER.map((s) => (s.id === "s4" ? { ...s, requires_no_promise: false } : s));
    expect(nextStep(conAviso, st({ today: "2026-10-05", executed: new Set(["s1", "s2"]), promiseOpen: true }))?.step.id).toBe("s4");
  });
  it("un paso atrasado se muestra para el próximo día hábil desde hoy", () => {
    const n = nextStep(LADDER, st({ today: "2026-10-13", executed: new Set(["s1", "s2"]) }));
    expect(n?.date).toBe("2026-10-13");
  });
});

describe("textos y restricción", () => {
  it("reemplaza las variables del aviso", () => {
    expect(renderStepText("Debés {monto} hace {dias} días (vence {vence}) en {negocio}", { monto: "$ 1,00", dias: 3, vence: "01/10/2026", negocio: "Sol" })).toBe(
      "Debés $ 1,00 hace 3 días (vence 01/10/2026) en Sol",
    );
  });
  it("sólo restringe las áreas elegidas y nunca el POS ni el panel del dueño", () => {
    const areas = ["reportes", "configuracion"];
    expect(restrictedAreaFor("/reportes", areas)).toBe("reportes");
    expect(restrictedAreaFor("/contabilidad/libro", areas)).toBe("reportes");
    expect(restrictedAreaFor("/configuracion?tab=pagos", areas)).toBe("configuracion");
    expect(restrictedAreaFor("/importaciones", areas)).toBeNull();
    expect(restrictedAreaFor("/pos", ["reportes", "configuracion", "importaciones", "integraciones"])).toBeNull();
    expect(restrictedAreaFor("/caja", areas)).toBeNull();
    expect(restrictedAreaFor("/dashboard-team", areas)).toBeNull();
    expect(restrictedAreaFor("/reportes-extra", areas)).toBeNull();
  });
});

describe("promesas", () => {
  it("ventana de mañana a hoy + máximo", () => {
    expect(promiseWindow("2026-10-14", 15)).toEqual({ min: "2026-10-15", max: "2026-10-29" });
  });
  it("valida fecha e importe como el servidor", () => {
    const base = { today: "2026-10-14", date: "2026-10-20", amountCents: 100_000, balanceCents: 500_000, maxDays: 15 };
    expect(validatePromise(base)).toBeNull();
    expect(validatePromise({ ...base, date: "2026-10-14" })).toBe("invalid_promise_date");
    expect(validatePromise({ ...base, date: "2026-11-30" })).toBe("invalid_promise_date");
    expect(validatePromise({ ...base, amountCents: 0 })).toBe("invalid_amount");
    expect(validatePromise({ ...base, amountCents: 600_000 })).toBe("invalid_amount");
  });
});
