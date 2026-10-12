import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFER_SETTINGS,
  TRANSFER_STATUSES,
  TRANSFER_STATUS_LABEL,
  allowedActions,
  canTransition,
  dueState,
  formatRemitoNumber,
  localDate,
  needsApproval,
  nextStatuses,
  receiveOutcome,
  submitTarget,
  transferErrorMessage,
  type TransferSettings,
} from "@/lib/stock/transfers";

const S = DEFAULT_TRANSFER_SETTINGS;

describe("máquina de estados de traslados", () => {
  it("cada estado tiene etiqueta sin guion largo", () => {
    for (const st of TRANSFER_STATUSES) {
      expect(TRANSFER_STATUS_LABEL[st]).toBeTruthy();
      expect(TRANSFER_STATUS_LABEL[st]).not.toContain("—");
    }
  });

  it("el flujo feliz es borrador → programado → en tránsito → recibido", () => {
    expect(nextStatuses("draft", "submit")).toEqual(["pending_approval", "scheduled"]);
    expect(nextStatuses("scheduled", "dispatch")).toEqual(["in_transit"]);
    expect(nextStatuses("in_transit", "receive")).toEqual(["partially_received", "received"]);
    expect(nextStatuses("partially_received", "receive")).toContain("received");
  });

  it("no se despacha un borrador ni se recibe algo programado", () => {
    expect(canTransition("draft", "dispatch")).toBe(false);
    expect(canTransition("scheduled", "receive")).toBe(false);
    expect(canTransition("pending_approval", "dispatch")).toBe(false);
  });

  it("se cancela hasta en tránsito, nunca con recepción empezada o terminada", () => {
    for (const st of ["draft", "pending_approval", "scheduled", "in_transit"] as const) {
      expect(canTransition(st, "cancel"), st).toBe(true);
    }
    for (const st of ["partially_received", "received", "cancelled"] as const) {
      expect(canTransition(st, "cancel"), st).toBe(false);
    }
  });

  it("rechazar devuelve a borrador; sólo se edita en borrador", () => {
    expect(nextStatuses("pending_approval", "reject")).toEqual(["draft"]);
    expect(canTransition("draft", "edit")).toBe(true);
    expect(canTransition("scheduled", "edit")).toBe(false);
  });

  it("los estados finales no aceptan ninguna acción", () => {
    const actions = ["edit", "submit", "approve", "reject", "reschedule", "dispatch", "receive", "cancel"] as const;
    for (const a of actions) {
      expect(canTransition("received", a), a).toBe(false);
      expect(canTransition("cancelled", a), a).toBe(false);
    }
  });
});

describe("aprobación", () => {
  const withApproval = (o: Partial<TransferSettings>): TransferSettings => ({
    ...S,
    require_approval: true,
    ...o,
  });

  it("sin aprobación configurada nunca la pide", () => {
    expect(needsApproval(S, 1000, 1e9)).toBe(false);
  });

  it("aprobación sin umbrales la pide siempre", () => {
    expect(needsApproval(withApproval({}), 1, 0)).toBe(true);
  });

  it("con umbral de unidades o de valor alcanza con superar uno", () => {
    const s = withApproval({ approval_min_units: 10, approval_min_value: 50000 });
    expect(needsApproval(s, 9, 1000)).toBe(false);
    expect(needsApproval(s, 10, 0)).toBe(true);
    expect(needsApproval(s, 1, 50000)).toBe(true);
  });

  it("el dueño confirma directo; el encargado queda pendiente", () => {
    const s = withApproval({});
    expect(submitTarget(s, 5, 0, "owner")).toBe("scheduled");
    expect(submitTarget(s, 5, 0, "manager")).toBe("pending_approval");
    expect(submitTarget(S, 5, 0, "manager")).toBe("scheduled");
  });
});

describe("acciones por rol", () => {
  it("cuatro ojos: el encargado no aprueba lo que armó", () => {
    const t = { status: "pending_approval" as const, created_by: "u1" };
    expect(allowedActions(t, "manager", "u1")).not.toContain("approve");
    expect(allowedActions(t, "manager", "u2")).toContain("approve");
    expect(allowedActions(t, "owner", "u1")).toContain("approve");
  });

  it("el cajero recibe por defecto pero no despacha", () => {
    expect(allowedActions({ status: "in_transit", created_by: null }, "cashier", "c")).toEqual(["receive"]);
    expect(allowedActions({ status: "scheduled", created_by: null }, "cashier", "c")).toEqual([]);
    const s = { ...S, cashier_can_dispatch: true, cashier_can_receive: false };
    expect(allowedActions({ status: "scheduled", created_by: null }, "cashier", "c", s)).toEqual(["dispatch"]);
    expect(allowedActions({ status: "in_transit", created_by: null }, "cashier", "c", s)).toEqual([]);
  });

  it("el visor no hace nada", () => {
    expect(allowedActions({ status: "draft", created_by: null }, "viewer", "v")).toEqual([]);
    expect(allowedActions({ status: "draft", created_by: null }, null, "v")).toEqual([]);
  });
});

describe("programación perezosa", () => {
  const today = "2026-10-12";
  it("vencido, hoy y futuro antes de despachar", () => {
    expect(dueState("2026-10-11", "scheduled", today)).toBe("overdue");
    expect(dueState("2026-10-12", "scheduled", today)).toBe("today");
    expect(dueState("2026-10-20T00:00:00Z", "scheduled", today)).toBe("future");
    expect(dueState(null, "scheduled", today)).toBe("today");
    expect(dueState(null, "draft", today)).toBe("none");
  });
  it("después de despachar ya no vence", () => {
    expect(dueState("2026-10-01", "in_transit", today)).toBe("none");
    expect(dueState("2026-10-01", "received", today)).toBe("none");
  });
  it("localDate usa la fecha local", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("recepción con diferencias", () => {
  it("recepción parcial deja pendiente y no pide motivo", () => {
    const r = receiveOutcome([{ dispatched: 10, received: 0, incoming: 6 }], false);
    expect(r.status).toBe("partially_received");
    expect(r.lines[0].pending).toBe(4);
    expect(r.error).toBeNull();
  });

  it("si llega todo cierra sola", () => {
    const r = receiveOutcome([{ dispatched: 10, received: 4, incoming: 6 }], false);
    expect(r.status).toBe("received");
    expect(r.lines[0].difference).toBe(0);
    expect(r.error).toBeNull();
  });

  it("cerrar con faltante exige motivo", () => {
    const r = receiveOutcome([{ dispatched: 10, received: 0, incoming: 9 }], true);
    expect(r.status).toBe("received");
    expect(r.lines[0].difference).toBe(-1);
    expect(r.error).toBe("difference_reason_required");
    const ok = receiveOutcome([{ dispatched: 10, received: 0, incoming: 9, reason: "danado" }], true);
    expect(ok.error).toBeNull();
  });

  it("sin exigir motivo, cierra igual", () => {
    const r = receiveOutcome([{ dispatched: 10, received: 0, incoming: 9 }], true, {
      ...S,
      require_difference_reason: false,
    });
    expect(r.error).toBeNull();
  });

  it("sobrante: permitido por defecto, bloqueable", () => {
    const line = [{ dispatched: 5, received: 0, incoming: 6, reason: "sobrante" as const }];
    expect(receiveOutcome(line, true).lines[0].difference).toBe(1);
    expect(receiveOutcome(line, true).error).toBeNull();
    expect(receiveOutcome(line, true, { ...S, allow_over_receive: false }).error).toBe(
      "over_receive_not_allowed",
    );
  });

  it("parcial sin nada que recibir es error", () => {
    expect(receiveOutcome([{ dispatched: 5, received: 0, incoming: 0 }], false).error).toBe(
      "nothing_to_receive",
    );
  });

  it("líneas no despachadas no generan diferencia", () => {
    const r = receiveOutcome(
      [
        { dispatched: null, received: 0, incoming: 0 },
        { dispatched: 2, received: 0, incoming: 2 },
      ],
      false,
    );
    expect(r.status).toBe("received");
    expect(r.error).toBeNull();
  });

  it("cantidades con decimales (kg) no dejan diferencias fantasma", () => {
    const r = receiveOutcome([{ dispatched: 1.2, received: 0.7, incoming: 0.5 }], false);
    expect(r.status).toBe("received");
    expect(r.lines[0].difference).toBe(0);
  });
});

describe("remito y errores", () => {
  it("número de remito con 6 dígitos", () => {
    expect(formatRemitoNumber(7)).toBe("R-000007");
    expect(formatRemitoNumber(1234567)).toBe("R-1234567");
  });
  it("traduce los códigos del servidor", () => {
    expect(transferErrorMessage(new Error("single_store"))).toMatch(/dos sucursales/);
    expect(transferErrorMessage({ message: "insufficient_stock_origin: Yerba" })).toMatch(/stock suficiente/);
    expect(transferErrorMessage(new Error("forbidden_approval"))).toMatch(/aprueba el dueño/);
    expect(transferErrorMessage(new Error("feature_not_in_plan: traslados"))).toMatch(/plan/);
    expect(transferErrorMessage(new Error("otra cosa"))).toBe("otra cosa");
  });
});
