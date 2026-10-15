// =============================================================================
// Edge Function: transfer_watch (ADR-061): detección automática de
// transferencias recibidas en un CVU de Mercado Pago mientras la hoja de cobro
// espera.
//
// Acciones (usuario con membresía activa en el negocio actual):
//   start  { account_id, amount, store_id?, register_id? }  crea la espera con
//          la tolerancia, el modo y la ventana de la cuenta (autoridad del
//          servidor). Exige cuenta de Mercado Pago con auto_detect, la feature
//          transferencia_auto_mp y Mercado Pago conectado (credencial de la
//          sucursal si tiene, ADR-057).
//   poll   { watch_id }  busca en /v1/payments/search las transferencias
//          entrantes desde 2 min antes de la espera y empareja (pairTransfer).
//          Un solo candidato y ninguna otra espera que lo acepte: se reserva
//          el movimiento (índice único: nunca se usa dos veces). Varios: queda
//          ambigua con los candidatos y decide el cajero.
//   pick   { watch_id, mp_payment_id }  el cajero elige un candidato (se
//          re-verifica contra la API).
//   reject { watch_id }  "No es esta": libera el movimiento y sigue esperando.
//   cancel { watch_id }   close { watch_id, sale_id }
//   probe  { account_id }  (dueño o encargado) transferencias entrantes de los
//          últimos 7 días, para verificar que la API las informa en la cuenta.
//
// Mercado Pago no manda webhooks de transferencias recibidas que no creó la
// aplicación: la detección es por consulta (el POS sondea cada pocos
// segundos mientras espera). Todo queda en audit_logs.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import { isIncomingTransfer, pairTransfer, transferInfo, type TransferInfo, type WatchLite } from "../_shared/mpTransfers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Admin = any;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const MIN_POLL_MS = 3000;

type Watch = {
  id: string;
  tenant_id: string;
  account_id: string;
  store_id: string | null;
  amount: number | string;
  tolerance: number | string;
  mode: string;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  mp_payment_id: string | null;
  matched_amount: number | string | null;
  payer_name: string | null;
  payer_doc: string | null;
  rejected_ids: string[] | null;
  candidates: TransferInfo[] | null;
  scope_store_id: string | null;
  mp_user_id: string | null;
};
const WATCH_COLS =
  "id, tenant_id, account_id, store_id, amount, tolerance, mode, status, expires_at, created_at, updated_at, mp_payment_id, matched_amount, payer_name, payer_doc, rejected_ids, candidates, scope_store_id, mp_user_id";

const lite = (w: Watch): WatchLite => ({
  id: w.id,
  amount: Number(w.amount),
  tolerance: Number(w.tolerance),
  created_at: w.created_at,
  expires_at: w.expires_at,
  rejected_ids: w.rejected_ids ?? [],
});

function view(w: Watch) {
  return {
    id: w.id,
    status: w.status,
    amount: Number(w.amount),
    tolerance: Number(w.tolerance),
    mode: w.mode,
    expires_at: w.expires_at,
    match: w.mp_payment_id
      ? {
          id: w.mp_payment_id,
          amount: Number(w.matched_amount ?? w.amount),
          payer_name: w.payer_name,
          payer_doc: w.payer_doc,
        }
      : null,
    candidates: w.status === "ambiguous" ? (w.candidates ?? []) : [],
  };
}

const isMpCvu = (a: { bank_slug: string | null; cbu: string | null }) =>
  a.bank_slug === "mercado-pago" || (a.cbu ?? "").startsWith("0000003");

async function audit(admin: Admin, tenantId: string, userId: string, entityId: string, action: string, data: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: userId,
    entity_type: "transfer_watches",
    entity_id: entityId,
    action,
    after_data: data,
  });
}

async function searchTransfers(token: string, ownUserId: string | null, from: Date, to: Date): Promise<{ list: TransferInfo[]; checked: number; error?: string }> {
  const q = new URLSearchParams({
    sort: "date_created",
    criteria: "desc",
    range: "date_created",
    begin_date: from.toISOString(),
    end_date: to.toISOString(),
    limit: "50",
    offset: "0",
  });
  const r = await fetch(`${MP_API}/v1/payments/search?${q.toString()}`, { headers: mpHeaders(token) });
  if (!r.ok) return { list: [], checked: 0, error: `mp_search_${r.status}` };
  const body = (await r.json().catch(() => null)) as { results?: unknown[] } | null;
  const results = body?.results ?? [];
  const list: TransferInfo[] = [];
  for (const p of results) {
    if (!isIncomingTransfer(p, ownUserId)) continue;
    const t = transferInfo(p);
    if (t) list.push(t);
  }
  return { list, checked: results.length };
}

async function mpUserId(token: string): Promise<string | null> {
  const r = await fetch(`${MP_API}/users/me`, { headers: mpHeaders(token) }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as { id?: unknown } | null;
  return j?.id != null ? String(j.id) : null;
}

/** Reserva el movimiento para la espera. false = ya lo usó otra. */
async function claim(admin: Admin, w: Watch, t: TransferInfo): Promise<Watch | null> {
  const { data, error } = await admin
    .from("transfer_watches")
    .update({
      status: "matched",
      mp_payment_id: t.id,
      matched_amount: t.amount,
      payer_name: t.payer_name,
      payer_doc: t.payer_doc,
      matched_at: new Date().toISOString(),
      candidates: [],
    })
    .eq("id", w.id)
    .in("status", ["waiting", "ambiguous"])
    .select(WATCH_COLS)
    .maybeSingle();
  if (error || !data) return null;
  return data as Watch;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anonKey, {
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

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  const action = String(b.action ?? "");
  const featureOk = async () => {
    const { data } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "transferencia_auto_mp" });
    return data === true;
  };
  const loadAccount = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await admin
      .from("transfer_accounts")
      .select("id, bank_slug, cbu, is_active, deleted_at, auto_detect, auto_tolerance, auto_mode, auto_window_min")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    return data as
      | {
          id: string;
          bank_slug: string | null;
          cbu: string | null;
          is_active: boolean;
          deleted_at: string | null;
          auto_detect: boolean;
          auto_tolerance: number | string;
          auto_mode: string;
          auto_window_min: number;
        }
      | null;
  };
  const loadWatch = async (id: unknown): Promise<Watch | null> => {
    if (!isUuid(id)) return null;
    const { data } = await admin.from("transfer_watches").select(WATCH_COLS).eq("id", id).eq("tenant_id", tenantId).maybeSingle();
    return (data as Watch | null) ?? null;
  };

  // ── probe ──────────────────────────────────────────────────────────────────
  if (action === "probe") {
    if (mem.role !== "owner" && mem.role !== "manager") return json({ error: "forbidden" }, 403);
    const acc = await loadAccount(b.account_id);
    if (!acc || acc.deleted_at) return json({ error: "account_not_found" }, 404);
    if (!isMpCvu(acc)) return json({ error: "auto_detect_requires_mp_cvu" }, 400);
    const storeId = isUuid(b.store_id) ? b.store_id : null;
    const cred = await tenantMpCredential(admin, tenantId, undefined, { storeId });
    if (!cred) return json({ error: "not_connected" }, 400);
    const own = await mpUserId(cred.token);
    const now = new Date();
    const res = await searchTransfers(cred.token, own, new Date(now.getTime() - 7 * 86_400_000), now);
    if (res.error) return json({ error: res.error }, 502);
    return json({
      checked: res.checked,
      incoming: res.list.length,
      sample: res.list.slice(0, 5).map((t) => ({ amount: t.amount, at: t.at, payer_name: t.payer_name })),
      env: cred.env,
    });
  }

  // ── start ──────────────────────────────────────────────────────────────────
  if (action === "start") {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
    const acc = await loadAccount(b.account_id);
    if (!acc || acc.deleted_at || !acc.is_active) return json({ error: "account_not_found" }, 404);
    if (!acc.auto_detect) return json({ error: "auto_detect_off" }, 400);
    if (!isMpCvu(acc)) return json({ error: "auto_detect_requires_mp_cvu" }, 400);
    if (!(await featureOk())) return json({ error: "feature_not_in_plan" }, 403);
    const storeId = isUuid(b.store_id) ? b.store_id : null;
    const cred = await tenantMpCredential(admin, tenantId, undefined, { storeId });
    if (!cred) return json({ error: "not_connected" }, 400);
    const own = await mpUserId(cred.token);
    const now = Date.now();
    const { data: w, error } = await admin
      .from("transfer_watches")
      .insert({
        tenant_id: tenantId,
        store_id: storeId,
        register_id: isUuid(b.register_id) ? b.register_id : null,
        account_id: acc.id,
        created_by: user.id,
        amount: Math.round(amount * 100) / 100,
        tolerance: Number(acc.auto_tolerance) || 0,
        mode: acc.auto_mode === "auto_close" ? "auto_close" : "notify",
        expires_at: new Date(now + Math.max(5, Number(acc.auto_window_min) || 30) * 60_000).toISOString(),
        scope_store_id: cred.scopeStoreId,
        mp_user_id: own,
      })
      .select(WATCH_COLS)
      .single();
    if (error || !w) return json({ error: "watch_failed", detail: error?.message ?? null }, 500);
    await audit(admin, tenantId, user.id, w.id, "transfer_watch_started", { account_id: acc.id, amount, tolerance: w.tolerance, mode: w.mode });
    return json(view(w as Watch));
  }

  const w = await loadWatch(b.watch_id);
  if (!w) return json({ error: "watch_not_found" }, 404);

  // ── poll ───────────────────────────────────────────────────────────────────
  if (action === "poll") {
    if (w.status !== "waiting" && w.status !== "ambiguous") return json(view(w));
    if (Date.now() > Date.parse(w.expires_at)) {
      const { data: exp } = await admin
        .from("transfer_watches")
        .update({ status: "expired" })
        .eq("id", w.id)
        .in("status", ["waiting", "ambiguous"])
        .select(WATCH_COLS)
        .maybeSingle();
      return json(view((exp as Watch | null) ?? { ...w, status: "expired" }));
    }
    if (Date.now() - Date.parse(w.updated_at) < MIN_POLL_MS && w.status === "waiting") return json(view(w));
    const cred = await tenantMpCredential(admin, tenantId, undefined, { scopeStoreId: w.scope_store_id });
    if (!cred) return json({ ...view(w), error: "not_connected" });
    const res = await searchTransfers(cred.token, w.mp_user_id, new Date(Date.parse(w.created_at) - 2 * 60_000), new Date());
    if (res.error) return json({ ...view(w), error: res.error });

    const [{ data: usedRows }, { data: others }] = await Promise.all([
      admin
        .from("transfer_watches")
        .select("mp_payment_id")
        .eq("tenant_id", tenantId)
        .in("mp_payment_id", res.list.map((t) => t.id).concat(["-"])),
      admin
        .from("transfer_watches")
        .select(WATCH_COLS)
        .eq("tenant_id", tenantId)
        .in("status", ["waiting", "ambiguous"])
        .neq("id", w.id)
        .gt("expires_at", new Date().toISOString()),
    ]);
    const used = ((usedRows ?? []) as { mp_payment_id: string }[]).map((r) => r.mp_payment_id);
    const pair = pairTransfer(lite(w), res.list, { usedIds: used, otherWatches: ((others ?? []) as Watch[]).map(lite) });

    if (pair.status === "matched" && pair.match) {
      const claimed = await claim(admin, w, pair.match);
      if (claimed) {
        await audit(admin, tenantId, user.id, w.id, "transfer_watch_matched", {
          mp_payment_id: pair.match.id,
          amount: pair.match.amount,
          expected: Number(w.amount),
          payer_name: pair.match.payer_name,
          payer_doc: pair.match.payer_doc,
          source: "auto",
        });
        return json(view(claimed));
      }
      // Otra espera lo tomó: seguimos esperando.
    }
    const status = pair.status === "ambiguous" ? "ambiguous" : "waiting";
    const { data: upd } = await admin
      .from("transfer_watches")
      .update({ status, candidates: pair.status === "ambiguous" ? pair.candidates : [] })
      .eq("id", w.id)
      .in("status", ["waiting", "ambiguous"])
      .select(WATCH_COLS)
      .maybeSingle();
    if (status === "ambiguous" && w.status !== "ambiguous") {
      await audit(admin, tenantId, user.id, w.id, "transfer_watch_ambiguous", { candidates: pair.candidates.map((c) => c.id) });
    }
    return json(view((upd as Watch | null) ?? w));
  }

  // ── pick ───────────────────────────────────────────────────────────────────
  if (action === "pick") {
    const id = String(b.mp_payment_id ?? "");
    if (w.status !== "ambiguous" && w.status !== "waiting") return json({ error: "invalid_state" }, 409);
    if (!(w.candidates ?? []).some((c) => c.id === id)) return json({ error: "not_a_candidate" }, 400);
    if (!(await featureOk())) return json({ error: "feature_not_in_plan" }, 403);
    const cred = await tenantMpCredential(admin, tenantId, undefined, { scopeStoreId: w.scope_store_id });
    if (!cred) return json({ error: "not_connected" }, 400);
    const r = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(id)}`, { headers: mpHeaders(cred.token) });
    if (!r.ok) return json({ error: "provider_error" }, 502);
    const p = await r.json().catch(() => null);
    const t = isIncomingTransfer(p, w.mp_user_id) ? transferInfo(p) : null;
    if (!t || Math.abs(t.amount - Number(w.amount)) > Number(w.tolerance) + 0.005) return json({ error: "not_a_candidate" }, 400);
    const claimed = await claim(admin, w, t);
    if (!claimed) return json({ error: "already_used" }, 409);
    await audit(admin, tenantId, user.id, w.id, "transfer_watch_picked", {
      mp_payment_id: t.id,
      amount: t.amount,
      expected: Number(w.amount),
      payer_name: t.payer_name,
      payer_doc: t.payer_doc,
    });
    return json(view(claimed));
  }

  // ── reject ─────────────────────────────────────────────────────────────────
  if (action === "reject") {
    if (w.status !== "matched" || !w.mp_payment_id) return json({ error: "invalid_state" }, 409);
    const { data: upd } = await admin
      .from("transfer_watches")
      .update({
        status: "waiting",
        rejected_ids: [...(w.rejected_ids ?? []), w.mp_payment_id],
        mp_payment_id: null,
        matched_amount: null,
        payer_name: null,
        payer_doc: null,
        matched_at: null,
      })
      .eq("id", w.id)
      .eq("status", "matched")
      .select(WATCH_COLS)
      .maybeSingle();
    await audit(admin, tenantId, user.id, w.id, "transfer_watch_rejected", { mp_payment_id: w.mp_payment_id });
    return json(view((upd as Watch | null) ?? w));
  }

  // ── cancel ─────────────────────────────────────────────────────────────────
  if (action === "cancel") {
    if (w.status === "closed" || w.status === "cancelled") return json(view(w));
    // Un movimiento reservado se libera al cancelar (no hubo venta).
    const { data: upd } = await admin
      .from("transfer_watches")
      .update({ status: "cancelled", mp_payment_id: null })
      .eq("id", w.id)
      .neq("status", "closed")
      .select(WATCH_COLS)
      .maybeSingle();
    await audit(admin, tenantId, user.id, w.id, "transfer_watch_cancelled", { previous_status: w.status, mp_payment_id: w.mp_payment_id });
    return json(view((upd as Watch | null) ?? w));
  }

  // ── close ──────────────────────────────────────────────────────────────────
  if (action === "close") {
    if (!isUuid(b.sale_id)) return json({ error: "invalid_sale" }, 400);
    const { data: sale } = await admin.from("sales").select("id").eq("id", b.sale_id).eq("tenant_id", tenantId).maybeSingle();
    if (!sale) return json({ error: "sale_not_found" }, 404);
    const { data: upd } = await admin
      .from("transfer_watches")
      .update({ status: "closed", sale_id: sale.id })
      .eq("id", w.id)
      .eq("status", "matched")
      .select(WATCH_COLS)
      .maybeSingle();
    if (!upd) return json({ error: "invalid_state" }, 409);
    await audit(admin, tenantId, user.id, w.id, "transfer_watch_closed", { sale_id: sale.id, mp_payment_id: w.mp_payment_id, amount: w.matched_amount });
    return json(view(upd as Watch));
  }

  return json({ error: "invalid_action" }, 400);
});
