import { describe, it, expect } from "vitest";
import { isWeakPin, overrideErrorMessage, pinProblem } from "@/lib/account/pin";

// Mismos casos que account_pin_is_weak() / account_set_supervisor_pin() en SQL.
describe("PIN de supervisor", () => {
  it("rechaza repetidos y escaleras", () => {
    expect(isWeakPin("0000")).toBe(true);
    expect(isWeakPin("1234")).toBe(true);
    expect(isWeakPin("987654")).toBe(true);
    expect(isWeakPin("8901")).toBe(true);
    expect(isWeakPin("4821")).toBe(false);
  });

  it("valida largo y dígitos", () => {
    expect(pinProblem("123")).not.toBeNull();
    expect(pinProblem("1234567")).not.toBeNull();
    expect(pinProblem("12a4")).not.toBeNull();
    expect(pinProblem("1234")).toMatch(/fácil/);
    expect(pinProblem("4821")).toBeNull();
    expect(pinProblem("482190")).toBeNull();
  });

  it("mensajes del cajero", () => {
    expect(overrideErrorMessage("pin_invalid", { attempts_left: 1 })).toContain("Queda 1 intento");
    expect(overrideErrorMessage("pin_invalid", { attempts_left: 3 })).toContain("Quedan 3 intentos");
    expect(overrideErrorMessage("pin_not_set")).toContain("PIN");
    expect(overrideErrorMessage("otro")).toBe("No se pudo autorizar la venta.");
  });
});
