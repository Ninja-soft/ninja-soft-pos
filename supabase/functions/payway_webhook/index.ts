// =============================================================================
// Edge Function: payway_webhook (F8 · H17). verify_jwt = false.
//
// Hoy NO es parte del flujo de cobro: el checkout propio (/pagar + Edge
// payway_checkout) aprueba de forma SINCRÓNICA con la respuesta de POST
// /payments, y el poll del POS (Edge payway action status) re-verifica los
// pagos en revisión con row.mp_payment_id. No se manda notifications_url.
// Se mantiene inofensivo por compatibilidad (links viejos del formulario
// hosted y notificaciones configuradas a mano en el panel del comercio):
//   * GET  ?view=success|cancel → pantalla neutra de retorno.
//   * POST ?i=<12 hex del intent> → NUNCA acredita a ciegas: toma el id de
//     pago del cuerpo y re-verifica contra GET {v2}/payments/{id} con la apikey
//     privada del tenant (approved + monto EXACTO en centavos +
//     site_transaction_id == intent). Lógica en _shared/payway.ts.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { decidePaymentStatus, paywayPaymentId, paywayV2Base } from "../_shared/payway.ts";
import { intentSecretScope, loadProviderSecret } from "../_shared/paymentSecrets.ts";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

Deno.serve(async (req: Request) => {
  const reqUrl = new URL(req.url);

  // Pantallas de retorno del cliente (GET desde el navegador).
  if (req.method === "GET") {
    const view = reqUrl.searchParams.get("view");
    if (view === "cancel") {
      return html(
        "<h1>Pago cancelado</h1><p>Avisale al cajero para reintentar el cobro.</p>",
      );
    }
    return html(
      "<h1>¡Listo!</h1><p>Si el pago se aprobó, la venta se registra sola en el mostrador. Podés cerrar esta pantalla.</p>",
    );
  }

  if (req.method !== "POST") {
    return new Response("method_not_allowed", { status: 405 });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Correlación por prefijo corto (?i=<12 hex del intent>): el validador de
  // notifications_url de Payway limita la URL a ~100 caracteres, así que el
  // UUID entero no entra. Se resuelve contra los intents payway PENDIENTES
  // recientes; con ambigüedad (prefijo repetido) no se acredita.
  const shortRef = (reqUrl.searchParams.get("i") ?? "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(shortRef)) {
    return new Response("ok", { status: 200 });
  }
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: pendings } = await admin
    .from("mp_payment_intents")
    .select("id, tenant_id, status, amount")
    .eq("provider_key", "payway")
    .eq("status", "pending")
    .gte("created_at", since)
    .limit(200);
  const matches = (pendings ?? []).filter(
    (p) => String(p.id).replace(/-/g, "").toLowerCase().startsWith(shortRef),
  );
  if (matches.length !== 1) return new Response("ok", { status: 200 });
  const row = matches[0];
  if (!row || row.status !== "pending") {
    return new Response("ok", { status: 200 });
  }

  const secretRow = await loadProviderSecret(admin, row.tenant_id, "payway", { scopeStoreId: await intentSecretScope(admin, row.id) });
  const sec = (secretRow?.secrets ?? {}) as { private_apikey?: string };
  if (!sec.private_apikey) return new Response("ok", { status: 200 });

  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", row.tenant_id)
    .eq("provider_key", "payway")
    .maybeSingle();
  const base = paywayV2Base(methodRow?.sandbox);

  // El payment_id viene en el cuerpo de la notificación (sólo como pista: se
  // re-verifica). Se aceptan las formas conocidas; sin id no se acredita.
  let notifiedId: string | null = null;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const cand =
      body.payment_id ??
      body.id ??
      (body.payment as { id?: unknown } | undefined)?.id ??
      (Array.isArray(body.payments)
        ? (body.payments[0] as { id?: unknown } | undefined)?.id
        : undefined);
    notifiedId = paywayPaymentId(cand);
  } catch {
    /* cuerpo no-JSON: se ignora */
  }
  if (!notifiedId) return new Response("ok", { status: 200 });

  // Verificación independiente (nunca confiar en el cuerpo del webhook).
  const r = await fetch(`${base}/payments/${notifiedId}`, {
    headers: { apikey: sec.private_apikey },
  }).catch(() => null);
  if (!r || !r.ok) return new Response("ok", { status: 200 });
  const decision = decidePaymentStatus(
    await r.json().catch(() => null),
    Number(row.amount),
    row.id,
  );
  if (decision.status === "ignore") return new Response("ok", { status: 200 });
  await admin
    .from("mp_payment_intents")
    .update(
      decision.status === "pending"
        ? // Estado intermedio: guardamos el id para que el poll del POS
          // (Edge payway action status) lo re-verifique.
          { mp_payment_id: notifiedId }
        : { status: decision.status, mp_payment_id: notifiedId },
    )
    .eq("id", row.id)
    .eq("status", "pending");
  return new Response("ok", { status: 200 });
});
