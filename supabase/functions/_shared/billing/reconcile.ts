// =============================================================================
// Conciliación diaria con Mercado Pago (F20-10 · H136 · ADR-131). Spec
// docs/40-cobranza-saas.md §9.5, §17.2 y §17.3.
//
// Lógica pura, sin red ni base: la Edge `platform_mp_reconcile` lee los pagos
// de la cuenta de NinjaSoft (GET /v1/payments/search) y los insumos locales
// (platform_recon_inputs), llama a reconcile() y graba el resultado con
// platform_recon_finish (la forma de la salida es la de ese RPC). Corre igual
// en Deno y en Node (los tests la importan desde lib/billing/reconcile.ts).
//
// Qué compara:
//   · Cruce exacto: pago local de proveedor 'mercadopago' con external_id = id
//     del pago de MP (o el cruce que ya quedó grabado en una corrida anterior).
//   · Cruce flojo: mismo negocio (external_reference = id de la suscripción o
//     preapproval), monto dentro de la tolerancia y fecha a ±3 días. Cubre los
//     pagos que el webhook guardó con el id del authorized_payment o del
//     preapproval en lugar del id del pago. No genera diferencia.
//   · Diferencias: faltante en el ledger, faltante en MP, montos distintos,
//     contracargo o mediación, reintegro, estado distinto y duplicados (en el
//     ledger por negocio y período, en MP por negocio y monto dentro de 72 h).
// Nunca guarda datos del pagador.
// =============================================================================

export interface MpPayment {
  mp_payment_id: string;
  status: string;
  status_detail: string | null;
  operation_type: string | null;
  amount_cents: number;
  refunded_cents: number;
  fee_cents: number | null;
  net_cents: number | null;
  date_created: string | null;
  date_approved: string | null;
  date_last_updated: string | null;
  external_reference: string | null;
  preapproval_id: string | null;
  description: string | null;
}

/** Pago local (platform_recon_inputs().payments). */
export interface LocalPayment {
  id: string;
  tenant_id: string;
  method: string;
  status: string;
  amount_cents: number;
  fee_cents: number | null;
  net_cents: number | null;
  paid_at: string;
  provider: string | null;
  external_id: string | null;
  period_start: string | null;
  refunded_cents: number;
}

/** Suscripción para ubicar al negocio de un pago (platform_recon_inputs().subscriptions). */
export interface SubRef {
  id: string;
  tenant_id: string;
  preapproval_id: string | null;
  tenant_name: string | null;
  excluded: string | null;
}

/** Cruce grabado en una corrida anterior (platform_recon_inputs().seen). */
export interface SeenRef {
  mp_payment_id: string;
  payment_id: string | null;
  tenant_id: string | null;
}

export type ReconKind =
  | "missing_local"
  | "missing_mp"
  | "duplicate"
  | "amount_mismatch"
  | "chargeback"
  | "refund"
  | "status_mismatch";

export type ReconSeverity = "high" | "medium" | "low";

export interface ReconDiff {
  key: string;
  kind: ReconKind;
  severity: ReconSeverity;
  tenant_id: string | null;
  payment_id: string | null;
  mp_payment_id: string | null;
  expected_cents: number | null;
  actual_cents: number | null;
  detail: Record<string, unknown>;
}

export interface ReconMpOut extends MpPayment {
  tenant_id: string | null;
  payment_id: string | null;
  match_kind: "exact" | "loose" | null;
}

export interface ReconFee {
  payment_id: string;
  fee_cents: number;
  net_cents: number | null;
}

/** Forma exacta de p_result de platform_recon_finish. */
export interface ReconResult {
  mp_payments: ReconMpOut[];
  diffs: ReconDiff[];
  fees: ReconFee[];
  matched: number;
  local_count: number;
  scope_mp_ids: string[];
  scope_payment_ids: string[];
}

export interface ReconcileInput {
  mp: MpPayment[];
  local: LocalPayment[];
  subscriptions: SubRef[];
  seen?: SeenRef[];
  window: { from: string; to: string };
  toleranceCents: number;
  /** false = sin credenciales de MP: sólo se revisan los duplicados locales. */
  mpAvailable: boolean;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const DAY_MS = 86_400_000;

function toCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Un elemento de `results` de /v1/payments/search → MpPayment. null si no
 * tiene id o monto. La comisión es la suma de fee_details que paga el
 * cobrador (si MP no la detalla, monto menos neto); el neto sale de
 * transaction_details.net_received_amount.
 */
export function parseMpPayment(raw: unknown): MpPayment | null {
  const p = obj(raw);
  const id = str(p.id);
  const amount = toCents(p.transaction_amount);
  if (!id || amount === null) return null;
  const net = toCents(obj(p.transaction_details).net_received_amount);
  let fee: number | null = null;
  if (Array.isArray(p.fee_details) && p.fee_details.length > 0) {
    fee = 0;
    for (const f of p.fee_details) {
      const fo = obj(f);
      const payer = str(fo.fee_payer);
      if (payer && payer !== "collector") continue;
      fee += toCents(fo.amount) ?? 0;
    }
  } else if (net !== null) {
    fee = Math.max(amount - net, 0);
  }
  const meta = obj(p.metadata);
  const poi = obj(obj(p.point_of_interaction).transaction_data);
  return {
    mp_payment_id: id,
    status: str(p.status) ?? "unknown",
    status_detail: str(p.status_detail),
    operation_type: str(p.operation_type),
    amount_cents: amount,
    refunded_cents: Math.max(toCents(p.transaction_amount_refunded) ?? 0, 0),
    fee_cents: fee,
    net_cents: net,
    date_created: str(p.date_created),
    date_approved: str(p.date_approved),
    date_last_updated: str(p.date_last_updated),
    external_reference: str(p.external_reference),
    preapproval_id: str(meta.preapproval_id) ?? str(poi.subscription_id),
    description: str(p.description),
  };
}

/** Ventana de la conciliación: las últimas `hours` horas hasta `now`. */
export function reconWindow(now: Date, hours: number): { from: string; to: string } {
  const h = Math.min(Math.max(Math.round(Number(hours) || 72), 1), 24 * 365);
  return { from: new Date(now.getTime() - h * 3_600_000).toISOString(), to: now.toISOString() };
}

const APPROVED_MP = new Set(["approved", "authorized"]);
const LOOSE_MP = new Set(["approved", "authorized", "refunded", "charged_back", "in_mediation"]);
const ts = (v: string | null | undefined): number => (v ? Date.parse(v) : NaN);
const mpDate = (m: MpPayment): number => {
  const a = ts(m.date_approved);
  return Number.isFinite(a) ? a : ts(m.date_created);
};
const isMpMethod = (l: LocalPayment) => l.provider === "mercadopago" || l.method.startsWith("mp_");
const daysApart = (a: number, b: number) => Math.round((Math.abs(a - b) / DAY_MS) * 10) / 10;

export function reconcile(input: ReconcileInput): ReconResult {
  const tol = Math.max(0, Math.round(Number(input.toleranceCents) || 0));
  const from = ts(input.window.from);
  const to = ts(input.window.to);
  const inWindow = (l: LocalPayment) => {
    const t = ts(l.paid_at);
    return t >= from && t <= to;
  };
  const subsById = new Map(input.subscriptions.map((s) => [s.id, s]));
  const subsByPre = new Map(input.subscriptions.filter((s) => s.preapproval_id).map((s) => [s.preapproval_id as string, s]));
  const subByTenant = new Map(input.subscriptions.map((s) => [s.tenant_id, s]));
  const localById = new Map(input.local.map((l) => [l.id, l]));
  const seenByMp = new Map((input.seen ?? []).map((s) => [s.mp_payment_id, s]));
  // La cuenta de NinjaSoft también cobra otras cosas (compras de catálogos de
  // Tiendita, con external_reference = intent): sólo se concilian los pagos de
  // suscripciones (débito recurrente, referencia a una suscripción o a su
  // preapproval) y los que ya están en el ledger o se cruzaron antes.
  const localExt = new Set(input.local.filter((l) => l.provider === "mercadopago" && l.external_id).map((l) => l.external_id as string));
  const isBilling = (m: MpPayment) =>
    m.operation_type === "recurring_payment" ||
    (m.external_reference !== null && subsById.has(m.external_reference)) ||
    (m.preapproval_id !== null && subsByPre.has(m.preapproval_id)) ||
    localExt.has(m.mp_payment_id) ||
    seenByMp.has(m.mp_payment_id);
  const mpAll = input.mpAvailable ? input.mp : [];
  const mpList = mpAll.filter(isBilling);

  const tenantOf = (m: MpPayment): string | null => {
    if (m.external_reference && subsById.has(m.external_reference)) return subsById.get(m.external_reference)!.tenant_id;
    if (m.preapproval_id && subsByPre.has(m.preapproval_id)) return subsByPre.get(m.preapproval_id)!.tenant_id;
    return seenByMp.get(m.mp_payment_id)?.tenant_id ?? null;
  };
  const tenantInfo = (tenantId: string | null) => {
    const s = tenantId ? subByTenant.get(tenantId) : undefined;
    const d: Record<string, unknown> = { tenant_name: s?.tenant_name ?? null };
    if (s?.excluded) d.excluded = s.excluded;
    return d;
  };

  const diffs: ReconDiff[] = [];
  const fees: ReconFee[] = [];
  const out: ReconMpOut[] = [];
  const matchedLocal = new Set<string>();

  // 1) Cruces exactos (por id o por el cruce grabado).
  const exact = new Map<string, LocalPayment>();
  for (const m of mpList) {
    let l = input.local.find((x) => x.provider === "mercadopago" && x.external_id === m.mp_payment_id);
    if (!l) {
      const seenPay = seenByMp.get(m.mp_payment_id)?.payment_id;
      if (seenPay && localById.has(seenPay)) l = localById.get(seenPay);
    }
    if (l) {
      exact.set(m.mp_payment_id, l);
      matchedLocal.add(l.id);
    }
  }

  // 2) Cruces flojos sobre lo que quedó sin cruzar.
  const loose = new Map<string, LocalPayment>();
  const ordered = [...mpList].sort((a, b) => mpDate(a) - mpDate(b) || a.mp_payment_id.localeCompare(b.mp_payment_id));
  for (const m of ordered) {
    if (exact.has(m.mp_payment_id) || !LOOSE_MP.has(m.status)) continue;
    const tenant = tenantOf(m);
    if (!tenant) continue;
    const t = mpDate(m);
    const cands = input.local
      .filter(
        (l) =>
          l.tenant_id === tenant &&
          isMpMethod(l) &&
          !matchedLocal.has(l.id) &&
          Math.abs(l.amount_cents - m.amount_cents) <= tol &&
          Number.isFinite(t) &&
          Math.abs(ts(l.paid_at) - t) <= 3 * DAY_MS,
      )
      .sort((a, b) => Math.abs(ts(a.paid_at) - t) - Math.abs(ts(b.paid_at) - t) || a.id.localeCompare(b.id));
    if (cands[0]) {
      loose.set(m.mp_payment_id, cands[0]);
      matchedLocal.add(cands[0].id);
    }
  }

  // 3) Diferencias por pago de MP.
  let matched = 0;
  for (const m of mpList) {
    const l = exact.get(m.mp_payment_id) ?? loose.get(m.mp_payment_id) ?? null;
    const tenant = l?.tenant_id ?? tenantOf(m);
    out.push({
      ...m,
      tenant_id: tenant,
      payment_id: l?.id ?? null,
      match_kind: exact.has(m.mp_payment_id) ? "exact" : loose.has(m.mp_payment_id) ? "loose" : null,
    });
    const base = {
      ...tenantInfo(tenant),
      mp_status: m.status,
      mp_status_detail: m.status_detail,
      mp_date: m.date_approved ?? m.date_created,
    };
    if (!l) {
      if (APPROVED_MP.has(m.status)) {
        diffs.push({
          key: `missing_local:${m.mp_payment_id}`,
          kind: "missing_local",
          severity: "high",
          tenant_id: tenant,
          payment_id: null,
          mp_payment_id: m.mp_payment_id,
          expected_cents: m.amount_cents,
          actual_cents: null,
          detail: { ...base, description: m.description, external_reference: m.external_reference },
        });
      }
      continue;
    }
    matched++;
    const ldetail = { ...base, local_status: l.status, period_start: l.period_start, paid_at: l.paid_at };
    if (Math.abs(l.amount_cents - m.amount_cents) > tol) {
      diffs.push({
        key: `amount:${m.mp_payment_id}`,
        kind: "amount_mismatch",
        severity: "medium",
        tenant_id: tenant,
        payment_id: l.id,
        mp_payment_id: m.mp_payment_id,
        expected_cents: l.amount_cents,
        actual_cents: m.amount_cents,
        detail: { ...ldetail, difference_cents: m.amount_cents - l.amount_cents },
      });
    }
    if ((m.status === "charged_back" || m.status === "in_mediation") && l.status === "approved") {
      diffs.push({
        key: `chargeback:${m.mp_payment_id}`,
        kind: "chargeback",
        severity: "high",
        tenant_id: tenant,
        payment_id: l.id,
        mp_payment_id: m.mp_payment_id,
        expected_cents: l.amount_cents,
        actual_cents: m.amount_cents,
        detail: ldetail,
      });
    } else if (m.status === "refunded" || m.refunded_cents > 0) {
      const target = m.status === "refunded" ? Math.max(m.refunded_cents, m.amount_cents) : m.refunded_cents;
      if ((l.status === "approved" || l.status === "partially_refunded") && l.refunded_cents < target) {
        diffs.push({
          key: `refund:${m.mp_payment_id}:${target}`,
          kind: "refund",
          severity: "high",
          tenant_id: tenant,
          payment_id: l.id,
          mp_payment_id: m.mp_payment_id,
          expected_cents: l.refunded_cents,
          actual_cents: target,
          detail: { ...ldetail, refunded_cents: target, partial: target < l.amount_cents },
        });
      }
    } else if ((m.status === "rejected" || m.status === "cancelled") && l.status === "approved") {
      diffs.push({
        key: `status:${m.mp_payment_id}:${m.status}`,
        kind: "status_mismatch",
        severity: "medium",
        tenant_id: tenant,
        payment_id: l.id,
        mp_payment_id: m.mp_payment_id,
        expected_cents: l.amount_cents,
        actual_cents: m.amount_cents,
        detail: ldetail,
      });
    }
    if (m.fee_cents !== null && (l.fee_cents !== m.fee_cents || (m.net_cents !== null && l.net_cents !== m.net_cents))) {
      fees.push({ payment_id: l.id, fee_cents: m.fee_cents, net_cents: m.net_cents });
    }
  }

  // 4) Duplicados en MP: mismo negocio y monto dentro de 72 h.
  const approvedByTenant = new Map<string, MpPayment[]>();
  for (const o of out) {
    if (o.status !== "approved" || !o.tenant_id) continue;
    const arr = approvedByTenant.get(o.tenant_id) ?? [];
    arr.push(o);
    approvedByTenant.set(o.tenant_id, arr);
  }
  for (const [tenant, arr] of approvedByTenant) {
    arr.sort((a, b) => mpDate(a) - mpDate(b) || a.mp_payment_id.localeCompare(b.mp_payment_id));
    for (let i = 1; i < arr.length; i++) {
      const later = arr[i]!;
      const prev = arr
        .slice(0, i)
        .reverse()
        .find((p) => Math.abs(p.amount_cents - later.amount_cents) <= tol && mpDate(later) - mpDate(p) < 3 * DAY_MS);
      if (!prev) continue;
      diffs.push({
        key: `dup_mp:${later.mp_payment_id}`,
        kind: "duplicate",
        severity: "medium",
        tenant_id: tenant,
        payment_id: (out.find((o) => o.mp_payment_id === later.mp_payment_id)?.payment_id as string | null) ?? null,
        mp_payment_id: later.mp_payment_id,
        expected_cents: prev.amount_cents,
        actual_cents: later.amount_cents,
        detail: {
          ...tenantInfo(tenant),
          source: "mp",
          other_mp_payment_id: prev.mp_payment_id,
          days_apart: daysApart(mpDate(later), mpDate(prev)),
          mp_status: later.status,
        },
      });
    }
  }

  // 5) Duplicados en el ledger: dos pagos aprobados del mismo negocio y período.
  const byPeriod = new Map<string, LocalPayment[]>();
  for (const l of input.local) {
    if (l.status !== "approved" || !l.period_start) continue;
    const k = `${l.tenant_id}:${l.period_start}`;
    const arr = byPeriod.get(k) ?? [];
    arr.push(l);
    byPeriod.set(k, arr);
  }
  for (const arr of byPeriod.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => ts(a.paid_at) - ts(b.paid_at) || a.id.localeCompare(b.id));
    const first = arr[0]!;
    for (const l of arr.slice(1)) {
      diffs.push({
        key: `dup_local:${l.tenant_id}:${l.period_start}:${l.id}`,
        kind: "duplicate",
        severity: "medium",
        tenant_id: l.tenant_id,
        payment_id: l.id,
        mp_payment_id: l.provider === "mercadopago" ? l.external_id : null,
        expected_cents: first.amount_cents,
        actual_cents: l.amount_cents,
        detail: {
          ...tenantInfo(l.tenant_id),
          source: "ledger",
          period_start: l.period_start,
          other_payment_id: first.id,
          days_apart: daysApart(ts(l.paid_at), ts(first.paid_at)),
          local_status: l.status,
          method: l.method,
        },
      });
    }
  }

  // 6) Faltantes en MP: pagos de MP del ledger dentro de la ventana sin cruce.
  if (input.mpAvailable) {
    for (const l of input.local) {
      if (!isMpMethod(l) || l.status !== "approved" || !inWindow(l) || matchedLocal.has(l.id)) continue;
      diffs.push({
        key: `missing_mp:${l.id}`,
        kind: "missing_mp",
        severity: "low",
        tenant_id: l.tenant_id,
        payment_id: l.id,
        mp_payment_id: null,
        expected_cents: l.amount_cents,
        actual_cents: null,
        detail: { ...tenantInfo(l.tenant_id), local_status: l.status, external_id: l.external_id, paid_at: l.paid_at, period_start: l.period_start },
      });
    }
  }

  const scopePayments = new Set<string>();
  for (const l of input.local) if (inWindow(l)) scopePayments.add(l.id);
  for (const id of matchedLocal) scopePayments.add(id);

  return {
    mp_payments: out,
    diffs,
    fees,
    matched,
    local_count: input.local.filter(inWindow).length,
    scope_mp_ids: mpList.map((m) => m.mp_payment_id),
    scope_payment_ids: [...scopePayments],
  };
}
