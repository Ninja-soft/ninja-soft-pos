// =============================================================================
// set_platform_secret · app de Mercado Libre (ADR-126).
//
// Estado (sin el secreto), "Probar conexión" y resumen de uso para la sección
// interna Mercado Libre. Corre con service_role dentro de la Edge; el secreto
// se usa sólo para hablar con /oauth/token y nunca se devuelve ni se loguea.
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  ML_API,
  classifyMlTokenProbe,
  missingPlatformFields,
  resolveMlConfig,
  type MlEnv,
  type MlPlatformSecrets,
} from "../_shared/mercadolibre/config.ts";

const TIMEOUT = 8_000;

/** Lo que la pantalla necesita saber de la config, sin valores secretos. */
export function mlAppStatusExtras(db: MlPlatformSecrets, env: MlEnv) {
  const eff = resolveMlConfig({ db, env });
  const envId = (env.ML_CLIENT_ID ?? "").trim();
  return {
    missing: missingPlatformFields(db),
    origin: eff.ok ? eff.origin : null,
    effective: eff.ok ? { client_id: eff.config.clientId, redirect_uri: eff.config.redirectUri } : null,
    env: {
      client_id: envId || null, // el App ID es público (va en la URL de autorización)
      client_secret: Boolean((env.ML_CLIENT_SECRET ?? "").trim()),
      redirect_uri: (env.ML_REDIRECT_URI ?? "").trim() || null,
    },
  };
}

/** Cuentas conectadas y últimas notificaciones (todas las de la plataforma). */
export async function mlAppStats(admin: SupabaseClient) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [accounts, last, day, dayErr] = await Promise.all([
    admin.from("ml_accounts").select("tenant_id, status").is("deleted_at", null).limit(10_000),
    admin
      .from("ml_notifications")
      .select("topic, status, source, received_at")
      .order("received_at", { ascending: false })
      .limit(8),
    admin.from("ml_notifications").select("id", { count: "exact", head: true }).gte("received_at", since),
    admin
      .from("ml_notifications")
      .select("id", { count: "exact", head: true })
      .gte("received_at", since)
      .in("status", ["error", "dead"]),
  ]);
  if (accounts.error) return null;
  const rows = (accounts.data ?? []) as { tenant_id: string; status: string }[];
  const active = rows.filter((r) => r.status === "active");
  return {
    tenants_connected: new Set(active.map((r) => r.tenant_id)).size,
    accounts_active: active.length,
    accounts_reauth: rows.filter((r) => r.status === "reauth_required").length,
    notifications_24h: day.count ?? 0,
    notifications_errors_24h: dayErr.count ?? 0,
    last_notifications: (last.data ?? []) as { topic: string; status: string; source: string; received_at: string }[],
  };
}

async function tokenCall(params: Record<string, string>) {
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

/**
 * Valida App ID + secreto sin tocar cuentas de clientes:
 *  1. client_credentials: si ML lo acepta, con ese token de app se lee
 *     GET /applications/{id} (nombre, redirect y URL de notificaciones).
 *  2. Si no, refresh_token inventado: invalid_grant = par correcto,
 *     invalid_client = par incorrecto.
 */
export async function testMlApp(db: MlPlatformSecrets, env: MlEnv): Promise<Record<string, unknown>> {
  const eff = resolveMlConfig({ db, env });
  if (!eff.ok) return { ok: false, error: "not_configured" };
  const { clientId, clientSecret } = eff.config;
  const base = { origin: eff.origin, client_id: clientId };
  try {
    const cc = await tokenCall({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const v1 = classifyMlTokenProbe(cc.status, cc.body);
    if (v1 === "invalid_credentials") return { ...base, ok: false, error: "invalid_credentials" };
    const appToken = (cc.body as { access_token?: unknown } | null)?.access_token;
    if (v1 === "valid" && typeof appToken === "string") {
      let app: Record<string, unknown> | null = null;
      try {
        const r = await fetch(`${ML_API}/applications/${encodeURIComponent(clientId)}`, {
          headers: { Authorization: `Bearer ${appToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (r.ok) {
          const a = (await r.json()) as Record<string, unknown>;
          app = {
            id: a.id ?? null,
            name: typeof a.name === "string" ? a.name : null,
            site_id: typeof a.site_id === "string" ? a.site_id : null,
            redirect_uri: typeof a.callback_url === "string" ? a.callback_url : null,
            notifications_url: typeof a.notifications_callback_url === "string" ? a.notifications_callback_url : null,
            topics: Array.isArray(a.notifications_topics) ? (a.notifications_topics as unknown[]).map(String).slice(0, 40) : null,
          };
        }
      } catch {
        app = null;
      }
      return { ...base, ok: true, method: "client_credentials", app };
    }
    const rt = await tokenCall({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: "TG-000000000000000000000000-0",
    });
    const v2 = classifyMlTokenProbe(rt.status, rt.body);
    if (v2 === "valid") return { ...base, ok: true, method: "token_probe", app: null };
    if (v2 === "invalid_credentials") return { ...base, ok: false, error: "invalid_credentials" };
    return { ...base, ok: false, error: `ml_http_${rt.status}` };
  } catch {
    return { ...base, ok: false, error: "ml_unreachable" };
  }
}
