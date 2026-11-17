// =============================================================================
// _shared/mpAuth.ts — credencial Mercado Pago del tenant para las Edge de cobro
// (mp_qr, mp_point, mp_create_qr, mp_webhook, mp_orders_webhook).
//
// * Producción: payment_secrets(mercadopago).access_token (OAuth con refresh
//   automático si está por vencer, o token manual tal cual).
// * Prueba (ADR-032): payment_secrets(mercadopago).test_access_token, usado
//   sólo con el switch Sandbox del medio activado (tenant_payment_methods
//   .sandbox de la fila mercadopago; Point comparte la conexión y el switch).
// * PAY-27 (ADR-188): `strict` (sólo mp_webhook / mp_orders_webhook) hace que
//   un error de base o un refresh OAuth fallido con el token YA vencido lancen
//   (el webhook responde 503 y MP reintenta) en vez de devolver null o el
//   token vencido. `refreshTimeoutMs` corta el POST /oauth/token. Sin esas
//   opciones el comportamiento es el de siempre (mp_qr, mp_point, etc.).
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { type MpEnv, pickMpCredential } from "./mpOrders.ts";
import { loadProviderSecret, SecretLoadError, updateSecretRow } from "./paymentSecrets.ts";

export const MP_API = "https://api.mercadopago.com";

type Secrets = {
  access_token?: string;
  test_access_token?: string;
  refresh_token?: string | null;
  expires_at?: string | null;
  via?: string;
};

type RowRef = { rowId: string | null; tenantId: string; storeId: string | null };

export type MpCredentialOpts = {
  storeId?: string | null;
  scopeStoreId?: string | null;
  /** PAY-27: errores de base / refresh fallido con token vencido lanzan. */
  strict?: boolean;
  /** PAY-27: timeout del POST /oauth/token (sin valor: sin timeout, como antes). */
  refreshTimeoutMs?: number;
};

/** Refresh OAuth que no se pudo hacer con el token ya vencido (modo estricto). */
export class MpRefreshError extends Error {
  constructor(detail: string) {
    super(`refresh OAuth de Mercado Pago falló con el token vencido: ${detail}`);
    this.name = "MpRefreshError";
  }
}

async function refreshIfNeeded(
  admin: SupabaseClient,
  ref: RowRef,
  sec: Secrets,
  opts: { strict?: boolean; refreshTimeoutMs?: number } = {},
): Promise<Secrets> {
  const aboutToExpire =
    sec.expires_at && Date.parse(sec.expires_at) - Date.now() < 5 * 60 * 1000;
  if (!(sec.via === "oauth" && sec.refresh_token && aboutToExpire)) return sec;
  // Estricto: si el refresh no sale y el token todavía sirve (vence en < 5
  // min), se usa igual; sólo se lanza si ya venció.
  const expired = () => Date.parse(sec.expires_at!) <= Date.now();
  const giveUp = (detail: string): Secrets => {
    if (opts.strict && expired()) throw new MpRefreshError(detail);
    return sec;
  };

  const { data: plat, error: platErr } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  if (platErr && opts.strict) throw new SecretLoadError("platform_secrets", platErr);
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
    signal: opts.refreshTimeoutMs ? AbortSignal.timeout(opts.refreshTimeoutMs) : undefined,
  });
  if (!r.ok) return giveUp(`HTTP ${r.status}`);
  const t = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.access_token) return giveUp("respuesta sin access_token");
  const updated: Secrets = {
    ...sec,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? sec.refresh_token,
    expires_at: t.expires_in
      ? new Date(Date.now() + t.expires_in * 1000).toISOString()
      : sec.expires_at,
  };
  // Se reescribe la MISMA fila usada (negocio o sucursal, ADR-057).
  const saved = await updateSecretRow(
    admin,
    { rowId: ref.rowId, tenantId: ref.tenantId, providerKey: "mercadopago", storeId: ref.storeId },
    updated as Record<string, unknown>,
  );
  if (saved.error) {
    // PAY-27: no se lanza ni en modo estricto. MP ya rotó el refresh_token y
    // el access_token nuevo está en memoria: usarlo acredita este pago; un 503
    // haría que el reintento refresque con el refresh_token viejo (ya
    // inválido) y el pago no se acreditaría nunca por webhook.
    console.error(JSON.stringify({
      evt: "mp_oauth_refresh_save_failed",
      tenant: ref.tenantId,
      store: ref.storeId,
      error: String((saved.error as { message?: string }).message ?? saved.error).slice(0, 200),
    }));
  }
  return updated;
}

/**
 * Token MP del tenant. Sin `forceEnv` decide el ambiente por el switch
 * Sandbox; con `forceEnv` usa el del intent (status / webhook / cancel).
 *
 * ADR-057: `opts.storeId` resuelve la credencial de la sucursal (si tiene una
 * propia) antes que la del negocio; `opts.scopeStoreId` (lo registrado en el
 * intent, incluso null) usa ESA credencial exacta. Devuelve además el alcance
 * usado (scopeStoreId) para guardarlo en el intent.
 */
export async function tenantMpCredential(
  admin: SupabaseClient,
  tenantId: string,
  forceEnv?: MpEnv | null,
  opts: MpCredentialOpts = {},
): Promise<{ token: string; env: MpEnv; scopeStoreId: string | null; oauth: boolean } | null> {
  const { strict, refreshTimeoutMs, ...scope } = opts;
  // Secreto y switch Sandbox en paralelo (antes eran dos rondas seguidas).
  const [loaded, methodRes] = await Promise.all([
    loadProviderSecret(admin, tenantId, "mercadopago", { ...scope, strict }),
    forceEnv
      ? Promise.resolve({ data: null })
      : admin
          .from("tenant_payment_methods")
          .select("sandbox")
          .eq("tenant_id", tenantId)
          .eq("provider_key", "mercadopago")
          .maybeSingle(),
  ]);
  const methodErr = (methodRes as { error?: unknown }).error;
  if (strict && methodErr) throw new SecretLoadError("tenant_payment_methods", methodErr);
  let sec = (loaded?.secrets ?? {}) as Secrets;
  const scopeStoreId = loaded?.scopeStoreId ?? null;
  const sandbox = !forceEnv && (methodRes.data as { sandbox?: boolean } | null)?.sandbox === true;

  const pick = pickMpCredential(sec, sandbox, forceEnv ?? null);
  if (pick?.env === "prod") {
    sec = await refreshIfNeeded(admin, { rowId: loaded?.rowId ?? null, tenantId, storeId: scopeStoreId }, sec, {
      strict,
      refreshTimeoutMs,
    });
    return sec.access_token
      ? { token: sec.access_token, env: "prod", scopeStoreId, oauth: sec.via === "oauth" }
      : null;
  }
  return pick ? { ...pick, scopeStoreId, oauth: false } : null;
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
