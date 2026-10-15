// =============================================================================
// Edge Function: ml_full: Mercado Libre Full (ADR-142). Deploy: verify_jwt =
// true (el cron manda el anon key como Bearer y X-Cron-Secret =
// platform_secrets('internal_cron').token).
//
// SÓLO LECTURAS a la API de Mercado Libre (GET): nunca crea envíos ni toca el
// stock de Full (ML es la fuente de verdad del depósito Full).
//
// Desde la UI (JWT; gating ml_full_edge_guard: miembro activo, rol y features
// mercadolibre + mercadolibre_full; la cuenta tiene que ser del negocio):
//   sync {account_id}                         stock de Full + operaciones de
//                                             30 días (dueño o encargado)
//   check_reception {account_id, inbound_id}  lee lo recibido por ML de un
//                                             envío abierto (cualquier rol
//                                             operativo)
//   costs {account_id}                        cargos de Full de facturación
//                                             (dueño o encargado)
// Cron (body.mode = "cron"): cuentas de ml_full_accounts_due(): sync, recepción
// de los envíos abiertos y, una vez por día, costos.
// Lógica pura y testeada en ../_shared/mercadolibre/full.ts.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { MlApiError } from "../_shared/mercadolibre/client.ts";
import { checkInboundReception, syncFullAccount, syncFullCosts } from "../_shared/mercadolibre/full.ts";
import { accountClient, adminClient, cors, json, mlConfig, rpcOf, safeEqual } from "../_shared/mercadolibre/runtime.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = new Set(["sync", "costs"]);
const BUDGET_MS = 45_000;

// deno-lint-ignore no-explicit-any
type Admin = any;

function errorBody(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof MlApiError) {
    const status = e.code === "rate_limited" ? 429 : e.code === "invalid_grant" ? 409 : e.status >= 400 && e.status < 500 ? 400 : 502;
    return { status, body: { error: e.code, message: e.message } };
  }
  return { status: 500, body: { error: "full_failed", message: e instanceof Error ? e.message.slice(0, 300) : String(e) } };
}

async function knownFullItems(admin: Admin, accountId: string): Promise<string[]> {
  const { data } = await admin
    .from("ml_items")
    .select("ml_item_id")
    .eq("account_id", accountId)
    .eq("logistic_type", "fulfillment")
    .is("deleted_at", null)
    .limit(5000);
  return (data ?? []).map((r: { ml_item_id: string }) => r.ml_item_id);
}

async function openInbounds(admin: Admin, accountId: string, inboundId?: string) {
  let q = admin
    .from("ml_full_inbounds")
    .select("id, ml_inbound_id, dispatched_at, status, ml_full_inbound_items(inventory_id)")
    .eq("account_id", accountId)
    .in("status", ["in_transit", "partially_received"])
    .not("ml_inbound_id", "is", null);
  if (inboundId) q = q.eq("id", inboundId);
  const { data } = await q.limit(50);
  return (data ?? []).map((r: { id: string; ml_inbound_id: string; dispatched_at: string | null; ml_full_inbound_items: Array<{ inventory_id: string }> }) => ({
    id: r.id,
    ml_inbound_id: r.ml_inbound_id,
    dispatched_at: r.dispatched_at,
    inventory_ids: [...new Set((r.ml_full_inbound_items ?? []).map((i) => i.inventory_id))],
  }));
}

async function runAccount(
  admin: Admin,
  rpc: ReturnType<typeof rpcOf>,
  client: ReturnType<typeof accountClient>,
  account: { id: string; ml_user_id: number },
  opts: { costs: boolean; deadline: number },
) {
  const deps = { rpc, client, deadline: opts.deadline };
  const out: Record<string, unknown> = {};
  try {
    const r = await syncFullAccount(deps, account, await knownFullItems(admin, account.id));
    out.sync = r;
    let received = 0;
    for (const ib of await openInbounds(admin, account.id)) {
      if (Date.now() > opts.deadline) break;
      if (ib.inventory_ids.length === 0) continue;
      await checkInboundReception(deps, account, ib);
      received++;
    }
    out.receptions = received;
    if (opts.costs && Date.now() < opts.deadline) {
      try {
        out.costs = await syncFullCosts(deps, account);
      } catch (e) {
        // Sin el permiso de facturación no se frena el resto.
        out.costs_error = e instanceof MlApiError ? e.code : "costs_failed";
      }
    }
    const note = r.partial ? "Sincronización parcial: se completa en la próxima corrida." : r.errors ? `${r.errors} inventarios sin leer` : null;
    await rpc("ml_full_sync_done", { p_account: account.id, p_error: null, p_note: note });
  } catch (e) {
    const msg = e instanceof MlApiError ? `${e.code}: ${e.message}` : String(e instanceof Error ? e.message : e);
    await rpc("ml_full_sync_done", { p_account: account.id, p_error: msg.slice(0, 400), p_note: null });
    throw e;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const admin = adminClient();
  const rpc = rpcOf(admin);
  const t0 = Date.now();

  let b: Record<string, unknown>;
  try {
    b = await readJsonLimited(req, 32 * 1024);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // ---- Cron ----------------------------------------------------------------
  if (b.mode === "cron") {
    const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
    const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
    if (!cronSecret || !token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);
    const cfg = await mlConfig(admin);
    if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);
    const due = ((await rpc("ml_full_accounts_due", {})) ?? []) as Array<{ account_id: string; ml_user_id: number; costs_due: boolean }>;
    const results: Record<string, unknown> = {};
    for (const a of due) {
      if (Date.now() - t0 > BUDGET_MS * 0.8) break;
      try {
        results[a.account_id] = await runAccount(admin, rpc, accountClient(admin, cfg.config, a.account_id), { id: a.account_id, ml_user_id: a.ml_user_id }, {
          costs: a.costs_due,
          deadline: t0 + BUDGET_MS,
        });
      } catch (e) {
        results[a.account_id] = errorBody(e).body;
      }
    }
    console.log(JSON.stringify({ fn: "ml_full", mode: "cron", accounts: due.length, ms: Date.now() - t0 }));
    return json({ ok: true, accounts: due.length, results, ms: Date.now() - t0 });
  }

  // ---- UI (JWT) ------------------------------------------------------------
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
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

  const action = String(b.action ?? "");
  if (!["sync", "check_reception", "costs"].includes(action)) return json({ error: "unknown_action" }, 400);
  const { data: guard, error: gErr } = await admin.rpc("ml_full_edge_guard", {
    p_tenant: tenantId,
    p_user: user.id,
    p_manage: MANAGE.has(action),
  });
  if (gErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);

  const accountId = String(b.account_id ?? "");
  if (!UUID_RE.test(accountId)) return json({ error: "invalid_account" }, 400);
  const { data: account } = await admin
    .from("ml_accounts")
    .select("id, ml_user_id, status")
    .eq("id", accountId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!account) return json({ error: "no_account" }, 404);
  if (account.status !== "active") return json({ error: "reauth_required" }, 409);
  const cfg = await mlConfig(admin);
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);
  const client = accountClient(admin, cfg.config, account.id);
  const deps = { rpc, client, deadline: t0 + BUDGET_MS };

  try {
    switch (action) {
      case "sync": {
        const out = await runAccount(admin, rpc, client, account, { costs: false, deadline: t0 + BUDGET_MS });
        return json({ ok: true, ...out });
      }
      case "check_reception": {
        const inboundId = String(b.inbound_id ?? "");
        if (!UUID_RE.test(inboundId)) return json({ error: "invalid_inbound" }, 400);
        const [ib] = await openInbounds(admin, account.id, inboundId);
        if (!ib) return json({ error: "inbound_not_open" }, 409);
        const lines = await checkInboundReception(deps, account, ib);
        return json({ ok: true, lines });
      }
      case "costs": {
        const saved = await syncFullCosts(deps, account);
        return json({ ok: true, saved });
      }
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    const { status, body } = errorBody(e);
    return json(body, status);
  }
});
