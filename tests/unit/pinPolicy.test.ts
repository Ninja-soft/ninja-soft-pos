import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY,
  actionModes,
  authorizeErrorMessage,
  modesProblem,
  isSupervisor,
  needsPinFrom,
  normalizeSettings,
  pinExpiresAt,
  pinRequired,
  supervisorRequiredAction,
} from "@/lib/security/pinPolicy";

describe("política de PIN", () => {
  it("por defecto nada pide PIN salvo el cierre forzado", () => {
    expect(pinRequired(DEFAULT_POLICY, "sale_void", 99999)).toBe(false);
    expect(pinRequired(DEFAULT_POLICY, "cash_out", 1)).toBe(false);
    expect(pinRequired(DEFAULT_POLICY, "shift_force_close", null)).toBe(true);
  });

  it("montos desde el umbral, descuento por encima del porcentaje", () => {
    const p = normalizeSettings({
      pin_policy: {
        ...DEFAULT_POLICY,
        cash_out: { enabled: true, threshold: 5000 },
        discount_over: { enabled: true, threshold: 15 },
      },
    }).pin_policy;
    expect(pinRequired(p, "cash_out", 4999.99)).toBe(false);
    expect(pinRequired(p, "cash_out", 5000)).toBe(true);
    expect(pinRequired(p, "discount_over", 15)).toBe(false);
    expect(pinRequired(p, "discount_over", 15.5)).toBe(true);
  });

  it("normaliza: completa acciones nuevas y no deja apagar el cierre forzado", () => {
    const s = normalizeSettings({
      pin_policy: { shift_force_close: { enabled: false, threshold: 0 } } as never,
    });
    expect(s.pin_policy.shift_force_close.enabled).toBe(true);
    expect(s.pin_policy.sale_return).toEqual(DEFAULT_POLICY.sale_return);
    expect(s.supervisor_roles).toEqual(["owner", "manager"]);
  });

  it("supervisores por rol o elegidos; el dueño siempre", () => {
    const s = { supervisor_roles: ["owner", "manager"] as ("owner" | "manager" | "cashier")[], supervisor_user_ids: ["u-ana"] };
    expect(isSupervisor(s, "owner", "x")).toBe(true);
    expect(isSupervisor(s, "manager", "x")).toBe(true);
    expect(isSupervisor(s, "cashier", "u-ana")).toBe(true);
    expect(isSupervisor(s, "cashier", "u-beto")).toBe(false);
    expect(isSupervisor(s, null, null)).toBe(false);
  });

  it("al supervisor no se le pide PIN", () => {
    const s = normalizeSettings({ pin_policy: { ...DEFAULT_POLICY, sale_void: { enabled: true, threshold: 0 } } });
    expect(needsPinFrom(s, "sale_void", 100, "cashier", "c")).toBe(true);
    expect(needsPinFrom(s, "sale_void", 100, "manager", "m")).toBe(false);
  });

  it("lee el error del servidor", () => {
    expect(supervisorRequiredAction(new Error("supervisor_required:cash_out"))).toBe("cash_out");
    expect(supervisorRequiredAction({ message: "supervisor_required:nada" })).toBeNull();
    expect(supervisorRequiredAction("otro")).toBeNull();
  });

  it("vencimiento por rotación y mensajes", () => {
    expect(pinExpiresAt(null, 90)).toBeNull();
    expect(pinExpiresAt("2026-01-01T00:00:00Z", null)).toBeNull();
    expect(pinExpiresAt("2026-01-01T12:00:00Z", 30)!.toISOString().slice(0, 10)).toBe("2026-01-31");
    expect(authorizeErrorMessage("pin_invalid", { attempts_left: 1 }, 20)).toMatch(/Queda 1 intento.*20 minutos/);
    expect(authorizeErrorMessage("pin_expired")).toMatch(/venció/);
  });
});

describe("modos del PIN por acción (ADR-060)", () => {
  const base = () =>
    normalizeSettings({
      pin_autenticador: true,
      pin_modes: ["fixed", "rotating", "one_time", "totp"],
      pin_policy: {
        ...DEFAULT_POLICY,
        sale_void: { enabled: true, threshold: 0, modes: ["one_time"] },
      },
    });

  it("la acción recorta los modos del negocio", () => {
    const s = base();
    expect(actionModes(s, "sale_void")).toEqual(["one_time"]);
    expect(actionModes(s, "cash_out")).toEqual(["fixed", "rotating", "one_time", "totp"]);
  });

  it("sin la feature sólo vale el PIN fijo", () => {
    const s = { ...base(), pin_autenticador: false };
    expect(actionModes(s, "sale_void")).toEqual(["fixed"]);
    expect(actionModes(s, "cash_out")).toEqual(["fixed"]);
  });

  it("si la acción quedó sin modos del negocio vuelve a los del negocio (espejo de SQL)", () => {
    const s = { ...base(), pin_modes: ["fixed" as const, "rotating" as const] };
    expect(actionModes(s, "sale_void")).toEqual(["fixed", "rotating"]);
  });

  it("normaliza: modos válidos, default dentro de los permitidos y topes", () => {
    const s = normalizeSettings({
      pin_modes: ["totp", "basura", "fixed"] as never,
      pin_default_mode: "rotating",
      pin_rotation_hours: 500,
      pin_one_time_max_minutes: 0,
    });
    expect(s.pin_modes).toEqual(["fixed", "totp"]);
    expect(s.pin_default_mode).toBe("fixed");
    expect(s.pin_rotation_hours).toBe(24);
    expect(s.pin_one_time_max_minutes).toBe(5);
    expect(s.pin_autenticador).toBe(false);
  });

  it("valida la configuración antes de guardar", () => {
    expect(modesProblem(base())).toBeNull();
    expect(modesProblem({ ...base(), pin_modes: ["fixed"], pin_default_mode: "fixed" })).toMatch(/Anular una venta/);
    expect(modesProblem({ ...base(), pin_default_mode: "totp", pin_modes: ["fixed", "one_time"] })).toMatch(/por defecto/);
  });

  it("mensajes de los errores nuevos", () => {
    expect(authorizeErrorMessage("one_time_scope")).toMatch(/otra acción/);
    expect(authorizeErrorMessage("rate_limited")).toMatch(/minuto/);
    expect(authorizeErrorMessage("requester_locked")).toMatch(/tu usuario/);
  });
});
