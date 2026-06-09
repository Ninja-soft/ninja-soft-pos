// =============================================================================
// Edge Function: catalog_purchase_webhook — recibe la notificación de Mercado
// Pago cuando un tenant paga la COMPRA de un catálogo (pago único). Público,
// sin JWT (lo llama MP). Identifica el intent por ?intent=<id>, consulta el pago
// real en MP con el Access Token de NinjaSoft (platform_secrets, NO confía en el
// body) y, si está aprobado, acredita la compra vía finalize_catalog_purchase
// (idempotente, notifica al tenant). Siempre responde 200 para que MP no
// reintente en loop.
//
// verify_jwt = false (se setea al desplegar).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const APPROVED = new Set(["approved", "authorized"]);
const REJECTED = new Set(["rejected", "cancelled", "refunded", "charged_back"]);

Deno.serve(async (req: Request) => {
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const reqUrl = new URL(req.url);
    const intentId = reqUrl.searchParams.get("intent");
    if (!intentId) return ok();

    // Payment id + topic desde query o body (MP manda ambos formatos).
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
      .from("catalog_payment_intents")
      .select("id, status, tenant_id, catalog_id, amount")
      .eq("id", intentId)
      .maybeSingle();
    if (!intent) return ok();
    // Idempotencia barata: si ya está aprobado, no re-procesamos.
    if (intent.status === "approved") return ok();

    // Access Token de la cuenta de NinjaSoft (la que cobró la preference).
    const { data: plat } = await admin
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "mercadopago")
      .maybeSingle();
    const accessToken = (plat?.secrets as { access_token?: string } | null)
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

    const status = pay.status ?? "";
    if (APPROVED.has(status)) {
      // Antifraude #2 (BUG 13): el monto pagado tiene que coincidir con el
      // esperado (tolerancia de centavos). Si difiere, NO acreditamos el acceso:
      // dejamos el intent en pending y alertamos (posible manipulación). MP ya
      // cobró, así que el alerta queda para revisión/refund de NinjaSoft.
      const paid = Number(pay.transaction_amount ?? NaN);
      const expected = Number(intent.amount);
      if (!Number.isFinite(paid) || Math.abs(paid - expected) > 0.01) {
        console.error(
          "[catalog_purchase_webhook] amount_mismatch, NOT crediting access",
          { intentId, paid, expected },
        );
        await admin.from("audit_logs").insert({
          tenant_id: intent.tenant_id,
          actor_user_id: null,
          entity_type: "catalog_payment_intents",
          entity_id: intentId,
          action: "catalog_payment_amount_mismatch",
          after_data: {
            catalog_id: intent.catalog_id,
            payment_id: String(paymentId),
            paid,
            expected,
          },
        });
        return ok();
      }

      // BUG 12 (detección de doble cobro): finalize_catalog_purchase es
      // idempotente — si el catálogo YA estaba poseído (otro intent del mismo
      // (tenant, catalog) ya acreditó), NO crea una segunda compra y devuelve
      // false. En ese caso este es un 2º pago real cobrado por MP sin
      // contrapartida nueva → lo marcamos para alerta/refund (no re-acreditamos
      // acceso, que ya existe).
      const { data: created } = await admin.rpc("finalize_catalog_purchase", {
        p_intent_id: intentId,
        p_payment_id: String(paymentId),
        p_price: paid,
      });
      if (created === false) {
        console.error(
          "[catalog_purchase_webhook] duplicate_paid_purchase (already owned) — flag for refund",
          { intentId, catalogId: intent.catalog_id, tenantId: intent.tenant_id },
        );
        await admin.from("audit_logs").insert({
          tenant_id: intent.tenant_id,
          actor_user_id: null,
          entity_type: "catalog_payment_intents",
          entity_id: intentId,
          action: "catalog_duplicate_payment",
          after_data: {
            catalog_id: intent.catalog_id,
            payment_id: String(paymentId),
            amount: paid,
            note: "second approved payment for already-owned catalog; candidate for refund",
          },
        });
        // Avisamos al dueño del tenant (no hay target interno en notifications;
        // el audit_log es el canal de ops/refund).
        await admin.from("notifications").insert({
          target_tenant_id: intent.tenant_id,
          target_role: "owner",
          type: "billing",
          severity: "warning",
          title: "Detectamos un pago duplicado de un catálogo",
          body:
            "Recibimos un segundo pago por un catálogo que ya tenías. No se te " +
            "cobra el acceso de nuevo; nuestro equipo revisará el reintegro.",
        });
      }
    } else if (REJECTED.has(status)) {
      await admin
        .from("catalog_payment_intents")
        .update({
          status: status === "cancelled" ? "cancelled" : "rejected",
          mp_payment_id: String(paymentId),
        })
        .eq("id", intentId);
    }
    // pending / in_process: dejamos el intent en pending; MP reintentará.

    return ok();
  } catch {
    return ok();
  }
});
