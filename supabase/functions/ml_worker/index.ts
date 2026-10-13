// =============================================================================
// Edge Function: ml_worker: procesa la integración con Mercado Libre
// (H87 · ADR-104). Deploy: verify_jwt = true (el cron manda el anon key como
// Bearer y X-Cron-Secret = platform_secrets('internal_cron').token).
//
// Modos (body.mode):
//   cron       1) inbox: notificaciones (órdenes, ítems, preguntas, envíos)
//                 con GET autenticado del recurso; 2) cola de escrituras
//                 (stock, precio, estado, respuestas, subida de facturas) con
//                 límite de llamadas por cuenta y backoff. En ese orden.
//   reconcile  missed_feeds de la app (2 días) + órdenes actualizadas de cada
//              cuenta (orders/search) -> al inbox (idempotente).
//   tokens     renueva los tokens que vencen pronto (lock por cuenta) y toca
//              las cuentas sin uso.
// Lógica pura y testeada en ../_shared/mercadolibre/*.
// =============================================================================
import { appIdOf } from "../_shared/mercadolibre/config.ts";
import { MlApiError } from "../_shared/mercadolibre/client.ts";
import { getAccessToken } from "../_shared/mercadolibre/oauth.ts";
import { isMvpTopic, parseNotification, syntheticOrderNotification } from "../_shared/mercadolibre/notifications.ts";
import {
  jobFamily,
  processJob,
  processNotification,
  type JobRow,
  type NotificationRow,
} from "../_shared/mercadolibre/worker.ts";
import type { MlMissedFeeds, MlOrderSearch } from "../_shared/mercadolibre/types.ts";
import {
  accountClient,
  adminClient,
  cors,
  json,
  mlConfig,
  postFormAs,
  rpcOf,
  safeEqual,
  tokenDeps,
} from "../_shared/mercadolibre/runtime.ts";

const BUDGET_MS = 45_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const admin = adminClient();

  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
  const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
  if (!cronSecret || !token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);

  const cfg = mlConfig();
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);
  let body: { mode?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const t0 = Date.now();
  const rpc = rpcOf(admin);
  const clients = new Map<string, ReturnType<typeof accountClient>>();
  const deps = {
    rpc,
    client: (id: string) => {
      let c = clients.get(id);
      if (!c) {
        c = accountClient(admin, cfg.config, id);
        clients.set(id, c);
      }
      return c;
    },
    postForm: (id: string, path: string, form: FormData) => postFormAs(admin, cfg.config, id, path, form),
  };
  const out: Record<string, unknown> = { mode: body.mode ?? "cron" };

  try {
    if (body.mode === "reconcile") {
      out.result = await reconcile(admin, deps, cfg.config.clientId, t0);
    } else if (body.mode === "tokens") {
      out.result = await tokens(admin, cfg.config, deps, t0);
    } else {
      // 1) Inbox.
      let notes = 0;
      while (Date.now() - t0 < BUDGET_MS * 0.6) {
        const batch = (await rpc("ml_notifications_claim", { p_limit: 20 })) as NotificationRow[];
        if (!batch?.length) break;
        for (const n of batch) {
          const o = await processNotification(deps, n);
          await rpc("ml_notification_finish", {
            p_id: n.id,
            p_status: o.status === "retry" ? "error" : o.status,
            p_error: "error" in o ? o.error : (o.note ?? null),
            p_retry_ms: "retryMs" in o ? o.retryMs : null,
          });
          notes++;
        }
      }
      // 2) Cola de escrituras.
      let jobs = 0;
      while (Date.now() - t0 < BUDGET_MS) {
        const batch = (await rpc("ml_jobs_claim", { p_limit: 20 })) as JobRow[];
        if (!batch?.length) break;
        for (const j of batch) {
          // Cuentas sin la feature o desconectadas: el trabajo se cancela.
          const o = await processJob(deps, j);
          await rpc("ml_job_finish", {
            p_id: j.id,
            p_status: o.status === "ignored" ? "done" : o.status,
            p_error: "error" in o ? o.error : (o.note ?? null),
            p_result: "note" in o && o.note ? { note: o.note, family: jobFamily(j.kind) } : null,
            p_retry_ms: "retryMs" in o ? o.retryMs : null,
          });
          jobs++;
        }
      }
      out.notifications = notes;
      out.jobs = jobs;
    }
  } catch (e) {
    console.error(JSON.stringify({ fn: "ml_worker", error: String(e instanceof Error ? e.message : e) }));
    return json({ ok: false, error: "worker_failed", ms: Date.now() - t0 }, 500);
  }
  out.ms = Date.now() - t0;
  console.log(JSON.stringify({ fn: "ml_worker", ...out }));
  return json({ ok: true, ...out });
});

// deno-lint-ignore no-explicit-any
type Admin = any;
type Deps = { rpc: ReturnType<typeof rpcOf>; client: (id: string) => ReturnType<typeof accountClient> };

async function reconcile(admin: Admin, deps: Deps, appId: string, t0: number) {
  const due = ((await deps.rpc("ml_accounts_due", { p_kind: "poll" })) ?? []) as Array<{
    account_id: string;
    ml_user_id: number;
    last_orders_poll_at: string | null;
  }>;
  let missed = 0;
  let polled = 0;
  // missed_feeds es de la app: se lee con el token de cualquier cuenta activa.
  if (due.length > 0) {
    try {
      const feeds = await deps.client(due[0]!.account_id).get<MlMissedFeeds>("/missed_feeds", { app_id: appId, limit: 100 });
      for (const m of feeds.messages ?? []) {
        const p = parseNotification(m, appIdOf(Deno.env.toObject()));
        if (!p.ok) continue;
        await deps.rpc("ml_notification_ingest", {
          p: {
            dedupe_key: p.n.dedupeKey, notification_id: p.n.notificationId, topic: p.n.topic, resource: p.n.resource,
            user_id: p.n.userId, attempts: p.n.attempts, sent: p.n.sent, actions: p.n.actions,
            source: "missed_feeds", handled: isMvpTopic(p.n.topic),
          },
        });
        missed++;
      }
    } catch (e) {
      console.error(JSON.stringify({ fn: "ml_worker", step: "missed_feeds", error: String(e instanceof Error ? e.message : e) }));
    }
  }
  for (const a of due) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const started = new Date();
    const fromMs = a.last_orders_poll_at ? Date.parse(a.last_orders_poll_at) - 15 * 60_000 : Date.now() - 2 * 86400_000;
    try {
      const res = await deps.client(a.account_id).get<MlOrderSearch>("/orders/search", {
        seller: a.ml_user_id,
        "order.date_last_updated.from": new Date(fromMs).toISOString(),
        sort: "date_desc",
        limit: 50,
      });
      for (const o of res.results ?? []) {
        const s = syntheticOrderNotification(o.id, a.ml_user_id, o.last_updated ?? o.date_closed ?? o.date_created);
        await deps.rpc("ml_notification_ingest", { p: { ...s, source: "poll", handled: true } });
      }
      await deps.rpc("ml_account_polled", { p_account: a.account_id, p_at: started.toISOString(), p_error: null });
      polled++;
    } catch (e) {
      const msg = e instanceof MlApiError ? `${e.code}: ${e.message}` : String(e);
      await deps.rpc("ml_account_polled", { p_account: a.account_id, p_at: null, p_error: msg.slice(0, 400) });
    }
  }
  void admin;
  return { missed, polled };
}

async function tokens(admin: Admin, cfg: { clientId: string; clientSecret: string; redirectUri: string }, deps: Deps, t0: number) {
  const due = ((await deps.rpc("ml_accounts_due", { p_kind: "tokens" })) ?? []) as Array<{ account_id: string }>;
  let ok = 0;
  let failed = 0;
  for (const a of due) {
    if (Date.now() - t0 > BUDGET_MS) break;
    try {
      await getAccessToken(tokenDeps(admin, cfg), a.account_id, { skewMs: 2 * 3600_000 });
      // Una llamada real: ML invalida el refresh tras 4 meses sin uso.
      await deps.client(a.account_id).get("/users/me");
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}
