// =============================================================================
// Edge Function: talo_webhook · notificaciones de pagos de Talo (F8 · ADR-175).
// verify_jwt = false (la llama Talo). Se publica en
// https://hooks.soft.ninja/talo (ADR-069).
//
//   * POST ?intent=<uuid> → cuerpo { message, paymentId, externalId } SIN firma
//     (la firma HMAC X-Talo-Signature figura como "próximamente" en la doc).
//     NUNCA confía en el cuerpo: el paymentId sólo indica qué pago re-consultar
//     (GET /payments/{id}) con la credencial del negocio, y tiene que ser el
//     guardado en el intent. Acredita sólo SUCCESS u OVERPAID + external_id =
//     intent + precio del intent. Idempotente (updates condicionales; un intent
//     approved sólo actualiza lo recibido y las devoluciones en curso).
//   * Siempre 200 y rápido (la doc pide responder en menos de 3 segundos; el
//     POS y el cron de cobros en espera son el respaldo).
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { parseWebhook, UUID_RE } from "../_shared/talo.ts";
import { INTENT_COLS, loadCredsScoped, syncIntent, type IntentRow } from "../_shared/talo_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const ok = () => new Response("ok", { status: 200 });

Deno.serve(withWebhookLog("talo", "talo_webhook", async (req: Request, wh) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  const reqUrl = new URL(req.url);

  try {
    const intentParam = reqUrl.searchParams.get("intent") ?? "";

    let hint = null as ReturnType<typeof parseWebhook>;
    try {
      hint = parseWebhook(await readJsonLimited(req));
    } catch {
      /* cuerpo no-JSON: sin paymentId no hay nada que re-consultar */
    }
    if (!hint) return ok();
    wh.ref(hint.paymentId);
    if (!UUID_RE.test(intentParam)) return ok();
    // Si el cuerpo trae externalId, tiene que ser el intent de la URL.
    if (hint.externalId && hint.externalId !== intentParam) {
      wh.fail("externalId distinto al cobro");
      return ok();
    }
    wh.ref(intentParam);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentParam)
      .eq("provider_key", "talo")
      .maybeSingle();
    const row = data as IntentRow | null;
    if (!row) return ok();
    wh.tenant(row.tenant_id);
    // El pago del cuerpo tiene que ser el que creamos para este intent.
    if (!row.preference_id || row.preference_id !== hint.paymentId) {
      wh.fail("pago distinto al del cobro");
      return ok();
    }

    // ADR-057: la conexión (negocio o sucursal) con la que se creó el cobro.
    const conn = await loadCredsScoped(admin, row.tenant_id, {
      scopeStoreId: await intentSecretScope(admin, row.id),
    });
    if (!conn) {
      wh.fail("sin credenciales de Talo");
      return ok();
    }

    // Un intent approved igual se re-consulta: puede haber llegado más plata
    // (OVERPAID) o cambiado una devolución en curso. El estado no se toca.
    const res = await syncIntent(admin, row, conn.creds, "webhook", null);
    if ("error" in res) {
      console.error("talo_webhook", res.error);
      wh.fail(`Talo: ${String(res.error)}`);
    } else {
      wh.done();
    }
  } catch (e) {
    console.error("talo_webhook", e instanceof Error ? e.message : "error");
    wh.fail(e);
  }
  return ok();
}));
