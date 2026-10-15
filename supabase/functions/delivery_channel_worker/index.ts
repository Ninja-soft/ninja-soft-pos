// =============================================================================
// Edge Function: delivery_channel_worker · cola saliente, reconciliación y
// simulador de los canales de delivery (F13 · H49 integraciones, ADR-102).
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer para pasar
// el gateway; la autenticación real es el X-Cron-Secret o el JWT del usuario).
//
// DOS MODOS:
//   1. Cron (pg_cron + pg_net cada minuto si delivery_channel_any_due()):
//      X-Cron-Secret == platform_secrets('internal_cron').token.
//        * cola saliente: toma con lease (delivery_channel_outbox_claim),
//          llama al adaptador (aceptar, rechazar, listo, retirado) y guarda el
//          resultado (delivery_channel_outbox_result: ok, o reintento con
//          backoff 15 s ... 15 min, o error definitivo).
//        * eventos con error: los vuelve a procesar (hasta 5 intentos en 24 h).
//        * reconciliación: pide a la plataforma los pedidos recientes y los
//          ingresa con ids estables (recupera un webhook perdido).
//   2. Usuario (JWT de dueño o encargado con la feature, delivery_channel_edge_guard):
//        { action: "flush" }                       cola y reconciliación de su negocio ya
//        { action: "test", connection_id }         estado del adaptador y credenciales
//        { action: "simulate", connection_id, scenario, brand?, external_order_id?, status? }
//          scenario: order | order_lost | status | cancel | courier
//          (sólo conexiones del simulador; firma y manda el webhook real)
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { getAdapter } from "../_shared/deliveryChannels/registry.ts";
import {
  buildSimulatedOrder,
  SIM_BRANDS,
  SIM_SIGNATURE_HEADER,
  signSimBody,
  simulateCourier,
  simWebhookBody,
  type SimProduct,
} from "../_shared/deliveryChannels/simulator.ts";
import type { ChannelProvider, ExternalStatus, NormalizedOrder, SimStore } from "../_shared/deliveryChannels/types.ts";
import {
  contextFromRow,
  reconcileEvents,
  runOutboxAction,
  type OutboxRow,
  type WebhookContextRow,
} from "../_shared/deliveryChannels/worker.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const CRON_BUDGET_MS = 40_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function simStoreFor(admin: SupabaseClient, connectionId: string): SimStore {
  return {
    async put(externalOrderId, payload, status, webhookSent) {
      const { error } = await admin.rpc("delivery_channel_sim_put", {
        p_connection: connectionId,
        p_external_order_id: externalOrderId,
        p_payload: payload ?? {},
        p_status: status,
        p_webhook_sent: webhookSent,
      });
      if (error) throw new Error(error.message);
    },
    async recent(since) {
      const { data, error } = await admin.rpc("delivery_channel_sim_recent", {
        p_connection: connectionId,
        p_since: since.toISOString(),
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as Awaited<ReturnType<SimStore["recent"]>>;
    },
  };
}

async function loadContext(admin: SupabaseClient, connectionId: string) {
  const { data, error } = await admin.rpc("delivery_channel_webhook_context", { p_connection: connectionId });
  if (error || !data) return null;
  const row = data as WebhookContextRow;
  return { row, ctx: contextFromRow(row, { simStore: simStoreFor(admin, connectionId) }) };
}

async function processOutbox(admin: SupabaseClient, tenantId: string | null, t0: number) {
  const { data, error } = await admin.rpc("delivery_channel_outbox_claim", { p_limit: 50, p_tenant: tenantId });
  if (error) return { error: error.message };
  const rows = (data ?? []) as OutboxRow[];
  const cache = new Map<string, Awaited<ReturnType<typeof loadContext>>>();
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() - t0 > CRON_BUDGET_MS) {
      // Sin presupuesto: se libera para la próxima vuelta (no cuenta como intento fallido real).
      await admin.rpc("delivery_channel_outbox_result", {
        p_id: row.id, p_ok: false, p_error: "Sin tiempo en esta vuelta", p_response: null, p_retryable: true,
      });
      continue;
    }
    if (!cache.has(row.connection_id)) cache.set(row.connection_id, await loadContext(admin, row.connection_id));
    const loaded = cache.get(row.connection_id);
    const adapter = getAdapter(row.provider);
    const res = loaded && adapter
      ? await runOutboxAction(adapter, row, loaded.ctx)
      : { ok: false, retryable: false, error: "Conexión o adaptador no disponible" };
    await admin.rpc("delivery_channel_outbox_result", {
      p_id: row.id,
      p_ok: res.ok,
      p_error: res.error ?? null,
      p_response: (res.response ?? null) as unknown,
      p_retryable: res.retryable,
    });
    if (res.ok) ok++;
    else failed++;
  }
  return { claimed: rows.length, ok, failed };
}

async function retryEvents(admin: SupabaseClient) {
  const { data } = await admin.rpc("delivery_channel_events_retry_due", { p_limit: 20 });
  const ids = (data ?? []) as string[];
  for (const id of ids) await admin.rpc("delivery_channel_process_event", { p_event: id });
  return ids.length;
}

async function reconcile(admin: SupabaseClient, tenantId: string | null, t0: number) {
  const { data, error } = await admin.rpc("delivery_channel_reconcile_due", { p_limit: 20 });
  if (error) return { error: error.message };
  const due = ((data ?? []) as { connection_id: string; tenant_id: string; provider: ChannelProvider; since: string }[])
    .filter((d) => !tenantId || d.tenant_id === tenantId);
  let ingested = 0;
  for (const d of due) {
    if (Date.now() - t0 > CRON_BUDGET_MS) break;
    const loaded = await loadContext(admin, d.connection_id);
    const adapter = getAdapter(d.provider);
    if (!loaded || !adapter) continue;
    try {
      const recent = await adapter.fetchRecentOrders(new Date(d.since), loaded.ctx);
      for (const ev of reconcileEvents(recent)) {
        const { error: e } = await admin.rpc("delivery_channel_ingest_event", {
          p_connection: d.connection_id,
          p_event: ev,
          p_source: "reconciliacion",
        });
        if (e) throw new Error(e.message);
        ingested++;
      }
      // En el simulador, lo recuperado ya no está "perdido".
      if (d.provider === "simulador") {
        for (const r of recent) await loaded.ctx.simStore!.put(r.order.external_order_id, null, r.status ?? "nuevo", true);
      }
      await admin.rpc("delivery_channel_reconciled", { p_connection: d.connection_id, p_ok: true, p_error: null });
    } catch (e) {
      await admin.rpc("delivery_channel_reconciled", {
        p_connection: d.connection_id,
        p_ok: false,
        p_error: e instanceof Error ? e.message.slice(0, 200) : "error",
      });
    }
  }
  return { connections: due.length, ingested };
}

async function postSimWebhook(ctxRow: WebhookContextRow, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const sig = await signSimBody(ctxRow.webhook_secret ?? "", raw);
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/delivery_channel_webhook?c=${ctxRow.connection_id}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SIM_SIGNATURE_HEADER]: sig },
    body: raw,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* texto plano */
  }
  return { status: res.status, body: parsed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const t0 = Date.now();

  // --- Cron -------------------------------------------------------------------
  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  if (cronSecret) {
    const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
    if (!token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);
    const outbox = await processOutbox(admin, null, t0);
    const events = await retryEvents(admin);
    const recon = await reconcile(admin, null, t0);
    console.log(JSON.stringify({ fn: "delivery_channel_worker", mode: "cron", outbox, events, recon, ms: Date.now() - t0 }));
    return json({ ok: true, outbox, events, recon });
  }

  // --- Usuario ----------------------------------------------------------------
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  const action = String(body.action ?? "");
  const connectionId = typeof body.connection_id === "string" && UUID_RE.test(body.connection_id) ? body.connection_id : null;
  const { data: guard, error: guardErr } = await admin.rpc("delivery_channel_edge_guard", {
    p_tenant: tenantId,
    p_user: user.id,
    p_connection: connectionId,
  });
  if (guardErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);

  const audit = (act: string, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "delivery_channel_connections",
      entity_id: connectionId,
      action: act,
      after_data: after,
    });

  if (action === "flush") {
    const outbox = await processOutbox(admin, tenantId, t0);
    const recon = await reconcile(admin, tenantId, t0);
    return json({ ok: true, outbox, recon });
  }

  if (!connectionId) return json({ error: "invalid_connection" }, 400);
  const loaded = await loadContext(admin, connectionId);
  if (!loaded) return json({ error: "connection_not_found" }, 404);
  const { row: ctxRow } = loaded;

  if (action === "test") {
    const adapter = getAdapter(ctxRow.provider);
    const keys = Object.keys(ctxRow.credentials ?? {});
    const result = {
      ok: Boolean(adapter?.ready) && ctxRow.status === "activa",
      provider: ctxRow.provider,
      adapter_ready: Boolean(adapter?.ready),
      status: ctxRow.status,
      credential_keys: keys,
      message: adapter?.ready
        ? ctxRow.status === "activa"
          ? "Conexión lista para recibir pedidos."
          : "La conexión está pausada o pendiente."
        : "El adaptador de esta plataforma todavía no está habilitado (falta el trámite y la homologación).",
    };
    await audit("delivery_channel_tested", { ok: result.ok, provider: ctxRow.provider });
    return json(result);
  }

  if (action === "simulate") {
    if (ctxRow.provider !== "simulador") return json({ error: "only_simulator" }, 400);
    if (ctxRow.status !== "activa") return json({ error: "connection_paused" }, 400);
    const scenario = String(body.scenario ?? "order");
    const store = ctxRow.external_store_id;
    const sim = loaded.ctx.simStore!;

    if (scenario === "order" || scenario === "order_lost") {
      const brand = (SIM_BRANDS as string[]).includes(String(body.brand)) ? (body.brand as ChannelProvider) : "pedidosya";
      const { data: prods, error: pErr } = await admin.rpc("delivery_channel_sim_products", {
        p_connection: connectionId,
        p_limit: 30,
      });
      if (pErr) return json({ error: "products_failed" }, 500);
      let order: NormalizedOrder;
      try {
        order = buildSimulatedOrder((prods ?? []) as SimProduct[], {
          brand,
          unmappedItem: Boolean(body.unmapped_item),
          logistics: body.logistics === "propia" ? "propia" : "plataforma",
          orderType: body.order_type === "takeaway" ? "takeaway" : "delivery",
        });
      } catch {
        return json({ error: "no_products", message: "Cargá productos con precio para simular un pedido." }, 400);
      }
      const lost = scenario === "order_lost";
      await sim.put(order.external_order_id, order, "nuevo", !lost);
      await audit("delivery_channel_simulated", { scenario, brand, external_order_id: order.external_order_id });
      if (lost) {
        // El webhook "se pierde": lo recupera la reconciliación del cron.
        return json({ ok: true, external_order_id: order.external_order_id, webhook: null });
      }
      const res = await postSimWebhook(ctxRow, { ...simWebhookBody(store, order.external_order_id, "ORDER_NEW", { order }) });
      return json({ ok: res.status === 200, external_order_id: order.external_order_id, webhook: res });
    }

    const orderId = typeof body.external_order_id === "string" ? body.external_order_id.slice(0, 120) : "";
    if (!orderId) return json({ error: "external_order_id_required" }, 400);

    let payload: Record<string, unknown>;
    if (scenario === "cancel") {
      await sim.put(orderId, null, "cancelado", true);
      payload = simWebhookBody(store, orderId, "ORDER_CANCELLED", {
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.slice(0, 200) : "El cliente canceló en la app",
      }) as unknown as Record<string, unknown>;
    } else if (scenario === "status") {
      const allowed: ExternalStatus[] = ["aceptado", "listo", "retirado", "entregado"];
      const status = allowed.includes(body.status as ExternalStatus) ? (body.status as ExternalStatus) : "retirado";
      await sim.put(orderId, null, status, true);
      payload = simWebhookBody(store, orderId, "ORDER_STATUS", { status }) as unknown as Record<string, unknown>;
    } else if (scenario === "courier") {
      const step = Math.max(0, Math.min(4, Number(body.step) || 0));
      payload = simWebhookBody(store, orderId, "COURIER", { courier: simulateCourier(step) }) as unknown as Record<
        string,
        unknown
      >;
    } else {
      return json({ error: "invalid_scenario" }, 400);
    }
    await audit("delivery_channel_simulated", { scenario, external_order_id: orderId });
    const res = await postSimWebhook(ctxRow, payload);
    return json({ ok: res.status === 200, webhook: res });
  }

  return json({ error: "invalid_action" }, 400);
});
