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
//   * Responde 200 enseguida (MP corta a los 22 s y reintenta): el trabajo
//     corre en segundo plano con EdgeRuntime.waitUntil cuando está disponible.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { runInBackground, tenantMpCredential } from "../_shared/mpAuth.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import {
  applyOrderToIntent,
  fetchOrder,
  ORDER_INTENT_COLUMNS,
  type OrderIntentRow,
} from "../_shared/mpIntents.ts";
import { parseOrderNotification } from "../_shared/mpOrders.ts";

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

async function handle(orderId: string): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: rowRaw } = await admin
    .from("mp_payment_intents")
    .select(ORDER_INTENT_COLUMNS)
    .eq("mp_order_id", orderId)
    .maybeSingle();
  const row = rowRaw as OrderIntentRow | null;
  if (!row) return; // order que no es nuestra (u otra integración de la cuenta).
  if (row.status === "approved") return; // ya acreditado: idempotente.

  // ADR-057: la credencial (negocio o sucursal) con la que se creó el cobro.
  const cred = await tenantMpCredential(admin, row.tenant_id, row.mp_env ?? "prod", {
    scopeStoreId: await intentSecretScope(admin, row.id),
  });
  if (!cred) return;
  const got = await fetchOrder(cred.token, orderId);
  if (!got.ok) {
    console.error("[mp_orders_webhook] no se pudo leer la order", {
      orderId,
      status: got.status,
    });
    return;
  }
  await applyOrderToIntent(admin, row, got.order, { userId: null, source: "webhook" });
}

Deno.serve(async (req: Request) => {
  try {
    const reqUrl = new URL(req.url);
    let body: unknown = null;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = null;
      }
    }
    const n = parseOrderNotification(reqUrl, body);
    if (n.type !== "order" || !n.orderId) return ok();

    const pending = runInBackground(handle(n.orderId));
    if (pending) await pending;
    return ok();
  } catch {
    return ok();
  }
});
