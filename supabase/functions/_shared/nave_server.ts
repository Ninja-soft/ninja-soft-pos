// =============================================================================
// Nave: helpers server-side (Deno) compartidos por `nave`, `nave_point` y
// `nave_webhook`. Cargan la conexión del tenant (payment_secrets provider
// 'nave': la MISMA conexión sirve para QR + link y Point) y aplican el
// resultado verificado de un pago sobre el intent local (mp_payment_intents)
// de forma idempotente, con auditoría. La lógica pura vive en ./nave.ts.
// =============================================================================
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  approvedPaymentIdFromRequest,
  createNaveClient,
  evaluatePayment,
  isSafeNaveId,
  naveApiBase,
  naveEnv,
  parsePointTerminals,
  paymentRequestOutcome,
  type NaveChannel,
  type NaveClient,
  type NaveEnv,
  type PaymentEvaluation,
  type PointTerminal,
} from "./nave.ts";
import { loadProviderSecret } from "./paymentSecrets.ts";

// deno-lint-ignore no-explicit-any
export type Admin = SupabaseClient<any, "public", any>;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

export type NaveConnection = {
  env: NaveEnv;
  client: NaveClient;
  posId: string | null;
  terminals: PointTerminal[];
  /** Sucursal de la credencial usada (null = la del negocio, ADR-057). */
  scopeStoreId: string | null;
};

// Conexión Nave del tenant. Secretos: client_id, client_secret, pos_id (QR +
// link), point_pos_ids (terminales Point, opcional), audience (opcional).
// Ambiente: tenant_payment_methods.sandbox de la fila 'nave'.
// ADR-057: `opts.storeId` usa la conexión propia de la sucursal (pos_id del
// local) si tiene; `opts.scopeStoreId` (del intent) la exacta.
export async function loadNaveConnection(
  admin: Admin,
  tenantId: string,
  opts: { storeId?: string | null; scopeStoreId?: string | null } = {},
): Promise<NaveConnection | null> {
  const loaded = await loadProviderSecret(admin, tenantId, "nave", opts);
  const sec = (loaded?.secrets ?? {}) as {
    client_id?: string;
    client_secret?: string;
    pos_id?: string;
    point_pos_ids?: string;
    audience?: string;
  };
  if (!sec.client_id || !sec.client_secret) return null;
  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "nave")
    .maybeSingle();
  const env = naveEnv((methodRow as { sandbox?: boolean } | null)?.sandbox);
  return {
    env,
    client: createNaveClient({
      env,
      clientId: sec.client_id,
      clientSecret: sec.client_secret,
      audience: sec.audience ?? null,
    }),
    posId: sec.pos_id?.trim() || null,
    terminals: parsePointTerminals(sec.point_pos_ids),
    scopeStoreId: loaded?.scopeStoreId ?? null,
  };
}

export type IntentRow = {
  id: string;
  tenant_id: string;
  provider_key: string;
  status: string;
  amount: number | string;
  preference_id: string | null;
  mp_payment_id: string | null;
};
export const INTENT_COLS = "id, tenant_id, provider_key, status, amount, preference_id, mp_payment_id";

export const channelOf = (providerKey: string): NaveChannel =>
  providerKey === "nave_point" ? "point" : "qr";

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

// Aplica un Payment YA verificado (GET /payments/{id}) sobre el intent local.
// Idempotente: cada transición es condicional al estado actual, así webhooks
// repetidos y el poll del POS no duplican efectos. Devuelve el estado local.
export async function applyPaymentEvaluation(
  admin: Admin,
  row: IntentRow,
  ev: PaymentEvaluation,
  source: "webhook" | "status" | "cancel",
): Promise<string> {
  const info = {
    provider_key: row.provider_key,
    payment_id: ev.paymentId,
    nave_status: ev.status,
    reason_code: ev.reasonCode,
    reason_name: ev.reasonName,
    amount: Number(row.amount),
    paid_amount: ev.amount,
    source,
  };

  if (ev.outcome === "approved") {
    // Un pago verificado SIEMPRE queda registrado como approved, aunque el
    // intent se haya cancelado antes (plata cobrada): así aparece en la
    // conciliación de Cobros QR como "aprobado sin venta" y no se pierde.
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
        "nave_payment_approved",
        { ...info, previous_status: row.status },
        null,
        row.status === "pending" ? null : "approved_after_" + row.status,
      );
    }
    return "approved";
  }

  if (ev.outcome === "rejected" || ev.outcome === "mismatch") {
    if (row.status === "pending") {
      const { data } = await admin
        .from("mp_payment_intents")
        .update({ status: "rejected", mp_payment_id: ev.paymentId || row.mp_payment_id })
        .eq("id", row.id)
        .eq("status", "pending")
        .select("id");
      if ((data as unknown[] | null)?.length || ev.outcome === "mismatch") {
        await audit(
          admin,
          row,
          ev.outcome === "mismatch" ? "nave_payment_mismatch" : "nave_payment_rejected",
          info,
        );
      }
      return "rejected";
    }
    if (ev.outcome === "mismatch") await audit(admin, row, "nave_payment_mismatch", info);
    return row.status;
  }

  if (ev.outcome === "pending") {
    // Guardamos el payment_id para que el próximo poll lo re-verifique.
    if (row.status === "pending" && ev.paymentId && !row.mp_payment_id) {
      await admin
        .from("mp_payment_intents")
        .update({ mp_payment_id: ev.paymentId })
        .eq("id", row.id)
        .eq("status", "pending");
    }
    return row.status;
  }

  // Post-pago (CANCELLED/REFUNDED/…) o desconocido: se preserva en auditoría,
  // sin remapear ni disparar efectos del flujo de cobro.
  await audit(admin, row, "nave_payment_status", info);
  return row.status;
}

export async function fetchJson(
  client: NaveClient,
  method: "GET" | "DELETE",
  url: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const r = await client.request(method, url);
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body };
}

export type SyncResult = {
  status: string;
  mp_payment_id: string | null;
  card_type: "debit" | "credit" | null;
  reason?: string | null;
};

// Verifica un payment_id contra la API (fuente de verdad) y lo aplica.
export async function verifyAndApply(
  admin: Admin,
  conn: NaveConnection,
  row: IntentRow,
  paymentUrl: string,
  source: "webhook" | "status" | "cancel",
): Promise<{ local: string; ev: PaymentEvaluation } | { error: number }> {
  const r = await fetchJson(conn.client, "GET", paymentUrl);
  if (!r.ok) return { error: r.status };
  const ev = evaluatePayment(r.body, {
    intentId: row.id,
    amount: Number(row.amount),
    paymentRequestId: row.preference_id,
  });
  const local = await applyPaymentEvaluation(admin, row, ev, source);
  return { local, ev };
}

// Fallback manual (poll del POS / cancel / baja notificada): consulta la
// payment_request; si tiene un pago aprobado lo verifica contra /payments y
// lo aplica; si la intención venció o se dio de baja, cancela el intent.
export async function syncIntent(
  admin: Admin,
  conn: NaveConnection,
  row: IntentRow,
  source: "webhook" | "status" | "cancel",
): Promise<SyncResult | { error: string; detail?: string }> {
  const channel = channelOf(row.provider_key);
  const base = naveApiBase(conn.env, channel);

  // Ya resuelto localmente: devolver (Point: tipo de tarjeta desde el pago).
  if (row.status !== "pending") {
    let card: "debit" | "credit" | null = null;
    if (row.status === "approved" && channel === "point" && isSafeNaveId(row.mp_payment_id)) {
      const r = await fetchJson(conn.client, "GET", `${base}/integrations/payments/${row.mp_payment_id}`)
        .catch(() => null);
      if (r?.ok) {
        card = evaluatePayment(r.body, { intentId: row.id, amount: Number(row.amount) }).cardType;
      }
    }
    return { status: row.status, mp_payment_id: row.mp_payment_id, card_type: card };
  }

  // 1) Pago ya notificado (pendiente) → re-verificar.
  if (isSafeNaveId(row.mp_payment_id)) {
    const res = await verifyAndApply(
      admin, conn, row, `${base}/integrations/payments/${row.mp_payment_id}`, source,
    );
    if ("local" in res && res.local !== "pending") {
      return { status: res.local, mp_payment_id: res.ev.paymentId, card_type: res.ev.cardType, reason: res.ev.reasonCode };
    }
  }

  // 2) Consultar la payment_request.
  if (!isSafeNaveId(row.preference_id)) {
    return { status: "pending", mp_payment_id: null, card_type: null };
  }
  const pr = await fetchJson(conn.client, "GET", `${base}/integrations/payment_requests/${row.preference_id}`);
  if (pr.status === 404) return { status: "pending", mp_payment_id: null, card_type: null };
  if (!pr.ok) {
    return { error: "nave_error", detail: JSON.stringify(pr.body ?? {}).slice(0, 300) };
  }
  const approvedId = approvedPaymentIdFromRequest(pr.body);
  if (approvedId) {
    const res = await verifyAndApply(
      admin, conn, row, `${base}/integrations/payments/${approvedId}`, source,
    );
    if ("error" in res) return { error: "nave_error", detail: `payment ${res.error}` };
    return {
      status: res.local,
      mp_payment_id: res.local === "approved" ? res.ev.paymentId : null,
      card_type: res.ev.cardType,
      reason: res.ev.reasonCode,
    };
  }

  const outcome = paymentRequestOutcome(pr.body, channel);
  const reason =
    ((pr.body as { disabled_reason?: unknown } | null)?.disabled_reason as string | undefined) ?? null;
  if (outcome === "cancelled" || outcome === "rejected") {
    const { data } = await admin
      .from("mp_payment_intents")
      .update({ status: outcome })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if ((data as unknown[] | null)?.length) {
      await audit(admin, row, `nave_payment_request_${outcome}`, {
        provider_key: row.provider_key,
        payment_request_id: row.preference_id,
        reason,
        source,
      });
    }
    return { status: outcome, mp_payment_id: null, card_type: null, reason };
  }
  return { status: "pending", mp_payment_id: null, card_type: null };
}

// Usuario autenticado + tenant + membresía activa (patrón de las Edge de cobro).
export async function authMember(
  req: Request,
): Promise<
  | { admin: Admin; tenantId: string; userId: string; role: string; supabaseUrl: string }
  | Response
> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);
  return {
    admin,
    tenantId,
    userId: user.id,
    role: String((mem as { role?: string }).role ?? ""),
    supabaseUrl: url,
  };
}

// Cancela una payment_request local+remota (best-effort en Nave). Si mientras
// tanto el pago se aprobó, gana el pago (queda approved para conciliación).
export async function cancelIntent(
  admin: Admin,
  conn: NaveConnection,
  row: IntentRow,
  actor: string,
): Promise<string> {
  if (row.status !== "pending") return row.status;
  const base = naveApiBase(conn.env, channelOf(row.provider_key));
  let remoteOk = false;
  if (isSafeNaveId(row.preference_id)) {
    const r = await conn.client
      .request("DELETE", `${base}/integrations/payment_requests/${row.preference_id}`)
      .catch(() => null);
    remoteOk = Boolean(r?.ok);
  }
  const sync = await syncIntent(admin, conn, row, "cancel").catch(() => null);
  if (sync && "status" in sync && sync.status !== "pending") return sync.status;
  const { data } = await admin
    .from("mp_payment_intents")
    .update({ status: "cancelled" })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");
  if ((data as unknown[] | null)?.length) {
    await audit(
      admin,
      row,
      "nave_payment_request_cancelled",
      { provider_key: row.provider_key, payment_request_id: row.preference_id, remote_ok: remoteOk },
      actor,
    );
  }
  return "cancelled";
}
