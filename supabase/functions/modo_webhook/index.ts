// =============================================================================
// Edge Function: modo_webhook — recibe notificaciones de MODO (público, sin
// JWT: lo llama MODO). Identifica el intent por ?intent=<id>. verify_jwt = false.
//
// Exige external_intention_id = intent y re-consulta la intención a MODO con
// las credenciales del negocio: sólo se aplica el estado que devuelve MODO
// ("approved" además con el monto esperado). SEC-63: si la re-consulta falla
// (red, timeout, HTTP no-2xx) responde 503 para que MODO reintente y no aplica
// nada del cuerpo; antes aplicaba rejected / cancelled / expired sin verificar.
//
// La lógica vive en _shared/modoWebhookHandler.ts (handleModoWebhook, testeada
// con Vitest en tests/unit/modoWebhook.test.ts); acá sólo se arman las
// dependencias reales. Ver la limitación "VALIDAR MODO" en ese archivo.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { intentSecretScope, loadProviderSecret } from "../_shared/paymentSecrets.ts";
import { handleModoWebhook, type ModoSecrets, type ModoWebhookDb } from "../_shared/modoWebhookHandler.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

// ⚠️ VALIDAR MODO — base URLs / endpoints (mismos overrides que modo_create_qr).
const MODO_API_BASE = Deno.env.get("MODO_API_BASE") ?? "https://merchants.preprod.playdigital.com.ar";
const MODO_TOKEN_URL = Deno.env.get("MODO_TOKEN_URL") ?? `${MODO_API_BASE}/merchants/v2/auth/token`;
const MODO_INTENT_URL = Deno.env.get("MODO_INTENT_URL") ?? `${MODO_API_BASE}/merchants/v2/payment-intentions`;

Deno.serve(withWebhookLog("modo", "modo_webhook", (req: Request, wh) =>
  handleModoWebhook(req, wh, {
    db: () => {
      const url = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      return createClient(url, serviceKey, { auth: { persistSession: false } }) as unknown as ModoWebhookDb;
    },
    loadSecret: async (db, tenantId, intentId) => {
      const row = await loadProviderSecret(db, tenantId, "modo", {
        scopeStoreId: await intentSecretScope(db, intentId),
      });
      return (row?.secrets ?? null) as ModoSecrets | null;
    },
    fetch: (url, init) => fetch(url, init),
    tokenUrl: MODO_TOKEN_URL,
    intentUrl: MODO_INTENT_URL,
    log: { error: (message, data) => console.error(message, data) },
  })));
