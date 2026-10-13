// =============================================================================
// Edge Function: getnet_webhook · notificaciones + retorno del checkout de
// Getnet Argentina (F8 · H18, ADR-031, ADR-065). verify_jwt = false (la llaman
// Getnet y el navegador del cliente).
//
//   * GET  ?view=success|failed → pantalla neutra de retorno para el cliente
//     (redirect_urls de la orden). El POS se entera por su propio poll.
//   * POST ?intent=<uuid> → webhookUrl por orden (API Geopagos).
//   * POST sin ?intent → webhook de Web Checkout (URL única del comercio,
//     configurada en el Portal Getnet): el cobro se busca por el
//     payment_intent_id del cuerpo (preference_id del intent).
//   En los dos casos NUNCA confía en el cuerpo: re-consulta la orden con el
//   token del tenant y acredita sólo con la confirmación de la API y el monto
//   verificado. Idempotente: updates condicionales por estado; un intent ya
//   approved no se toca. Un intent que el POS dio por rechazado puede pasar a
//   approved si Getnet lo confirma (queda en la conciliación como cobro sin
//   venta). Siempre responde 200 para que Getnet no reintente en loop.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideFor,
  extractWebhookIntentId,
  extractWebhookOrderId,
  fetchGetnetOrderFor,
} from "../_shared/getnet.ts";
import { getnetAuth, loadGetnetSlot } from "../_shared/getnet_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = () => new Response("ok", { status: 200 });

type Row = { id: string; tenant_id: string; status: string; amount: number | string; preference_id: string | null };
const COLS = "id, tenant_id, status, amount, preference_id";

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
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      /* cuerpo no-JSON: se ignora (igual re-consultamos) */
    }
    const hinted = extractWebhookOrderId(body) ?? extractWebhookIntentId(body);
    const intentParam = reqUrl.searchParams.get("intent") ?? "";

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    let row: Row | null = null;
    if (UUID_RE.test(intentParam)) {
      const { data } = await admin
        .from("mp_payment_intents")
        .select(COLS)
        .eq("id", intentParam)
        .eq("provider_key", "getnet")
        .maybeSingle();
      row = (data as Row | null) ?? null;
      if (row && hinted && hinted !== String(row.preference_id)) return ok(); // notificación ajena
    } else if (hinted) {
      // Web Checkout: el id del cuerpo sólo elige QUÉ intent re-consultar.
      const { data } = await admin
        .from("mp_payment_intents")
        .select(COLS)
        .eq("provider_key", "getnet")
        .eq("preference_id", hinted)
        .limit(1);
      row = ((data as Row[] | null) ?? [])[0] ?? null;
    }
    if (!row || !row.preference_id) return ok();
    if (row.status === "approved") return ok(); // idempotente
    const orderId = String(row.preference_id);

    // Slot Web Checkout (ADR-069): el checkout propio no usa este webhook.
    const secretRow = await loadGetnetSlot(admin, row.tenant_id, "web_checkout", {
      scopeStoreId: await intentSecretScope(admin, row.id),
    });
    const sec = (secretRow?.secrets ?? {}) as { client_id?: string; client_secret?: string };
    if (!secretRow || !sec.client_id || !sec.client_secret) return ok();

    const auth = await getnetAuth(admin, row.tenant_id, secretRow, "getnet_webhook");
    if (!auth.ok) return ok();
    const res = await fetchGetnetOrderFor(auth.profile, auth.token, orderId);
    if (!res.ok) {
      console.error(JSON.stringify({
        fn: "getnet_webhook",
        step: "status",
        profile: auth.profile.key,
        status: res.httpStatus,
        detail: res.detail.slice(0, 200),
      }));
      return ok();
    }

    const d = decideFor(auth.profile, res.order, Number(row.amount));
    if (d.status === "pending") return ok();

    // approved puede venir después de que el POS lo dio por rechazado; el
    // resto de los estados sólo resuelve intents pendientes.
    const from = d.status === "approved" ? ["pending", "rejected"] : ["pending"];
    const { data: changed } = await admin
      .from("mp_payment_intents")
      .update({
        status: d.status,
        mp_payment_id: d.status === "approved" ? (d.paymentId ?? orderId) : null,
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
          payment_id: d.paymentId,
          state: d.state,
          reason: d.reason ?? null,
          amount: Number(row.amount),
          previous_status: row.status,
          api_profile: auth.profile.key,
          via: "webhook",
        },
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ fn: "getnet_webhook", step: "unhandled", error: String(e).slice(0, 300) }));
  }
  return ok();
});
