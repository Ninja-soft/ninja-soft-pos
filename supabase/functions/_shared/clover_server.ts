// =============================================================================
// Clover (Fiserv): helpers server-side (Deno) compartidos por `clover_point` y
// `clover_webhook` (ADR-047). Cargan la conexión Fiserv del tenant
// (payment_secrets provider 'fiserv'), hablan con Cloud Pay Display con el
// token del comercio (renovándolo si es un token v2/OAuth con refresh) y
// aplican el resultado VERIFICADO de un pago sobre el intent local
// (mp_payment_intents, provider_key 'fiserv_point') de forma idempotente y
// auditada. La lógica pura vive en ./clover.ts.
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  allowedDevices,
  cardKindOf,
  cloverApiBase,
  cloverConnectBase,
  cloverEnv,
  cloverEnvFromIntent,
  cloverHeaders,
  cloverRefreshUrl,
  evaluateCloverPayment,
  externalPaymentIdOf,
  isSafeCloverId,
  parseCloverDevices,
  parseDeviceSerials,
  type CloverDevice,
  type CloverEnv,
  type CloverEvaluation,
} from "./clover.ts";

// deno-lint-ignore no-explicit-any
export type Admin = SupabaseClient<any, "public", any>;

export const PROVIDER = "fiserv_point";
export const CONNECTION = "fiserv";

export type CloverSecrets = {
  merchant_id?: string;
  access_token?: string;
  refresh_token?: string;
  device_serials?: string;
};

export type CloverConnection = {
  tenantId: string;
  env: CloverEnv;
  merchantId: string;
  configured: CloverDevice[];
  // Llamada autenticada con reintento único ante 401 (refresh si se puede).
  request: (url: string, init?: { method?: string; deviceId?: string | null; idempotencyKey?: string | null; body?: unknown; signal?: AbortSignal }) => Promise<Response>;
};

// Conexión Fiserv del tenant. Ambiente: tenant_payment_methods.sandbox de la
// fila 'fiserv'. `envOverride` permite consultar en el ambiente del intent.
export async function loadCloverConnection(
  admin: Admin,
  tenantId: string,
  envOverride?: CloverEnv,
): Promise<CloverConnection | null> {
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", CONNECTION)
    .maybeSingle();
  const sec = ((secretRow as { secrets?: unknown } | null)?.secrets ?? {}) as CloverSecrets;
  if (!isSafeCloverId(sec.merchant_id) || !sec.access_token) return null;

  let env = envOverride;
  if (!env) {
    const { data: methodRow } = await admin
      .from("tenant_payment_methods")
      .select("sandbox")
      .eq("tenant_id", tenantId)
      .eq("provider_key", CONNECTION)
      .maybeSingle();
    env = cloverEnv((methodRow as { sandbox?: boolean } | null)?.sandbox);
  }
  const theEnv = env;

  let token = sec.access_token;
  let refreshed = false;

  // Renueva el par de tokens v2/OAuth (sólo si hay refresh_token y la app de
  // NinjaSoft está configurada: secret de función CLOVER_APP_ID).
  const refresh = async (): Promise<boolean> => {
    const clientId = Deno.env.get("CLOVER_APP_ID");
    if (refreshed || !sec.refresh_token || !clientId) return false;
    refreshed = true;
    const r = await fetch(cloverRefreshUrl(theEnv), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, refresh_token: sec.refresh_token }),
    }).catch(() => null);
    if (!r?.ok) return false;
    const j = (await r.json().catch(() => null)) as { access_token?: string; refresh_token?: string } | null;
    if (!j?.access_token) return false;
    token = j.access_token;
    const next = { ...sec, access_token: j.access_token, refresh_token: j.refresh_token ?? sec.refresh_token };
    await admin
      .from("payment_secrets")
      .update({ secrets: next })
      .eq("tenant_id", tenantId)
      .eq("provider_key", CONNECTION)
      .then(() => null, () => null);
    return true;
  };

  const request: CloverConnection["request"] = async (url, init = {}) => {
    const send = () =>
      fetch(url, {
        method: init.method ?? "GET",
        headers: cloverHeaders({ token, deviceId: init.deviceId, idempotencyKey: init.idempotencyKey }),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
    const r = await send();
    if (r.status === 401 && (await refresh())) return send();
    return r;
  };

  return {
    tenantId,
    env: theEnv,
    merchantId: sec.merchant_id,
    configured: parseDeviceSerials(sec.device_serials),
    request,
  };
}

// Terminales del comercio: las de Clover (GET devices), acotadas a las que el
// dueño cargó a mano si cargó alguna. Si Clover no responde, quedan las
// cargadas a mano.
export async function listDevices(conn: CloverConnection): Promise<{ devices: CloverDevice[]; apiOk: boolean }> {
  try {
    const r = await conn.request(`${cloverApiBase(conn.env)}/v3/merchants/${conn.merchantId}/devices`);
    if (!r.ok) return { devices: conn.configured, apiOk: false };
    return { devices: allowedDevices(conn.configured, parseCloverDevices(await r.json())), apiOk: true };
  } catch {
    return { devices: conn.configured, apiOk: false };
  }
}

export type IntentRow = {
  id: string;
  tenant_id: string;
  provider_key: string;
  status: string;
  amount: number | string;
  point_device_id: string | null;
  mp_payment_id: string | null;
  mp_env: string | null;
};
export const INTENT_COLS = "id, tenant_id, provider_key, status, amount, point_device_id, mp_payment_id, mp_env";

export async function audit(
  admin: Admin,
  row: { id: string; tenant_id: string },
  action: string,
  after: Record<string, unknown>,
  actor: string | null = null,
  reason: string | null = null,
) {
  // Best-effort: la auditoría no debe tumbar la confirmación de un pago.
  await admin
    .from("audit_logs")
    .insert({
      tenant_id: row.tenant_id,
      actor_user_id: actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action,
      reason,
      after_data: after,
    })
    .then(() => null, () => null);
}

// Aplica una evaluación YA verificada contra Clover. Idempotente: cada
// transición es condicional al estado actual (poll, webhook y la respuesta del
// POST no duplican efectos). Devuelve el estado local resultante.
export async function applyEvaluation(
  admin: Admin,
  row: IntentRow,
  ev: CloverEvaluation,
  source: "pay" | "status" | "webhook" | "cancel",
): Promise<string> {
  const info = {
    provider_key: row.provider_key,
    clover_payment_id: ev.paymentId,
    clover_result: ev.result,
    amount: Number(row.amount),
    paid_cents: ev.amountCents,
    tip_cents: ev.tipCents,
    device: row.point_device_id,
    reason: ev.reason,
    source,
  };

  if (ev.outcome === "approved") {
    // Un cobro verificado SIEMPRE queda approved, aunque el intent se haya
    // cancelado antes (plata cobrada): aparece en la conciliación de cobros.
    const { data } = await admin
      .from("mp_payment_intents")
      .update({ status: "approved", mp_payment_id: ev.paymentId })
      .eq("id", row.id)
      .neq("status", "approved")
      .select("id");
    if ((data as unknown[] | null)?.length) {
      await audit(
        admin,
        row,
        "clover_payment_approved",
        { ...info, previous_status: row.status },
        null,
        row.status === "pending" ? null : "approved_after_" + row.status,
      );
    }
    return "approved";
  }

  if (ev.outcome === "pending") {
    if (row.status === "pending" && ev.paymentId && !row.mp_payment_id) {
      await admin
        .from("mp_payment_intents")
        .update({ mp_payment_id: ev.paymentId })
        .eq("id", row.id)
        .eq("status", "pending");
    }
    return row.status;
  }

  // rejected | cancelled | mismatch: sólo desde pending.
  const next = ev.outcome === "cancelled" ? "cancelled" : "rejected";
  if (row.status === "pending") {
    const { data } = await admin
      .from("mp_payment_intents")
      .update({ status: next, mp_payment_id: ev.paymentId ?? row.mp_payment_id })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if ((data as unknown[] | null)?.length || ev.outcome === "mismatch") {
      await audit(admin, row, `clover_payment_${ev.outcome}`, info);
    }
    return next;
  }
  if (ev.outcome === "mismatch") await audit(admin, row, "clover_payment_mismatch", info);
  return row.status;
}

// Cierra un intent pendiente sin pago (error del POST, cancelación, reset).
export async function closePending(
  admin: Admin,
  row: IntentRow,
  status: "rejected" | "cancelled",
  reason: string,
  source: string,
  actor: string | null = null,
): Promise<string> {
  const { data } = await admin
    .from("mp_payment_intents")
    .update({ status })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");
  if ((data as unknown[] | null)?.length) {
    await audit(admin, row, `clover_payment_${status}`, { provider_key: row.provider_key, device: row.point_device_id, reason, source }, actor);
    return status;
  }
  return row.status;
}

export type SyncResult = {
  status: string;
  mp_payment_id: string | null;
  card_type: "debit" | "credit" | null;
  reason?: string | null;
};

// Débito o crédito del pago (best-effort, API de plataforma).
async function cardTypeOf(conn: CloverConnection, paymentId: string | null): Promise<"debit" | "credit" | null> {
  if (!isSafeCloverId(paymentId)) return null;
  try {
    const r = await conn.request(
      `${cloverApiBase(conn.env)}/v3/merchants/${conn.merchantId}/payments/${paymentId}?expand=tender`,
    );
    return r.ok ? cardKindOf(await r.json()) : null;
  } catch {
    return null;
  }
}

// Fuente de verdad: GET /connect/v1/payments/external/{externalPaymentId} en la
// terminal del intent. Lo usan el poll del POS, el webhook y el cancel.
export async function syncIntent(
  admin: Admin,
  conn: CloverConnection,
  row: IntentRow,
  source: "status" | "webhook" | "cancel",
): Promise<SyncResult | { error: string; detail?: string }> {
  if (row.status === "approved") {
    return { status: "approved", mp_payment_id: row.mp_payment_id, card_type: await cardTypeOf(conn, row.mp_payment_id) };
  }
  if (!isSafeCloverId(row.point_device_id)) {
    return { status: row.status, mp_payment_id: row.mp_payment_id, card_type: null };
  }
  const ext = externalPaymentIdOf(row.id);
  const r = await conn.request(`${cloverConnectBase(conn.env)}/v1/payments/external/${ext}`, {
    deviceId: row.point_device_id,
  });
  // 404: la terminal todavía no registró un pago con ese id.
  if (r.status === 404) return { status: row.status, mp_payment_id: row.mp_payment_id, card_type: null };
  if (!r.ok) {
    return { error: r.status === 401 ? "clover_auth_failed" : "clover_error", detail: (await r.text()).slice(0, 300) };
  }
  const ev = evaluateCloverPayment(await r.json().catch(() => null), {
    intentId: row.id,
    amount: Number(row.amount),
  });
  const local = await applyEvaluation(admin, row, ev, source);
  return {
    status: local,
    mp_payment_id: local === "approved" ? ev.paymentId : null,
    card_type: local === "approved" ? await cardTypeOf(conn, ev.paymentId) : null,
    reason: ev.reason,
  };
}

// Conexión en el ambiente en el que se creó el intent.
export function loadConnectionForIntent(admin: Admin, row: IntentRow) {
  return loadCloverConnection(admin, row.tenant_id, cloverEnvFromIntent(row.mp_env));
}
