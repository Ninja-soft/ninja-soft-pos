// =============================================================================
// Edge Function: gocuotas_webhook · notificaciones + retorno del checkout de
// GO Cuotas (F8 · ADR-033). verify_jwt = false (la llaman GO Cuotas y el
// navegador del cliente).
//
//   * GET ?view=success|failed → pantalla neutra de retorno (url_success /
//     url_failure del checkout). No confirma nada: el POS se entera por su poll.
//   * POST ?intent=<uuid> → webhook_url del checkout. NUNCA confía en el
//     cuerpo (GO Cuotas no documenta firma): el order_id sólo es una pista de
//     qué orden re-consultar con la API Key del tenant; si la orden no tiene
//     order_reference_id = intent, se busca por referencia en el listado.
//     Acredita sólo approved + referencia propia + monto exacto en centavos.
//     Idempotente (updates condicionales; un intent approved no se toca).
//     Siempre 200 para que GO Cuotas no reintente en loop.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { extractWebhookHint } from "../_shared/gocuotas.ts";
import { INTENT_COLS, loadApiKey, syncIntent, type IntentRow } from "../_shared/gocuotas_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = () => new Response("ok", { status: 200 });

Deno.serve(withWebhookLog("gocuotas", "gocuotas_webhook", async (req: Request, wh) => {
  const reqUrl = new URL(req.url);

  if (req.method === "GET") {
    if (reqUrl.searchParams.get("view") === "failed") {
      return html("<h1>Pago no completado</h1><p>Avisale al cajero para reintentar el cobro.</p>");
    }
    return html(
      "<h1>¡Listo!</h1><p>Si el pago se aprobó, la venta se registra sola en el mostrador. Podés cerrar esta pantalla.</p>",
    );
  }
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    const intentId = reqUrl.searchParams.get("intent") ?? "";
    if (!UUID_RE.test(intentId)) return ok();
    wh.ref(intentId);

    let hint = { orderId: null as string | null, reference: null as string | null };
    try {
      hint = extractWebhookHint(await req.json());
    } catch {
      /* cuerpo no-JSON: se ignora (igual re-consultamos) */
    }
    if (hint.reference && hint.reference !== intentId) return ok(); // notificación ajena

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentId)
      .eq("provider_key", "gocuotas")
      .maybeSingle();
    const row = data as IntentRow | null;
    if (row) wh.tenant(row.tenant_id);
    if (!row || row.status === "approved") return ok(); // idempotente

    // ADR-057: la API Key (negocio o sucursal) con la que se creó el cobro.
    const apiKey = await loadApiKey(admin, row.tenant_id, {
      scopeStoreId: await intentSecretScope(admin, row.id),
    });
    if (!apiKey) {
      wh.fail("sin API Key de GO Cuotas");
      return ok();
    }

    const res = await syncIntent(admin, row, apiKey, "webhook", hint.orderId, null);
    if ("error" in res) {
      console.error("gocuotas_webhook", res.detail);
      wh.fail(`GO Cuotas: ${String(res.error)}`);
    } else {
      wh.done();
    }
  } catch (e) {
    console.error("gocuotas_webhook", e);
    wh.fail(e);
  }
  return ok();
}));
