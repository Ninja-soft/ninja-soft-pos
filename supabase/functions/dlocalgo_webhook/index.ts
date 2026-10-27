// =============================================================================
// Edge Function: dlocalgo_webhook · notificaciones de dLocal Go (F8 · ADR-180).
// verify_jwt = false (la llama dLocal Go). Se publica en
// https://hooks.soft.ninja/dlocalgo (ADR-069).
//
//   * POST ?intent=<uuid> → notificación del pago, cuerpo { payment_id } con
//     el header "Authorization: V2-HMAC-SHA256, Signature: <hex>". La firma
//     (HMAC-SHA256 con la Secret Key del negocio sobre API_KEY + cuerpo crudo)
//     se verifica con la credencial con la que se creó el cobro; sin firma
//     válida no se procesa. Igual NUNCA se confía en el cuerpo: el payment_id
//     tiene que ser el guardado en el intent y el pago se RE-CONSULTA (GET
//     /v1/payments/{id}). Acredita sólo PAID + order_id = intent + ARS + monto
//     exacto. Idempotente (updates condicionales; un intent approved no se toca).
//   * POST ?refund=<uuid> → notificación de la devolución. Misma firma; se
//     re-consulta GET /v1/refunds/{id} con el id que guardamos: SUCCESS →
//     devuelto · REJECTED / CANCELLED → no se pudo (se puede volver a pedir).
//   * GET → 200 neutro (por si alguien abre la URL). No confirma nada.
//   * Siempre 200: dLocal Go reintenta cada 10 min hasta 30 días ante otro
//     código; el POS y el cron de cobros en espera son el respaldo.
// =============================================================================
import { readTextLimited } from "../_shared/requestGuard.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { mapRefundStatus, parseNotification, UUID_RE, verifySignature } from "../_shared/dlocalgo.ts";
import {
  INTENT_COLS,
  clientFor,
  envOfIntent,
  loadCredsScoped,
  syncIntent,
  type IntentRow,
} from "../_shared/dlocalgo_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import { withWebhookLog } from "../_shared/webhookLog.ts";

const ok = () => new Response("ok", { status: 200 });

Deno.serve(withWebhookLog("dlocalgo", "dlocalgo_webhook", async (req: Request, wh) => {
  const reqUrl = new URL(req.url);

  if (req.method === "GET") return ok();
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  try {
    const intentParam = reqUrl.searchParams.get("intent") ?? "";
    const refundParam = reqUrl.searchParams.get("refund") ?? "";
    const signature = req.headers.get("authorization");

    let raw = "";
    try {
      raw = await readTextLimited(req);
    } catch {
      return ok(); // cuerpo demasiado grande o ilegible: nada que re-consultar
    }
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const hint = parseNotification(body);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // ── Devolución ────────────────────────────────────────────────────────────
    if (UUID_RE.test(refundParam)) {
      wh.ref(refundParam);
      const { data: rf } = await admin
        .from("dlocalgo_refunds")
        .select("id, tenant_id, intent_id, payment_id, refund_ref, status")
        .eq("id", refundParam)
        .maybeSingle();
      const refund = rf as
        | { id: string; tenant_id: string; intent_id: string; payment_id: string; refund_ref: string | null; status: string }
        | null;
      if (!refund) return ok();
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
        wh.fail("sin credenciales de dLocal Go");
        return ok();
      }
      if (!(await verifySignature(conn.creds, raw, signature))) {
        wh.fail("firma inválida");
        return ok();
      }
      // El id de la devolución: el que guardamos al pedirla (o el del cuerpo
      // firmado si todavía no lo teníamos).
      const ref = refund.refund_ref ?? hint.refundId;
      if (!ref) {
        wh.done();
        return ok();
      }
      const got = await clientFor(conn.creds, envOfIntent(intent)).getRefund(ref);
      if (!got.ok) {
        wh.fail(`dLocal Go: ${got.httpStatus} ${got.detail}`);
        return ok();
      }
      const next = mapRefundStatus((got.value as { status?: unknown }).status);
      if (!next || next === refund.status) {
        wh.done();
        return ok();
      }
      const { data: changed } = await admin
        .from("dlocalgo_refunds")
        .update({ status: next, refund_ref: ref, error_code: next === "failed" ? "refund_rejected" : null })
        .eq("id", refund.id)
        .in("status", ["requested", "initiated", "failed"])
        .select("id");
      if (changed && changed.length > 0) {
        await admin.from("audit_logs").insert({
          tenant_id: refund.tenant_id,
          actor_user_id: null,
          entity_type: "dlocalgo_refunds",
          entity_id: refund.id,
          action: `dlocalgo_refund_${next}`,
          after_data: { intent_id: refund.intent_id, payment_id: refund.payment_id, refund_ref: ref, via: "webhook" },
        });
      }
      wh.done();
      return ok();
    }

    // ── Pago ─────────────────────────────────────────────────────────────────
    if (!hint.paymentId) return ok();
    wh.ref(hint.paymentId);
    if (!UUID_RE.test(intentParam)) return ok();
    wh.ref(intentParam);

    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentParam)
      .eq("provider_key", "dlocalgo")
      .maybeSingle();
    const row = data as IntentRow | null;
    if (row) wh.tenant(row.tenant_id);
    if (!row || row.status === "approved") return ok(); // idempotente
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
      wh.fail("sin credenciales de dLocal Go");
      return ok();
    }
    if (!(await verifySignature(conn.creds, raw, signature))) {
      wh.fail("firma inválida");
      return ok();
    }

    const res = await syncIntent(admin, row, conn.creds, "webhook", null);
    if ("error" in res) {
      console.error("dlocalgo_webhook", res.error);
      wh.fail(`dLocal Go: ${String(res.error)}`);
    } else {
      wh.done();
    }
  } catch (e) {
    console.error("dlocalgo_webhook", e instanceof Error ? e.message : "error");
    wh.fail(e);
  }
  return ok();
}));
