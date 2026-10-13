import { describe, it, expect } from "vitest";
import {
  argentinaDay,
  can,
  deniedReason,
  HINT_MANAGER,
  HINT_READ_ONLY,
  HINT_VOID_PAST_DAY,
  isReadOnlyRole,
  type RoleAction,
} from "@/lib/permissions/roles";
import { errorDescription, roleErrorMessage, ROLE_ERROR_MESSAGES } from "@/lib/permissions/errors";
import { transferErrorMessage } from "@/lib/stock/transfers";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { cashErrorMessage } from "@/lib/cash/ownership";

const ALL: RoleAction[] = [
  "catalog:write",
  "catalog:taxonomy",
  "catalog:import",
  "stock:adjust",
  "customers:create",
  "customers:update",
  "customers:delete",
  "sales:return",
  "sales:void",
  "operate",
];

// 2026-10-13 15:00 en Argentina (18:00 UTC).
const NOW = Date.UTC(2026, 9, 13, 18, 0, 0);

describe("matriz de permisos por rol (ADR-071)", () => {
  it("dueño y encargado pueden todo", () => {
    for (const role of ["owner", "manager"]) {
      for (const a of ALL) expect(can(role, a, { saleDate: "2020-01-01T12:00:00Z", now: NOW })).toBe(true);
    }
  });

  it("solo lectura no escribe nada", () => {
    for (const a of ALL) expect(deniedReason("viewer", a)).toBe(HINT_READ_ONLY);
    expect(isReadOnlyRole("viewer")).toBe(true);
    expect(isReadOnlyRole("cashier")).toBe(false);
  });

  it("cajero: sin catálogo, stock, importación ni baja de clientes", () => {
    for (const a of ["catalog:write", "catalog:taxonomy", "catalog:import", "stock:adjust", "customers:delete"] as const) {
      expect(deniedReason("cashier", a)).toBe(HINT_MANAGER);
    }
  });

  it("cajero: alta y edición de clientes, devoluciones y operación sí", () => {
    for (const a of ["customers:create", "customers:update", "sales:return", "operate"] as const) {
      expect(can("cashier", a)).toBe(true);
    }
  });

  it("cajero anula ventas del día (hora de Argentina) y no las anteriores", () => {
    // 10:00 AR de hoy.
    expect(can("cashier", "sales:void", { saleDate: "2026-10-13T13:00:00Z", now: NOW })).toBe(true);
    // 23:30 AR de ayer = 02:30 UTC de hoy: es otro día en Argentina.
    expect(deniedReason("cashier", "sales:void", { saleDate: "2026-10-13T02:30:00Z", now: NOW })).toBe(
      HINT_VOID_PAST_DAY,
    );
    expect(can("cashier", "sales:void", { saleDate: "2026-10-12T15:00:00Z", now: NOW })).toBe(false);
  });

  it("rol desconocido o cargando: permitido (la base revalida)", () => {
    for (const r of [null, undefined, "", "internal"]) {
      for (const a of ALL) expect(can(r, a)).toBe(true);
    }
  });

  it("argentinaDay usa UTC-3", () => {
    expect(argentinaDay("2026-10-13T02:59:00Z")).toBe("2026-10-12");
    expect(argentinaDay("2026-10-13T03:00:00Z")).toBe("2026-10-13");
  });
});

describe("mapeo de errores por rol", () => {
  it("traduce cada código de la base", () => {
    for (const code of Object.keys(ROLE_ERROR_MESSAGES)) {
      expect(roleErrorMessage({ message: code, code: "42501" })).toBe(ROLE_ERROR_MESSAGES[code]);
      expect(roleErrorMessage(new Error(code))).toBe(ROLE_ERROR_MESSAGES[code]);
      expect(roleErrorMessage(code)).toBe(ROLE_ERROR_MESSAGES[code]);
    }
  });

  it("no confunde códigos parecidos ni otros errores", () => {
    expect(roleErrorMessage("forbidden")).toBeNull();
    expect(roleErrorMessage("insufficient_payment")).toBeNull();
    expect(roleErrorMessage(null)).toBeNull();
    expect(roleErrorMessage({ message: "forbidden_read_only" })).toBe(ROLE_ERROR_MESSAGES.forbidden_read_only);
  });

  it("errorDescription: rol traducido o el mensaje original", () => {
    expect(errorDescription({ message: "forbidden_role" })).toBe(ROLE_ERROR_MESSAGES.forbidden_role);
    expect(errorDescription(new Error("otra cosa"))).toBe("otra cosa");
    expect(errorDescription(undefined)).toBeUndefined();
  });

  it("los mapeos existentes reconocen los rechazos por rol", () => {
    const e = { message: "forbidden_read_only" };
    expect(transferErrorMessage(e)).toBe(ROLE_ERROR_MESSAGES.forbidden_read_only);
    expect(purchaseErrorMessage(e)).toBe(ROLE_ERROR_MESSAGES.forbidden_read_only);
    expect(cashErrorMessage(e)).toBe(ROLE_ERROR_MESSAGES.forbidden_read_only);
  });
});
