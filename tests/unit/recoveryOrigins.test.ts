import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECOVERY_ORIGIN,
  allowedRecoveryOrigins,
  pickRecoveryOrigin,
} from "@/supabase/functions/_shared/recoveryOrigins";

describe("SEC-62 · orígenes del link de recuperación", () => {
  const prod = allowedRecoveryOrigins(undefined);

  it("acepta sólo el origen exacto de producción por defecto", () => {
    expect(pickRecoveryOrigin("https://pos.soft.ninja", prod)).toBe("https://pos.soft.ninja");
    expect(pickRecoveryOrigin("https://pos.soft.ninja/", prod)).toBe("https://pos.soft.ninja");
  });

  it.each([
    "https://ninja-soft-pos-atacante.vercel.app",
    "https://ninja-soft-pos.vercel.app",
    "http://localhost:3005",
    "https://pos.soft.ninja.evil.com",
    "https://evil.com/https://pos.soft.ninja",
    "javascript:alert(1)",
    "",
    null,
  ])("un origen no permitido cae al de producción: %s", (o) => {
    expect(pickRecoveryOrigin(o, prod)).toBe(DEFAULT_RECOVERY_ORIGIN);
  });

  it("los extra sólo entran por env y exactos", () => {
    const allowed = allowedRecoveryOrigins(" http://localhost:3005 , https://Preview.Example.com/ , no-es-url, https://x.com/path ");
    expect(pickRecoveryOrigin("http://localhost:3005", allowed)).toBe("http://localhost:3005");
    expect(pickRecoveryOrigin("https://preview.example.com", allowed)).toBe("https://preview.example.com");
    expect(pickRecoveryOrigin("http://localhost:3006", allowed)).toBe(DEFAULT_RECOVERY_ORIGIN);
    expect(allowed.has("https://x.com/path")).toBe(false);
    expect(allowed.size).toBe(3);
  });
});
