// =============================================================================
// Edge Function: mp_webhook — recibe notificaciones de Mercado Pago (público,
// sin JWT). Identifica el intent por ?intent=<id>, consulta el pago real en MP
// con el Access Token del tenant (no confía en el body) y actualiza el estado.
// Siempre responde 200 para que MP no reintente en loop.
//
// Desde ADR-032 cubre sólo los pagos de Checkout Pro (link). Las orders de la
// Orders API (QR dinámico y Point) llegan por mp_orders_webhook (topic order).
// El token se elige por el ambiente del intent (mp_env: prod | test).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { tenantMpCredential } from "../_shared/mpAuth.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { amountsMatch, type MpEnv } from "../_shared/mpOrders.ts";

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

Deno.serve(async (req: Request) => {
  const ok = () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const reqUrl = new URL(req.url);
    const intentId = reqUrl.searchParams.get("intent");
    if (!intentId) return ok();

    // Payment id desde query o body.
    let paymentId =
      reqUrl.searchParams.get("data.id") || reqUrl.searchParams.get("id") || "";
    let topic =
      reqUrl.searchParams.get("type") || reqUrl.searchParams.get("topic") || "";
    if (req.method === "POST") {
      try {
        const body = (await req.json()) as {
          type?: string;
          topic?: string;
          data?: { id?: string };
        };
        topic = body.type || body.topic || topic;
        paymentId = body.data?.id || paymentId;
      } catch {
        // sin body JSON; seguimos con query.
      }
    }
    if (topic && topic !== "payment") return ok(); // solo pagos
    if (!paymentId) return ok();

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, status, amount, mp_env")
      .eq("id", intentId)
      .maybeSingle();
    if (!intent) return ok();

    // ADR-057: verifica con la misma credencial (negocio o sucursal) con la
    // que se creó el cobro.
    const cred = await tenantMpCredential(
      admin,
      intent.tenant_id,
      ((intent as { mp_env?: MpEnv | null }).mp_env ?? "prod") as MpEnv,
      { scopeStoreId: await intentSecretScope(admin, intentId) },
    );
    if (!cred) return ok();
    const accessToken = cred.token;

    const payRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!payRes.ok) return ok();
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
        return ok();
      }
    }

    await admin
      .from("mp_payment_intents")
      .update({ status, mp_payment_id: String(paymentId) })
      .eq("id", intentId)
      .neq("status", "approved");

    return ok();
  } catch {
    return ok();
  }
});
