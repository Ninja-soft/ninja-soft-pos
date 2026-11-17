// =============================================================================
// Edge Function: mp_orders_webhook — notificaciones topic `order` de la Orders
// API de Mercado Pago (QR dinámico y Point, ADR-032). Público (deploy con
// --no-verify-jwt). La URL se configura en el panel de la aplicación de MP
// (Webhooks → evento Order), no por order.
//
// Reglas (iguales al polling del POS, _shared/mpIntents.ts):
//   * Nunca se confía en el payload: sólo se toma data.id, se busca el intent
//     por mp_order_id y la order se RE-LEE con el token del tenant (en el
//     ambiente con que se creó el intent).
//   * Se acredita sólo processed + pago processed + monto exacto +
//     external_reference = intent. Idempotente (transiciones desde pending).
//   * MP corta la notificación a los 22 s y la reintenta. PAY-27 (ADR-188):
//     todo es sincrónico: credencial (tope 6 s), lectura de la order (8 s) y
//     applyOrderToIntent. Si algo falla de forma transitoria (red, timeout,
//     5xx, 429, 401 con OAuth, base, escritura del estado) responde 503 y MP
//     reintenta; la acreditación es idempotente.
//
// OPS-23: la lógica vive en _shared/mpWebhookHandlers.ts (handleMpOrdersWebhook,
// testeada con Vitest); acá sólo se arman las dependencias reales.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { tenantMpCredential } from "../_shared/mpAuth.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { applyOrderToIntent, fetchOrder, ORDER_INTENT_COLUMNS, type OrderIntentRow } from "../_shared/mpIntents.ts";
import { handleMpOrdersWebhook, type WebhookDb } from "../_shared/mpWebhookHandlers.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const sb = (db: WebhookDb) => db as unknown as SupabaseClient;

Deno.serve(withWebhookLog("mercadopago_orders", "mp_orders_webhook", (req: Request, wh) =>
  handleMpOrdersWebhook(req, wh, {
    db: () => {
      const url = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      return createClient(url, serviceKey, { auth: { persistSession: false } }) as unknown as WebhookDb;
    },
    intentColumns: ORDER_INTENT_COLUMNS,
    credential: (db, tenantId, env, opts) => tenantMpCredential(sb(db), tenantId, env, opts),
    secretScope: (db, intentId, opts) => intentSecretScope(db, intentId, opts),
    fetchOrder,
    applyOrder: (db, row, order, actor, opts) => applyOrderToIntent(sb(db), row as OrderIntentRow, order, actor, opts),
    log: { error: (message, data) => console.error(message, data) },
  })));
