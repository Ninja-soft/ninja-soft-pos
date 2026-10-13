// =============================================================================
// Edge Function: directo_webhook · notificaciones + retorno de la orden de
// Directo (F8 · ADR-041). verify_jwt = false (la llaman Directo y el
// navegador del cliente).
//
//   * GET ?view=success|failed → pantalla neutra de retorno
//     (Return_Url_Success / Return_Url_Error). No confirma nada: el POS se
//     entera por su poll.
//   * POST ?intent=<uuid> → Notify_Url de la orden, cuerpo
//     { notification_id }. NUNCA confía en el cuerpo: el id sólo indica qué
//     notificación re-consultar (GET api/merchant/notification/{id}) con las
//     credenciales del tenant. Acredita sólo status Successful +
//     merchant_Order_Id = intent + monto exacto si Directo lo informa.
//     Idempotente (updates condicionales; un intent approved no se toca).
//     Siempre 200 para que Directo no reintente en loop.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { extractNotificationId } from "../_shared/directo.ts";
import { INTENT_COLS, loadCreds, syncIntent, type IntentRow } from "../_shared/directo_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = () => new Response("ok", { status: 200 });

Deno.serve(withWebhookLog("directo", "directo_webhook", async (req: Request, wh) => {
  const reqUrl = new URL(req.url);

  if (req.method === "GET") {
    if (reqUrl.searchParams.get("view") === "failed") {
      return html("<h1>Pago no completado</h1><p>Avisale al cajero para reintentar el cobro.</p>");
    }
    return html(
      "<h1>¡Listo!</h1><p>Si Directo aprobó el pago, la venta se registra sola en el mostrador. Podés cerrar esta pantalla.</p>",
    );
  }
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    const intentId = reqUrl.searchParams.get("intent") ?? "";
    if (!UUID_RE.test(intentId)) return ok();
    wh.ref(intentId);

    let notificationId: string | null = null;
    try {
      notificationId = extractNotificationId(await req.json());
    } catch {
      /* cuerpo no-JSON: sin id no hay nada que re-consultar */
    }
    if (!notificationId) return ok();
    wh.ref(notificationId);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentId)
      .eq("provider_key", "directo")
      .maybeSingle();
    const row = data as IntentRow | null;
    if (row) wh.tenant(row.tenant_id);
    if (!row || row.status === "approved") return ok(); // idempotente

    // ADR-057: la conexión (negocio o sucursal) con la que se creó el cobro.
    const creds = await loadCreds(admin, row.tenant_id, {
      scopeStoreId: await intentSecretScope(admin, row.id),
    });
    if (!creds) {
      wh.fail("sin credenciales de Directo");
      return ok();
    }

    const res = await syncIntent(admin, row, creds, "webhook", notificationId, null);
    if ("error" in res) {
      console.error("directo_webhook", res.error, res.detail ?? "");
      wh.fail(`Directo: ${String(res.error)}`);
    } else {
      wh.done();
    }
  } catch (e) {
    console.error("directo_webhook", e);
    wh.fail(e);
  }
  return ok();
}));
