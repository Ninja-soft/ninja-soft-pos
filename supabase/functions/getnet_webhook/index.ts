// =============================================================================
// Edge Function: getnet_webhook · notificaciones + retorno del checkout de
// Getnet Argentina (F8 · H18, ADR-031). verify_jwt = false (la llaman Getnet
// y el navegador del cliente).
//
//   * GET  ?view=success|failed → pantalla neutra de retorno para el cliente
//     (redirect_urls de la orden). El POS se entera por su propio poll.
//   * POST ?intent=<uuid> → webhookUrl de la orden. NUNCA confía en el cuerpo:
//     la orden a consultar es la que guardamos al crearla (preference_id); el
//     data.order.uuid del cuerpo sólo se usa para descartar notificaciones que
//     no corresponden. Re-consulta GET /api/v2/orders/{uuid} con el token del
//     tenant y acredita sólo APPROVED/PROCESSED/SUCCESS con monto exacto.
//     Idempotente: updates condicionales por estado; un intent ya approved no
//     se toca. Un intent que el POS dio por rechazado puede pasar a approved
//     si Getnet lo confirma (queda en la conciliación como cobro sin venta).
//     Siempre responde 200 para que Getnet no reintente en loop.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  extractWebhookOrderId,
  fetchGetnetOrder,
  fetchGetnetToken,
} from "../_shared/getnet.ts";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = () => new Response("ok", { status: 200 });

Deno.serve(async (req: Request) => {
  const reqUrl = new URL(req.url);

  if (req.method === "GET") {
    if (reqUrl.searchParams.get("view") === "failed") {
      return html(
        "<h1>Pago no completado</h1><p>Avisale al cajero para reintentar el cobro.</p>",
      );
    }
    return html(
      "<h1>¡Listo!</h1><p>Si el pago se aprobó, la venta se registra sola en el mostrador. Podés cerrar esta pantalla.</p>",
    );
  }
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    const intentId = reqUrl.searchParams.get("intent") ?? "";
    if (!UUID_RE.test(intentId)) return ok();

    let hinted: string | null = null;
    try {
      hinted = extractWebhookOrderId(await req.json());
    } catch {
      /* cuerpo no-JSON: se ignora (igual re-consultamos) */
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: row } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, status, amount, preference_id")
      .eq("id", intentId)
      .eq("provider_key", "getnet")
      .maybeSingle();
    if (!row || !row.preference_id) return ok();
    if (row.status === "approved") return ok(); // idempotente
    const orderId = String(row.preference_id);
    if (hinted && hinted !== orderId) return ok(); // notificación ajena

    const { data: secretRow } = await admin
      .from("payment_secrets")
      .select("secrets")
      .eq("tenant_id", row.tenant_id)
      .eq("provider_key", "getnet")
      .maybeSingle();
    const sec = (secretRow?.secrets ?? {}) as { client_id?: string; client_secret?: string };
    if (!sec.client_id || !sec.client_secret) return ok();

    const token = await fetchGetnetToken(sec.client_id, sec.client_secret);
    if (!token) return ok();
    const res = await fetchGetnetOrder(token, orderId);
    if (!res.ok) return ok();

    const d = decideIntentUpdate(res.order, Number(row.amount));
    if (d.status === "pending") return ok();

    // approved puede venir después de que el POS lo dio por rechazado; el
    // resto de los estados sólo resuelve intents pendientes.
    const from = d.status === "approved" ? ["pending", "rejected"] : ["pending"];
    const { data: changed } = await admin
      .from("mp_payment_intents")
      .update({
        status: d.status,
        mp_payment_id: d.status === "approved" ? orderId : null,
      })
      .eq("id", row.id)
      .in("status", from)
      .select("id");

    if (changed && changed.length > 0) {
      await admin.from("audit_logs").insert({
        tenant_id: row.tenant_id,
        actor_user_id: null,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: `getnet_payment_${d.status}`,
        after_data: {
          order_id: orderId,
          state: d.state,
          reason: d.reason ?? null,
          amount: Number(row.amount),
          previous_status: row.status,
          via: "webhook",
        },
      });
    }
  } catch (e) {
    console.error("getnet_webhook", e);
  }
  return ok();
});
