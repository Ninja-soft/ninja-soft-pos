import { describe, expect, it } from "vitest";
import { callbackUrl, homePath, safeNextPath } from "@/lib/auth/redirect";

describe("safeNextPath", () => {
  it("acepta rutas internas", () => {
    expect(safeNextPath("/ventas")).toBe("/ventas");
    expect(safeNextPath("/signup?step=2")).toBe("/signup?step=2");
  });

  it("rechaza URLs externas y protocol-relative", () => {
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.com")).toBe("/dashboard");
  });

  it("usa el fallback si no hay next", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath(undefined, "/internal/tenants")).toBe("/internal/tenants");
  });
});

describe("callbackUrl", () => {
  it("arma la URL del callback OAuth con next codificado", () => {
    expect(callbackUrl("https://pos.soft.ninja", "/signup?step=2")).toBe(
      "https://pos.soft.ninja/auth/callback?next=%2Fsignup%3Fstep%3D2",
    );
  });
});

describe("homePath", () => {
  it("dueño o cajero con negocio va al panel", () => {
    expect(homePath({ isInternal: false, hasTenant: true })).toBe("/dashboard");
  });
  it("staff con negocio propio va al panel (accede al interno desde el menú)", () => {
    expect(homePath({ isInternal: true, hasTenant: true })).toBe("/dashboard");
  });
  it("staff sin negocio va al panel interno", () => {
    expect(homePath({ isInternal: true, hasTenant: false })).toBe("/internal/tenants");
  });
  it("usuario sin negocio termina el alta", () => {
    expect(homePath({ isInternal: false, hasTenant: false })).toBe("/onboarding");
  });
});
