import { describe, it, expect } from "vitest";
import {
  availableActions,
  canManageStaff,
  effectiveStatus,
  liftOutcome,
  staffErrorMessage,
  statusChipText,
  statusDraftProblem,
  upcomingEvents,
  type StatusEvent,
} from "@/lib/staff/status";

const ev = (p: Partial<StatusEvent> & Pick<StatusEvent, "kind" | "starts_on">): StatusEvent => ({
  id: p.id ?? `${p.kind}-${p.starts_on}`,
  subtype: null,
  ends_on: null,
  reason: null,
  deleted_at: null,
  ...p,
});

describe("estado efectivo del personal", () => {
  it("sin eventos está activo", () => {
    expect(effectiveStatus([], "2026-10-12").status).toBe("active");
  });

  it("la suspensión con fecha de vuelta termina sola", () => {
    const s = [ev({ kind: "suspension", starts_on: "2026-10-10", ends_on: "2026-10-12", reason: "x" })];
    expect(effectiveStatus(s, "2026-10-12").status).toBe("suspended");
    expect(effectiveStatus(s, "2026-10-13").status).toBe("active");
    expect(effectiveStatus(s, "2026-10-09").status).toBe("active");
  });

  it("prioridad: baja > suspensión > licencia", () => {
    const list = [
      ev({ kind: "leave", starts_on: "2026-10-01", ends_on: "2026-10-30", subtype: "vacaciones" }),
      ev({ kind: "suspension", starts_on: "2026-10-05", ends_on: "2026-10-06" }),
      ev({ kind: "termination", starts_on: "2026-10-06", subtype: "despido" }),
    ];
    expect(effectiveStatus(list, "2026-10-02").status).toBe("on_leave");
    expect(effectiveStatus(list, "2026-10-05").status).toBe("suspended");
    expect(effectiveStatus(list, "2026-10-06").status).toBe("terminated");
    expect(effectiveStatus(list, "2026-12-01").status).toBe("terminated");
  });

  it("los cancelados y los reingresos no cuentan", () => {
    const list = [
      ev({ kind: "suspension", starts_on: "2026-10-01", deleted_at: "2026-10-01T10:00:00Z" }),
      ev({ kind: "rehire", starts_on: "2026-10-01" }),
    ];
    expect(effectiveStatus(list, "2026-10-02").status).toBe("active");
  });

  it("un reingreso corta la baja (ends_on el día anterior)", () => {
    const list = [
      ev({ kind: "termination", starts_on: "2026-09-01", ends_on: "2026-10-11", subtype: "renuncia" }),
      ev({ kind: "rehire", starts_on: "2026-10-12" }),
    ];
    expect(effectiveStatus(list, "2026-10-11").status).toBe("terminated");
    expect(effectiveStatus(list, "2026-10-12").status).toBe("active");
  });

  it("programados en orden", () => {
    const list = [
      ev({ kind: "leave", starts_on: "2026-12-20", ends_on: "2027-01-05" }),
      ev({ kind: "leave", starts_on: "2026-11-01", ends_on: "2026-11-03" }),
      ev({ kind: "suspension", starts_on: "2026-10-01" }),
    ];
    expect(upcomingEvents(list, "2026-10-12").map((e) => e.starts_on)).toEqual(["2026-11-01", "2026-12-20"]);
  });
});

describe("quién puede cambiar el estado", () => {
  it("dueño a encargado y cajero; encargado sólo a cajeros y perfiles", () => {
    expect(canManageStaff({ actorRole: "owner", actorId: "o", targetRole: "manager", targetId: "m" })).toBe(true);
    expect(canManageStaff({ actorRole: "manager", actorId: "m", targetRole: "cashier", targetId: "c" })).toBe(true);
    expect(canManageStaff({ actorRole: "manager", actorId: "m", targetRole: null, targetId: null })).toBe(true);
    expect(canManageStaff({ actorRole: "manager", actorId: "m", targetRole: "manager", targetId: "m2" })).toBe(false);
  });
  it("nadie toca al dueño ni a sí mismo; cajero no gestiona", () => {
    expect(canManageStaff({ actorRole: "manager", actorId: "m", targetRole: "owner", targetId: "o" })).toBe(false);
    expect(canManageStaff({ actorRole: "owner", actorId: "o", targetRole: "owner", targetId: "o" })).toBe(false);
    expect(canManageStaff({ actorRole: "owner", actorId: "o", targetRole: "cashier", targetId: "o" })).toBe(false);
    expect(canManageStaff({ actorRole: "cashier", actorId: "c", targetRole: "cashier", targetId: "c2" })).toBe(false);
  });
});

describe("formulario y acciones", () => {
  const today = "2026-10-12";
  it("valida fechas, motivo y tipo de baja", () => {
    expect(statusDraftProblem({ kind: "suspension", subtype: null, from: "2026-10-11", until: null, reason: "abc" }, today)).toMatch(/anterior/);
    expect(statusDraftProblem({ kind: "suspension", subtype: null, from: today, until: "2026-10-10", reason: "abc" }, today)).toMatch(/posterior/);
    expect(statusDraftProblem({ kind: "suspension", subtype: null, from: today, until: null, reason: " " }, today)).toMatch(/motivo/);
    expect(statusDraftProblem({ kind: "termination", subtype: null, from: today, until: null, reason: "abc" }, today)).toMatch(/tipo de baja/);
    expect(statusDraftProblem({ kind: "leave", subtype: "vacaciones", from: today, until: "2026-10-20", reason: "" }, today)).toBeNull();
  });
  it("no se superponen dos del mismo tipo ni se suspende a alguien de baja", () => {
    const existing = [ev({ kind: "leave", starts_on: "2026-10-15", ends_on: "2026-10-20" })];
    expect(statusDraftProblem({ kind: "leave", subtype: "otra", from: "2026-10-18", until: "2026-10-25", reason: "" }, today, existing)).toMatch(/Ya hay/);
    expect(statusDraftProblem({ kind: "suspension", subtype: null, from: "2026-10-18", until: null, reason: "abc" }, today, existing)).toBeNull();
    const gone = [ev({ kind: "termination", starts_on: "2026-10-01", subtype: "despido" })];
    expect(statusDraftProblem({ kind: "suspension", subtype: null, from: today, until: null, reason: "abc" }, today, gone)).toMatch(/de baja/);
  });
  it("levantar: programado se cancela, vigente termina ayer", () => {
    expect(liftOutcome(ev({ kind: "leave", starts_on: "2026-10-20" }), today)).toBe("cancelled");
    expect(liftOutcome(ev({ kind: "leave", starts_on: today }), today)).toBe("cancelled");
    expect(liftOutcome(ev({ kind: "suspension", starts_on: "2026-10-01" }), today)).toBe("ended");
    expect(liftOutcome(ev({ kind: "termination", starts_on: "2026-10-01" }), today)).toBe("invalid");
    expect(liftOutcome(ev({ kind: "leave", starts_on: "2026-10-01", ends_on: "2026-10-05" }), today)).toBe("invalid");
  });
  it("acciones por estado", () => {
    expect(availableActions("active")).toContain("terminate");
    expect(availableActions("suspended")).toEqual(["lift", "terminate"]);
    expect(availableActions("terminated")).toEqual(["rehire"]);
  });
  it("textos", () => {
    expect(statusChipText({ status: "on_leave", subtype: "vacaciones", until: "2026-10-20" })).toBe("Vacaciones · hasta 20/10");
    expect(statusChipText({ status: "terminated" })).toBe("De baja");
    expect(staffErrorMessage(new Error("cannot_change_owner"))).toMatch(/dueño/);
    expect(staffErrorMessage({ message: "limit_reached: max_users" })).toMatch(/máximo/);
  });
});
