// =============================================================================
// Edge Function: staff_payouts (F21 · ADR-121). Spec docs/40-cobranza-saas.md §20.
//
// Participación del staff: calcula con el motor puro
// ../_shared/staff/settlement.ts sobre los insumos de staff_settlement_inputs
// (RPC sólo para service_role) y nunca escribe tablas directamente: el cierre
// lo graba internal_staff_close_run con el JWT del usuario (auditoría con su
// nombre), que vuelve a verificar la base y el invariante en SQL.
//
// Acciones (JWT del usuario + header x-ninja-scope: internal):
//   { action: "preview", period? }      super_admin. Borrador del período abierto
//       más viejo (o el pedido), estimado del mes en curso y proyección del mes
//       próximo, con supuestos.
//   { action: "close", period, notes? } super_admin. Calcula y cierra.
//   { action: "mine" }                  cualquier persona del staff con ficha:
//       SÓLO su línea del mes en curso y de la proyección (sin la base ni las
//       líneas de los demás).
//   { action: "mp_lookup", operation_id, expected_cents }  super_admin.
//       Lee la operación en la cuenta de Mercado Pago de NinjaSoft (access
//       token de plataforma, platform_secrets 'mercadopago'), la controla
//       contra el pago a registrar y la guarda en staff_mp_lookups. La RPC
//       de pago toma el detalle de ahí.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  computeSettlement,
  projectedItems,
  type SettlementInput,
  type SettlementLine,
  type SettlementResult,
  type ProjectionTenant,
} from "../_shared/staff/settlement.ts";
import { addMonths, periodOf } from "../_shared/staff/dates.ts";
import { checkMpPayout, normalizeMpOperationId, parseMpPayment } from "../_shared/staff/mpPayout.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type Raw = Record<string, unknown>;
type Inputs = SettlementInput & {
  locked_until: string | null;
  start_period: string;
  house_label: string;
  collection_rate_bp: number;
  mp_tolerance_cents: number;
  projection: { period: string; collection_rate_bp: number; fee_rate_bp: number; tenants: ProjectionTenant[] };
};

const num = (v: unknown) => Number(v ?? 0);
const arr = <T = Raw>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function arToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

async function loadInputs(admin: SupabaseClient, period: string): Promise<Inputs> {
  const { data, error } = await admin.rpc("staff_settlement_inputs", { p_period: period });
  if (error || !data) throw new Error(error?.message ?? "inputs_failed");
  const d = data as Raw;
  const s = (d.settings ?? {}) as Raw;
  const p = (d.projection ?? {}) as Raw;
  return {
    period: String(d.period),
    settings: {
      houseAbsorbsExpenses: s.houseAbsorbsExpenses !== false,
      negativeCarry: s.negativeCarry !== false,
      incomeTaxReserveBp: num(s.incomeTaxReserveBp),
    },
    start_period: String(s.start_period),
    house_label: String(s.house_label ?? "NinjaSoft"),
    collection_rate_bp: num(s.collectionRateBp),
    mp_tolerance_cents: num(s.mpToleranceCents),
    locked_until: (d.locked_until as string | null) ?? null,
    members: arr<Raw>(d.members).map((m) => ({ id: String(m.id), name: String(m.name) })),
    shares: arr<Raw>(d.shares).map((x) => ({
      member_id: String(x.member_id),
      share_bp: num(x.share_bp),
      expense_bp: x.expense_bp === null || x.expense_bp === undefined ? null : num(x.expense_bp),
      valid_from: String(x.valid_from),
      valid_to: (x.valid_to as string | null) ?? null,
    })),
    clientRules: arr<Raw>(d.clientRules).map((r) => ({
      id: String(r.id),
      member_id: String(r.member_id),
      tenant_id: String(r.tenant_id),
      kind: r.kind as SettlementInput["clientRules"][number]["kind"],
      value: num(r.value),
      valid_from: String(r.valid_from),
      valid_to: (r.valid_to as string | null) ?? null,
    })),
    appliedSignupRuleIds: arr<string>(d.appliedSignupRuleIds).map(String),
    items: arr<Raw>(d.items).map((i) => ({
      source: i.source as "payment" | "reversal",
      id: String(i.id),
      tenant_id: String(i.tenant_id),
      tenant_name: String(i.tenant_name ?? ""),
      date: String(i.date),
      amount_cents: num(i.amount_cents),
      fee_cents: num(i.fee_cents),
    })),
    expenses: arr<Raw>(d.expenses).map((e) => ({
      id: String(e.id),
      name: String(e.name),
      category: e.category as SettlementInput["expenses"][number]["category"],
      vendor: (e.vendor as string | null) ?? null,
      amount_cents: num(e.amount_cents),
      currency: e.currency === "USD" ? "USD" : "ARS",
      recurrence: e.recurrence as SettlementInput["expenses"][number]["recurrence"],
      interval_n: e.interval_n === null || e.interval_n === undefined ? null : num(e.interval_n),
      start_date: String(e.start_date),
      end_date: (e.end_date as string | null) ?? null,
      spread_months: num(e.spread_months) || 1,
      allocation: e.allocation as SettlementInput["expenses"][number]["allocation"],
      member_id: (e.member_id as string | null) ?? null,
      tenant_id: (e.tenant_id as string | null) ?? null,
      custom: arr<Raw>(e.custom).map((c) => ({ member_id: (c.member_id as string | null) ?? null, share_bp: num(c.share_bp) })),
      exemptions: arr<Raw>(e.exemptions).map((x) => ({
        member_id: String(x.member_id),
        valid_from: (x.valid_from as string | null) ?? null,
        valid_to: (x.valid_to as string | null) ?? null,
      })),
      period_amounts: arr<Raw>(e.period_amounts).map((x) => ({ period: String(x.period), amount_cents: num(x.amount_cents) })),
    })),
    fxRates: arr<Raw>(d.fxRates).map((f) => ({ period: String(f.period), currency: "USD" as const, rate: num(f.rate) })),
    adjustments: arr<Raw>(d.adjustments).map((a) => ({
      id: String(a.id),
      member_id: String(a.member_id),
      amount_cents: num(a.amount_cents),
      reason: String(a.reason ?? ""),
    })),
    carryIn: arr<Raw>(d.carryIn).map((c) => ({ member_id: String(c.member_id), amount_cents: num(c.amount_cents) })),
    projection: {
      period: String(p.period),
      collection_rate_bp: num(p.collection_rate_bp),
      fee_rate_bp: num(p.fee_rate_bp),
      tenants: arr<Raw>(p.tenants).map((t) => ({
        tenant_id: String(t.tenant_id),
        tenant_name: String(t.tenant_name ?? ""),
        expected_cents: num(t.expected_cents),
        cycle: t.cycle === "yearly" ? "yearly" : "monthly",
        due_date: String(t.due_date),
      })),
    },
  };
}

/** Proyección del mes siguiente a `base`: ingresos esperados, gastos recurrentes y arrastre del estimado actual. */
function project(inp: Inputs, current: SettlementResult) {
  const items = projectedItems(inp.projection.tenants, inp.projection.period, inp.projection.collection_rate_bp, inp.projection.fee_rate_bp);
  const result = computeSettlement({
    ...inp,
    period: inp.projection.period,
    items,
    adjustments: [],
    carryIn: current.lines.filter((l) => l.carry_out_cents < 0).map((l) => ({ member_id: l.member_id, amount_cents: l.carry_out_cents })),
    appliedSignupRuleIds: [...inp.appliedSignupRuleIds, ...current.lines.flatMap((l) => l.signup_rule_ids)],
  });
  const assumptions = {
    period: inp.projection.period,
    collection_rate_bp: inp.projection.collection_rate_bp,
    fee_rate_bp: inp.projection.fee_rate_bp,
    tenants: inp.projection.tenants.length,
    expected_cents: inp.projection.tenants.reduce((s, t) => s + t.expected_cents, 0),
    detail: inp.projection.tenants,
    notes: [
      "Suscripciones activas o en mora que se cobran, con sus descuentos vigentes (precios con IVA incluido).",
      "Mensuales: una vez en el mes. Anuales: sólo si renuevan en ese mes.",
      "No suma pruebas que todavía no pagaron ni bajas programadas.",
      "Comisión de cobro estimada con el promedio de los últimos 90 días.",
      "Gastos recurrentes del mes; los en dólares con la última cotización cargada.",
      "Sin ajustes manuales del mes próximo; incluye el saldo negativo que arrastre el mes en curso.",
    ],
  };
  return { result, assumptions };
}

function firstOpenPeriod(inp: Pick<Inputs, "locked_until" | "start_period">): string {
  if (!inp.locked_until) return inp.start_period;
  return addMonths(periodOf(inp.locked_until), 1);
}

const ownLine = (r: SettlementResult, memberIds: string[]): SettlementLine | null =>
  r.lines.find((l) => memberIds.includes(l.member_id)) ?? null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: {
        Authorization: req.headers.get("Authorization") ?? "",
        ...(req.headers.get("x-ninja-scope") === "internal" ? { "x-ninja-scope": "internal" } : {}),
      },
    },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  // Quién es, según la base (internal_scope + nivel + ficha de staff).
  const { data: access, error: accErr } = await userClient.rpc("internal_staff_access");
  const acc = (access ?? {}) as { is_staff?: boolean; is_owner?: boolean; member_ids?: string[] };
  if (accErr || !acc.is_staff) return json({ error: "forbidden" }, 403);
  const isOwner = acc.is_owner === true;
  const memberIds = (acc.member_ids ?? []).map(String);

  let body: Raw = {};
  try {
    body = (await req.json()) as Raw;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");
  const thisMonth = periodOf(arToday());

  try {
    if (action === "mine") {
      if (memberIds.length === 0) return json({ ok: true, member: false });
      const inp = await loadInputs(admin, thisMonth);
      const current = computeSettlement(inp);
      const proj = project(inp, current);
      return json({
        ok: true,
        member: true,
        current: { period: current.period, line: ownLine(current, memberIds), warnings: current.warnings.length },
        projection: {
          period: proj.result.period,
          line: ownLine(proj.result, memberIds),
          assumptions: { ...proj.assumptions, detail: undefined, expected_cents: undefined },
        },
      });
    }

    if (!isOwner) return json({ error: "forbidden" }, 403);

    if (action === "preview") {
      const cur = await loadInputs(admin, thisMonth);
      const open = firstOpenPeriod(cur);
      const askedRaw = typeof body.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.period) ? periodOf(body.period) : open;
      const asked = askedRaw < cur.start_period ? cur.start_period : askedRaw;
      const draftInp = asked === thisMonth ? cur : await loadInputs(admin, asked);
      const draft = computeSettlement(draftInp);
      const current = asked === thisMonth ? draft : computeSettlement(cur);
      const proj = project(cur, current);
      return json({
        ok: true,
        house_label: cur.house_label,
        start_period: cur.start_period,
        locked_until: cur.locked_until,
        open_period: open,
        this_month: thisMonth,
        draft: { result: draft, can_close: asked === open && asked < thisMonth && draft.errors.length === 0 },
        current: asked === thisMonth ? null : current,
        projection: proj,
        settings: { ...cur.settings, collectionRateBp: cur.collection_rate_bp, mpToleranceCents: cur.mp_tolerance_cents },
      });
    }

    if (action === "close") {
      const period = typeof body.period === "string" ? periodOf(body.period) : "";
      if (!period) return json({ error: "period_required" }, 400);
      const inp = await loadInputs(admin, period);
      const result = computeSettlement(inp);
      if (result.errors.length) return json({ ok: false, error: "result_has_errors", errors: result.errors }, 422);
      const { data, error } = await userClient.rpc("internal_staff_close_run", {
        p_period: period,
        p_result: result,
        p_notes: typeof body.notes === "string" ? body.notes.slice(0, 500) : null,
      });
      if (error) return json({ ok: false, error: error.message }, 409);
      return json({ ok: true, run_id: data, result });
    }

    if (action === "mp_lookup") {
      const op = normalizeMpOperationId(String(body.operation_id ?? ""));
      const expected = Math.round(num(body.expected_cents));
      if (!op) return json({ ok: false, error: "invalid_operation_id" }, 400);
      const { data: plat } = await admin.from("platform_secrets").select("secrets").eq("key", "mercadopago").maybeSingle();
      const token = ((plat?.secrets ?? null) as { access_token?: string } | null)?.access_token;
      if (!token) return json({ ok: false, error: "mp_not_configured" });

      const headers = { Authorization: `Bearer ${token}` };
      const [payRes, meRes] = await Promise.all([
        fetch(`https://api.mercadopago.com/v1/payments/${op}`, { headers }),
        fetch("https://api.mercadopago.com/users/me", { headers }),
      ]);
      const me = meRes.ok ? ((await meRes.json()) as { id?: number | string; nickname?: string }) : null;
      if (!payRes.ok) {
        const error = payRes.status === 404 ? "mp_not_found" : `mp_http_${payRes.status}`;
        await admin.from("staff_mp_lookups").insert({ operation_id: op, ok: false, error, fetched_by: user.id });
        return json({ ok: false, error, account: me?.nickname ?? null });
      }
      const summary = parseMpPayment(await payRes.json());
      if (!summary) {
        await admin.from("staff_mp_lookups").insert({ operation_id: op, ok: false, error: "mp_unreadable", fetched_by: user.id });
        return json({ ok: false, error: "mp_unreadable" });
      }
      const check = checkMpPayout(summary, {
        expected_cents: expected,
        own_user_id: me?.id !== undefined ? String(me.id) : null,
        tolerance_cents: (await loadToleranceCents(admin)) ?? 0,
      });
      const stored = { ...summary, check, account: { id: me?.id ?? null, nickname: me?.nickname ?? null } };
      const { data: row } = await admin
        .from("staff_mp_lookups")
        .insert({ operation_id: op, ok: true, summary: stored, fetched_by: user.id })
        .select("id")
        .single();
      return json({ ok: true, lookup_id: (row as { id: string } | null)?.id ?? null, summary: stored, check });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "error" }, 500);
  }
});

async function loadToleranceCents(admin: SupabaseClient): Promise<number | null> {
  const { data } = await admin.from("staff_payout_settings").select("mp_amount_tolerance_cents").eq("id", true).maybeSingle();
  return data ? Number((data as { mp_amount_tolerance_cents: number }).mp_amount_tolerance_cents) : null;
}
