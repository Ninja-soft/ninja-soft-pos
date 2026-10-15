// =============================================================================
// Cobranza 360 (F20-11 · H136 · ADR-131): lógica pura de la lista de cobranza
// (filtros, aging, totales, export) y de la historia unificada por negocio
// (texto de cada hecho). Los datos vienen de internal_billing_portfolio e
// internal_billing_timeline (20261126100000_cobranza_360); acá no hay red.
// =============================================================================

import { BILLING_MODE_LABELS, CHARGE_KIND_LABELS, CHARGE_STATUS_LABELS, PAYMENT_STATUS_LABELS, formatCents, formatDay } from "@/lib/billing/ledger";
import { COLLECTION_STATE_LABELS, DUNNING_ACTION_LABELS, PROMISE_STATUS_LABELS, type CollectionState, type DunningAction, type PromiseStatus } from "@/lib/billing/mora";
import { xlsxDate, xlsxDay, type XlsxSheet } from "@/lib/utils/xlsx";

// ── Tipos ───────────────────────────────────────────────────────────────────

export interface PortfolioCollection {
  state: CollectionState;
  days_overdue: number;
  soft_restricted: boolean;
  last_step_action: DunningAction | null;
  last_step_title: string | null;
  last_step_at: string | null;
  next_step_action: DunningAction | null;
  next_step_title: string | null;
  next_step_date: string | null;
  suspend_on: string | null;
  status_by_ladder: "past_due" | "suspended" | null;
  uncollectible_at: string | null;
}

export interface PortfolioRow {
  tenant_id: string;
  name: string;
  slug: string | null;
  billing_mode: string;
  sub_status: string | null;
  plan_name: string | null;
  billing_cycle: string | null;
  balance_cents: number;
  overdue_cents: number;
  upcoming_cents: number;
  credit_cents: number;
  oldest_due_date: string | null;
  days_overdue: number;
  aging: { d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  collection: PortfolioCollection | null;
  promise: { id: string; amount_cents: number; promised_date: string; channel: "owner" | "staff"; paid_cents: number | null } | null;
  broken_promises_90d: number;
  collector: { id: string; name: string | null; assigned_at: string | null } | null;
  last_note: { at: string; kind: NoteKind; outcome: NoteOutcome | null; body: string; next_action_at: string | null; by: string | null } | null;
  next_action_at: string | null;
  notes_count: number;
  last_payment_at: string | null;
  open_diffs: number;
}

export interface Collector {
  id: string;
  name: string;
  level: string;
  tenants: number;
}

export interface Portfolio {
  as_of: string;
  rows: PortfolioRow[];
  excluded_count: number;
  me: string | null;
  can_manage: boolean;
  can_assign: boolean;
  collectors: Collector[];
}

export type TimelineGroup = "plata" | "gestion" | "mora" | "avisos" | "plan";

export interface Timeline360Event {
  id: string;
  at: string;
  group: TimelineGroup;
  kind: string;
  amount_cents: number | null;
  actor: string | null;
  data: Record<string, unknown>;
}

export interface Timeline360 {
  tenant_id: string;
  name: string;
  exclusion: string | null;
  can_manage: boolean;
  collector: { id: string; name: string | null } | null;
  scheduled_change: { id: string; kind: string; effective_on: string; to_plan: string | null; to_cycle: string | null } | null;
  events: Timeline360Event[];
}

export type NoteKind = "call" | "whatsapp" | "email" | "meeting" | "other";
export type NoteOutcome = "contacted" | "no_answer" | "promised" | "disputed" | "other";

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  call: "Llamada",
  whatsapp: "WhatsApp",
  email: "Email",
  meeting: "Reunión",
  other: "Otra gestión",
};

export const NOTE_OUTCOME_LABELS: Record<NoteOutcome, string> = {
  contacted: "Hablamos",
  no_answer: "No contestó",
  promised: "Prometió pagar",
  disputed: "Reclama la deuda",
  other: "Otro",
};

export const TIMELINE_GROUP_LABELS: Record<TimelineGroup, string> = {
  plata: "Plata",
  gestion: "Gestiones",
  mora: "Mora",
  avisos: "Avisos",
  plan: "Plan",
};

// ── Aging y escalera ────────────────────────────────────────────────────────

export type AgingBucket = "al_dia" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export const AGING_LABELS: Record<AgingBucket, string> = {
  al_dia: "Al día",
  d1_30: "1 a 30 días",
  d31_60: "31 a 60 días",
  d61_90: "61 a 90 días",
  d90_plus: "Más de 90 días",
};

/** Tramo de antigüedad por la deuda vencida más vieja. */
export function agingBucket(row: Pick<PortfolioRow, "overdue_cents" | "days_overdue">): AgingBucket {
  const d = Math.max(0, Math.trunc(Number(row.days_overdue) || 0));
  if (Number(row.overdue_cents) <= 0 || d <= 0) return "al_dia";
  if (d <= 30) return "d1_30";
  if (d <= 60) return "d31_60";
  if (d <= 90) return "d61_90";
  return "d90_plus";
}

export type LadderFilter = "sin_mora" | "vencida" | "en_promesa" | "restringida" | "suspendida" | "incobrable";

export const LADDER_LABELS: Record<LadderFilter, string> = {
  sin_mora: "Sin mora",
  vencida: "Vencida",
  en_promesa: "En promesa",
  restringida: "Restringida",
  suspendida: "Suspendida",
  incobrable: "Incobrable",
};

/** Estado de la escalera más grave que aplica al negocio. */
export function ladderState(row: Pick<PortfolioRow, "collection" | "sub_status" | "overdue_cents">): LadderFilter {
  const c = row.collection;
  if (c?.state === "incobrable" || c?.uncollectible_at) return "incobrable";
  if (row.sub_status === "suspended" || c?.status_by_ladder === "suspended") return "suspendida";
  if (c?.soft_restricted) return "restringida";
  if (c?.state === "en_promesa") return "en_promesa";
  if (c?.state === "vencida" || Number(row.overdue_cents) > 0) return "vencida";
  return "sin_mora";
}

export const LADDER_TONES: Record<LadderFilter, "success" | "warning" | "info" | "danger" | "neutral"> = {
  sin_mora: "success",
  vencida: "warning",
  en_promesa: "info",
  restringida: "warning",
  suspendida: "danger",
  incobrable: "danger",
};

// ── Filtros, orden y totales ────────────────────────────────────────────────

export interface PortfolioFilters {
  q: string;
  aging: "all" | AgingBucket;
  minCents: number | null;
  maxCents: number | null;
  ladder: "all" | LadderFilter;
  promise: "all" | "con" | "sin";
  /** all, none (sin asignar), me (los míos) o el id de una persona. */
  collector: string;
  me: string | null;
}

export const EMPTY_FILTERS: PortfolioFilters = {
  q: "",
  aging: "all",
  minCents: null,
  maxCents: null,
  ladder: "all",
  promise: "all",
  collector: "all",
  me: null,
};

const fold = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export function filterPortfolio(rows: PortfolioRow[], f: PortfolioFilters): PortfolioRow[] {
  const q = fold(f.q.trim());
  return rows.filter((r) => {
    if (q && !fold(r.name).includes(q) && !fold(r.slug).includes(q) && !fold(r.collector?.name).includes(q)) return false;
    if (f.aging !== "all" && agingBucket(r) !== f.aging) return false;
    // El monto filtra por lo vencido si hay mora; si no, por el saldo.
    const amount = r.overdue_cents > 0 ? r.overdue_cents : r.balance_cents;
    if (f.minCents != null && amount < f.minCents) return false;
    if (f.maxCents != null && amount > f.maxCents) return false;
    if (f.ladder !== "all" && ladderState(r) !== f.ladder) return false;
    if (f.promise === "con" && !r.promise) return false;
    if (f.promise === "sin" && r.promise) return false;
    if (f.collector === "none" && r.collector) return false;
    if (f.collector === "me" && (!f.me || r.collector?.id !== f.me)) return false;
    if (f.collector !== "all" && f.collector !== "none" && f.collector !== "me" && r.collector?.id !== f.collector) return false;
    return true;
  });
}

export type PortfolioSort = "mora" | "vencido" | "saldo" | "nombre" | "proxima";

/** Orden por defecto: más días de mora primero (spec §14.3). */
export function sortPortfolio(rows: PortfolioRow[], by: PortfolioSort = "mora"): PortfolioRow[] {
  const out = [...rows];
  const name = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name, "es");
  out.sort((a, b) => {
    switch (by) {
      case "vencido":
        return b.overdue_cents - a.overdue_cents || name(a, b);
      case "saldo":
        return b.balance_cents - a.balance_cents || name(a, b);
      case "nombre":
        return name(a, b);
      case "proxima": {
        const x = a.next_action_at ?? "9999-12-31";
        const y = b.next_action_at ?? "9999-12-31";
        return x.localeCompare(y) || name(a, b);
      }
      default:
        return b.days_overdue - a.days_overdue || b.overdue_cents - a.overdue_cents || name(a, b);
    }
  });
  return out;
}

export interface PortfolioTotals {
  count: number;
  balance_cents: number;
  overdue_cents: number;
  with_promise: number;
  unassigned: number;
  overdue_count: number;
}

export function portfolioTotals(rows: PortfolioRow[]): PortfolioTotals {
  return rows.reduce<PortfolioTotals>(
    (t, r) => ({
      count: t.count + 1,
      balance_cents: t.balance_cents + (Number(r.balance_cents) || 0),
      overdue_cents: t.overdue_cents + (Number(r.overdue_cents) || 0),
      with_promise: t.with_promise + (r.promise ? 1 : 0),
      unassigned: t.unassigned + (r.collector ? 0 : 1),
      overdue_count: t.overdue_count + (r.overdue_cents > 0 ? 1 : 0),
    }),
    { count: 0, balance_cents: 0, overdue_cents: 0, with_promise: 0, unassigned: 0, overdue_count: 0 },
  );
}

/** Texto del próximo paso de la escalera ("Suspensión el 14/10"). */
export function nextStepLabel(c: PortfolioCollection | null): string | null {
  if (!c?.next_step_action) return null;
  const label = DUNNING_ACTION_LABELS[c.next_step_action] ?? c.next_step_title ?? "Próximo paso";
  return c.next_step_date ? `${label} el ${formatDay(c.next_step_date)}` : label;
}

// ── Texto de la historia ────────────────────────────────────────────────────

export type EventTone = "neutral" | "success" | "warning" | "danger" | "info" | "brand";
export type EventIcon =
  | "charge"
  | "void"
  | "payment"
  | "reversal"
  | "bonus"
  | "allocation"
  | "interest"
  | "waiver"
  | "promise"
  | "dunning"
  | "notice"
  | "transfer"
  | "plan"
  | "mode"
  | "note"
  | "collector"
  | "recon";

export interface DescribedEvent {
  title: string;
  detail: string | null;
  tone: EventTone;
  icon: EventIcon;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : v == null ? null : typeof v === "number" ? String(v) : null);
const cents = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const join = (...parts: (string | null | undefined | false)[]) => {
  const out = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" · ");
  return out === "" ? null : out;
};

const CYCLE_LABELS: Record<string, string> = { monthly: "mensual", yearly: "anual" };
const cycle = (v: unknown) => CYCLE_LABELS[String(v ?? "")] ?? null;

const PLAN_CHANGE_KIND_LABELS: Record<string, string> = {
  upgrade: "Subió de plan",
  downgrade: "Bajó de plan",
  lateral: "Cambió de plan",
  cycle_up: "Pasó a ciclo anual",
  cycle_down: "Pasó a ciclo mensual",
  addon_add: "Sumó un complemento",
};

const PAYMENT_TITLES: Record<string, string> = {
  mp_preapproval: "Pago con débito automático de Mercado Pago",
  mp_checkout: "Pago con Mercado Pago",
  transfer: "Pago por transferencia",
  cash: "Pago en efectivo",
  other: "Pago",
};

const NOTICE_KIND_LABELS: Record<string, string> = {
  notice: "Aviso de cobro",
  statement: "Resumen de cuenta",
  manual: "Aviso de cobro manual",
};

const RECON_KIND_LABELS: Record<string, string> = {
  missing_local: "pago de Mercado Pago que falta en la cuenta",
  missing_mp: "pago que no aparece en Mercado Pago",
  duplicate: "posible pago duplicado",
  amount_mismatch: "monto distinto al de Mercado Pago",
  chargeback: "contracargo en Mercado Pago",
  refund: "reintegro en Mercado Pago",
  status_mismatch: "estado distinto al de Mercado Pago",
};

const RECON_RESOLUTION_LABELS: Record<string, string> = {
  imputed: "pago imputado",
  duplicate_kept: "quedó a cuenta",
  refund_registered: "reintegro registrado",
  chargeback_registered: "contracargo registrado",
  accepted: "aceptada",
  ignored: "ignorada",
  auto: "se resolvió sola",
};

/** Título, detalle, tono e ícono de un hecho de la historia 360. Nunca devuelve "undefined". */
export function describeEvent(ev: Pick<Timeline360Event, "kind" | "data" | "amount_cents">): DescribedEvent {
  const d = ev.data ?? {};
  const k = ev.kind;
  switch (k) {
    case "charge": {
      const kind = str(d.charge_kind);
      const status = str(d.status);
      return {
        title: `${(kind && CHARGE_KIND_LABELS[kind]) ?? "Cargo"} generado`,
        detail: join(str(d.description), d.due_date ? `vence el ${formatDay(String(d.due_date))}` : null, status ? CHARGE_STATUS_LABELS[status] ?? null : null),
        tone: status === "paid" ? "success" : "neutral",
        icon: "charge",
      };
    }
    case "charge_void":
      return { title: "Cargo anulado", detail: join(str(d.description), str(d.reason)), tone: "warning", icon: "void" };
    case "payment": {
      const method = str(d.method);
      const status = str(d.status);
      const fee = cents(d.fee_cents);
      return {
        title: (method && PAYMENT_TITLES[method]) ?? "Pago registrado",
        detail: join(
          status && status !== "approved" ? PAYMENT_STATUS_LABELS[status] ?? null : null,
          str(d.external_id) ? `operación ${String(d.external_id)}` : null,
          fee != null && fee > 0 ? `comisión ${formatCents(fee)}` : null,
        ),
        tone: status === "approved" ? "success" : status === "charged_back" || status === "refunded" ? "danger" : "neutral",
        icon: "payment",
      };
    }
    case "payment_reversal":
      return { title: "Contracargo del pago", detail: str(d.reason), tone: "danger", icon: "reversal" };
    case "refund":
      return { title: "Reintegro del pago", detail: join(str(d.description), str(d.reason)), tone: "danger", icon: "reversal" };
    case "bonus_credit":
      return { title: "Bonificación", detail: join(str(d.description), str(d.reason)), tone: "success", icon: "bonus" };
    case "adjustment_credit":
      return { title: "Ajuste a favor", detail: join(str(d.description), str(d.reason)), tone: "success", icon: "bonus" };
    case "adjustment_debit":
      return { title: "Ajuste al debe", detail: join(str(d.description), str(d.reason)), tone: "warning", icon: "charge" };
    case "opening_balance":
      return { title: "Saldo inicial", detail: str(d.description), tone: "neutral", icon: "charge" };
    case "allocation":
      return {
        title: "Imputación",
        detail: join(str(d.credit) ? `${String(d.credit)} contra ${str(d.debit) ?? "la deuda"}` : str(d.debit)),
        tone: "neutral",
        icon: "allocation",
      };
    case "allocation_released":
      return { title: "Imputación liberada", detail: join(str(d.credit), str(d.reason)), tone: "warning", icon: "allocation" };
    case "interest": {
      const month = str(d.month);
      return {
        title: "Punitorios devengados",
        detail: month ? `Mes ${month.slice(5, 7)}/${month.slice(0, 4)}` : null,
        tone: "warning",
        icon: "interest",
      };
    }
    case "waiver": {
      const status = str(d.status);
      return {
        title: status === "pending_approval" ? "Condonación pendiente de aprobación" : status === "rejected" ? "Condonación rechazada" : "Condonación de punitorios",
        detail: join(str(d.reason), str(d.decision_reason)),
        tone: status === "rejected" ? "danger" : status === "pending_approval" ? "info" : "success",
        icon: "waiver",
      };
    }
    case "promise": {
      const date = str(d.promised_date);
      return {
        title: d.channel === "owner" ? "El negocio prometió pagar" : "Promesa de pago cargada por el staff",
        detail: join(date ? `para el ${formatDay(date)}` : null, str(d.note)),
        tone: "info",
        icon: "promise",
      };
    }
    case "promise_kept":
    case "promise_broken":
    case "promise_cancelled":
    case "promise_open": {
      const st = k.slice("promise_".length) as PromiseStatus;
      const amount = cents(d.amount_cents);
      return {
        title: `Promesa ${(PROMISE_STATUS_LABELS[st] ?? "resuelta").toLowerCase()}`,
        detail: join(amount != null ? `de ${formatCents(amount)}` : null, str(d.promised_date) ? `para el ${formatDay(String(d.promised_date))}` : null, str(d.reason)),
        tone: st === "kept" ? "success" : st === "broken" ? "danger" : "neutral",
        icon: "promise",
      };
    }
    case "dunning_step": {
      const action = str(d.action) as DunningAction | null;
      const days = cents(d.days_overdue);
      return {
        title: `Escalera de mora: ${(action && DUNNING_ACTION_LABELS[action]) ?? str(d.title) ?? "paso"}`,
        detail: join(days != null ? `${days} días de atraso` : null, d.notified === true ? "se avisó al negocio" : null, str(d.close_reason)),
        tone: action === "suspend" || action === "mark_uncollectible" ? "danger" : "warning",
        icon: "dunning",
      };
    }
    case "notice": {
      const kind = str(d.notice_kind);
      const rec = Array.isArray(d.recipients) ? (d.recipients as unknown[]).filter((x) => typeof x === "string") : [];
      return {
        title: `${(kind && NOTICE_KIND_LABELS[kind]) ?? "Aviso de cobro"} enviado`,
        detail: join(str(d.due_date) ? `vence el ${formatDay(String(d.due_date))}` : null, rec.length ? `a ${rec.join(", ")}` : null),
        tone: "info",
        icon: "notice",
      };
    }
    case "transfer_reported":
      return {
        title: "El negocio informó una transferencia",
        detail: join(str(d.paid_on) ? `del ${formatDay(String(d.paid_on))}` : null, str(d.reference) ? `ref. ${String(d.reference)}` : null),
        tone: "info",
        icon: "transfer",
      };
    case "transfer_approved":
      return { title: "Transferencia acreditada", detail: null, tone: "success", icon: "transfer" };
    case "transfer_rejected":
      return { title: "Transferencia rechazada", detail: str(d.reject_reason), tone: "danger", icon: "transfer" };
    case "plan_change_applied":
    case "plan_change_scheduled":
    case "plan_change_cancelled": {
      const ck = str(d.change_kind);
      const base = (ck && PLAN_CHANGE_KIND_LABELS[ck]) ?? "Cambio de plan";
      const target = join(
        str(d.from_plan) && str(d.to_plan) && d.from_plan !== d.to_plan ? `de ${String(d.from_plan)} a ${String(d.to_plan)}` : str(d.to_plan) ? `Plan ${String(d.to_plan)}` : null,
        d.from_cycle !== d.to_cycle && cycle(d.to_cycle) ? `ciclo ${cycle(d.to_cycle)}` : null,
        str(d.addon_key),
      );
      if (k === "plan_change_scheduled") {
        return {
          title: `${base} (programado)`,
          detail: join(target, str(d.effective_on) ? `rige el ${formatDay(String(d.effective_on))}` : null, str(d.reason)),
          tone: "info",
          icon: "plan",
        };
      }
      if (k === "plan_change_cancelled") {
        return { title: `${base} cancelado`, detail: join(target, str(d.cancel_reason)), tone: "neutral", icon: "plan" };
      }
      return { title: base, detail: join(target, d.source === "trigger" ? "desde el panel del negocio o el sistema" : null, str(d.reason)), tone: "brand", icon: "plan" };
    }
    case "plan_changed":
      return { title: "Cambio de plan", detail: join(str(d.plan) ? `Plan ${String(d.plan)}` : null, cycle(d.cycle) ? `ciclo ${cycle(d.cycle)}` : null, str(d.reason)), tone: "brand", icon: "plan" };
    case "plan_change_requested":
      return { title: "El negocio pidió cambiar de plan", detail: join(str(d.plan_key) ? `Plan ${String(d.plan_key)}` : null), tone: "brand", icon: "plan" };
    case "addon_activated":
      return { title: "Complemento activado", detail: str(d.addon), tone: "brand", icon: "plan" };
    case "addon_set":
      return { title: d.status === "active" ? "Complemento bonificado" : "Complemento quitado", detail: str(d.addon), tone: "brand", icon: "plan" };
    case "addon_cancelled":
      return { title: "Complemento dado de baja", detail: str(d.addon), tone: "neutral", icon: "plan" };
    case "mode_change": {
      const to = str(d.to_mode);
      const from = str(d.from_mode);
      return {
        title: `Modalidad: ${(to && BILLING_MODE_LABELS[to]) ?? "cambio"}`,
        detail: join(from ? `antes ${(BILLING_MODE_LABELS[from] ?? from).toLowerCase()}` : null, d.status && d.status !== "applied" ? "pendiente" : null, str(d.reason)),
        tone: "brand",
        icon: "mode",
      };
    }
    case "note": {
      const kind = str(d.note_kind) as NoteKind | null;
      const outcome = str(d.outcome) as NoteOutcome | null;
      const voided = Boolean(d.voided_at);
      return {
        title: `${(kind && NOTE_KIND_LABELS[kind]) ?? "Gestión"}${outcome ? `: ${NOTE_OUTCOME_LABELS[outcome] ?? ""}` : ""}${voided ? " (anulada)" : ""}`,
        detail: join(str(d.body), str(d.next_action_at) ? `próxima acción el ${formatDay(String(d.next_action_at))}` : null, voided ? str(d.void_reason) : null),
        tone: voided ? "neutral" : "info",
        icon: "note",
      };
    }
    case "collector_assigned": {
      const to = str(d.to);
      return {
        title: to ? `Cobrador asignado: ${to}` : "Se quitó el cobrador asignado",
        detail: join(str(d.from) ? `antes ${String(d.from)}` : null, str(d.reason)),
        tone: "neutral",
        icon: "collector",
      };
    }
    case "recon_diff": {
      const dk = str(d.diff_kind);
      const res = str(d.resolution);
      return {
        title: `Conciliación: ${(dk && RECON_KIND_LABELS[dk]) ?? "diferencia"}`,
        detail: join(res ? RECON_RESOLUTION_LABELS[res] ?? null : d.status === "open" ? "pendiente" : null, str(d.mp_payment_id) ? `MP ${String(d.mp_payment_id)}` : null, str(d.resolve_reason)),
        tone: d.status === "open" ? "warning" : "neutral",
        icon: "recon",
      };
    }
    default:
      return { title: "Movimiento de cobranza", detail: null, tone: "neutral", icon: "charge" };
  }
}

/** Filtra la historia por grupo ("all" = todo). */
export function filterTimeline(events: Timeline360Event[], group: "all" | TimelineGroup): Timeline360Event[] {
  return group === "all" ? events : events.filter((e) => e.group === group);
}

// ── Export XLSX ─────────────────────────────────────────────────────────────

export function portfolioXlsxSheet(rows: PortfolioRow[], asOf?: string): XlsxSheet {
  const t = portfolioTotals(rows);
  return {
    name: "Cobranza",
    title: "Lista de cobranza",
    subtitle: asOf ? `Al ${formatDay(asOf)}. Importes con IVA incluido.` : undefined,
    columns: [
      { header: "Negocio", key: "negocio", width: 28 },
      { header: "Modalidad", key: "modalidad", width: 24 },
      { header: "Plan", key: "plan", width: 16 },
      { header: "Saldo", key: "saldo", type: "money" },
      { header: "Vencido", key: "vencido", type: "money" },
      { header: "Días de mora", key: "dias", type: "number" },
      { header: "Antigüedad", key: "aging", width: 16 },
      { header: "Estado de la escalera", key: "escalera", width: 18 },
      { header: "Próximo paso", key: "proximo", width: 22 },
      { header: "Fecha del próximo paso", key: "proximo_fecha", type: "date" },
      { header: "Promesa (monto)", key: "promesa_monto", type: "money" },
      { header: "Promesa (fecha)", key: "promesa_fecha", type: "date" },
      { header: "Cobrador", key: "cobrador", width: 20 },
      { header: "Última gestión", key: "gestion", width: 36 },
      { header: "Próxima acción", key: "proxima_accion", type: "date" },
      { header: "Último pago", key: "ultimo_pago", type: "datetime" },
    ],
    rows: rows.map((r) => ({
      negocio: r.name,
      modalidad: BILLING_MODE_LABELS[r.billing_mode] ?? r.billing_mode,
      plan: r.plan_name ?? "",
      saldo: r.balance_cents / 100,
      vencido: r.overdue_cents / 100,
      dias: r.days_overdue,
      aging: AGING_LABELS[agingBucket(r)],
      escalera: LADDER_LABELS[ladderState(r)],
      proximo: r.collection?.next_step_action ? DUNNING_ACTION_LABELS[r.collection.next_step_action] ?? "" : "",
      proximo_fecha: xlsxDay(r.collection?.next_step_date),
      promesa_monto: r.promise ? r.promise.amount_cents / 100 : null,
      promesa_fecha: xlsxDay(r.promise?.promised_date),
      cobrador: r.collector?.name ?? "",
      gestion: r.last_note ? `${formatDay(r.last_note.at)} ${NOTE_KIND_LABELS[r.last_note.kind] ?? ""}: ${r.last_note.body}` : "",
      proxima_accion: xlsxDay(r.next_action_at),
      ultimo_pago: xlsxDate(r.last_payment_at),
    })),
    totals: { saldo: t.balance_cents / 100, vencido: t.overdue_cents / 100 },
  };
}

export function timelineXlsxSheet(events: Timeline360Event[], tenantName?: string): XlsxSheet {
  return {
    name: "Historia",
    title: "Historia de cobranza",
    subtitle: tenantName,
    columns: [
      { header: "Fecha", key: "fecha", type: "datetime" },
      { header: "Grupo", key: "grupo", width: 12 },
      { header: "Hecho", key: "hecho", width: 36 },
      { header: "Detalle", key: "detalle", width: 48 },
      { header: "Importe", key: "importe", type: "money" },
      { header: "Quién", key: "quien", width: 20 },
    ],
    rows: events.map((e) => {
      const x = describeEvent(e);
      return {
        fecha: xlsxDate(e.at),
        grupo: TIMELINE_GROUP_LABELS[e.group] ?? e.group,
        hecho: x.title,
        detalle: x.detail ?? "",
        importe: e.amount_cents == null ? null : e.amount_cents / 100,
        quien: e.actor ?? "Sistema",
      };
    }),
  };
}

export { COLLECTION_STATE_LABELS };
