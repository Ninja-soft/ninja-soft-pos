// =============================================================================
// Edge Function: platform_billing (F20-3 · ADR-110 / ADR-117).
// Spec: docs/40-cobranza-saas.md §8.2 y §13.1. Lógica pura en
// ../_shared/arca/padron.ts (parser y reglas) y ../_shared/arca/wsaa.ts.
//
// Acciones (JWT del usuario; verify_jwt = true):
//   { action: "padron_status" }
//       → { ok, available, reason, environment }
//   { action: "padron_lookup", cuit, tenant_id?, refresh? }
//       Consulta ws_sr_constancia_inscripcion (padrón A5, getPersona_v2) con
//       el certificado de la PLATAFORMA (arca_platform del ambiente activo de
//       platform_issuer_profile). Devuelve razón social, condición frente al
//       IVA y domicilio fiscal y lo graba en platform_fiscal_lookups (cache
//       30 días). El negocio después confirma con owner_set_billing_profile
//       ({ use_padron: true }): la base toma los datos de esa consulta, el
//       cliente nunca declara "verificado".
//
// Quién:
//   · dueño o encargado del negocio actual (lo valida my_billing_profile con
//     el JWT del usuario);
//   · staff interno con el header x-ninja-scope: internal y tenant_id (lo
//     valida internal_billing_profile_get). Sólo el staff puede refresh.
//
// Sin certificado de la plataforma (hoy, §22 #1) responde
// { ok: false, error: "platform_not_configured", reason } SIN llamar a ARCA:
// la UI ofrece la carga manual ("sin verificar").
// Rate limit: 10 consultas por hora por negocio y 300 por hora en total.
// Secretos: ARCA_KEY_ENC descifra la clave de la plataforma; Token y Sign no
// se loguean ni se guardan.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import type { ArcaEnv } from "../_shared/arca/config.ts";
import { postSoap, type FetchLike } from "../_shared/arca/client.ts";
import { platformAuth } from "../_shared/arca/platformAuth.ts";
import {
  buildGetPersonaV2,
  cuitIsValid,
  isFresh,
  PADRON_CACHE_DAYS,
  PADRON_SERVICE,
  padronEndpointFor,
  parsePersonaV2,
  rateLimited,
} from "../_shared/arca/padron.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const fetcher: FetchLike = (url, init) => fetch(url, init);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PadronStatus = { available: boolean; reason: string | null; environment: ArcaEnv | null };

async function padronStatus(admin: SupabaseClient): Promise<PadronStatus> {
  const { data } = await admin.from("platform_issuer_profile").select("environment, padron_enabled").eq("is_active", true).maybeSingle();
  const ip = data as { environment: ArcaEnv; padron_enabled: boolean } | null;
  if (!ip) return { available: false, reason: "issuer_missing", environment: null };
  if (!ip.padron_enabled) return { available: false, reason: "disabled", environment: ip.environment };
  const { data: ready } = await admin.rpc("arca_platform_ready", { p_env: ip.environment });
  if (!ready) return { available: false, reason: "certificate_missing", environment: ip.environment };
  return { available: true, reason: null, environment: ip.environment };
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
  const isStaff = internalHeader && (user.app_metadata as { is_internal?: boolean } | null)?.is_internal === true;

  // Autorización con la base (RLS / RPC con el JWT del usuario).
  let tenantId: string;
  if (isStaff) {
    tenantId = String(body.tenant_id ?? "");
    if (!UUID.test(tenantId)) return json({ error: "invalid_tenant_id" }, 400);
    const { error } = await userClient.rpc("internal_billing_profile_get", { p_tenant: tenantId });
    if (error) return json({ error: "forbidden" }, 403);
  } else {
    const { data, error } = await userClient.rpc("my_billing_profile");
    if (error || !data) return json({ error: "forbidden" }, 403);
    tenantId = String((data as { tenant_id: string }).tenant_id);
  }

  if (action === "padron_status") {
    return json({ ok: true, ...(await padronStatus(admin)) });
  }
  if (action !== "padron_lookup") return json({ error: "unknown_action" }, 400);

  const cuit = String(body.cuit ?? "").replace(/\D/g, "");
  if (!cuitIsValid(cuit)) return json({ ok: false, error: "invalid_cuit" }, 400);

  const st = await padronStatus(admin);
  if (!st.available || !st.environment) {
    return json({ ok: false, error: "platform_not_configured", reason: st.reason });
  }
  const env = st.environment;

  // Cache (30 días). El staff puede forzar "Volver a consultar".
  const refresh = isStaff && body.refresh === true;
  if (!refresh) {
    const since = new Date(Date.now() - PADRON_CACHE_DAYS * 86_400_000).toISOString();
    const { data: hit } = await admin
      .from("platform_fiscal_lookups")
      .select("id, status, result, error, fetched_at")
      .eq("cuit", cuit)
      .eq("environment", env)
      .in("status", ["ok", "no_encontrado"])
      .gte("fetched_at", since)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const h = hit as { id: string; status: string; result: unknown; error: string | null; fetched_at: string } | null;
    if (h && isFresh(h.fetched_at)) {
      return json({ ok: true, cached: true, status: h.status, persona: h.result, message: h.error, fetched_at: h.fetched_at });
    }
  }

  // Rate limit.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [{ count: tenantHour }, { count: globalHour }] = await Promise.all([
    admin.from("platform_fiscal_lookups").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).gte("fetched_at", hourAgo),
    admin.from("platform_fiscal_lookups").select("id", { count: "exact", head: true }).gte("fetched_at", hourAgo),
  ]);
  const limited = rateLimited({ tenantHour: tenantHour ?? 0, globalHour: globalHour ?? 0 });
  if (limited) return json({ ok: false, error: "rate_limited", scope: limited }, 429);

  const auth = await platformAuth(admin, env, PADRON_SERVICE, fetcher);
  if (!auth.ok) {
    console.error(JSON.stringify({ fn: "platform_billing", step: "wsaa", code: auth.code }));
    return json({ ok: false, error: auth.code === "platform_not_configured" ? "platform_not_configured" : "arca_auth_failed", code: auth.code, message: auth.message, transient: auth.transient });
  }

  const r = await postSoap(
    fetcher,
    padronEndpointFor(env, Deno.env.toObject()),
    buildGetPersonaV2({ token: auth.token, sign: auth.sign, cuitRepresentada: auth.cuit }, cuit),
    "",
    15_000,
  );
  const parsed = r.transport
    ? ({ status: "error", code: r.error ?? "sin_respuesta", message: "El padrón de ARCA no respondió" } as const)
    : parsePersonaV2(r.text, cuit);

  const row = {
    cuit,
    environment: env,
    status: parsed.status,
    result: parsed.status === "ok" ? parsed.persona : null,
    error: parsed.status === "ok" ? null : parsed.message.slice(0, 500),
    tenant_id: tenantId,
    requested_by: user.id,
  };
  const { data: saved } = await admin.from("platform_fiscal_lookups").insert(row).select("fetched_at").maybeSingle();

  if (parsed.status === "ok") {
    return json({ ok: true, cached: false, status: "ok", persona: parsed.persona, fetched_at: (saved as { fetched_at: string } | null)?.fetched_at ?? null });
  }
  if (parsed.status === "no_encontrado") return json({ ok: true, cached: false, status: "no_encontrado", message: parsed.message });
  return json({ ok: false, error: "padron_error", code: parsed.code, message: parsed.message, transient: r.transport });
});
