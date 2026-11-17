// SEC-23 (ADR-186): MFA TOTP del staff interno.
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  INTERNAL_HOME_PATH,
  MFA_CHALLENGE_PATH,
  MFA_ENROLL_PATH,
  createFlagReader,
  hasVerifiedTotp,
  internalMfaRedirect,
  isInternalMfaGuardedPath,
  isTotpCode,
  mfaResetErrorMessage,
  normalizeTotpCode,
  type InternalMfaInput,
} from "@/lib/auth/internalMfa";
import {
  aalFromAuthHeader,
  decodeJwtPayload,
  isMissingFunctionError,
  staffMfaBlocked,
  staffMfaRejection,
} from "@/supabase/functions/_shared/internalMfa";

const ROOT = path.resolve(__dirname, "..", "..");

// Edges con rama de staff por app_metadata.is_internal (ADR-186, lista final).
const STAFF_EDGES = [
  "ai_assistant",
  "arca_padron",
  "arca_wsfe",
  "catalog_purchase_checkout",
  "catalog_sync",
  "internal_create_tenant",
  "internal_impersonate",
  "internal_tenant_members",
  "mp_subscription_checkout",
  "mp_subscription_manage",
  "mp_subscription_pause",
  "mp_update_subscription_amount",
  "platform_billing",
  "process_pending_emails",
  "send_email",
  "set_email_providers",
  "set_email_smtp",
  "set_platform_secret",
  "staff_admin",
];
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

const base: InternalMfaInput = {
  isInternal: true,
  flagOn: true,
  currentLevel: "aal1",
  hasVerifiedFactor: true,
  pathname: "/internal/tenants",
};
const run = (over: Partial<InternalMfaInput>) => internalMfaRedirect({ ...base, ...over });

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma`;
}

describe("internalMfaRedirect (middleware)", () => {
  it("con el flag apagado no redirige nunca (comportamiento de siempre)", () => {
    for (const pathname of ["/internal", "/internal/tenants", MFA_CHALLENGE_PATH, MFA_ENROLL_PATH]) {
      for (const hasVerifiedFactor of [true, false]) {
        expect(run({ flagOn: false, pathname, hasVerifiedFactor })).toBeNull();
      }
    }
  });

  it("no toca a quien no es staff ni rutas fuera del panel interno", () => {
    expect(run({ isInternal: false })).toBeNull();
    expect(run({ pathname: "/dashboard" })).toBeNull();
    expect(run({ pathname: "/pos" })).toBeNull();
    expect(run({ pathname: "/internalx" })).toBeNull();
  });

  it("aal1 con factor → challenge con next", () => {
    expect(run({})).toBe(`${MFA_CHALLENGE_PATH}?next=${encodeURIComponent("/internal/tenants")}`);
    expect(run({ pathname: "/internal" })).toBe(`${MFA_CHALLENGE_PATH}?next=%2Finternal`);
    expect(run({ pathname: MFA_CHALLENGE_PATH })).toBeNull();
    expect(run({ currentLevel: null })).toMatch(/^\/login\/mfa\?next=/);
  });

  it("aal1 sin factor → enrolar (y la pantalla de enrolamiento queda abierta)", () => {
    expect(run({ hasVerifiedFactor: false })).toBe(MFA_ENROLL_PATH);
    expect(run({ hasVerifiedFactor: false, pathname: MFA_CHALLENGE_PATH })).toBe(MFA_ENROLL_PATH);
    expect(run({ hasVerifiedFactor: false, pathname: MFA_ENROLL_PATH })).toBeNull();
  });

  it("aal2 pasa; en el challenge vuelve al panel", () => {
    expect(run({ currentLevel: "aal2" })).toBeNull();
    expect(run({ currentLevel: "aal2", pathname: MFA_ENROLL_PATH })).toBeNull();
    expect(run({ currentLevel: "aal2", pathname: MFA_CHALLENGE_PATH })).toBe(INTERNAL_HOME_PATH);
  });

  it("rutas protegidas", () => {
    expect(isInternalMfaGuardedPath("/internal")).toBe(true);
    expect(isInternalMfaGuardedPath("/internal/seguridad/mfa")).toBe(true);
    expect(isInternalMfaGuardedPath(MFA_CHALLENGE_PATH)).toBe(true);
    expect(isInternalMfaGuardedPath("/login")).toBe(false);
    expect(isInternalMfaGuardedPath("/login-internal")).toBe(false);
  });

  it("factor verificado = TOTP verificado", () => {
    expect(hasVerifiedTotp(undefined)).toBe(false);
    expect(hasVerifiedTotp([{ factor_type: "totp", status: "unverified" }])).toBe(false);
    expect(hasVerifiedTotp([{ factor_type: "phone", status: "verified" }])).toBe(false);
    expect(hasVerifiedTotp([{ factor_type: "totp", status: "verified" }])).toBe(true);
  });
});

describe("lectura cacheada del flag", () => {
  it("cachea el valor durante el TTL y vuelve a leer al vencer", async () => {
    const read = createFlagReader(1000);
    const fetcher = vi.fn().mockResolvedValue(true);
    expect(await read(fetcher, 0)).toBe(true);
    expect(await read(fetcher, 500)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(false);
    expect(await read(fetcher, 1500)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("si la lectura falla devuelve false sin cachear", async () => {
    const read = createFlagReader(1000);
    expect(await read(() => Promise.resolve(null), 0)).toBe(false);
    expect(await read(() => Promise.reject(new Error("red")), 1)).toBe(false);
    const ok = vi.fn().mockResolvedValue(true);
    expect(await read(ok, 2)).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("código TOTP y mensajes", () => {
  it("normaliza y valida", () => {
    expect(normalizeTotpCode(" 123-456 ")).toBe("123456");
    expect(normalizeTotpCode("1234567")).toBe("123456");
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("12345")).toBe(false);
  });

  it("errores de internal_mfa_reset", () => {
    expect(mfaResetErrorMessage("forbidden")).toMatch(/super admin/);
    expect(mfaResetErrorMessage("cannot_reset_self")).toMatch(/propia/);
    expect(mfaResetErrorMessage("not_internal_staff")).toMatch(/staff/);
    expect(mfaResetErrorMessage(null)).toMatch(/No se pudo/);
  });
});

describe("Edges de staff · _shared/internalMfa", () => {
  it("lee el claim aal del JWT", () => {
    expect(aalFromAuthHeader(jwt({ aal: "aal2", sub: "x" }))).toBe("aal2");
    expect(aalFromAuthHeader(jwt({ aal: "aal1" }))).toBe("aal1");
    expect(aalFromAuthHeader(jwt({ sub: "x" }))).toBe("aal1");
    expect(aalFromAuthHeader("")).toBe("aal1");
    expect(aalFromAuthHeader("Bearer basura")).toBe("aal1");
    expect(decodeJwtPayload(jwt({ nombre: "Ñandú" }))?.nombre).toBe("Ñandú");
  });

  it("bloquea sólo aal1 con el flag prendido", () => {
    expect(staffMfaBlocked(false, "aal1")).toBe(false);
    expect(staffMfaBlocked(true, "aal1")).toBe(true);
    expect(staffMfaBlocked(true, "aal2")).toBe(false);
  });

  it("staffMfaRejection: flag de la RPC y falla cerrado", async () => {
    const client = (data: unknown, error: unknown = null) => ({
      rpc: vi.fn().mockResolvedValue({ data, error }),
    });
    expect(await staffMfaRejection(client(false), jwt({ aal: "aal1" }))).toBeNull();
    expect(await staffMfaRejection(client(true), jwt({ aal: "aal1" }))).toBe("mfa_required");
    expect(await staffMfaRejection(client(null, { message: "boom" }), jwt({ aal: "aal1" }))).toBe("mfa_required");
    const c = client(true);
    expect(await staffMfaRejection(c, jwt({ aal: "aal2" }))).toBeNull();
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("RPC inexistente (Edge antes que la migración) = flag apagado; otro error falla cerrado", async () => {
    const missing = [
      { code: "PGRST202", message: "Could not find the function public.internal_mfa_required without parameters in the schema cache" },
      { code: "42883", message: "function public.internal_mfa_required() does not exist" },
      { message: "Could not find the function public.internal_mfa_required" },
    ];
    for (const error of missing) {
      expect(isMissingFunctionError(error)).toBe(true);
      const c = { rpc: vi.fn().mockResolvedValue({ data: null, error }) };
      expect(await staffMfaRejection(c, jwt({ aal: "aal1" }))).toBeNull();
    }
    for (const error of [{ code: "42501", message: "permission denied" }, { message: "fetch failed" }, null, "x"]) {
      expect(isMissingFunctionError(error)).toBe(false);
    }
    const rejects = { rpc: vi.fn().mockRejectedValue(new Error("red")) };
    expect(await staffMfaRejection(rejects, jwt({ aal: "aal1" }))).toBe("mfa_required");
  });

  it("toda Edge que mira app_metadata.is_internal usa el helper", () => {
    const dir = path.join(ROOT, "supabase", "functions");
    const withStaff = fs
      .readdirSync(dir)
      .filter((d) => !d.startsWith("_") && fs.existsSync(path.join(dir, d, "index.ts")))
      .filter((d) => /\.is_internal(?![a-z_])/.test(read(`supabase/functions/${d}/index.ts`)));
    expect(withStaff.sort()).toEqual(STAFF_EDGES.slice().sort());
    for (const fn of STAFF_EDGES) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toContain('from "../_shared/internalMfa.ts"');
      expect(src, fn).toMatch(/await staffMfaRejection\(userClient,/);
    }
  });
});

describe("migración 20270122100000_sec23_internal_mfa", () => {
  const sql = read("supabase/migrations/20270122100000_sec23_internal_mfa.sql");

  it("flag apagado por defecto y funciones nuevas con revoke y search_path", () => {
    expect(sql).toMatch(/values \('internal_mfa_required', 'false'::jsonb\)/);
    expect(sql).toContain("revoke execute on function public.internal_mfa_required() from public, anon;");
    expect(sql).toContain("revoke execute on function public.internal_mfa_reset(uuid, text) from public, anon;");
    const fns = sql.match(/create or replace function [^(]+\(/g) ?? [];
    expect(fns).toHaveLength(3);
    expect((sql.match(/set search_path = /g) ?? []).length).toBe(3);
  });

  it("is_internal() sigue STABLE y sólo lee el flag para staff", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.is_internal()"));
    expect(body).toMatch(/^create or replace function public\.is_internal\(\)\s+returns boolean\s+language plpgsql\s+stable/);
    expect(body.indexOf("is_internal')::boolean")).toBeLessThan(body.indexOf("public.internal_mfa_required()"));
    expect(body).toContain("coalesce(v_claims ->> 'aal', 'aal1') = 'aal2'");
    // El cache por transacción sólo guarda 'on': forjarlo nunca apaga la exigencia.
    expect(body).toContain("current_setting('ninja.internal_mfa_required', true), '') <> 'on'");
    expect(body).toContain("set_config('ninja.internal_mfa_required', 'on', true)");
    expect(body).not.toMatch(/set_config\('ninja\.internal_mfa_required', 'off'/);
  });

  it("system_settings sin escritura para authenticated ni anon", () => {
    expect(sql).toContain("revoke insert, update, delete on table public.system_settings from authenticated;");
    expect(sql).toContain("revoke insert, update, delete on table public.system_settings from anon;");
  });

  it("internal_mfa_reset: super_admin, no a sí mismo, auditado", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.internal_mfa_reset"));
    expect(body).toContain("internal_level() is distinct from 'super_admin'");
    expect(body).toContain("cannot_reset_self");
    expect(body).toContain("delete from auth.mfa_factors");
    expect(body).toContain("insert into audit_logs");
    expect(body).toContain("'sessions_revoked', v_sess_ok");
    expect(body).not.toContain("'sessions_revoked', true");
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/);
  });

  it("grants.expected.json incluye las funciones nuevas", () => {
    const expected = JSON.parse(read("supabase/security/grants.expected.json")) as {
      functions: { sig: string; anon: boolean; authenticated: boolean; secdef: boolean }[];
    };
    const bySig = new Map(expected.functions.map((f) => [f.sig, f]));
    for (const sig of ["internal_mfa_required()", "internal_mfa_reset(p_user_id uuid, p_motivo text)"]) {
      expect(bySig.get(sig), sig).toMatchObject({ anon: false, authenticated: true, secdef: true });
    }
  });
});
