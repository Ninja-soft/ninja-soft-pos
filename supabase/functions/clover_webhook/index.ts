// =============================================================================
// Edge Function: clover_webhook: notificaciones de pagos de Clover (ADR-047).
// verify_jwt = false (lo llama Clover). Los webhooks de Clover son POR APP: la
// URL se configura una sola vez en la app de NinjaSoft del Developer Dashboard
// de Clover (App Settings, Webhooks), suscripta a Payments:
//   {SUPABASE_URL}/functions/v1/clover_webhook
//
//   * POST { verificationCode } → Clover la manda al registrar la URL. Se
//     escribe en el log de la función para copiarla en el Dashboard y se
//     responde 200 (no toca datos).
//   * POST { appId, merchants: { [mId]: [{ objectId: "P:<id>" }] } } → el
//     header X-Clover-Auth tiene que coincidir con el secret de función
//     CLOVER_WEBHOOK_AUTH (Clover Auth Code de la app). NUNCA se confía en el
//     cuerpo: por cada merchant se ubican los tenants con esa conexión Fiserv y
//     se re-consultan sus intents pendientes de Clover contra la API
//     (GET /connect/v1/payments/external/{ext}), con la misma regla del poll.
//
// Siempre 200 (salvo auth inválida: 401) para que Clover no desactive la URL;
// el poll del POS sigue siendo el respaldo.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { parseCloverWebhook, safeEqual } from "../_shared/clover.ts";
import {
  CONNECTION,
  INTENT_COLS,
  PROVIDER,
  loadConnectionForIntent,
  syncIntent,
  type IntentRow,
} from "../_shared/clover_server.ts";

const ok = () => new Response("ok", { status: 200 });

// Intents pendientes que se re-verifican por merchant notificado.
const MAX_INTENTS = 20;
const WINDOW_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    return ok();
  }
  const hook = parseCloverWebhook(raw);
  if (!hook) return ok();

  if (hook.kind === "verification") {
    // Se copia del log al Developer Dashboard de Clover (paso único).
    console.log("[clover_webhook] verificationCode:", hook.code);
    return ok();
  }

  const expected = Deno.env.get("CLOVER_WEBHOOK_AUTH") ?? "";
  const got = req.headers.get("X-Clover-Auth") ?? "";
  if (!expected || !safeEqual(got, expected)) return new Response("unauthorized", { status: 401 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  for (const m of hook.merchants) {
    // Tenants con esa conexión Fiserv (el merchant_id vive en el secreto).
    const { data: conns } = await admin
      .from("payment_secrets")
      .select("tenant_id")
      .eq("provider_key", CONNECTION)
      .eq("secrets->>merchant_id", m.merchantId);
    for (const c of (conns ?? []) as { tenant_id: string }[]) {
      const { data: rows } = await admin
        .from("mp_payment_intents")
        .select(INTENT_COLS)
        .eq("tenant_id", c.tenant_id)
        .eq("provider_key", PROVIDER)
        .eq("status", "pending")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(MAX_INTENTS);
      for (const row of (rows ?? []) as IntentRow[]) {
        try {
          const conn = await loadConnectionForIntent(admin, row);
          if (conn) await syncIntent(admin, conn, row, "webhook");
        } catch {
          // Transitorio: el poll del POS lo resuelve.
        }
      }
    }
  }
  return ok();
});
