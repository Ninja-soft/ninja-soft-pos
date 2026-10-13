// =============================================================================
// Edge Function: catalog_sync (ADR-107). Sincroniza el catálogo precargado
// "Tiendita" (catalog_stores / catalog_products) desde el feed del scraper del
// dueño en Railway (GET /api/feed/stores y /api/feed/products, Bearer).
// Lógica pura en ../_shared/catalogSync.ts (con tests).
//
// Secrets: CATALOG_FEED_URL (base, p. ej. https://<app>.up.railway.app) y
// CATALOG_FEED_TOKEN (= FEED_TOKEN del scraper). Nunca se loguean.
//
// DOS ENTRADAS:
//   1. Cron (pg_cron + pg_net): header X-Cron-Secret ==
//      platform_secrets('internal_cron').token. Semanal sábado 06:00 AR (la
//      corrida ya la abrió la base con catalog_sync_enqueue) y cada minuto
//      mientras haya una corrida abierta sin lease (catalog_sync_any_due).
//   2. Staff interno (JWT con app_metadata.is_internal, nivel admin o
//      super_admin; soporte no): { action: "start", full?: boolean } abre la
//      corrida (auditada en audit_logs por catalog_sync_enqueue antes de
//      responder) y procesa la primera tanda.
//
// UNA INVOCACIÓN = UNA TANDA: toma la corrida con lease (catalog_sync_claim,
// 170 s), responde 202 al toque y sigue en segundo plano (EdgeRuntime.waitUntil)
// hasta ~100 s: por tienda pide páginas de 1000 con su cursor, upsert batcheado
// (catalog_sync_upsert_products) y guarda el cursor en catalog_sync_runs después
// de CADA página. Al terminar una tienda: faltantes si fue completa + conteo
// (catalog_sync_finish_store). Si se acaba el tiempo, suelta el lease y el cron
// de cada minuto la continúa desde el cursor guardado; si la invocación muere,
// el lease vence y pasa lo mismo. Al final, recuento y aviso a los negocios
// por catálogo afectado (catalog_sync_finalize).
//
// Primera corrida: completa. Siguientes: incremental por tienda con `since` =
// inicio de la última corrida OK de esa tienda (menos 1 h de margen).
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer para pasar
// el gateway; la autenticación real es el X-Cron-Secret o el JWT del staff).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  applyError,
  applyPage,
  feedProductsUrl,
  feedStoresUrl,
  hasTime,
  initStores,
  LEASE_SECONDS,
  MAX_STORE_ERRORS,
  mapFeedPage,
  nextPendingStore,
  runMode,
  totals,
  type FeedPage,
  type FeedStore,
  type PreviousRun,
  type StoresState,
  type UpsertResult,
} from "../_shared/catalogSync.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const FETCH_TIMEOUT_MS = 30_000;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface RunRow {
  id: string;
  force_full: boolean;
  invocations: number;
  stores: StoresState;
  started_at: string;
}

interface Feed {
  url: string;
  token: string;
}

async function feedGet<T>(feed: Feed, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${feed.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`feed respondió ${res.status}`);
  return (await res.json()) as T;
}

async function saveRun(admin: SupabaseClient, runId: string, stores: StoresState, extra: Record<string, unknown> = {}) {
  const t = totals(stores);
  const { error } = await admin
    .from("catalog_sync_runs")
    .update({ stores, ...t, mode: runMode(stores), heartbeat_at: new Date().toISOString(), ...extra })
    .eq("id", runId);
  if (error) throw new Error(`no se pudo guardar el avance: ${error.message}`);
}

/** Primera invocación de la corrida: tiendas del feed, alta de las nuevas y since por tienda. */
async function initRun(admin: SupabaseClient, feed: Feed, run: RunRow): Promise<StoresState> {
  const feedStores = await feedGet<FeedStore[]>(feed, feedStoresUrl(feed.url));
  if (!Array.isArray(feedStores) || feedStores.length === 0) throw new Error("el feed no devolvió tiendas");
  const { error: stErr } = await admin.rpc("catalog_sync_upsert_stores", {
    p_stores: feedStores.map((s) => ({ key: s.id, name: s.label, logo_url: s.logo })),
  });
  if (stErr) throw new Error(`alta de tiendas: ${stErr.message}`);
  const { data: prev, error: prevErr } = await admin
    .from("catalog_sync_runs")
    .select("status, started_at, stores")
    .in("status", ["ok", "partial"])
    .neq("id", run.id)
    .order("started_at", { ascending: false })
    .limit(50);
  if (prevErr) throw new Error(`corridas anteriores: ${prevErr.message}`);
  const stores = initStores(feedStores, (prev ?? []) as PreviousRun[], run.force_full);
  await saveRun(admin, run.id, stores);
  return stores;
}

/** Una tanda con presupuesto de tiempo. Devuelve si la corrida terminó. */
async function processSlice(admin: SupabaseClient, feed: Feed, run: RunRow): Promise<{ finished: boolean; pages: number }> {
  const t0 = Date.now();
  let stores = run.stores ?? {};
  let pages = 0;

  try {
    if (Object.keys(stores).length === 0) stores = await initRun(admin, feed, run);

    while (hasTime(t0, Date.now())) {
      const key = nextPendingStore(stores);
      if (!key) {
        await saveRun(admin, run.id, stores);
        const { error } = await admin.rpc("catalog_sync_finalize", { p_run: run.id });
        if (error) throw new Error(`cierre: ${error.message}`);
        return { finished: true, pages };
      }
      const st = stores[key];
      try {
        const page = await feedGet<FeedPage>(feed, feedProductsUrl(feed.url, key, st.since, st.cursor));
        if (!page || !Array.isArray(page.items)) throw new Error("respuesta del feed inválida");
        const rows = mapFeedPage(page.items);
        let result: UpsertResult = { nuevos: 0, actualizados: 0, faltantes: 0 };
        if (rows.length) {
          const { data, error } = await admin.rpc("catalog_sync_upsert_products", {
            p_run: run.id,
            p_store: key,
            p_full: st.full,
            p_rows: rows,
          });
          if (error) throw new Error(`upsert: ${error.message}`);
          result = data as UpsertResult;
        }
        let next = applyPage(st, page, result);
        if (!page.nextCursor) {
          const { data: fin, error: finErr } = await admin.rpc("catalog_sync_finish_store", {
            p_run: run.id,
            p_store: key,
            p_full: st.full,
          });
          if (finErr) throw new Error(`cierre de ${key}: ${finErr.message}`);
          next = { ...next, done: true, marcados: Number((fin as { marcados?: number } | null)?.marcados ?? 0) };
        }
        stores = { ...stores, [key]: next };
        pages++;
        await saveRun(admin, run.id, stores, { current_store: key });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ fn: "catalog_sync", run: run.id, store: key, error: msg }));
        stores = { ...stores, [key]: applyError(st, msg) };
        await saveRun(admin, run.id, stores, { last_error: `${key}: ${msg}`.slice(0, 500) });
        // Si la tienda todavía tiene reintentos, se corta la tanda: el cron
        // reintenta al minuto. Si quedó terminada con error, se sigue con otra.
        if (!stores[key].done) break;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ fn: "catalog_sync", run: run.id, error: msg }));
    // Si ni siquiera se pudo leer la lista de tiendas tras varios intentos, la
    // corrida se cierra con error (no queda reintentando hasta el timeout).
    const giveUp = Object.keys(stores).length === 0 && (run.invocations ?? 0) >= MAX_STORE_ERRORS;
    await admin
      .from("catalog_sync_runs")
      .update({
        last_error: msg.slice(0, 500),
        ...(giveUp ? { status: "error", finished_at: new Date().toISOString(), locked_until: null } : {}),
      })
      .eq("id", run.id);
    if (giveUp) return { finished: true, pages };
  }

  // Sin terminar: soltar el lease para que el cron de cada minuto continúe.
  await admin.from("catalog_sync_runs").update({ locked_until: null }).eq("id", run.id).eq("status", "running");
  return { finished: false, pages };
}

async function claimAndProcess(admin: SupabaseClient, feed: Feed, runId: string | null) {
  const { data, error } = await admin.rpc("catalog_sync_claim", { p_run: runId, p_lease_seconds: LEASE_SECONDS });
  if (error) throw new Error(`claim: ${error.message}`);
  const run = ((data ?? []) as RunRow[])[0];
  if (!run) return { claimed: false };
  const out = await processSlice(admin, feed, run);
  return { claimed: true, run: run.id, ...out };
}

function background(p: Promise<unknown>) {
  const guarded = p.catch((e) => console.error(JSON.stringify({ fn: "catalog_sync", error: String(e) })));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(guarded);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const feed: Feed = {
    url: (Deno.env.get("CATALOG_FEED_URL") ?? "").trim(),
    token: (Deno.env.get("CATALOG_FEED_TOKEN") ?? "").trim(),
  };

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // --- Cron -------------------------------------------------------------------
  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  if (cronSecret) {
    const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
    if (!token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);
    if (!feed.url || !feed.token) return json({ error: "feed_not_configured" }, 503);
    background(claimAndProcess(admin, feed, null));
    return json({ ok: true, accepted: true }, 202);
  }

  // --- Staff interno ----------------------------------------------------------
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "", "x-ninja-scope": "internal" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const meta = (user.app_metadata ?? {}) as { is_internal?: boolean; internal_level?: string };
  if (!meta.is_internal) return json({ error: "forbidden" }, 403);
  if (meta.internal_level === "support") return json({ error: "forbidden" }, 403);

  const action = String(body.action ?? "start");
  if (action !== "start") return json({ error: "unknown_action" }, 400);
  if (!feed.url || !feed.token) return json({ error: "feed_not_configured" }, 503);

  // Abre (o reusa) la corrida y audita ANTES de responder.
  const { data: runId, error: enqErr } = await admin.rpc("catalog_sync_enqueue", {
    p_trigger: "manual",
    p_user: user.id,
    p_full: body.full === true,
  });
  if (enqErr || !runId) return json({ error: "enqueue_failed" }, 500);

  background(claimAndProcess(admin, feed, String(runId)));
  return json({ ok: true, run_id: runId }, 202);
});
