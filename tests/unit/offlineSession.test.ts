import { describe, expect, it } from "vitest";
import { stringToBase64URL } from "@supabase/ssr";
import { OFFLINE_POLICY_DEFAULTS } from "@/lib/pos/offline/policy";
import {
  authStorageKey,
  buildLastPos,
  isLastPos,
  parsePersistedSession,
  resolveOfflineMode,
  type OfflineModeInput,
} from "@/lib/pos/offline/session";
import { decodeSessionCookie } from "@/modules/pos/offline/offlineSession";

// POS abierto sin conexión (H65, ADR-087): quién puede vender.

const NOW = Date.parse("2026-10-13T15:00:00Z");
const T = "tenant-1";
const U = "user-1";

function input(over: Partial<OfflineModeInput> = {}): OfflineModeInput {
  return {
    last: { v: 1, tenantId: T, userId: U, at: "2026-10-13T14:00:00Z" },
    session: { userId: U, email: "caja@negocio.com", expiresAt: NOW / 1000 - 600, hasRefresh: true },
    idle: String(NOW - 60_000),
    snapshot: {
      tenantId: T,
      userId: U,
      at: "2026-10-13T14:50:00Z",
      policy: OFFLINE_POLICY_DEFAULTS,
      shift: { id: "shift-1", storeId: null },
    },
    now: NOW,
    ...over,
  };
}

describe("resolveOfflineMode", () => {
  it("vende con sesión del mismo usuario, foto vigente y caja abierta (aunque el access token esté vencido)", () => {
    expect(resolveOfflineMode(input())).toEqual({ mode: "sell" });
  });
  it("sin datos del POS en el dispositivo", () => {
    expect(resolveOfflineMode(input({ last: null }))).toMatchObject({ mode: "readonly", reason: "no_device_data" });
  });
  it("sin sesión de Supabase o sin refresh token (cerró sesión): no vende", () => {
    expect(resolveOfflineMode(input({ session: null }))).toMatchObject({ mode: "readonly", reason: "no_session" });
    expect(
      resolveOfflineMode(input({ session: { userId: U, email: null, expiresAt: null, hasRefresh: false } })),
    ).toMatchObject({ mode: "readonly", reason: "no_session" });
  });
  it("la sesión es de otro usuario", () => {
    expect(
      resolveOfflineMode(input({ session: { userId: "otro", email: null, expiresAt: null, hasRefresh: true } })),
    ).toMatchObject({ mode: "readonly", reason: "other_user" });
  });
  it("vencida por inactividad (8 h)", () => {
    expect(resolveOfflineMode(input({ idle: String(NOW - 9 * 3_600_000) }))).toMatchObject({
      mode: "readonly",
      reason: "idle_expired",
    });
  });
  it("sin foto o foto de otro usuario", () => {
    expect(resolveOfflineMode(input({ snapshot: null }))).toMatchObject({ reason: "no_snapshot" });
    const s = input().snapshot!;
    expect(resolveOfflineMode(input({ snapshot: { ...s, userId: "otro" } }))).toMatchObject({ reason: "no_snapshot" });
    expect(resolveOfflineMode(input({ snapshot: { ...s, tenantId: "otro" } }))).toMatchObject({ reason: "no_snapshot" });
  });
  it("política apagada", () => {
    const s = input().snapshot!;
    expect(
      resolveOfflineMode(input({ snapshot: { ...s, policy: { ...s.policy, enabled: false } } })),
    ).toMatchObject({ reason: "disabled" });
  });
  it("foto más vieja que las horas de la política", () => {
    const s = input().snapshot!;
    const old = new Date(NOW - 3 * 3_600_000).toISOString();
    expect(
      resolveOfflineMode(input({ snapshot: { ...s, at: old, policy: { ...s.policy, maxHours: 2 } } })),
    ).toMatchObject({ reason: "stale" });
    expect(resolveOfflineMode(input({ snapshot: { ...s, at: "no es fecha" } }))).toMatchObject({ reason: "stale" });
  });
  it("sin caja abierta en la foto", () => {
    const s = input().snapshot!;
    expect(resolveOfflineMode(input({ snapshot: { ...s, shift: null } }))).toMatchObject({ reason: "no_shift" });
  });
  it("los textos no usan em dash", () => {
    const reasons = [
      input({ last: null }),
      input({ session: null }),
      input({ snapshot: null }),
      input({ idle: String(NOW - 9 * 3_600_000) }),
    ].map((i) => resolveOfflineMode(i));
    for (const r of reasons) if (r.mode === "readonly") expect(`${r.title} ${r.text}`).not.toContain("—");
  });
});

describe("sesión persistida", () => {
  const raw = JSON.stringify({
    access_token: "eyJ.secreto",
    refresh_token: "refresh-secreto",
    expires_at: 1_800_000_000,
    user: { id: U, email: "caja@negocio.com" },
  });

  it("sólo conserva id, email, vencimiento y si hay refresh (nunca los tokens)", () => {
    const s = parsePersistedSession(raw);
    expect(s).toEqual({ userId: U, email: "caja@negocio.com", expiresAt: 1_800_000_000, hasRefresh: true });
    expect(JSON.stringify(s)).not.toContain("secreto");
  });
  it("JSON roto o sin usuario", () => {
    expect(parsePersistedSession("{")).toBeNull();
    expect(parsePersistedSession(JSON.stringify({ access_token: "x" }))).toBeNull();
    expect(parsePersistedSession(null)).toBeNull();
  });
  it("decodifica la cookie de @supabase/ssr (base64- o JSON plano)", () => {
    expect(decodeSessionCookie(`base64-${stringToBase64URL(raw)}`)).toBe(raw);
    expect(decodeSessionCookie(raw)).toBe(raw);
    expect(decodeSessionCookie(null)).toBeNull();
  });
  it("clave de almacenamiento sb-<ref>-auth-token", () => {
    expect(authStorageKey("https://hrkditzrsavehnhngakb.supabase.co")).toBe("sb-hrkditzrsavehnhngakb-auth-token");
    expect(authStorageKey("http://127.0.0.1:54321")).toBe("sb-127-auth-token");
    expect(authStorageKey("no es url")).toBeNull();
  });
});

describe("puntero pos.last", () => {
  it("se arma y valida sin secretos", () => {
    const l = buildLastPos(T, U, new Date(NOW));
    expect(isLastPos(l)).toBe(true);
    expect(Object.keys(l).sort()).toEqual(["at", "tenantId", "userId", "v"]);
    expect(isLastPos({ ...l, v: 2 })).toBe(false);
    expect(isLastPos({ ...l, userId: "" })).toBe(false);
    expect(isLastPos(null)).toBe(false);
  });
});
