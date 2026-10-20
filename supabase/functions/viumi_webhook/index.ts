// =============================================================================
// Edge Function: viumi_webhook · notificaciones de Viumi (F8 · ADR-173).
// verify_jwt = false (la llama Viumi). Se publica en
// https://hooks.soft.ninja/viumi (ADR-069).
//
//   * POST ?intent=<uuid> → webhook del pago, cuerpo { data: { type: "Payment",
//     order: { uuid, status, source }, payment: { id, authorizationCode,
//     refNumber, status } } } SIN firma documentada. NUNCA confía en el cuerpo:
//     el uuid de la orden sólo indica qué re-consultar (GET /api/v2/orders/{uuid})
//     con la credencial del negocio, y tiene que ser el guardado en el intent.
//     Acredita sólo con un pago aprobado + monto exacto. Idempotente (updates
//     condicionales; un intent approved no se toca).
//   * GET → pantalla neutra (por si alguien abre la URL). No confirma nada.
//   * Siempre 200 para que Viumi no reintente en loop (el POS y el cron de
//     cobros en espera son el respaldo).
// =============================================================================
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { parseWebhook, UUID_RE } from "../_shared/viumi.ts";
import { INTENT_COLS, loadCredsScoped, syncIntent, type IntentRow } from "../_shared/viumi_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const ok = () => new Response("ok", { status: 200 });

Deno.serve(withWebhookLog("viumi", "viumi_webhook", async (req: Request, wh) => {
  const reqUrl = new URL(req.url);

  if (req.method === "GET") return ok();
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    const intentParam = reqUrl.searchParams.get("intent") ?? "";

    let hint = null as ReturnType<typeof parseWebhook>;
    try {
      hint = parseWebhook(await readJsonLimited(req));
    } catch {
      /* cuerpo no-JSON: sin uuid no hay nada que re-consultar */
    }
    if (!hint) return ok();
    wh.ref(hint.uuid);

    if (!UUID_RE.test(intentParam)) return ok();
    wh.ref(intentParam);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentParam)
      .eq("provider_key", "viumi")
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
      wh.fail("sin credenciales de Viumi");
      return ok();
    }

    const res = await syncIntent(admin, row, conn.creds, "webhook", null);
    if ("error" in res) {
      console.error("viumi_webhook", res.error);
      wh.fail(`Viumi: ${String(res.error)}`);
    } else {
      wh.done();
    }
  } catch (e) {
    console.error("viumi_webhook", e instanceof Error ? e.message : "error");
    wh.fail(e);
  }
  return ok();
}));
