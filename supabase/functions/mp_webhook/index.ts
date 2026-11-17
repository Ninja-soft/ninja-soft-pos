// =============================================================================
// Edge Function: mp_webhook — recibe notificaciones de Mercado Pago (público,
// sin JWT). Identifica el intent por ?intent=<id>, consulta el pago real en MP
// con el Access Token del tenant (no confía en el body) y actualiza el estado.
// Responde 200 salvo una falla transitoria (MP caído / lento / 5xx / 429 o
// error de base): ahí responde 503 para que MP reintente (PAY-27, ADR-188).
// Un 4xx de MP o un aviso que no es nuestro siguen en 200 (no hay loop).
//
// Desde ADR-032 cubre sólo los pagos de Checkout Pro (link). Las orders de la
// Orders API (QR dinámico y Point) llegan por mp_orders_webhook (topic order).
// El token se elige por el ambiente del intent (mp_env: prod | test).
//
// ADR-064: también recibe los avisos de contracargos (topic_chargebacks_wh)
// y reclamos (topic_claims_integration_wh) configurados en la aplicación de
// MP ("Tus integraciones" > Webhooks, URL sin ?intent). No confía en el
// cuerpo: identifica la cuenta por user_id, vuelve a leer el caso y el pago
// con la credencial del negocio y guarda con _payment_disputes_upsert. Los
// avisos de pagos con ?intent siguen igual.
//
// OPS-23: la lógica vive en _shared/mpWebhookHandlers.ts (handleMpWebhook,
// testeada con Vitest); acá sólo se arman las dependencias reales.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { tenantMpCredential } from "../_shared/mpAuth.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { disputesEnabled, fetchChargeback, fetchClaim, fetchPayment, saveDisputes } from "../_shared/disputesSync.ts";
import { handleMpWebhook, type WebhookDb } from "../_shared/mpWebhookHandlers.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

Deno.serve(withWebhookLog("mercadopago", "mp_webhook", (req: Request, wh) =>
  handleMpWebhook(req, wh, {
    db: () => {
      const url = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      return createClient(url, serviceKey, { auth: { persistSession: false } }) as unknown as WebhookDb;
    },
    credential: (db, tenantId, env, opts) => tenantMpCredential(db as unknown as SupabaseClient, tenantId, env, opts),
    secretScope: (db, intentId) => intentSecretScope(db, intentId),
    fetchMp: (url, init) => fetch(url, init),
    disputes: {
      enabled: disputesEnabled,
      fetchChargeback,
      fetchClaim,
      fetchPayment,
      save: saveDisputes,
    },
    log: { error: (message, data) => console.error(message, data) },
  })));
