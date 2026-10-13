// =============================================================================
// Edge Function: nave_webhook: notificaciones de Nave (F8 · H21c, ADR-030).
// verify_jwt = false (lo llama Nave). Esta URL se informa a Nave en el
// onboarding (una para sandbox y otra para producción; no viaja por request):
//   {SUPABASE_URL}/functions/v1/nave_webhook
//
//   * POST {payment_id, payment_check_url, external_payment_id} → NUNCA se
//     confía en el cuerpo: external_payment_id ubica el intent local (uuid,
//     provider 'nave' | 'nave_point'); la URL a consultar se valida contra los
//     hosts Nave del ambiente del tenant (anti-SSRF) o se construye desde la
//     base confiable con el payment_id; GET autenticado con el token del
//     tenant; sólo APPROVED + correlación + monto exacto acredita. Idempotente
//     (transiciones condicionales): los reintentos de Nave no duplican nada.
//   * POST {payment_request_id, status, disabled_reason, external_payment_id}
//     (baja de una intención Point) → se re-consulta la payment_request.
//   * GET ?view=return → pantalla neutra de "volver" del checkout hosted
//     (callback_url): NO confirma el pago.
//
// Respuestas: 200 cuando la notificación quedó procesada o es descartable
// (payload inválido / intent ajeno); 5xx ante fallas transitorias de Nave para
// que Nave reintente (10 s, 70 s, 490 s, …).
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { parseNotification, resolvePaymentCheckUrl } from "../_shared/nave.ts";
import {
  INTENT_COLS,
  channelOf,
  loadNaveConnection,
  syncIntent,
  verifyAndApply,
  type IntentRow,
} from "../_shared/nave_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
const ok = () => new Response("ok", { status: 200 });
const retry = () => new Response("retry", { status: 503 });

Deno.serve(withWebhookLog("nave", "nave_webhook", async (req: Request, wh) => {
  if (req.method === "GET") {
    return html(
      "<h1>Listo</h1><p>Si el pago se aprobó, la venta se registra sola en el mostrador. Podés cerrar esta pantalla.</p>",
    );
  }
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  let raw: unknown = null;
  try {
    raw = await readJsonLimited(req);
  } catch {
    return ok();
  }
  const n = parseNotification(raw);
  if (!n || !UUID.test(n.externalPaymentId)) return ok();
  wh.ref(n.externalPaymentId);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Correlación: external_payment_id = id del intent local.
  const { data } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", n.externalPaymentId)
    .in("provider_key", ["nave", "nave_point"])
    .maybeSingle();
  if (!data) return ok();
  const row = data as IntentRow;
  wh.tenant(row.tenant_id);

  // ADR-057: la conexión (negocio o sucursal) con la que se creó el cobro.
  const conn = await loadNaveConnection(admin, row.tenant_id, {
    scopeStoreId: await intentSecretScope(admin, row.id),
  });
  if (!conn) {
    wh.fail("sin conexión de Nave");
    return ok();
  }

  try {
    if (n.kind === "payment_request") {
      // La baja tiene que ser de NUESTRA payment_request.
      if (n.paymentRequestId !== row.preference_id) return ok();
      const res = await syncIntent(admin, conn, row, "webhook");
      if ("error" in res) {
        wh.fail(`Nave: error ${String(res.error)} al sincronizar`);
        return retry();
      }
      wh.done();
      return ok();
    }

    const url = resolvePaymentCheckUrl(n, conn.env, channelOf(row.provider_key));
    if (!url) return ok();
    const res = await verifyAndApply(admin, conn, row, url, "webhook");
    if ("error" in res) {
      // 404: pago inexistente para este comercio (o forjado) → descartar.
      if (res.error === 404 || res.error === 400) return ok();
      wh.fail(`Nave: error ${String(res.error)} al verificar el pago`);
      return retry();
    }
    wh.done();
    return ok();
  } catch (e) {
    // Red / auth de Nave caída: que Nave reintente.
    wh.fail(e);
    return retry();
  }
}));
