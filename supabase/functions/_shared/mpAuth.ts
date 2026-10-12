// =============================================================================
// _shared/mpAuth.ts — credencial Mercado Pago del tenant para las Edge de cobro
// (mp_qr, mp_point, mp_create_qr, mp_webhook, mp_orders_webhook).
//
// * Producción: payment_secrets(mercadopago).access_token (OAuth con refresh
//   automático si está por vencer, o token manual tal cual).
// * Prueba (ADR-032): payment_secrets(mercadopago).test_access_token, usado
//   sólo con el switch Sandbox del medio activado (tenant_payment_methods
//   .sandbox de la fila mercadopago; Point comparte la conexión y el switch).
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { type MpEnv, pickMpCredential } from "./mpOrders.ts";

export const MP_API = "https://api.mercadopago.com";

type Secrets = {
  access_token?: string;
  test_access_token?: string;
  refresh_token?: string | null;
  expires_at?: string | null;
  via?: string;
};

async function refreshIfNeeded(
  admin: SupabaseClient,
  tenantId: string,
  sec: Secrets,
): Promise<Secrets> {
  const aboutToExpire =
    sec.expires_at && Date.parse(sec.expires_at) - Date.now() < 5 * 60 * 1000;
  if (!(sec.via === "oauth" && sec.refresh_token && aboutToExpire)) return sec;

  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const ps = (plat?.secrets ?? {}) as { client_id?: string; client_secret?: string };
  if (!ps.client_id || !ps.client_secret) return sec;

  const r = await fetch(`${MP_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: ps.client_id,
      client_secret: ps.client_secret,
      grant_type: "refresh_token",
      refresh_token: sec.refresh_token,
    }),
  });
  if (!r.ok) return sec;
  const t = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.access_token) return sec;
  const updated: Secrets = {
    ...sec,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? sec.refresh_token,
    expires_at: t.expires_in
      ? new Date(Date.now() + t.expires_in * 1000).toISOString()
      : sec.expires_at,
  };
  await admin
    .from("payment_secrets")
    .update({ secrets: updated })
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago");
  return updated;
}

/**
 * Token MP del tenant. Sin `forceEnv` decide el ambiente por el switch
 * Sandbox; con `forceEnv` usa el del intent (status / webhook / cancel).
 */
export async function tenantMpCredential(
  admin: SupabaseClient,
  tenantId: string,
  forceEnv?: MpEnv | null,
): Promise<{ token: string; env: MpEnv } | null> {
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago")
    .maybeSingle();
  let sec = (secretRow?.secrets ?? {}) as Secrets;

  let sandbox = false;
  if (!forceEnv) {
    const { data: method } = await admin
      .from("tenant_payment_methods")
      .select("sandbox")
      .eq("tenant_id", tenantId)
      .eq("provider_key", "mercadopago")
      .maybeSingle();
    sandbox = method?.sandbox === true;
  }

  const pick = pickMpCredential(sec, sandbox, forceEnv ?? null);
  if (pick?.env === "prod") {
    sec = await refreshIfNeeded(admin, tenantId, sec);
    return sec.access_token ? { token: sec.access_token, env: "prod" } : null;
  }
  return pick;
}

/** Headers estándar de la Orders API (idempotencia obligatoria en POST). */
export function mpHeaders(token: string, idempotencyKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) h["X-Idempotency-Key"] = idempotencyKey;
  return h;
}

/** Corre `work` después de responder si el runtime lo permite (webhooks). */
export function runInBackground(work: Promise<unknown>): Promise<unknown> | null {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(work.catch(() => null));
    return null;
  }
  return work.catch(() => null);
}
