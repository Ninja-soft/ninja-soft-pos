// =============================================================================
// Edge Function: mp_webhook — recibe notificaciones de Mercado Pago (público,
// sin JWT). Identifica el intent por ?intent=<id>, consulta el pago real en MP
// con el Access Token del tenant (no confía en el body) y actualiza el estado.
// Siempre responde 200 para que MP no reintente en loop.
//
// Desde ADR-032 cubre sólo los pagos de Checkout Pro (link). Las orders de la
// Orders API (QR dinámico y Point) llegan por mp_orders_webhook (topic order).
// El token se elige por el ambiente del intent (mp_env: prod | test).
//
// ADR-064: también recibe los avisos de contracargos (topic_chargebacks_wh)
// y reclamos (topic_claims_integration_wh) configurados en la aplicación de
// MP ("Tus integraciones" > Webhooks, URL sin ?intent). No confía en el
// cuerpo: identifica la cuenta por user_id, vuelve a leer el caso y el pago
// con la credencial del negocio y guarda con _payment_disputes_upsert. Los
// avisos de pagos con ?intent siguen igual.
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { tenantMpCredential } from "../_shared/mpAuth.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";
import { amountsMatch, type MpEnv } from "../_shared/mpOrders.ts";
import {
  claimPaymentId,
  dedupeDisputes,
  type DisputeInput,
  mergeMpChargeback,
  mergeMpClaim,
  mpDisputesFromPayment,
  webhookTopicKind,
} from "../_shared/paymentDisputes.ts";
import { disputesEnabled, fetchChargeback, fetchClaim, fetchPayment, saveDisputes } from "../_shared/disputesSync.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/**
 * Aviso de contracargo (topic_chargebacks_wh) o reclamo
 * (topic_claims_integration_wh). El aviso sólo trae el id del caso y el
 * vendedor (user_id): se busca qué negocios tienen conectada esa cuenta de
 * Mercado Pago (payment_secrets.secrets.mp_user_id, conexión por OAuth), y
 * con la credencial de cada uno se vuelve a leer el caso y el pago. Si el
 * pago no es de esa cuenta, MP no lo devuelve y no se guarda nada.
 */
async function handleDisputeNotice(
  admin: Admin,
  kind: "chargeback" | "claim",
  caseId: string,
  mpUserId: string,
  hintPaymentId: string,
): Promise<void> {
  if (!/^\d{1,30}$/.test(mpUserId)) return;
  const { data: rows } = await admin
    .from("payment_secrets")
    .select("tenant_id, store_id")
    .eq("provider_key", "mercadopago")
    .eq("secrets->>mp_user_id", mpUserId)
    .limit(10);
  for (const row of (rows ?? []) as { tenant_id: string; store_id: string | null }[]) {
    try {
      if (!(await disputesEnabled(admin, row.tenant_id))) continue;
      const cred = await tenantMpCredential(admin, row.tenant_id, "prod", { scopeStoreId: row.store_id ?? null });
      if (!cred) continue;
      let items: DisputeInput[] = [];
      if (kind === "chargeback") {
        const cb = await fetchChargeback(cred.token, caseId, mpUserId);
        if (!cb) continue;
        const ids = ((cb as { payments?: unknown[] }).payments ?? []).map(String).slice(0, 3);
        if (ids.length === 0 && hintPaymentId) ids.push(hintPaymentId);
        for (const pid of ids) {
          const pay = await fetchPayment(cred.token, pid);
          if (!pay) continue; // no es un pago de esta cuenta
          const fromPay = mpDisputesFromPayment(pay);
          const current = fromPay.find((d) => d.kind === "chargeback") ?? null;
          const merged = mergeMpChargeback(current, cb, pid);
          items.push(...fromPay.filter((d) => d.kind !== "chargeback"), ...(merged ? [merged] : []));
        }
      } else {
        const claim = await fetchClaim(cred.token, caseId);
        const pid = claimPaymentId(claim) ?? (hintPaymentId || null);
        if (!claim || !pid) continue;
        const pay = await fetchPayment(cred.token, pid);
        if (!pay) continue;
        const fromPay = mpDisputesFromPayment(pay);
        const current = fromPay.find((d) => d.kind === "claim") ?? null;
        const merged = mergeMpClaim(current, claim, pay);
        items.push(...fromPay.filter((d) => d.kind !== "claim"), ...(merged ? [merged] : []));
      }
      items = dedupeDisputes(items);
      if (items.length > 0) await saveDisputes(admin, row.tenant_id, row.store_id ?? null, items, null);
    } catch (e) {
      console.error("[mp_webhook] dispute_notice_failed", { tenant: row.tenant_id, kind, error: String(e).slice(0, 200) });
    }
  }
}

const MP_STATUS: Record<string, string> = {
  approved: "approved",
  authorized: "approved",
  rejected: "rejected",
  cancelled: "cancelled",
  refunded: "rejected",
  charged_back: "rejected",
  in_process: "pending",
  pending: "pending",
};

Deno.serve(withWebhookLog("mercadopago", "mp_webhook", async (req: Request, wh) => {
  const ok = () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const reqUrl = new URL(req.url);
    const intentId = reqUrl.searchParams.get("intent");

    // Payment id desde query o body.
    let paymentId =
      reqUrl.searchParams.get("data.id") || reqUrl.searchParams.get("id") || "";
    let topic =
      reqUrl.searchParams.get("type") || reqUrl.searchParams.get("topic") || "";
    let mpUserId = reqUrl.searchParams.get("user_id") || "";
    let hintPaymentId = "";
    if (req.method === "POST") {
      try {
        const body = (await readJsonLimited(req)) as {
          type?: string;
          topic?: string;
          user_id?: string | number;
          payment_id?: string | number;
          data?: { id?: string | number; payment_id?: string | number };
        };
        topic = body.type || body.topic || topic;
        paymentId = body.data?.id != null ? String(body.data.id) : paymentId;
        mpUserId = body.user_id != null ? String(body.user_id) : mpUserId;
        const hint = body.data?.payment_id ?? body.payment_id;
        hintPaymentId = hint != null ? String(hint) : "";
      } catch {
        // sin body JSON; seguimos con query.
      }
    }

    wh.ref(paymentId || intentId);

    // ADR-064: contracargos y reclamos (avisos de la aplicación, sin intent).
    const disputeKind = webhookTopicKind(topic);
    if (disputeKind) {
      if (paymentId && mpUserId) {
        const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
        await handleDisputeNotice(admin, disputeKind, paymentId, mpUserId, hintPaymentId);
        wh.done();
      }
      return ok();
    }

    if (!intentId) return ok();
    if (topic && topic !== "payment") return ok(); // solo pagos
    if (!paymentId) return ok();

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, status, amount, mp_env")
      .eq("id", intentId)
      .maybeSingle();
    if (!intent) return ok();
    wh.tenant(intent.tenant_id);

    // ADR-057: verifica con la misma credencial (negocio o sucursal) con la
    // que se creó el cobro.
    const cred = await tenantMpCredential(
      admin,
      intent.tenant_id,
      ((intent as { mp_env?: MpEnv | null }).mp_env ?? "prod") as MpEnv,
      { scopeStoreId: await intentSecretScope(admin, intentId) },
    );
    if (!cred) {
      wh.fail("sin credencial de Mercado Pago");
      return ok();
    }
    const accessToken = cred.token;

    const payRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!payRes.ok) {
      wh.fail(`MP /v1/payments respondió ${payRes.status}`);
      return ok();
    }
    const pay = (await payRes.json()) as {
      status?: string;
      external_reference?: string;
      transaction_amount?: number;
    };

    // Antifraude #1: el pago tiene que referenciar ESTE intent.
    if (pay.external_reference !== intentId) return ok();

    const status = MP_STATUS[pay.status ?? ""] ?? "pending";

    // Antifraude #2: para acreditar, el monto pagado tiene que coincidir con el
    // esperado (tolerancia de centavos). Si difiere, NO acreditamos: dejamos el
    // intent en pending y logueamos (posible manipulación del precio).
    if (status === "approved") {
      const paid = Number(pay.transaction_amount ?? NaN);
      const expected = Number(intent.amount);
      if (!amountsMatch(paid, expected)) {
        console.error("[mp_webhook] amount_mismatch, leaving pending (NOT crediting)", {
          intentId,
          paid,
          expected,
        });
        wh.fail("amount_mismatch");
        return ok();
      }
    }

    await admin
      .from("mp_payment_intents")
      .update({ status, mp_payment_id: String(paymentId) })
      .eq("id", intentId)
      .neq("status", "approved");

    wh.done();
    return ok();
  } catch (e) {
    wh.fail(e);
    return ok();
  }
}));
