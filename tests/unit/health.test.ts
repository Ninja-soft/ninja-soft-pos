// @vitest-environment node
// Healthcheck (F1.5 · ADR-098).
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_VERSION, baseReport, deepChecks } from "@/lib/health";

const PKG_VERSION = (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;

describe("healthcheck", () => {
  it("liveness con env y commit corto, sin secretos", () => {
    const r = baseReport(
      { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "abcdef1234567", SUPABASE_SERVICE_ROLE_KEY: "secreto" },
      new Date("2026-10-13T00:00:00Z"),
    );
    expect(r).toEqual({
      status: "ok",
      service: "ninja-soft-pos",
      version: PKG_VERSION,
      env: "production",
      commit: "abcdef1",
      time: "2026-10-13T00:00:00.000Z",
    });
    expect(JSON.stringify(r)).not.toContain("secreto");
  });

  it("version sale de package.json, no de npm_package_version (OPS-53)", () => {
    expect(APP_VERSION).toBe(PKG_VERSION);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baseReport({ npm_package_version: "9.9.9" }).version).toBe(PKG_VERSION);
    expect(baseReport({}).version).toBe(PKG_VERSION);
  });

  it("deep: prueba Auth y la base con la anon key", async () => {
    const fetchFn = vi.fn(async () => new Response("[]", { status: 200 }));
    const checks = await deepChecks({ fetchFn, supabaseUrl: "https://abc.supabase.co/", anonKey: "anon" });
    expect(checks.supabase_auth.ok).toBe(true);
    expect(checks.supabase_db.ok).toBe(true);
    const urls = fetchFn.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(urls).toEqual([
      "https://abc.supabase.co/auth/v1/health",
      "https://abc.supabase.co/rest/v1/plans?select=key&limit=1",
    ]);
  });

  it("deep: caída o sin configurar = no ok", async () => {
    const down = await deepChecks({
      fetchFn: async () => {
        throw new TypeError("fetch failed");
      },
      supabaseUrl: "https://abc.supabase.co",
      anonKey: "anon",
    });
    expect(down.supabase_auth).toMatchObject({ ok: false, status: null, error: "unreachable" });
    const err = await deepChecks({ fetchFn: async () => new Response("", { status: 503 }), supabaseUrl: "https://x", anonKey: "a" });
    expect(err.supabase_db).toMatchObject({ ok: false, status: 503 });
    const none = await deepChecks({ fetchFn: vi.fn(), supabaseUrl: undefined, anonKey: undefined });
    expect(none.supabase_auth.error).toBe("not_configured");
  });
});
