import { describe, it, expect } from "vitest";
import {
  canForceClose,
  canOpenRegister,
  canUseShift,
  cashErrorMessage,
  elapsedLabel,
  myOpenShift,
  registerSituation,
  shiftAgeTone,
  type ShiftLite,
} from "@/lib/cash/ownership";

const shift = (p: Partial<ShiftLite> = {}): ShiftLite => ({
  id: "s1",
  opened_by: "ana",
  status: "open",
  cash_register_id: "r1",
  store_id: "centro",
  ...p,
});

describe("propiedad de la caja", () => {
  it("sólo el dueño del turno vende y opera", () => {
    expect(canUseShift(shift(), "ana", "sell")).toBe(true);
    expect(canUseShift(shift(), "ana", "operate")).toBe(true);
    expect(canUseShift(shift(), "beto", "sell")).toBe(false);
    expect(canUseShift(shift({ status: "closed" }), "ana", "sell")).toBe(false);
    expect(canUseShift(null, "ana", "sell")).toBe(false);
  });

  it("caja compartida: otros venden, pero no retiran ni cierran", () => {
    expect(canUseShift(shift(), "beto", "sell", { sharedShift: true })).toBe(true);
    expect(canUseShift(shift(), "beto", "sell", { sharedShift: true, storeAllowed: false })).toBe(false);
    expect(canUseShift(shift(), "beto", "operate", { sharedShift: true })).toBe(false);
  });

  it("una caja por turno y un turno por usuario", () => {
    const open = [shift(), shift({ id: "s2", opened_by: "dueño", cash_register_id: "r2" })];
    expect(canOpenRegister("r1", open, "beto")).toBe("register_busy");
    expect(canOpenRegister("r3", open, "ana")).toBe("user_has_open_shift");
    expect(canOpenRegister("r3", open, "beto")).toBe("ok");
    expect(myOpenShift(open, "dueño")?.id).toBe("s2");
    expect(myOpenShift(open, null)).toBeNull();
  });

  it("situación de la caja del dispositivo", () => {
    expect(registerSituation(null, "ana")).toBe("free");
    expect(registerSituation(shift(), "ana")).toBe("mine");
    expect(registerSituation(shift(), "beto")).toBe("foreign");
    expect(registerSituation(shift(), "beto", true)).toBe("shared");
  });

  it("cierre forzado: supervisor sobre turno ajeno", () => {
    expect(canForceClose(shift(), "beto", true)).toBe(true);
    expect(canForceClose(shift(), "beto", false)).toBe(false);
    expect(canForceClose(shift(), "ana", true)).toBe(false);
  });

  it("tiempo abierto y alerta", () => {
    const now = new Date("2026-10-12T20:00:00Z");
    expect(elapsedLabel("2026-10-12T19:59:30Z", now)).toBe("30 s");
    expect(elapsedLabel("2026-10-12T19:48:00Z", now)).toBe("12 min");
    expect(elapsedLabel("2026-10-12T17:55:00Z", now)).toBe("2 h 05 min");
    expect(elapsedLabel("2026-10-10T18:00:00Z", now)).toBe("2 d 2 h");
    expect(shiftAgeTone("2026-10-12T12:00:00Z", now)).toBe("ok");
    expect(shiftAgeTone("2026-10-12T09:00:00Z", now)).toBe("long");
    expect(shiftAgeTone("2026-10-11T20:00:00Z", now)).toBe("stale");
  });

  it("mensajes de error", () => {
    expect(cashErrorMessage(new Error("shift_not_owned"))).toMatch(/otra persona/);
    expect(cashErrorMessage({ message: "user_has_open_shift" })).toMatch(/Ya tenés/);
    expect(cashErrorMessage("cualquier cosa")).toBeNull();
  });
});
