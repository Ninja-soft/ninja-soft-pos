// =============================================================================
// Edge Function: delivery_channel_webhook · pedidos y eventos de las apps de
// delivery (F13 · H49 integraciones, ADR-102). verify_jwt = false: la llaman
// PedidosYa, Rappi, Uber Eats, Mercado Pago Delivery o el simulador.
//
//   POST ?c=<id de la conexión>
//     1. Cuerpo con tope (requestGuard, 64 KB) y ráfaga por IP acotada.
//     2. Contexto de la conexión (service_role): proveedor, secreto, feature.
//     3. Firma por adaptador (verifySignature). Inválida -> 401.
//     4. Sin la feature canales_delivery en el plan -> 200 sin procesar.
//     5. parseEvent -> eventos normalizados -> RPC delivery_channel_ingest_event
//        (guarda el evento crudo, idempotente por conexión + id del evento, y
//        lo procesa: pedido, comanda, estado, cancelación, repartidor).
//     6. 200 rápido. Si la base no responde -> 500 para que la plataforma
//        reintente (la ingesta es idempotente).
//
// Sin secretos en el log. El adaptador de cada plataforma vive en
// ../_shared/deliveryChannels/.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { BodyTooLargeError, clientIp, createIpLimiter, readTextLimited } from "../_shared/requestGuard.ts";
import { getAdapter } from "../_shared/deliveryChannels/registry.ts";
import { NotImplementedError } from "../_shared/deliveryChannels/types.ts";
import { contextFromRow, type WebhookContextRow } from "../_shared/deliveryChannels/worker.ts";
import { SIM_SIGNATURE_HEADER } from "../_shared/deliveryChannels/simulator.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Un local con mucho movimiento no llega a esto; frena ráfagas desde una IP.
const limiter = createIpLimiter(600, 60_000);

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const ip = clientIp(req);
  if (!limiter.hit(ip)) return json({ error: "rate_limited" }, 429);

  const connectionId = new URL(req.url).searchParams.get("c") ?? "";
  if (!UUID_RE.test(connectionId)) return json({ error: "not_found" }, 404);

  let raw: string;
  try {
    raw = await readTextLimited(req);
  } catch (e) {
    return json({ error: e instanceof BodyTooLargeError ? "body_too_large" : "invalid_body" }, e instanceof BodyTooLargeError ? 413 : 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: row, error: ctxErr } = await admin.rpc("delivery_channel_webhook_context", { p_connection: connectionId });
  if (ctxErr) {
    console.error(JSON.stringify({ fn: "delivery_channel_webhook", stage: "context", error: ctxErr.message }));
    return json({ error: "unavailable" }, 500);
  }
  const ctxRow = row as WebhookContextRow | null;
  if (!ctxRow) return json({ error: "not_found" }, 404);

  const adapter = getAdapter(ctxRow.provider);
  if (!adapter) return json({ error: "not_found" }, 404);
  const ctx = contextFromRow(ctxRow);

  const signed = await adapter.verifySignature({ headers: req.headers, rawBody: raw, ip }, ctx).catch(() => false);
  if (!signed) return json({ error: "invalid_signature" }, 401);

  // Gating server-side también acá: sin la feature no se procesa nada.
  if (!ctxRow.has_feature) return json({ ok: true, ignored: "feature_not_in_plan" });

  let parsed;
  try {
    parsed = adapter.parseEvent(raw, ctx);
  } catch (e) {
    if (e instanceof NotImplementedError) return json({ error: "not_implemented" }, 501);
    return json({ error: "invalid_event", message: e instanceof Error ? e.message : "invalid" }, 400);
  }

  const source = ctxRow.provider === "simulador" && req.headers.get(SIM_SIGNATURE_HEADER) ? "simulador" : "webhook";
  const results: unknown[] = [];
  for (const ev of parsed.events) {
    const { data, error } = await admin.rpc("delivery_channel_ingest_event", {
      p_connection: connectionId,
      p_event: ev,
      p_source: source,
    });
    if (error) {
      // Evento mal formado: reintentarlo no lo arregla.
      if (/invalid_event|connection_not_found/.test(error.message)) return json({ error: "invalid_event" }, 400);
      console.error(JSON.stringify({ fn: "delivery_channel_webhook", stage: "ingest", connection: connectionId, error: error.message }));
      return json({ error: "unavailable" }, 500);
    }
    results.push(data);
  }

  if (parsed.reply) return json(parsed.reply.body, parsed.reply.status);
  return json({ ok: true, results });
});
