// =============================================================================
// Edge Function: ualabis_webhook · notificaciones y retorno de Ualá Bis
// (F8 · ADR-143). verify_jwt = false (la llaman Ualá y el navegador del
// cliente). Se publica en https://hooks.soft.ninja/ualabis (ADR-069).
//
//   * GET ?view=success|failed → pantalla neutra de retorno (callback_success /
//     callback_fail). No confirma nada: el POS se entera por su poll.
//   * POST ?intent=<uuid> → webhook de la orden, cuerpo { uuid,
//     external_reference, status, ... } SIN firma. NUNCA confía en el cuerpo:
//     el uuid sólo indica qué orden re-consultar (GET /orders/{uuid}) con la
//     credencial del negocio, y tiene que ser la guardada en el intent.
//     Acredita sólo PROCESSED o APPROVED + external_reference = intent + monto
//     exacto. Idempotente (updates condicionales; un intent approved no se toca).
//   * POST ?refund=<uuid> → webhook de la devolución. Re-consulta la orden:
//     REFUNDED → devolución hecha. NOT_REFUNDED sólo se toma si la orden sigue
//     pagada (sólo cambia el estado a la vista; se puede volver a pedir).
//   * Siempre 200 para que Ualá no reintente en loop (reintenta 3 veces más
//     ante otro código; el POS y el cron de cobros en espera son el respaldo).
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { parseWebhook, refundStateFromOrder, UUID_RE } from "../_shared/ualabis.ts";
import {
  INTENT_COLS,
  clientFor,
  envOfIntent,
  loadCredsScoped,
  syncIntent,
  type IntentRow,
} from "../_shared/ualabis_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const ok = () => new Response("ok", { status: 200 });

Deno.serve(withWebhookLog("ualabis", "ualabis_webhook", async (req: Request, wh) => {
  const reqUrl = new URL(req.url);

  if (req.method === "GET") {
    if (reqUrl.searchParams.get("view") === "failed") {
      return html("<h1>Pago no completado</h1><p>Avisale al cajero para reintentar el cobro.</p>");
    }
    return html(
      "<h1>¡Listo!</h1><p>Si Ualá Bis aprobó el pago, la venta se registra sola en el mostrador. Podés cerrar esta pantalla.</p>",
    );
  }
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    const intentParam = reqUrl.searchParams.get("intent") ?? "";
    const refundParam = reqUrl.searchParams.get("refund") ?? "";

    let hint = null as ReturnType<typeof parseWebhook>;
    try {
      hint = parseWebhook(await readJsonLimited(req));
    } catch {
      /* cuerpo no-JSON: sin uuid no hay nada que re-consultar */
    }
    if (!hint) return ok();
    wh.ref(hint.uuid);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // ── Devolución ────────────────────────────────────────────────────────────
    if (UUID_RE.test(refundParam)) {
      wh.ref(refundParam);
      const { data: rf } = await admin
        .from("ualabis_refunds")
        .select("id, tenant_id, intent_id, order_uuid, status")
        .eq("id", refundParam)
        .maybeSingle();
      const refund = rf as
        | { id: string; tenant_id: string; intent_id: string; order_uuid: string; status: string }
        | null;
      if (!refund || refund.order_uuid !== hint.uuid) return ok();
      wh.tenant(refund.tenant_id);
      if (refund.status === "refunded") return ok(); // idempotente

      const { data: irow } = await admin
        .from("mp_payment_intents")
        .select(INTENT_COLS)
        .eq("id", refund.intent_id)
        .eq("tenant_id", refund.tenant_id)
        .maybeSingle();
      const intent = irow as IntentRow | null;
      if (!intent) return ok();
      const conn = await loadCredsScoped(admin, refund.tenant_id, {
        scopeStoreId: await intentSecretScope(admin, intent.id),
      });
      if (!conn) {
        wh.fail("sin credenciales de Ualá Bis");
        return ok();
      }
      const order = await clientFor(conn.creds, envOfIntent(intent)).getOrder(refund.order_uuid);
      if (!order.ok) {
        wh.fail(`Ualá Bis: ${order.httpStatus} ${order.detail}`);
        return ok();
      }
      const next = refundStateFromOrder(order.value, hint.status);
      if (!next) {
        wh.done();
        return ok();
      }
      const { data: changed } = await admin
        .from("ualabis_refunds")
        .update({ status: next })
        .eq("id", refund.id)
        .in("status", ["requested", "initiated", "failed"])
        .select("id");
      if (changed && changed.length > 0) {
        await admin.from("audit_logs").insert({
          tenant_id: refund.tenant_id,
          actor_user_id: null,
          entity_type: "ualabis_refunds",
          entity_id: refund.id,
          action: `ualabis_refund_${next}`,
          after_data: { intent_id: refund.intent_id, order_uuid: refund.order_uuid, via: "webhook" },
        });
      }
      wh.done();
      return ok();
    }

    // ── Orden ────────────────────────────────────────────────────────────────
    if (!UUID_RE.test(intentParam)) return ok();
    wh.ref(intentParam);
    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentParam)
      .eq("provider_key", "ualabis")
      .maybeSingle();
    const row = data as IntentRow | null;
    if (row) wh.tenant(row.tenant_id);
    if (!row || row.status === "approved") return ok(); // idempotente
    // La orden del cuerpo tiene que ser la que creamos para este intent.
    if (!row.preference_id || row.preference_id !== hint.uuid) {
      wh.fail("orden distinta a la del cobro");
      return ok();
    }

    // ADR-057: la conexión (negocio o sucursal) con la que se creó el cobro.
    const conn = await loadCredsScoped(admin, row.tenant_id, {
      scopeStoreId: await intentSecretScope(admin, row.id),
    });
    if (!conn) {
      wh.fail("sin credenciales de Ualá Bis");
      return ok();
    }

    const res = await syncIntent(admin, row, conn.creds, "webhook", null);
    if ("error" in res) {
      console.error("ualabis_webhook", res.error);
      wh.fail(`Ualá Bis: ${String(res.error)}`);
    } else {
      wh.done();
    }
  } catch (e) {
    console.error("ualabis_webhook", e instanceof Error ? e.message : "error");
    wh.fail(e);
  }
  return ok();
}));
