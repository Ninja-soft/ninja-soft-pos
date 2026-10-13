// =============================================================================
// Edge Function: ml_webhook: callback de notificaciones de Mercado Libre
// (H87 · ADR-104). PÚBLICA: verify_jwt = false (la llama ML, sin JWT).
//
// ML exige HTTP 200 en menos de 500 ms; si no, DESACTIVA los tópicos. Por eso
// acá no se llama nunca a la API de ML: se valida, se guarda la notificación
// cruda (idempotente por _id) con UNA sola RPC y se responde. El worker
// (ml_worker, cron cada minuto) la procesa con un GET autenticado.
//
// ML no firma las notificaciones. Defensa: cuerpo limitado (16 KB,
// requestGuard), application_id = ML_CLIENT_ID, user_id de una cuenta
// conectada (si no, se descarta), `resource` con el patrón del tópico, límite
// por IP y, sobre todo, el estado real sólo se lee con el token del vendedor:
// un payload falso no puede escribir nada.
// =============================================================================
import { clientIp, createIpLimiter, readTextLimited } from "../_shared/requestGuard.ts";
import { appIdOf } from "../_shared/mercadolibre/config.ts";
import { isMvpTopic, parseNotification } from "../_shared/mercadolibre/notifications.ts";
import { adminClient } from "../_shared/mercadolibre/runtime.ts";

const ok = () => new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
// Ráfagas desde una misma IP (best-effort por isolate). ML manda desde ~50 IPs.
const limiter = createIpLimiter(600, 60_000);
const admin = adminClient();

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  if (req.method === "GET" || req.method === "HEAD") return ok();
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!limiter.hit(clientIp(req))) return new Response("too_many_requests", { status: 429 });

  let raw: unknown;
  try {
    raw = JSON.parse(await readTextLimited(req, 16 * 1024));
  } catch {
    return new Response("invalid_payload", { status: 400 });
  }
  const parsed = parseNotification(raw, appIdOf(Deno.env.toObject()));
  if (!parsed.ok) {
    console.log(JSON.stringify({ fn: "ml_webhook", ignored: parsed.reason, ms: Date.now() - t0 }));
    // 200 igual: ML no tiene que reintentar algo que no vamos a procesar.
    return ok();
  }
  const n = parsed.n;
  const { data, error } = await admin.rpc("ml_notification_ingest", {
    p: {
      dedupe_key: n.dedupeKey,
      notification_id: n.notificationId,
      topic: n.topic,
      resource: n.resource,
      user_id: n.userId,
      attempts: n.attempts,
      sent: n.sent,
      actions: n.actions,
      source: "webhook",
      handled: isMvpTopic(n.topic),
    },
  });
  if (error) {
    console.error(JSON.stringify({ fn: "ml_webhook", error: error.message, topic: n.topic, ms: Date.now() - t0 }));
    // Sin guardar: que ML reintente (lo recupera también missed_feeds).
    return new Response("retry", { status: 503 });
  }
  console.log(JSON.stringify({ fn: "ml_webhook", topic: n.topic, result: data, ms: Date.now() - t0 }));
  return ok();
});
