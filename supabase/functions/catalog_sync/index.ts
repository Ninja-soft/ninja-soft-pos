// =============================================================================
// Edge Function: catalog_sync (ADR-107, ADR-109). Sincroniza el catálogo
// precargado "Tiendita" desde el feed del scraper del dueño en Railway.
//
// ADR-109: lee el CATÁLOGO MAESTRO (GET /api/feed/catalog): un ítem por
// producto (EAN canónico o código propio de una tienda) con la ficha
// fusionada de todas las tiendas y TODAS sus ofertas (cada tienda y cada
// vendedor). Upsert batcheado en catalog_items + catalog_offers
// (catalog_sync_upsert_catalog). Se sincronizan todas las tiendas del feed
// (estén o no en un catálogo): las ofertas sirven para comparar precios; lo
// que ve cada negocio sigue dependiendo de sus catálogos.
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
// 170 s), responde 202 y sigue en segundo plano (EdgeRuntime.waitUntil) hasta
// ~100 s: pide páginas del feed maestro con su cursor y guarda el avance en
// catalog_sync_runs.feed después de CADA página. Terminada la lectura, cierra
// tienda por tienda (catalog_sync_finish_store: si fue completa, las ofertas
// que no vinieron quedan no disponibles, nunca se borran; conteo) y al final
// recuento y aviso a los negocios por catálogo afectado (catalog_sync_finalize).
// Si se acaba el tiempo, suelta el lease y el cron de cada minuto continúa;
// si la invocación muere, el lease vence y pasa lo mismo.
//
// Primera corrida (y la primera después de ADR-109): completa. Siguientes:
// incremental con `since` = inicio de la última corrida OK (menos 1 h).
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer para pasar
// el gateway; la autenticación real es el X-Cron-Secret o el JWT del staff).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  applyFeedError,
  applyPage,
  feedCatalogUrl,
  feedStoresUrl,
  hasTime,
  initFeedState,
  initStores,
  LEASE_SECONDS,
  MAX_FEED_ERRORS,
  mapCatalogPage,
  nextPendingStore,
  runMode,
  storeFaltantes,
  type FeedCatalogPage,
  type FeedState,
  type FeedStore,
  type PreviousRun,
  type RunTotals,
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
  feed: FeedState | null;
  nuevos: number;
  actualizados: number;
  ofertas_nuevas: number;
  ofertas_actualizadas: number;
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
  // 503 catalog_index_building: el scraper está armando el índice; se reintenta.
  if (!res.ok) throw new Error(`feed respondió ${res.status}`);
  return (await res.json()) as T;
}

interface Progress {
  stores: StoresState;
  feed: FeedState | null;
  totals: RunTotals;
}

async function saveRun(admin: SupabaseClient, runId: string, p: Progress, extra: Record<string, unknown> = {}) {
  const { error } = await admin
    .from("catalog_sync_runs")
    .update({
      stores: p.stores,
      feed: p.feed,
      ...p.totals,
      faltantes: storeFaltantes(p.stores),
      errores: (p.feed?.error ? 1 : 0) + Object.values(p.stores).filter((s) => s.error).length,
      mode: runMode(p.feed),
      heartbeat_at: new Date().toISOString(),
      ...extra,
    })
    .eq("id", runId);
  if (error) throw new Error(`no se pudo guardar el avance: ${error.message}`);
}

/** Primera invocación de la corrida: tiendas del feed (alta de las nuevas) y since. */
async function initRun(admin: SupabaseClient, feed: Feed, run: RunRow, totals: RunTotals): Promise<Progress> {
  const feedStores = await feedGet<FeedStore[]>(feed, feedStoresUrl(feed.url));
  if (!Array.isArray(feedStores) || feedStores.length === 0) throw new Error("el feed no devolvió tiendas");
  const { error: stErr } = await admin.rpc("catalog_sync_upsert_stores", {
    p_stores: feedStores.map((s) => ({ key: s.id, name: s.label, logo_url: s.logo })),
  });
  if (stErr) throw new Error(`alta de tiendas: ${stErr.message}`);
  const { data: prev, error: prevErr } = await admin
    .from("catalog_sync_runs")
    .select("status, started_at, feed")
    .in("status", ["ok", "partial"])
    .neq("id", run.id)
    .order("started_at", { ascending: false })
    .limit(20);
  if (prevErr) throw new Error(`corridas anteriores: ${prevErr.message}`);
  const progress: Progress = {
    stores: initStores(feedStores),
    feed: initFeedState((prev ?? []) as PreviousRun[], run.force_full),
    totals,
  };
  await saveRun(admin, run.id, progress);
  return progress;
}

const EMPTY_RESULT: UpsertResult = {
  recibidos: 0,
  nuevos: 0,
  actualizados: 0,
  ofertas: 0,
  ofertas_nuevas: 0,
  ofertas_actualizadas: 0,
  faltantes: 0,
  por_tienda: {},
};

/** Una tanda con presupuesto de tiempo. Devuelve si la corrida terminó. */
async function processSlice(admin: SupabaseClient, feed: Feed, run: RunRow): Promise<{ finished: boolean; pages: number }> {
  const t0 = Date.now();
  let p: Progress = {
    stores: run.stores ?? {},
    feed: run.feed ?? null,
    totals: {
      nuevos: run.nuevos ?? 0,
      actualizados: run.actualizados ?? 0,
      ofertas_nuevas: run.ofertas_nuevas ?? 0,
      ofertas_actualizadas: run.ofertas_actualizadas ?? 0,
    },
  };
  let pages = 0;

  try {
    if (!p.feed) p = await initRun(admin, feed, run, p.totals);

    while (hasTime(t0, Date.now())) {
      const st = p.feed as FeedState;
      // 1) Lectura del feed maestro, página por página.
      if (!st.done) {
        try {
          const page = await feedGet<FeedCatalogPage>(feed, feedCatalogUrl(feed.url, st.since, st.cursor));
          if (!page || !Array.isArray(page.items)) throw new Error("respuesta del feed inválida");
          const rows = mapCatalogPage(page.items);
          let result: UpsertResult = EMPTY_RESULT;
          if (rows.length) {
            const { data, error } = await admin.rpc("catalog_sync_upsert_catalog", { p_run: run.id, p_items: rows });
            if (error) throw new Error(`upsert: ${error.message}`);
            result = data as UpsertResult;
          }
          p = { ...p, ...applyPage(st, p.stores, p.totals, page, result) };
          pages++;
          await saveRun(admin, run.id, p, { current_store: null });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(JSON.stringify({ fn: "catalog_sync", run: run.id, error: msg }));
          p = { ...p, feed: applyFeedError(st, msg) };
          await saveRun(admin, run.id, p, { last_error: msg.slice(0, 500) });
          // Con reintentos pendientes se corta la tanda: el cron reintenta al minuto.
          if (!(p.feed as FeedState).done) break;
        }
        continue;
      }

      // 2) Cierre por tienda: faltantes (sólo si la lectura fue completa y sin
      //    error) + conteo. Una RPC por tienda: ninguna toca la tabla entera.
      const key = nextPendingStore(p.stores);
      if (key) {
        const { data: fin, error: finErr } = await admin.rpc("catalog_sync_finish_store", {
          p_run: run.id,
          p_store: key,
          p_full: st.full && !st.error,
        });
        const s = p.stores[key];
        p = {
          ...p,
          stores: {
            ...p.stores,
            [key]: finErr
              ? { ...s, done: true, error: `cierre: ${finErr.message}`.slice(0, 500) }
              : { ...s, done: true, marcados: Number((fin as { marcados?: number } | null)?.marcados ?? 0) },
          },
        };
        await saveRun(admin, run.id, p, { current_store: key });
        continue;
      }

      // 3) Fin: recuento y aviso por catálogo.
      await saveRun(admin, run.id, p, { current_store: null });
      const { error } = await admin.rpc("catalog_sync_finalize", { p_run: run.id });
      if (error) throw new Error(`cierre: ${error.message}`);
      return { finished: true, pages };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ fn: "catalog_sync", run: run.id, error: msg }));
    // Si ni siquiera se pudo leer la lista de tiendas tras varios intentos, la
    // corrida se cierra con error (no queda reintentando hasta el timeout).
    const giveUp = !p.feed && (run.invocations ?? 0) >= MAX_FEED_ERRORS;
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
