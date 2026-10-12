// =============================================================================
// Edge Function: mobbex_webhook: recibe notificaciones de Mobbex (público, sin
// JWT). Identifica el intent por ?intent=<id>.
//
// ANTIFRAUDE (espeja mp_webhook): NO confía en el body. Con las credenciales
// Mobbex del tenant (payment_secrets, las mismas que usó mobbex_create_qr)
// re-consulta la operación REAL y sólo entonces decide:
//   1. Operación: GET /p/operations/{data.payment.id del body} y, si no se
//      resuelve (Mobbex responde HTTP 200 con result:false), GET
//      /p/entity/operations?reference=<intentId> (docs[]). NUNCA el id del
//      checkout (CHK:…): no es una operación (GENERIC:EFCS en la API real).
//   2. reference de la operación == intentId.
//   3. Estado (status.code u `status` plano, número o string): 200/300/301 =
//      aprobado; 0/1/2/3/100/210 = pendiente; resto = rechazo.
//   4. Monto pedido (requestedTotal, o total) == mp_payment_intents.amount.
// El checkout se crea con webhooksType "final" (no llegan intentos fallidos);
// igual, un rechazo con el checkout abierto deja el intent PENDIENTE (el
// cliente puede reintentar) y sólo `checkout:expired` sin pago aprobado lo
// rechaza. Si no se puede verificar, NO se acredita. Siempre responde 200.
// Lógica pura en _shared/mobbex.ts (tests/unit/mobbexSandbox.test.ts).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  type MobbexPayment,
  decideMobbex,
  operationLookupUrls,
  pickOperationFromList,
  unwrapOperation,
  webhookPaymentId,
  webhookType,
} from "../_shared/mobbex.ts";

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
    if (!intentId || req.method !== "POST") return ok();

    // El body sólo se usa como PISTA (id de la operación y tipo de webhook).
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return ok();
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: intent } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, amount, status")
      .eq("id", intentId)
      .eq("provider_key", "mobbex")
      .maybeSingle();
    if (!intent) return ok();
    if (intent.status === "approved") return ok(); // idempotencia barata.

    const { data: secretRow } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", intent.tenant_id)
      .eq("provider_key", "mobbex")
      .maybeSingle();
    const sec = (secretRow?.secrets ?? {}) as { api_key?: string; access_token?: string };
    if (!sec.api_key || !sec.access_token) {
      console.error("[mobbex_webhook] no_credentials, leaving pending", { intentId });
      return ok();
    }
    const headers = {
      "x-api-key": sec.api_key,
      "x-access-token": sec.access_token,
      Accept: "application/json",
    };

    const paymentId = webhookPaymentId(body);
    const kind = webhookType(body);
    const [first, second] = operationLookupUrls(paymentId, intentId);
    const getJson = async (u: string): Promise<unknown> => {
      try {
        const r = await fetch(u, { headers });
        return r.ok ? await r.json().catch(() => null) : null;
      } catch {
        return null;
      }
    };

    let payment: MobbexPayment | null = null;
    if (paymentId && first) {
      payment = unwrapOperation(await getJson(first));
      if (payment && payment.reference !== intentId) payment = null;
    }
    const listUrl = paymentId ? second : first;
    if (!payment && listUrl) {
      payment = pickOperationFromList(await getJson(listUrl), paymentId);
    }

    const decision = decideMobbex({
      payment,
      intentId,
      expectedAmount: Number(intent.amount),
      webhookType: kind,
    });
    if (decision.status === null) {
      console.error(`[mobbex_webhook] ${decision.reason}, leaving as is`, {
        intentId,
        paymentId,
        kind,
      });
      return ok();
    }

    // mp_payment_id = id real de la operación Mobbex (nunca el CHK).
    const opId = payment?.id ?? paymentId ?? null;
    const q = admin
      .from("mp_payment_intents")
      .update(
        opId ? { status: decision.status, mp_payment_id: opId } : { status: decision.status },
      )
      .eq("id", intentId);
    // approved gana sobre un intent cancelado (plata cobrada: queda para la
    // conciliación); pending/rejected sólo mueven un intent todavía pendiente.
    await (decision.status === "approved" ? q.neq("status", "approved") : q.eq("status", "pending"));

    return ok();
  } catch (e) {
    console.error("[mobbex_webhook] unexpected", String(e).slice(0, 200));
    return ok();
  }
});
