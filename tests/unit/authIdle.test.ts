import { describe, expect, it } from "vitest";
import { INACTIVITY_MS, isIdleExpired, parseIdle } from "@/lib/auth/idle";

const NOW = 1_800_000_000_000;

describe("parseIdle", () => {
  it("lee un timestamp válido", () => {
    expect(parseIdle(String(NOW))).toBe(NOW);
  });
  it("ignora vacío o basura", () => {
    expect(parseIdle(undefined)).toBeNull();
    expect(parseIdle("")).toBeNull();
    expect(parseIdle("abc")).toBeNull();
  });
});

describe("isIdleExpired", () => {
  it("sin marca no vence (primer ingreso)", () => {
    expect(isIdleExpired(undefined, NOW)).toBe(false);
  });
  it("dentro de las 8 h sigue activa", () => {
    expect(isIdleExpired(String(NOW - INACTIVITY_MS + 1000), NOW)).toBe(false);
  });
  it("a las 8 h vence", () => {
    expect(isIdleExpired(String(NOW - INACTIVITY_MS), NOW)).toBe(true);
  });
  it("una marca en el futuro (reloj corrido) no vence", () => {
    expect(isIdleExpired(String(NOW + 60_000), NOW)).toBe(false);
  });
});
