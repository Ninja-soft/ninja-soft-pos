import { describe, it, expect } from "vitest";
import {
  ACCOUNT_CONFIG_DEFAULT,
  accountConfigSchema,
  accountConfigOverrideSchema,
  effectiveAccountConfig,
} from "@/lib/account/config";

describe("accountConfigSchema", () => {
  it("acepta el default", () => {
    expect(accountConfigSchema.parse(ACCOUNT_CONFIG_DEFAULT)).toEqual(ACCOUNT_CONFIG_DEFAULT);
  });

  it("rechaza valores fuera de rango", () => {
    expect(
      accountConfigSchema.safeParse({
        ...ACCOUNT_CONFIG_DEFAULT,
        terms: { ...ACCOUNT_CONFIG_DEFAULT.terms, cutoff_day: 40 },
      }).success,
    ).toBe(false);
    expect(
      accountConfigSchema.safeParse({
        ...ACCOUNT_CONFIG_DEFAULT,
        interest: { ...ACCOUNT_CONFIG_DEFAULT.interest, rate_pct: -1 },
      }).success,
    ).toBe(false);
  });

  it("el override es parcial", () => {
    expect(accountConfigOverrideSchema.safeParse({ terms: { days: 15 } }).success).toBe(true);
    expect(accountConfigOverrideSchema.safeParse({}).success).toBe(true);
  });
});

describe("effectiveAccountConfig", () => {
  it("negocio < grupo < cliente (merge profundo)", () => {
    const eff = effectiveAccountConfig(
      { terms: { mode: "days", days: 30 } },
      { terms: { days: 45 }, interest: { enabled: true } },
      { terms: { days: 10 } },
    );
    expect(eff.terms.days).toBe(10);
    expect(eff.terms.mode).toBe("days");
    expect(eff.interest.enabled).toBe(true);
    expect(eff.interest.rate_pct).toBe(ACCOUNT_CONFIG_DEFAULT.interest.rate_pct);
  });

  it("migra account_due_days cuando el negocio no tiene config", () => {
    expect(effectiveAccountConfig(null, null, null, 20).terms.days).toBe(20);
    expect(effectiveAccountConfig({ terms: { days: 7 } }, null, null, 20).terms.days).toBe(7);
  });

  it("los arrays del override reemplazan (no concatenan)", () => {
    const eff = effectiveAccountConfig({ reminders: { after_days: [1, 7] } }, null, { reminders: { after_days: [3] } });
    expect(eff.reminders.after_days).toEqual([3]);
  });
});
