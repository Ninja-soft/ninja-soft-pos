// =============================================================================
// Edge Function: mp_refund (H21h · ADR-067). Reintegro por Mercado Pago de una
// devolución ya registrada (return_sale_v2 dejó la fila mp_refunds en
// 'pending'). verify_jwt = true.
//
// Body: { refund_id: uuid }
//
//   1) Usuario autenticado del negocio actual. _mp_refund_claim (service_role)
//      valida negocio, que lo pida quien lo registró o un dueño o encargado,
//      la feature `reintegro_mp` y el estado, y lo pasa a 'processing'.
//   2) Credencial EXACTA con la que se creó el cobro (secret_store_id del
//      intent, ADR-057) y su ambiente (mp_env). Nunca sale del servidor.
//   3) Id del pago en MP: mp_payment_id del intent o, con la Orders API (QR
//      dinámico y Point), el reference_id del pago de la orden.
//   4) POST /v1/payments/{id}/refunds con { amount } y
//      X-Idempotency-Key = id:secuencia de la fila (un reintento después de un
//      error dudoso no duplica; después de un rechazo la clave cambia).
//   5) _mp_refund_finish registra el resultado (auditado) y, si se hizo,
//      la devolución en payment_disputes con origen 'pos' (ADR-064).
//
// Respuesta: { status: approved | in_process | failed | error, refund_id,
//   mp_refund_id?, error?, detail? }. 'failed' habilita el respaldo en
//   efectivo o vale (mp_refund_fallback); 'error' pide reintentar.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import type { MpEnv } from "../_shared/mpOrders.ts";
import { classifyMpRefund, mpOrderPaymentId, refundAmount, type MpRefundResult } from "../_shared/mpRefund.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 20_000;

type Claim = {
  id: string;
  amount: number | string;
  idempotency_key: string;
  provider_key: string;
  mp_payment_id: string | null;
  mp_order_id: string | null;
  mp_env: string | null;
  secret_store_id: string | null;
  provider_payment_id: string | null;
  error?: string;
  status?: string;
  mp_refund_id?: string | null;
};

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const refundId = typeof b.refund_id === "string" && UUID_RE.test(b.refund_id) ? b.refund_id : null;
  if (!refundId) return json({ error: "invalid_args" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: claimRaw, error: claimErr } = await admin.rpc("_mp_refund_claim", {
    p_id: refundId,
    p_tenant: tenantId,
    p_user: user.id,
  });
  if (claimErr) return json({ error: "claim_failed", detail: claimErr.message }, 500);
  const claim = claimRaw as Claim;
  if (claim.error) {
    const code = claim.error;
    if (code === "already_final") {
      return json({ status: claim.status, refund_id: refundId, mp_refund_id: claim.mp_refund_id ?? null, unchanged: true });
    }
    const http = code === "forbidden" || code === "feature_not_in_plan" ? 403 : code === "in_progress" ? 409 : 404;
    return json({ error: code, refund_id: refundId }, http);
  }

  const finish = async (res: MpRefundResult, providerPaymentId: string | null, raw: unknown) => {
    await admin.rpc("_mp_refund_finish", {
      p_id: refundId,
      p_tenant: tenantId,
      p_user: user.id,
      p_status: res.outcome,
      p_mp_refund_id: res.refundId,
      p_mp_status: res.mpStatus,
      p_error_code: res.code,
      p_error_detail: res.detail,
      p_provider_payment_id: providerPaymentId,
      p_raw: raw ?? null,
    });
    return json({
      status: res.outcome,
      refund_id: refundId,
      mp_refund_id: res.refundId,
      error: res.code,
      detail: res.detail,
    });
  };

  const fail = (code: MpRefundResult["code"], detail: string, outcome: "failed" | "error" = "failed") =>
    finish({ outcome, refundId: null, mpStatus: null, code, detail }, claim.provider_payment_id, null);

  // Credencial exacta del cobro (ADR-057) y su ambiente.
  const cred = await tenantMpCredential(admin, tenantId, (claim.mp_env as MpEnv | null) ?? "prod", {
    scopeStoreId: claim.secret_store_id,
  });
  if (!cred) return fail("mp_auth", "La cuenta de Mercado Pago con la que se cobró ya no está conectada.");

  // Id del pago en MP.
  let paymentId =
    claim.provider_payment_id && /^\d+$/.test(claim.provider_payment_id)
      ? claim.provider_payment_id
      : claim.mp_payment_id && /^\d+$/.test(claim.mp_payment_id)
        ? claim.mp_payment_id
        : null;
  if (!paymentId && claim.mp_order_id) {
    try {
      const o = await fetchJson(`${MP_API}/v1/orders/${encodeURIComponent(claim.mp_order_id)}`, {
        headers: mpHeaders(cred.token),
      });
      if (o.status >= 200 && o.status < 300) paymentId = mpOrderPaymentId(o.body);
      else if (o.status === 401 || o.status === 403) return fail("mp_auth", `order ${o.status}`);
      else if (o.status >= 500 || o.status === 429) return fail("provider_unavailable", `order ${o.status}`, "error");
    } catch (e) {
      return fail("provider_unavailable", String(e).slice(0, 200), "error");
    }
  }
  if (!paymentId) return fail("payment_not_found", "No se encontró el pago en Mercado Pago.");

  let res: MpRefundResult;
  let raw: unknown = null;
  try {
    const r = await fetchJson(`${MP_API}/v1/payments/${paymentId}/refunds`, {
      method: "POST",
      headers: mpHeaders(cred.token, claim.idempotency_key),
      body: JSON.stringify({ amount: refundAmount(Number(claim.amount)) }),
    });
    raw = r.body;
    res = classifyMpRefund(r.status, r.body);
  } catch (e) {
    // Timeout o red: no se sabe si MP la hizo. Reintento con la misma clave.
    res = { outcome: "error", refundId: null, mpStatus: null, code: "provider_unavailable", detail: String(e).slice(0, 200) };
  }
  return finish(res, paymentId, raw);
});
