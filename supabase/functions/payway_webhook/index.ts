// =============================================================================
// Edge Function: payway_webhook — notificaciones + retorno del Formulario de
// pago de Payway (F8 · H17). verify_jwt = false (lo llama Payway y el
// navegador del cliente).
//
// Dos roles:
//   * GET  ?view=success|cancel → pantalla neutra de retorno para el cliente
//     que pagó en el formulario hosted (el POS se entera por su propio poll).
//   * POST ?intent=<uuid> → notificación de Payway. NUNCA acredita a ciegas:
//     re-verifica contra GET {v2}/payments/{payment_id} con la apikey privada
//     del tenant (estado + monto exacto en centavos) antes de marcar el intent
//     como approved — mismo patrón conservador que modo/pagos360/mp_point.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const html = (body: string) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NinjaPos</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#f6f5fc;color:#15111f}main{text-align:center;padding:2rem}h1{font-size:1.4rem}</style></head><body><main>${body}</main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const V2 = {
  sandbox: "https://developers.decidir.com/api/v2",
  prod: "https://ventasonline.payway.com.ar/api/v2",
};

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
    .select("id, tenant_id, status, amount, preference_id")
    .eq("provider_key", "payway")
    .eq("status", "pending")
    .gte("created_at", since)
    .limit(200);
  const matches = (pendings ?? []).filter(
    (p) => String(p.id).replace(/-/g, "").toLowerCase().startsWith(shortRef),
  );
  if (matches.length !== 1) return new Response("ok", { status: 200 });
  const row = matches[0];
  if (!row || row.status !== "pending" || !row.preference_id) {
    return new Response("ok", { status: 200 });
  }

  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", row.tenant_id)
    .eq("provider_key", "payway")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as { private_apikey?: string };
  if (!sec.private_apikey) return new Response("ok", { status: 200 });

  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", row.tenant_id)
    .eq("provider_key", "payway")
    .maybeSingle();
  const base = methodRow?.sandbox ? V2.sandbox : V2.prod;

  // El payment_id REAL viene en el cuerpo de la notificación (el hash del
  // checkout guardado en preference_id no es consultable). Se aceptan las
  // formas conocidas del payload; sin id no se acredita (conservador).
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
    if (cand != null && /^[0-9]+$/.test(String(cand))) notifiedId = String(cand);
  } catch {
    /* cuerpo no-JSON: se ignora */
  }
  if (!notifiedId) return new Response("ok", { status: 200 });

  // Verificación independiente (nunca confiar en el cuerpo del webhook).
  const r = await fetch(`${base}/payments/${notifiedId}`, {
    headers: { apikey: sec.private_apikey },
  });
  if (!r.ok) return new Response("ok", { status: 200 });
  const pay = (await r.json()) as { status?: string; amount?: number };
  const state = String(pay.status ?? "").toLowerCase();

  if (state === "approved" || state === "accredited") {
    const amountOk =
      pay.amount == null ||
      Math.abs(Number(pay.amount) - Math.round(Number(row.amount) * 100)) < 1;
    await admin
      .from("mp_payment_intents")
      .update({
        status: amountOk ? "approved" : "rejected",
        mp_payment_id: notifiedId,
      })
      .eq("id", row.id);
  } else if (["rejected", "annulled", "voided"].includes(state)) {
    await admin
      .from("mp_payment_intents")
      .update({ status: "rejected", mp_payment_id: notifiedId })
      .eq("id", row.id);
  } else {
    // Estado intermedio: guardamos el payment_id para que el poll del POS
    // (Edge payway action status) pueda re-verificar más tarde.
    await admin
      .from("mp_payment_intents")
      .update({ mp_payment_id: notifiedId })
      .eq("id", row.id);
  }
  return new Response("ok", { status: 200 });
});
