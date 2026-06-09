// =============================================================================
// Edge Function: mp_webhook — recibe notificaciones de Mercado Pago (público,
// sin JWT). Identifica el intent por ?intent=<id>, consulta el pago real en MP
// con el Access Token del tenant (no confía en el body) y actualiza el estado.
// Siempre responde 200 para que MP no reintente en loop.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

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
      .select("id, tenant_id, status, amount")
      .eq("id", intentId)
      .maybeSingle();
    if (!intent) return ok();

    const { data: secretRow } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", intent.tenant_id)
      .eq("provider_key", "mercadopago")
      .maybeSingle();
    const accessToken = (secretRow?.secrets as { access_token?: string } | null)
      ?.access_token;
    if (!accessToken) return ok();

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
      if (!Number.isFinite(paid) || Math.abs(paid - expected) > 0.01) {
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
