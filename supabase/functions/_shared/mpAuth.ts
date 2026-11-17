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
// * PAY-28 (ADR-191): si el refresh sale bien pero no se puede guardar el
//   token rotado, se reintenta el guardado 2 veces (backoff corto) y, si sigue
//   fallando, queda un rastro en audit_logs (`mp_oauth_refresh_save_failed`,
//   sin tokens) para que staff reconecte. Vale para TODOS los llamadores y no
//   cambia el valor devuelto. `forceRefresh` (sólo los webhooks, ante un 401
//   de MP con credencial OAuth) refresca aunque `expires_at` diga vigente,
//   pero antes relee la fila: si otra Edge ya rotó el token (cambió
//   refresh_token / expires_at) usa el guardado sin refrescar, y si la fila se
//   rotó / actualizó hace menos de 60 s no fuerza (cooldown): un 401
//   persistente (cuenta equivocada, permisos) no rota el refresh_token en
//   cada reintento de MP.
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
  /** PAY-28: cuándo se rotó el token por última vez (cooldown del refresh forzado). */
  refreshed_at?: string;
};

type RowRef = { rowId: string | null; tenantId: string; storeId: string | null };

export type MpCredentialOpts = {
  storeId?: string | null;
  scopeStoreId?: string | null;
  /** PAY-27: errores de base / refresh fallido con token vencido lanzan. */
  strict?: boolean;
  /** PAY-27: timeout del POST /oauth/token (sin valor: sin timeout, como antes). */
  refreshTimeoutMs?: number;
  /** PAY-28: refrescar aunque `expires_at` diga vigente (401 de MP con OAuth). */
  forceRefresh?: boolean;
  /**
   * PAY-28: token que recibió el 401. Si el guardado ya es otro (otra Edge
   * rotó), se usa ése sin refrescar.
   */
  staleToken?: string;
};

/**
 * PAY-28: esperas entre los reintentos del guardado del token rotado (2
 * reintentos: 3 intentos en total). Cortas: corren dentro del tope de la
 * credencial de los webhooks (6 s) o, si se pasa, en wh.defer.
 */
export const MP_TOKEN_SAVE_BACKOFF_MS = [150, 400] as const;

/** PAY-28: no se fuerza un refresh si la fila se rotó / actualizó hace menos de esto. */
export const MP_FORCED_REFRESH_COOLDOWN_MS = 60_000;

/**
 * PAY-28: relee la fila de la credencial antes de un refresh forzado.
 * Devuelve los secretos a usar sin refrescar (otra Edge ya rotó el token, o
 * cooldown), o null si corresponde refrescar. Ante un error de lectura no
 * fuerza (devuelve los secretos cargados): rotar a ciegas es peor.
 */
async function forcedRefreshGate(
  admin: SupabaseClient,
  ref: RowRef,
  sec: Secrets,
  staleToken: string | undefined,
): Promise<Secrets | null> {
  // El token cargado ya no es el que dio 401: otra Edge rotó antes de esta carga.
  if (staleToken && sec.access_token && sec.access_token !== staleToken) return sec;
  let q = admin.from("payment_secrets").select("secrets, updated_at");
  if (ref.rowId) {
    q = q.eq("id", ref.rowId);
  } else {
    q = q.eq("tenant_id", ref.tenantId).eq("provider_key", "mercadopago");
    q = ref.storeId ? q.eq("store_id", ref.storeId) : q.is("store_id", null);
  }
  const { data, error } = await q.maybeSingle();
  if (error || !data) return sec;
  const row = data as { secrets?: Secrets | null; updated_at?: string | null };
  const fresh = (row.secrets ?? {}) as Secrets;
  if (fresh.refresh_token !== sec.refresh_token || fresh.expires_at !== sec.expires_at) {
    // Otra Edge ya rotó: usar lo guardado (sólo si trae un access_token).
    return fresh.access_token ? { ...sec, ...fresh } : sec;
  }
  const last = Math.max(
    Date.parse(fresh.refreshed_at ?? "") || 0,
    Date.parse(row.updated_at ?? "") || 0,
  );
  if (Date.now() - last < MP_FORCED_REFRESH_COOLDOWN_MS) return sec;
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errText = (e: unknown) =>
  String((e as { message?: string } | null)?.message ?? e).slice(0, 200);

/**
 * PAY-28: guarda el token rotado con reintentos. Si no sale, deja el rastro
 * operable en audit_logs (sin tokens: sólo negocio, fila, sucursal, intentos y
 * el error) y lo loguea. Nunca lanza: el token nuevo ya está en memoria.
 */
async function saveRotatedToken(admin: SupabaseClient, ref: RowRef, updated: Secrets): Promise<void> {
  const target = { rowId: ref.rowId, tenantId: ref.tenantId, providerKey: "mercadopago", storeId: ref.storeId };
  let lastErr: unknown = null;
  const attempts = MP_TOKEN_SAVE_BACKOFF_MS.length + 1;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(MP_TOKEN_SAVE_BACKOFF_MS[i - 1] ?? 0);
    let error: unknown;
    try {
      ({ error } = await updateSecretRow(admin, target, updated as Record<string, unknown>));
    } catch (e) {
      error = e;
    }
    if (!error) return;
    lastErr = error;
  }
  // PAY-27: no se lanza ni en modo estricto. MP ya rotó el refresh_token y el
  // access_token nuevo está en memoria: usarlo acredita este pago; un 503
  // haría que el reintento refresque con el refresh_token viejo (ya inválido).
  console.error(JSON.stringify({
    evt: "mp_oauth_refresh_save_failed",
    tenant: ref.tenantId,
    store: ref.storeId,
    attempts,
    error: errText(lastErr),
  }));
  try {
    const { error: auditErr } = await admin.from("audit_logs").insert({
      tenant_id: ref.tenantId,
      actor_user_id: null,
      entity_type: "payment_secrets",
      entity_id: ref.rowId,
      action: "mp_oauth_refresh_save_failed",
      after_data: {
        provider_key: "mercadopago",
        store_id: ref.storeId,
        attempts,
        error: errText(lastErr),
        hint: "reconectar Mercado Pago (el refresh_token guardado ya no sirve)",
      },
    });
    if (auditErr) throw auditErr;
  } catch (e) {
    console.error(JSON.stringify({ evt: "mp_oauth_refresh_save_failed_audit_error", tenant: ref.tenantId, error: errText(e) }));
  }
}

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
  opts: { strict?: boolean; refreshTimeoutMs?: number; forceRefresh?: boolean; staleToken?: string } = {},
): Promise<Secrets> {
  const aboutToExpire =
    sec.expires_at && Date.parse(sec.expires_at) - Date.now() < 5 * 60 * 1000;
  if (!(sec.via === "oauth" && sec.refresh_token && (aboutToExpire || opts.forceRefresh))) return sec;
  // Estricto: si el refresh no sale y el token todavía sirve (vence en < 5
  // min, o se forzó con el token vigente), se usa igual; sólo se lanza si ya
  // venció.
  const expired = () => !!sec.expires_at && Date.parse(sec.expires_at) <= Date.now();
  const giveUp = (detail: string): Secrets => {
    if (opts.strict && expired()) throw new MpRefreshError(detail);
    return sec;
  };
  // PAY-28: refresh forzado con el token todavía vigente → releer la fila.
  if (opts.forceRefresh && !aboutToExpire) {
    const skip = await forcedRefreshGate(admin, ref, sec, opts.staleToken);
    if (skip) return skip;
  }

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
    refreshed_at: new Date().toISOString(),
  };
  // Se reescribe la MISMA fila usada (negocio o sucursal, ADR-057), con
  // reintentos y rastro en audit_logs si no sale (PAY-28).
  await saveRotatedToken(admin, ref, updated);
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
  const { strict, refreshTimeoutMs, forceRefresh, staleToken, ...scope } = opts;
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
      forceRefresh,
      staleToken,
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
