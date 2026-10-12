// =============================================================================
// Edge Function: settlements (ADR-061): conciliación de procesadores.
//
// Modos:
//   * Usuario (JWT, dueño o encargado, plan con conciliacion_procesadores):
//       { action: "sync",  provider: "mercadopago", from, to }  trae los pagos
//          de Mercado Pago del período por API (cada credencial del negocio y
//          de las sucursales, ADR-057), los guarda como líneas y cruza.
//       { action: "match", provider, from, to }  vuelve a cruzar (después de
//          importar un archivo o de vender) y devuelve los cobros del POS sin
//          línea ("Venta sin cobro").
//   * Cron diario (X-Cron-Secret == platform_secrets('internal_cron').token):
//       { mode: "cron" }  para cada negocio con Mercado Pago conectado, la
//          feature y la sincronización automática prendida: últimos 7 días
//          por fecha de creación + acreditaciones de los últimos 3 días, y
//          cruce de los últimos 40 días.
//
// Mercado Pago: GET /v1/payments/search (range=date_created o
// money_release_date, sort asc, limit 100, offset) con la credencial de cada
// alcance (tenantMpCredential: OAuth con refresh o token manual; switch
// Sandbox del medio). Cada pago se normaliza con mpSettlementLine
// (comisiones e impuestos de charges_details / fee_details, neto,
// money_release_date y money_release_status).
//
// El cruce corre el motor puro _shared/settlementMatch.ts y escribe con la RPC
// _settlement_apply_matches (service_role), que valida aislamiento, marca
// conciliados los cobros que cierran (payments.reconciled_at, audit
// payments_reconciled con source 'settlement_auto') y no pisa líneas
// manuales ni revisadas.
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import { mpSettlementLine, type SettlementLineInput } from "../_shared/processorData.ts";
import { type MatchLine, type PosCandidate, matchChanged, matchSettlement } from "../_shared/settlementMatch.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Admin = any;

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 93;
const PAGE = 100;
const MAX_PAYMENTS_PER_SCOPE = 3000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** provider_key de los intents que liquida cada proveedor. */
const INTENT_PROVIDERS: Record<string, string[]> = {
  mercadopago: ["mercadopago", "mercadopago_point"],
  payway: ["payway", "payway_point"],
  nave: ["nave", "nave_point"],
  getnet: ["getnet", "getnet_point"],
  fiserv: ["fiserv_point"],
  gocuotas: ["gocuotas"],
};

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function parseRange(from: unknown, to: unknown): { from: Date; to: Date } | null {
  const f = new Date(String(from ?? ""));
  const t = new Date(String(to ?? ""));
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t < f) return null;
  if (t.getTime() - f.getTime() > MAX_RANGE_DAYS * DAY_MS) return null;
  return { from: f, to: t };
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// ── Mercado Pago: traer pagos ────────────────────────────────────────────────

type SyncOutcome = { scope: string | null; fetched: number; saved: number; truncated: boolean; error?: string };

async function mpScopes(admin: Admin, tenantId: string): Promise<(string | null)[]> {
  const { data, error } = await admin
    .from("payment_secrets")
    .select("store_id")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago");
  if (error) {
    // Base sin credenciales por sucursal: sólo la del negocio.
    return [null];
  }
  const set = new Set<string | null>(((data ?? []) as { store_id: string | null }[]).map((r) => r.store_id ?? null));
  return [...set];
}

async function searchMp(
  token: string,
  range: "date_created" | "money_release_date",
  from: Date,
  to: Date,
): Promise<{ results: unknown[]; truncated: boolean; error?: string }> {
  const results: unknown[] = [];
  let offset = 0;
  while (offset < MAX_PAYMENTS_PER_SCOPE) {
    const q = new URLSearchParams({
      sort: range,
      criteria: "asc",
      range,
      begin_date: from.toISOString(),
      end_date: to.toISOString(),
      limit: String(PAGE),
      offset: String(offset),
    });
    const r = await fetch(`${MP_API}/v1/payments/search?${q.toString()}`, { headers: mpHeaders(token) });
    if (!r.ok) {
      return { results, truncated: false, error: `mp_search_${r.status}: ${(await r.text()).slice(0, 200)}` };
    }
    const body = (await r.json().catch(() => null)) as { results?: unknown[]; paging?: { total?: number } } | null;
    const page = body?.results ?? [];
    results.push(...page);
    const total = Number(body?.paging?.total ?? 0);
    offset += PAGE;
    if (page.length < PAGE || offset >= total) return { results, truncated: false };
  }
  return { results, truncated: true };
}

async function saveLines(
  admin: Admin,
  tenantId: string,
  scope: string | null,
  importId: string | null,
  lines: SettlementLineInput[],
): Promise<number> {
  let saved = 0;
  for (const part of chunk(lines, 200)) {
    const rows = part.map((l) => ({ ...l, tenant_id: tenantId, scope_store_id: scope, import_id: importId }));
    const { error } = await admin
      .from("settlement_lines")
      .upsert(rows, { onConflict: "tenant_id,provider_key,line_key" });
    if (error) throw new Error(`save_failed: ${error.message}`);
    saved += part.length;
  }
  return saved;
}

async function syncMercadoPago(
  admin: Admin,
  tenantId: string,
  windows: { range: "date_created" | "money_release_date"; from: Date; to: Date }[],
  actor: string | null,
): Promise<SyncOutcome[]> {
  const out: SyncOutcome[] = [];
  for (const scope of await mpScopes(admin, tenantId)) {
    const cred = await tenantMpCredential(admin, tenantId, undefined, { scopeStoreId: scope });
    const main = windows[0]!;
    if (!cred) {
      out.push({ scope, fetched: 0, saved: 0, truncated: false, error: "not_connected" });
      await admin.from("settlement_sync_state").upsert(
        {
          tenant_id: tenantId,
          provider_key: "mercadopago",
          scope_store_id: scope,
          last_sync_at: new Date().toISOString(),
          last_status: "error",
          last_error: "not_connected",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,provider_key,scope_store_id" },
      );
      continue;
    }
    const byId = new Map<string, SettlementLineInput>();
    let fetched = 0;
    let truncated = false;
    let error: string | undefined;
    for (const w of windows) {
      const res = await searchMp(cred.token, w.range, w.from, w.to);
      fetched += res.results.length;
      truncated ||= res.truncated;
      if (res.error) error = res.error;
      for (const raw of res.results) {
        const line = mpSettlementLine(raw);
        if (line) byId.set(line.line_key, line);
      }
    }
    const lines = [...byId.values()];
    let importId: string | null = null;
    if (lines.length > 0) {
      const { data: imp } = await admin
        .from("settlement_imports")
        .insert({
          tenant_id: tenantId,
          provider_key: "mercadopago",
          source: "api",
          scope_store_id: scope,
          period_from: main.from.toISOString().slice(0, 10),
          period_to: main.to.toISOString().slice(0, 10),
          row_count: lines.length,
          meta: { fetched, truncated, env: cred.env, windows: windows.map((w) => w.range) },
          created_by: actor,
        })
        .select("id")
        .single();
      importId = (imp as { id?: string } | null)?.id ?? null;
    }
    const saved = await saveLines(admin, tenantId, scope, importId, lines);
    await admin.from("settlement_sync_state").upsert(
      {
        tenant_id: tenantId,
        provider_key: "mercadopago",
        scope_store_id: scope,
        last_sync_at: new Date().toISOString(),
        last_from: main.from.toISOString(),
        last_to: main.to.toISOString(),
        last_status: error ? "partial" : truncated ? "truncated" : "ok",
        last_error: error ?? null,
        last_count: saved,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,provider_key,scope_store_id" },
    );
    out.push({ scope, fetched, saved, truncated, ...(error ? { error } : {}) });
  }
  return out;
}

// ── Cruce ────────────────────────────────────────────────────────────────────

type PayRow = {
  id: string;
  sale_id: string;
  amount: number | string;
  method: string;
  reference: string | null;
  created_at: string;
  card_voucher: Record<string, unknown> | null;
  sales: { status: string; created_at: string } | null;
};

const PAY_COLS = "id, sale_id, amount, method, reference, created_at, card_voucher, sales(status, created_at)";

const vstr = (v: Record<string, unknown> | null, k: string) => {
  const x = v?.[k];
  return typeof x === "string" || typeof x === "number" ? String(x) : null;
};

/** Cobros del POS candidatos para un proveedor y período (con margen). */
async function loadCandidates(admin: Admin, tenantId: string, provider: string, from: Date, to: Date): Promise<PosCandidate[]> {
  const lo = new Date(from.getTime() - 3 * DAY_MS).toISOString();
  const hi = new Date(to.getTime() + 3 * DAY_MS).toISOString();
  const out: PosCandidate[] = [];
  const seenPayments = new Set<string>();

  // 1) Intents aprobados del proveedor y sus cobros.
  const keys = INTENT_PROVIDERS[provider] ?? [];
  if (keys.length > 0) {
    const { data: intents } = await admin
      .from("mp_payment_intents")
      .select("id, provider_key, amount, mp_payment_id, mp_order_id, preference_id, sale_id, created_at")
      .eq("tenant_id", tenantId)
      .in("provider_key", keys)
      .eq("status", "approved")
      .gte("created_at", lo)
      .lte("created_at", hi)
      .limit(10000);
    const list = (intents ?? []) as {
      id: string;
      provider_key: string;
      amount: number | string;
      mp_payment_id: string | null;
      mp_order_id: string | null;
      preference_id: string | null;
      sale_id: string | null;
      created_at: string;
    }[];
    const payByRef = new Map<string, PayRow>();
    for (const part of chunk(list.map((i) => i.id), 150)) {
      const { data: pays } = await admin
        .from("payments")
        .select(PAY_COLS)
        .eq("tenant_id", tenantId)
        .in("reference", part);
      for (const p of (pays ?? []) as PayRow[]) if (p.reference) payByRef.set(p.reference, p);
    }
    for (const i of list) {
      const p = payByRef.get(i.id);
      const order = i.mp_order_id ?? (provider === "getnet" || provider === "gocuotas" ? i.preference_id : null);
      if (p) {
        seenPayments.add(p.id);
        out.push({
          payment_id: p.id,
          sale_id: p.sale_id,
          intent_id: i.id,
          provider_key: i.provider_key,
          amount: Number(p.amount),
          created_at: p.created_at,
          provider_payment_id: i.mp_payment_id,
          provider_order_id: order,
          lote: vstr(p.card_voucher, "lote"),
          cupon: vstr(p.card_voucher, "cupon"),
          autorizacion: vstr(p.card_voucher, "autorizacion"),
          comercio: vstr(p.card_voucher, "comercio"),
          last4: vstr(p.card_voucher, "ultimos4"),
          sale_voided: p.sales?.status === "voided",
        });
      } else if (!i.sale_id) {
        out.push({
          payment_id: null,
          sale_id: null,
          intent_id: i.id,
          provider_key: i.provider_key,
          amount: Number(i.amount),
          created_at: i.created_at,
          provider_payment_id: i.mp_payment_id,
          provider_order_id: order,
        });
      }
    }
  }

  // 2) Mercado Pago: ventas registradas con el id del pago como referencia
  //    ("Crear venta" desde la conciliación o carga manual).
  if (provider === "mercadopago") {
    const { data: pays } = await admin
      .from("payments")
      .select(PAY_COLS)
      .eq("tenant_id", tenantId)
      .eq("method", "qr")
      .gte("created_at", lo)
      .lte("created_at", hi)
      .limit(10000);
    for (const p of (pays ?? []) as PayRow[]) {
      if (seenPayments.has(p.id) || !p.reference || !/^\d{6,}$/.test(p.reference)) continue;
      seenPayments.add(p.id);
      out.push({
        payment_id: p.id,
        sale_id: p.sale_id,
        intent_id: null,
        provider_key: "mercadopago",
        amount: Number(p.amount),
        created_at: p.created_at,
        provider_payment_id: p.reference,
        sale_voided: p.sales?.status === "voided",
      });
    }
  }

  // 3) Adquirentes de tarjeta (archivo): cobros con tarjeta del período cuyo
  //    cupón no diga otro adquirente.
  if (provider !== "mercadopago" && provider !== "gocuotas") {
    const { data: pays } = await admin
      .from("payments")
      .select(PAY_COLS)
      .eq("tenant_id", tenantId)
      .in("method", ["debit", "credit"])
      .gte("created_at", lo)
      .lte("created_at", hi)
      .limit(20000);
    for (const p of (pays ?? []) as PayRow[]) {
      if (seenPayments.has(p.id)) continue;
      const acq = vstr(p.card_voucher, "adquirente");
      if (acq && acq !== provider && provider !== "otro") continue;
      if (p.reference && UUID_RE.test(p.reference)) continue; // de un intent de otro proveedor
      seenPayments.add(p.id);
      out.push({
        payment_id: p.id,
        sale_id: p.sale_id,
        intent_id: null,
        provider_key: acq,
        amount: Number(p.amount),
        created_at: p.created_at,
        lote: vstr(p.card_voucher, "lote"),
        cupon: vstr(p.card_voucher, "cupon"),
        autorizacion: vstr(p.card_voucher, "autorizacion"),
        comercio: vstr(p.card_voucher, "comercio"),
        last4: vstr(p.card_voucher, "ultimos4"),
        sale_voided: p.sales?.status === "voided",
      });
    }
  }
  return out;
}

const LINE_COLS =
  "id, provider_key, external_id, order_id, external_reference, operation_at, gross, refunded, status, lote, cupon, autorizacion, comercio, last4, match_status, match_method, payment_id, intent_id, diff_amount";

async function runMatch(
  admin: Admin,
  tenantId: string,
  provider: string,
  from: Date,
  to: Date,
  actor: string | null,
) {
  const { data: lineRows, error } = await admin
    .from("settlement_lines")
    .select(LINE_COLS)
    .eq("tenant_id", tenantId)
    .eq("provider_key", provider)
    .gte("operation_at", from.toISOString())
    .lte("operation_at", to.toISOString())
    .limit(20000);
  if (error) throw new Error(`lines_failed: ${error.message}`);
  const lines = ((lineRows ?? []) as MatchLine[]).map((l) => ({ ...l, gross: Number(l.gross), refunded: Number(l.refunded ?? 0), diff_amount: Number(l.diff_amount ?? 0) }));
  const candidates = await loadCandidates(admin, tenantId, provider, from, to);

  // Los cobros ya fijados a mano en líneas FUERA del período no son candidatos.
  const { data: pinned } = await admin
    .from("settlement_lines")
    .select("payment_id")
    .eq("tenant_id", tenantId)
    .not("payment_id", "is", null)
    .or(`operation_at.lt.${from.toISOString()},operation_at.gt.${to.toISOString()}`)
    .limit(20000);
  const taken = new Set(((pinned ?? []) as { payment_id: string }[]).map((r) => r.payment_id));
  const pool = candidates.filter((c) => !c.payment_id || !taken.has(c.payment_id));

  const res = matchSettlement(lines, pool);
  const prev = new Map(lines.map((l) => [l.id, l]));
  const changed = res.lines.filter((m) => {
    const p = prev.get(m.line_id);
    return p && p.match_method !== "manual" && p.match_status !== "ignored" && matchChanged(p, m);
  });
  let applied = { updated: 0, reconciled: 0, unreconciled: 0 };
  for (const part of chunk(changed, 300)) {
    const { data, error: rpcErr } = await admin.rpc("_settlement_apply_matches", {
      p_tenant: tenantId,
      p_matches: part,
      p_actor: actor,
    });
    if (rpcErr) throw new Error(`apply_failed: ${rpcErr.message}`);
    const d = data as typeof applied;
    applied = {
      updated: applied.updated + (d?.updated ?? 0),
      reconciled: applied.reconciled + (d?.reconciled ?? 0),
      unreconciled: applied.unreconciled + (d?.unreconciled ?? 0),
    };
  }
  // Venta sin cobro: sólo los cobros del período pedido (no los del margen).
  const unmatched = res.unmatchedPayments.filter((c) => {
    const t = Date.parse(c.created_at);
    return t >= from.getTime() && t <= to.getTime();
  });
  return { lines: lines.length, candidates: pool.length, ...applied, unmatched_payments: unmatched };
}

// ── Cron ─────────────────────────────────────────────────────────────────────

async function runCron(admin: Admin) {
  const t0 = performance.now();
  const { data: rows } = await admin.from("payment_secrets").select("tenant_id").eq("provider_key", "mercadopago");
  const tenants = [...new Set(((rows ?? []) as { tenant_id: string }[]).map((r) => r.tenant_id))];
  const { data: states } = await admin
    .from("settlement_sync_state")
    .select("tenant_id, auto_sync")
    .eq("provider_key", "mercadopago")
    .is("scope_store_id", null);
  const off = new Set(((states ?? []) as { tenant_id: string; auto_sync: boolean }[]).filter((s) => !s.auto_sync).map((s) => s.tenant_id));

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const now = new Date();
  for (const tenantId of tenants) {
    if (performance.now() - t0 > 100_000) break; // presupuesto de la corrida
    if (off.has(tenantId)) {
      skipped++;
      continue;
    }
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "conciliacion_procesadores",
    });
    if (allowed !== true) {
      skipped++;
      continue;
    }
    try {
      await syncMercadoPago(
        admin,
        tenantId,
        [
          { range: "date_created", from: new Date(now.getTime() - 7 * DAY_MS), to: now },
          { range: "money_release_date", from: new Date(now.getTime() - 3 * DAY_MS), to: now },
        ],
        null,
      );
      await runMatch(admin, tenantId, "mercadopago", new Date(now.getTime() - 40 * DAY_MS), now, null);
      synced++;
    } catch (e) {
      failed++;
      console.error(JSON.stringify({ fn: "settlements", tenant: tenantId, error: String(e).slice(0, 200) }));
    }
  }
  const out = { tenants: tenants.length, synced, skipped, failed, ms: Math.round(performance.now() - t0) };
  console.log(JSON.stringify({ fn: "settlements", mode: "cron", ...out }));
  return out;
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Cron: autenticación por secreto interno.
  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  if (b.mode === "cron" || cronSecret) {
    if (!cronSecret) return json({ error: "forbidden" }, 403);
    const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
    if (!token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);
    return json(await runCron(admin));
  }

  // Usuario.
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

  // Dueño o encargado operativo (misma regla que las RPC) y plan.
  const { data: isManager } = await userClient.rpc("is_tenant_manager");
  if (isManager !== true) return json({ error: "forbidden" }, 403);
  const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
    p_tenant: tenantId,
    p_key: "conciliacion_procesadores",
  });
  if (allowed !== true) return json({ error: "feature_not_in_plan" }, 403);

  const action = String(b.action ?? "");
  const provider = String(b.provider ?? "");
  if (!/^[a-z0-9_]{2,40}$/.test(provider)) return json({ error: "invalid_provider" }, 400);
  const range = parseRange(b.from, b.to);
  if (!range) return json({ error: "invalid_range" }, 400);

  try {
    if (action === "sync") {
      if (provider !== "mercadopago") return json({ error: "provider_without_api" }, 400);
      const scopes = await syncMercadoPago(
        admin,
        tenantId,
        [{ range: "date_created", from: range.from, to: range.to }],
        user.id,
      );
      if (scopes.every((s) => s.error === "not_connected")) {
        return json({ error: "not_connected", scopes }, 400);
      }
      const match = await runMatch(admin, tenantId, provider, range.from, range.to, user.id);
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "settlement_sync_state",
        action: "settlement_synced",
        after_data: {
          provider,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          scopes: scopes.map(({ scope, fetched, saved, truncated, error }) => ({ scope, fetched, saved, truncated, error })),
          updated: match.updated,
          reconciled: match.reconciled,
        },
      });
      return json({ scopes, ...match });
    }
    if (action === "match") {
      return json(await runMatch(admin, tenantId, provider, range.from, range.to, user.id));
    }
    return json({ error: "invalid_action" }, 400);
  } catch (e) {
    return json({ error: "failed", detail: String(e).slice(0, 300) }, 500);
  }
});
