// =============================================================================
// Edge Function: arca_padron (ADR-133 · F18 · H104).
//
// Consulta del padrón de ARCA (ws_sr_constancia_inscripcion, getPersona_v2)
// para los usuarios de los negocios, con el certificado de NinjaSoft
// (arca_platform del ambiente de arca_padron_config). Lógica pura en
// ../_shared/arca/padron.ts; ticket de WSAA en ../_shared/arca/platformAuth.ts.
//
// Acciones (JWT del usuario; verify_jwt = true):
//   { action: "status" }                     → { ok, available, reason, environment, cache_days }
//   { action: "lookup", cuit, refresh? }     → { ok, status, persona, cached, fetched_at }
//       Cualquier miembro activo del negocio actual con la feature padron_arca
//       (arca_padron_guard). Cache compartida por CUIT (arca_padron_cache, los
//       días de la config) y rate limit por negocio (hora y día de Argentina) y
//       global (hora) sobre las consultas que llegan a ARCA. Cada consulta
//       queda en arca_padron_lookups: es lo que después habilita marcar al
//       cliente como verificado (trigger de customers), nunca el navegador.
//   Staff interno (header x-ninja-scope: internal; internal_arca_padron_get
//   con el JWT valida internal_scope):
//   { action: "internal_test", cuit }        → consulta ARCA sin cache y deja el
//       resultado en arca_padron_config (último test) y en audit_logs.
//
// Errores claros: invalid_cuit (dígito verificador), no_encontrado,
// not_configured (sin certificado o apagado), feature_not_in_plan,
// rate_limited, arca_auth_failed (típico: el certificado no tiene el
// servicio ws_sr_constancia_inscripcion), padron_error.
// Secretos: ARCA_KEY_ENC descifra la clave sólo en memoria. Nunca se loguean
// la clave, el Token ni el Sign.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import type { ArcaEnv } from "../_shared/arca/config.ts";
import { postSoap, type FetchLike } from "../_shared/arca/client.ts";
import { platformAuth } from "../_shared/arca/platformAuth.ts";
import {
  buildGetPersonaV2,
  cuitIsValid,
  isFresh,
  PADRON_SERVICE,
  padronEndpointFor,
  parsePersonaV2,
  quotaExceeded,
  type PadronResult,
} from "../_shared/arca/padron.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const fetcher: FetchLike = (url, init) => fetch(url, init);

type Config = {
  enabled: boolean;
  environment: ArcaEnv;
  cache_days: number;
  tenant_per_hour: number;
  tenant_per_day: number;
  global_per_hour: number;
};

async function readConfig(admin: SupabaseClient): Promise<Config | null> {
  const { data } = await admin
    .from("arca_padron_config")
    .select("enabled, environment, cache_days, tenant_per_hour, tenant_per_day, global_per_hour")
    .eq("id", true)
    .maybeSingle();
  return (data as Config | null) ?? null;
}

async function availability(admin: SupabaseClient, cfg: Config | null): Promise<{ available: boolean; reason: string | null }> {
  if (!cfg) return { available: false, reason: "disabled" };
  if (!cfg.enabled) return { available: false, reason: "disabled" };
  const { data: ready } = await admin.rpc("arca_platform_ready", { p_env: cfg.environment });
  if (!ready) return { available: false, reason: "certificate_missing" };
  return { available: true, reason: null };
}

/** Llama a ARCA con el certificado de la plataforma. No toca la cache. */
async function askArca(admin: SupabaseClient, env: ArcaEnv, cuit: string): Promise<
  | { ok: true; result: PadronResult }
  | { ok: false; error: string; code: string; message: string; transient: boolean }
> {
  const auth = await platformAuth(admin, env, PADRON_SERVICE, fetcher);
  if (!auth.ok) {
    console.error(JSON.stringify({ fn: "arca_padron", step: "wsaa", code: auth.code }));
    return {
      ok: false,
      error: auth.code === "platform_not_configured" ? "not_configured" : "arca_auth_failed",
      code: auth.code,
      message: auth.message,
      transient: auth.transient,
    };
  }
  const r = await postSoap(
    fetcher,
    padronEndpointFor(env, Deno.env.toObject()),
    buildGetPersonaV2({ token: auth.token, sign: auth.sign, cuitRepresentada: auth.cuit }, cuit),
    "",
    15_000,
  );
  if (r.transport) {
    return { ok: false, error: "padron_error", code: r.error ?? "sin_respuesta", message: "El padrón de ARCA no respondió", transient: true };
  }
  return { ok: true, result: parsePersonaV2(r.text, cuit) };
}

async function saveCache(admin: SupabaseClient, env: ArcaEnv, cuit: string, result: PadronResult): Promise<string | null> {
  if (result.status === "error") return null;
  const fetched_at = new Date().toISOString();
  await admin.from("arca_padron_cache").upsert(
    {
      cuit,
      environment: env,
      status: result.status,
      result: result.status === "ok" ? result.persona : null,
      message: result.status === "no_encontrado" ? result.message.slice(0, 500) : null,
      fetched_at,
    },
    { onConflict: "cuit,environment" },
  );
  return fetched_at;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const internalHeader = req.headers.get("x-ninja-scope") === "internal";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: {
        Authorization: req.headers.get("Authorization") ?? "",
        ...(internalHeader ? { "x-ninja-scope": "internal" } : {}),
      },
    },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");
  const cfg = await readConfig(admin);

  // --- Staff interno: probar con un CUIT --------------------------------------
  if (action === "internal_test") {
    if (!internalHeader || (user.app_metadata as { is_internal?: boolean } | null)?.is_internal !== true) {
      return json({ error: "forbidden" }, 403);
    }
    const { error: scopeErr } = await userClient.rpc("internal_arca_padron_get");
    if (scopeErr) return json({ error: "forbidden" }, 403);
    const cuit = String(body.cuit ?? "").replace(/\D/g, "");
    if (!cuitIsValid(cuit)) return json({ ok: false, error: "invalid_cuit" }, 400);
    if (!cfg) return json({ ok: false, error: "not_configured", reason: "disabled" });
    // La prueba no exige "encendido": sirve para probar antes de prender.
    const { data: ready } = await admin.rpc("arca_platform_ready", { p_env: cfg.environment });
    if (!ready) {
      await admin.rpc("arca_padron_test_record", { p_user: user.id, p_cuit: cuit, p_ok: false, p_message: "Falta el certificado de la plataforma en este ambiente" });
      return json({ ok: false, error: "not_configured", reason: "certificate_missing" });
    }
    const r = await askArca(admin, cfg.environment, cuit);
    if (!r.ok) {
      await admin.rpc("arca_padron_test_record", { p_user: user.id, p_cuit: cuit, p_ok: false, p_message: `${r.code}: ${r.message}` });
      return json({ ok: false, error: r.error, code: r.code, message: r.message, transient: r.transient });
    }
    const fetchedAt = await saveCache(admin, cfg.environment, cuit, r.result);
    const okTest = r.result.status !== "error";
    await admin.rpc("arca_padron_test_record", {
      p_user: user.id,
      p_cuit: cuit,
      p_ok: okTest,
      p_message:
        r.result.status === "ok"
          ? `OK: ${r.result.persona.razon_social}`
          : r.result.status === "no_encontrado"
            ? `Conexión OK, CUIT no encontrada: ${r.result.message}`
            : `${r.result.code}: ${r.result.message}`,
    });
    if (r.result.status === "error") return json({ ok: false, error: "padron_error", code: r.result.code, message: r.result.message });
    return json({
      ok: true,
      status: r.result.status,
      persona: r.result.status === "ok" ? r.result.persona : null,
      message: r.result.status === "no_encontrado" ? r.result.message : null,
      fetched_at: fetchedAt,
      environment: cfg.environment,
    });
  }

  // --- Usuario de un negocio ----------------------------------------------------
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);
  const { data: guard, error: guardErr } = await admin.rpc("arca_padron_guard", { p_tenant: tenantId, p_user: user.id });
  if (guardErr) return json({ error: "guard_failed" }, 500);
  if (guard === "forbidden") return json({ ok: false, error: "forbidden" }, 403);

  if (action === "status") {
    if (guard === "feature_not_in_plan") {
      return json({ ok: true, available: false, reason: "feature_not_in_plan", environment: cfg?.environment ?? null, cache_days: cfg?.cache_days ?? null });
    }
    const a = await availability(admin, cfg);
    return json({ ok: true, ...a, environment: cfg?.environment ?? null, cache_days: cfg?.cache_days ?? null });
  }
  if (action !== "lookup") return json({ error: "unknown_action" }, 400);
  if (guard === "feature_not_in_plan") return json({ ok: false, error: "feature_not_in_plan" }, 403);

  const cuit = String(body.cuit ?? "").replace(/\D/g, "");
  if (!cuitIsValid(cuit)) return json({ ok: false, error: "invalid_cuit" }, 400);

  const avail = await availability(admin, cfg);
  if (!avail.available || !cfg) return json({ ok: false, error: "not_configured", reason: avail.reason });
  const env = cfg.environment;

  const log = (row: { source: "arca" | "cache"; status: "ok" | "no_encontrado" | "error"; error_code?: string | null }) =>
    admin.from("arca_padron_lookups").insert({
      tenant_id: tenantId,
      user_id: user.id,
      cuit,
      environment: env,
      source: row.source,
      status: row.status,
      error_code: row.error_code ? row.error_code.slice(0, 80) : null,
    });

  // Cache compartida (los días de la config). "Volver a consultar" la saltea.
  if (body.refresh !== true) {
    const { data: hit } = await admin
      .from("arca_padron_cache")
      .select("status, result, message, fetched_at")
      .eq("cuit", cuit)
      .eq("environment", env)
      .maybeSingle();
    const h = hit as { status: "ok" | "no_encontrado"; result: unknown; message: string | null; fetched_at: string } | null;
    if (h && isFresh(h.fetched_at, new Date(), cfg.cache_days)) {
      await log({ source: "cache", status: h.status });
      return json({ ok: true, cached: true, status: h.status, persona: h.result, message: h.message, fetched_at: h.fetched_at, environment: env });
    }
  }

  // Rate limit (sólo lo que llega a ARCA).
  const { data: usage } = await admin.rpc("arca_padron_usage", { p_tenant: tenantId });
  const u = (usage ?? {}) as { tenant_hour?: number; tenant_day?: number; global_hour?: number };
  const limited = quotaExceeded(
    { tenant_hour: Number(u.tenant_hour ?? 0), tenant_day: Number(u.tenant_day ?? 0), global_hour: Number(u.global_hour ?? 0) },
    cfg,
  );
  if (limited) return json({ ok: false, error: "rate_limited", scope: limited }, 429);

  const r = await askArca(admin, env, cuit);
  if (!r.ok) {
    await log({ source: "arca", status: "error", error_code: r.code });
    return json({ ok: false, error: r.error, code: r.code, message: r.message, transient: r.transient });
  }
  const fetchedAt = await saveCache(admin, env, cuit, r.result);
  if (r.result.status === "error") {
    await log({ source: "arca", status: "error", error_code: r.result.code });
    return json({ ok: false, error: "padron_error", code: r.result.code, message: r.result.message, transient: false });
  }
  await log({ source: "arca", status: r.result.status });
  if (r.result.status === "no_encontrado") {
    return json({ ok: true, cached: false, status: "no_encontrado", persona: null, message: r.result.message, fetched_at: fetchedAt, environment: env });
  }
  return json({ ok: true, cached: false, status: "ok", persona: r.result.persona, fetched_at: fetchedAt, environment: env });
});
