// =============================================================================
// _shared/mercadolibre/runtime.ts (H87 · ADR-104). SÓLO Edge (usa Deno).
//
// Arma las dependencias reales de los módulos puros: cliente de Supabase con
// service_role, tokens con lock en la base (ml_token_* RPC), límite de
// llamadas por cuenta (ml_rate_take) y el cliente HTTP de ML por cuenta.
// La config de la app sale de platform_secrets.ml_app o de los secrets de
// Edge (ADR-126, `mlConfig(admin)`).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  ML_APP_SECRET_KEY,
  createMlConfigLoader,
  type MlAppConfig,
  type MlConfigResult,
  type MlPlatformSecrets,
} from "./config.ts";
import { MlApiError, createMlClient, type FetchLike, type MlClient, type MlFamily } from "./client.ts";
import { expiresAtFrom, getAccessToken, refreshTokenCall, type TokenDeps, type TokenRow } from "./oauth.ts";
import type { Rpc } from "./worker.ts";

export const fetcher: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/** Lee platform_secrets.ml_app con service_role (RLS deny a todos los demás). */
export async function readMlPlatformSecrets(admin: SupabaseClient): Promise<MlPlatformSecrets> {
  const { data, error } = await admin.from("platform_secrets").select("secrets").eq("key", ML_APP_SECRET_KEY).maybeSingle();
  if (error) {
    // Sin el detalle: nunca loguear nada que pueda traer el secreto.
    console.warn(JSON.stringify({ fn: "ml_config", warn: "platform_secrets_read_failed" }));
    throw new Error("platform_secrets_read_failed");
  }
  return (data?.secrets ?? null) as MlPlatformSecrets;
}

/**
 * Loader de la config de la app (ADR-126): platform_secrets.ml_app si está
 * completa, si no los secrets de Edge. ttlMs 0 = memo por invocación (crear
 * uno por request); > 0 = memo por isolate (ml_webhook).
 */
export function mlConfigLoader(admin: SupabaseClient, ttlMs = 0): () => Promise<MlConfigResult> {
  return createMlConfigLoader(() => readMlPlatformSecrets(admin), Deno.env.toObject(), { ttlMs });
}

/** Config efectiva para esta invocación (una lectura de la base). */
export function mlConfig(admin: SupabaseClient): Promise<MlConfigResult> {
  return mlConfigLoader(admin)();
}

export function rpcOf(admin: SupabaseClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function tokenDeps(admin: SupabaseClient, cfg: MlAppConfig): TokenDeps {
  const rpc = rpcOf(admin);
  const first = (d: unknown): TokenRow | null => {
    const row = Array.isArray(d) ? d[0] : d;
    return row && (row as TokenRow).access_token ? (row as TokenRow) : null;
  };
  return {
    read: async (id) => first(await rpc("ml_token_get", { p_account: id })),
    tryLock: async (id, lock, secs) => first(await rpc("ml_token_lock", { p_account: id, p_lock: lock, p_seconds: secs })),
    release: async (id, lock) => void (await rpc("ml_token_release", { p_account: id, p_lock: lock })),
    save: async (id, lock, tok) =>
      void (await rpc("ml_token_save", {
        p_account: id,
        p_lock: lock,
        p_access: tok.access_token,
        p_refresh: tok.refresh_token ?? null,
        p_expires_at: expiresAtFrom(tok.expires_in),
        p_scope: tok.scope ?? null,
      })),
    fail: async (id, lock, code, message) =>
      void (await rpc("ml_token_fail", { p_account: id, p_lock: lock, p_code: code, p_message: message })),
    refresh: (rt) => refreshTokenCall(fetcher, { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: rt }),
    sleep,
    now: () => Date.now(),
    newLockId: () => crypto.randomUUID(),
  };
}

/** Cliente de ML para una cuenta: token con lock + límite por familia. */
export function accountClient(admin: SupabaseClient, cfg: MlAppConfig, accountId: string): MlClient {
  const deps = tokenDeps(admin, cfg);
  const rpc = rpcOf(admin);
  let current: string | null = null;
  return createMlClient({
    fetch: fetcher,
    getToken: async (force) => {
      current = await getAccessToken(deps, accountId, { rejected: force ? current : null });
      return current;
    },
    gate: async (family: MlFamily) => {
      // Espera corta si el cupo se libera pronto; si no, que la cola reintente.
      for (let i = 0; i < 3; i++) {
        const wait = Number(await rpc("ml_rate_take", { p_account: accountId, p_family: family, p_cost: 1 })) || 0;
        if (wait <= 0) return;
        if (wait > 4_000) throw new MlApiError("rate_limited", "Límite de llamadas de la cuenta: se reintenta.", 429, true, wait);
        await sleep(wait);
      }
      throw new MlApiError("rate_limited", "Límite de llamadas de la cuenta: se reintenta.", 429, true, 5_000);
    },
  });
}

/** POST multipart autenticado (subida de la factura). */
export async function postFormAs(admin: SupabaseClient, cfg: MlAppConfig, accountId: string, path: string, form: FormData) {
  const client = accountClient(admin, cfg, accountId);
  const res = await client.request<unknown>("POST", path, { multipart: form });
  return res.data;
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
