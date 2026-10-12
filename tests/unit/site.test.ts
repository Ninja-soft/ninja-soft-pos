import { describe, expect, it } from "vitest";
import {
  CANONICAL_APP_URL,
  canonicalAppUrl,
  legacyHostRedirect,
  resolveAppOrigin,
} from "@/lib/site";

describe("resolveAppOrigin", () => {
  it("producción en el alias de Vercel → dominio canónico", () => {
    expect(resolveAppOrigin("https://ninja-soft-pos.vercel.app")).toBe(CANONICAL_APP_URL);
    expect(resolveAppOrigin("https://ninja-soft-pos.vercel.app", undefined, "production")).toBe(
      CANONICAL_APP_URL,
    );
  });

  it("usa NEXT_PUBLIC_APP_URL si es https y propio", () => {
    expect(resolveAppOrigin("https://ninja-soft-pos.vercel.app", "https://pos.soft.ninja/")).toBe(
      "https://pos.soft.ninja",
    );
    // Un env de desarrollo o un *.vercel.app no pisa el canónico.
    expect(resolveAppOrigin("https://ninja-soft-pos.vercel.app", "http://localhost:3000")).toBe(
      CANONICAL_APP_URL,
    );
    expect(
      resolveAppOrigin("https://pos.soft.ninja", "https://ninja-soft-pos.vercel.app"),
    ).toBe(CANONICAL_APP_URL);
  });

  it("cualquier *.vercel.app con VERCEL_ENV production → canónico", () => {
    expect(resolveAppOrigin("https://ninja-soft-pos-abc123-team.vercel.app", undefined, "production")).toBe(
      CANONICAL_APP_URL,
    );
  });

  it("previews y localhost conservan su origen", () => {
    expect(resolveAppOrigin("https://ninja-soft-pos-git-feat-team.vercel.app", undefined, "preview")).toBe(
      "https://ninja-soft-pos-git-feat-team.vercel.app",
    );
    expect(resolveAppOrigin("http://localhost:3025", "http://localhost:3000", "development")).toBe(
      "http://localhost:3025",
    );
  });

  it("origen inválido → canónico", () => {
    expect(resolveAppOrigin(undefined)).toBe(CANONICAL_APP_URL);
    expect(canonicalAppUrl("nada")).toBe(CANONICAL_APP_URL);
  });
});

describe("legacyHostRedirect", () => {
  it("redirige el alias de producción preservando path y query", () => {
    expect(legacyHostRedirect("ninja-soft-pos.vercel.app", "/pagar/abc?x=1")).toBe(
      "https://pos.soft.ninja/pagar/abc?x=1",
    );
    expect(legacyHostRedirect("Ninja-Soft-POS.vercel.app:443", "/api/mp/oauth/callback?code=1")).toBe(
      "https://pos.soft.ninja/api/mp/oauth/callback?code=1",
    );
  });

  it("no toca previews, el canónico ni localhost", () => {
    expect(legacyHostRedirect("ninja-soft-pos-git-x-team.vercel.app", "/")).toBeNull();
    expect(legacyHostRedirect("pos.soft.ninja", "/")).toBeNull();
    expect(legacyHostRedirect("localhost:3000", "/")).toBeNull();
    expect(legacyHostRedirect(null, "/")).toBeNull();
  });
});
