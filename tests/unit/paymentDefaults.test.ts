import { describe, expect, it } from "vitest";
import {
  DEFAULT_ON_PROVIDERS,
  isProviderEnabled,
  withDefaultMethods,
} from "@/lib/payments/defaults";

describe("medios habilitados por defecto", () => {
  it("efectivo y transferencia vienen prendidos", () => {
    expect([...DEFAULT_ON_PROVIDERS]).toEqual(["cash", "transfer"]);
  });

  it("sin fila, efectivo y transferencia cuentan como habilitados", () => {
    expect(isProviderEnabled("cash", undefined)).toBe(true);
    expect(isProviderEnabled("transfer", undefined)).toBe(true);
    expect(isProviderEnabled("mercadopago", undefined)).toBe(false);
  });

  it("una fila explícita manda (el dueño los puede apagar)", () => {
    expect(isProviderEnabled("cash", { enabled: false })).toBe(false);
    expect(isProviderEnabled("mercadopago", { enabled: true })).toBe(true);
  });

  it("completa las filas faltantes sin pisar las existentes", () => {
    const make = (provider_key: string) => ({ provider_key, enabled: true, surcharge_pct: 0 });
    const rows = [{ provider_key: "cash", enabled: false, surcharge_pct: 5 }];
    expect(withDefaultMethods(rows, make)).toEqual([
      { provider_key: "cash", enabled: false, surcharge_pct: 5 },
      { provider_key: "transfer", enabled: true, surcharge_pct: 0 },
    ]);
    expect(withDefaultMethods([], make).map((r) => r.provider_key)).toEqual(["cash", "transfer"]);
  });
});
