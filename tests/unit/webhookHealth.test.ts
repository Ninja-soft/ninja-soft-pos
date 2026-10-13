import { describe, expect, it } from "vitest";
import { WEBHOOK_PROVIDERS, buildWebhookHealth, healthLevel } from "@/lib/internal/webhookHealth";

describe("healthLevel", () => {
  const base = { lastEventAt: "2026-10-12T10:00:00+00:00", lastErrorAt: null };
  it("sin eventos, sin errores, aislados y mayoría", () => {
    expect(healthLevel({ ...base, total: 0, errors: 0 })).toBe("idle");
    expect(healthLevel({ ...base, total: 5, errors: 0 })).toBe("ok");
    expect(healthLevel({ ...base, total: 10, errors: 1, lastErrorAt: "2026-10-12T09:00:00+00:00" })).toBe("warn");
    expect(healthLevel({ ...base, total: 4, errors: 3, lastErrorAt: "2026-10-12T09:00:00+00:00" })).toBe("error");
  });
  it("si el último aviso fue un error, es error", () => {
    expect(
      healthLevel({
        total: 10,
        errors: 1,
        lastEventAt: "2026-10-12T10:00:00+00:00",
        lastErrorAt: "2026-10-12T10:00:00+00:00",
      }),
    ).toBe("error");
  });
});

describe("buildWebhookHealth", () => {
  it("completa los proveedores sin eventos y ordena primero lo que falla", () => {
    const rows = buildWebhookHealth([
      {
        provider: "modo",
        total: "4",
        ok_count: "1",
        error_count: "3",
        ignored_count: "0",
        last_event_at: "2026-10-12T10:00:00+00:00",
        last_error_at: "2026-10-12T10:00:00+00:00",
        last_error: "MODO respondió 500",
        avg_duration_ms: 120,
      },
      { provider: "getnet", total: 2, ok_count: 2, error_count: 0, ignored_count: 0, last_event_at: "2026-10-12T09:00:00+00:00" },
      { provider: "nuevo", total: 1, ok_count: 0, error_count: 0, ignored_count: 1 },
    ]);
    expect(rows).toHaveLength(WEBHOOK_PROVIDERS.length + 1);
    expect(rows[0]).toMatchObject({
      provider: "modo",
      level: "error",
      errors: 3,
      lastError: "MODO respondió 500",
      functionName: "modo_webhook",
    });
    expect(rows.find((r) => r.provider === "getnet")?.level).toBe("ok");
    expect(rows.find((r) => r.provider === "nave")).toMatchObject({ total: 0, level: "idle", avgDurationMs: null });
    expect(rows.find((r) => r.provider === "nuevo")?.label).toBe("nuevo");
  });
  it("tolera datos vacíos o inválidos", () => {
    expect(buildWebhookHealth(null).every((r) => r.level === "idle")).toBe(true);
  });
});
