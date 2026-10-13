// =============================================================================
// Conciliación (hub): lógica pura de /reportes/conciliacion. Junta lo de
// tarjetas por lote (ADR-044), procesadores (ADR-061) y disputas (ADR-064) en
// una sola lectura para el dueño:
//
//  * Resumen del período: vendiste, te cobraron, te acreditaron, falta
//    acreditar (próxima fecha) y en riesgo.
//  * Una tarjeta por procesador con su barra de estados.
//  * Series de los gráficos y el calendario de acreditaciones.
//  * La bandeja de pendientes (lo que hay que revisar) con sus acciones.
//  * Las hojas del Excel.
//
// Sin red ni React.
// =============================================================================
import {
  MATCH_LABEL,
  MONEY_LABEL,
  SETTLEMENT_PROVIDERS,
  XLSX_LINE_COLUMNS,
  lineDispute,
  localDay,
  moneyState,
  providerLabel,
  summarize,
  xlsxLineRows,
  type LineMatchStatus,
  type MatchTone,
  type OwnerSummary,
  type SettlementLineRow,
  type UnmatchedPayment,
} from "./processorReconciliation";
import {
  DISPUTE_KIND_LABEL,
  DISPUTE_STATUS_LABEL,
  LINE_DISPUTE_LABEL,
  deadlineInfo,
  disputeReasonLabel,
  effectiveNet,
  type DisputeIndex,
  type PaymentDisputeRow,
} from "./paymentDisputes";
import {
  XLSX_COLUMNS as CARD_XLSX_COLUMNS,
  batchLabel,
  dayLabel,
  merchantLabel,
  xlsxDetailRows,
  type CardRecSummary,
  type DayGroup,
} from "./cardReconciliation";
import {
  XLSX_ROW_STYLE,
  xlsxDate,
  xlsxDay,
  xlsxFileSlug,
  type XlsxColumn,
  type XlsxSheet,
  type XlsxStatusStyle,
} from "@/lib/utils/xlsx";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pago del POS sin cobro en el procesador, con su procesador. */
export type HubUnmatched = UnmatchedPayment & { provider: string };

// ── Filtro por sucursal ──────────────────────────────────────────────────────

/**
 * Líneas de una sucursal: las de la credencial de esa sucursal o las cruzadas
 * con una venta de esa sucursal. Sin sucursal elegida, todas.
 */
export function filterLinesByStore(
  lines: SettlementLineRow[],
  storeId: string | null,
  saleStore: (saleId: string | null) => string | null,
): SettlementLineRow[] {
  if (!storeId) return lines;
  return lines.filter((l) => l.scope_store_id === storeId || (l.sale_id != null && saleStore(l.sale_id) === storeId));
}

// ── Estados (barra por procesador) ───────────────────────────────────────────

export type SegmentKey = LineMatchStatus | "pos_only";

export interface StatusSegment {
  key: SegmentKey;
  label: string;
  tone: MatchTone;
  count: number;
  amount: number;
}

const SEGMENT_ORDER: SegmentKey[] = ["matched", "ignored", "amount_diff", "missing_in_pos", "pos_only"];

/** Segmentos de la barra de estado, sin los vacíos. */
export function statusSegments(s: Pick<OwnerSummary, "counts" | "amounts">): StatusSegment[] {
  return SEGMENT_ORDER.map((key) => ({
    key,
    label: MATCH_LABEL[key].label,
    tone: MATCH_LABEL[key].tone,
    count: s.counts[key],
    amount: s.amounts[key],
  })).filter((x) => x.count > 0);
}

export const toReviewCount = (s: Pick<OwnerSummary, "counts">) =>
  s.counts.missing_in_pos + s.counts.amount_diff + s.counts.pos_only;

/** Porcentaje conciliado (o revisado) sobre el total de cobros, 0 a 100. */
export function reconciledPct(s: Pick<OwnerSummary, "counts">): number {
  const total = SEGMENT_ORDER.reduce((a, k) => a + s.counts[k], 0);
  if (total === 0) return 0;
  return Math.round(((s.counts.matched + s.counts.ignored) / total) * 100);
}

// ── Por procesador ───────────────────────────────────────────────────────────

export interface ProviderCard {
  key: string;
  label: string;
  api: boolean;
  logo: string | null;
  summary: OwnerSummary;
  segments: StatusSegment[];
  toReview: number;
  pct: number;
  hasData: boolean;
}

export function providerCards(
  lines: SettlementLineRow[],
  unmatched: HubUnmatched[],
  index: DisputeIndex,
  now: Date = new Date(),
): ProviderCard[] {
  const byProvider = new Map<string, SettlementLineRow[]>();
  for (const l of lines) {
    const list = byProvider.get(l.provider_key) ?? [];
    list.push(l);
    byProvider.set(l.provider_key, list);
  }
  const unByProvider = new Map<string, HubUnmatched[]>();
  for (const u of unmatched) {
    const list = unByProvider.get(u.provider) ?? [];
    list.push(u);
    unByProvider.set(u.provider, list);
  }
  const known = new Set(SETTLEMENT_PROVIDERS.map((p) => p.key));
  const extra = [...new Set([...byProvider.keys(), ...unByProvider.keys()])].filter((k) => !known.has(k));
  const defs = [
    ...SETTLEMENT_PROVIDERS,
    ...extra.map((key) => ({ key, label: key, api: false, logo: null as string | null })),
  ];
  return defs.map((p) => {
    const ls = byProvider.get(p.key) ?? [];
    const un = unByProvider.get(p.key) ?? [];
    const summary = summarize(ls, un, now, index);
    return {
      key: p.key,
      label: p.label,
      api: p.api,
      logo: p.logo,
      summary,
      segments: statusSegments(summary),
      toReview: toReviewCount(summary),
      pct: reconciledPct(summary),
      hasData: ls.length + un.length > 0,
    };
  });
}

// ── Resumen del período ──────────────────────────────────────────────────────

export interface HubKpis {
  sold: number;
  count: number;
  charged: number;
  costPct: number;
  released: number;
  pending: number;
  nextRelease: string | null;
  atRisk: number;
  riskCount: number;
  toReview: number;
  providers: number;
}

export function hubKpis(cards: ProviderCard[], openDisputes: PaymentDisputeRow[] = []): HubKpis {
  const withData = cards.filter((c) => c.hasData);
  let sold = 0;
  let count = 0;
  let charged = 0;
  let released = 0;
  let pending = 0;
  let atRisk = 0;
  let riskCount = 0;
  let toReview = 0;
  let nextRelease: string | null = null;
  for (const c of withData) {
    const s = c.summary;
    sold += s.sold;
    count += s.count;
    charged += s.charged;
    released += s.released;
    pending += s.pending;
    atRisk += s.disputes.atRisk;
    riskCount += s.disputes.counts.chargeback + s.disputes.counts.claim;
    toReview += c.toReview;
    if (s.nextRelease && (!nextRelease || s.nextRelease < nextRelease)) nextRelease = s.nextRelease;
  }
  // Contracargos y reclamos abiertos de otros períodos también son plata en riesgo.
  const open = openDisputes.filter((d) => d.kind !== "refund" && !d.resolved_at);
  if (riskCount === 0 && open.length > 0) {
    riskCount = open.length;
    atRisk = open.reduce((a, d) => a + Number(d.amount || 0), 0);
  }
  return {
    sold: round2(sold),
    count,
    charged: round2(charged),
    costPct: sold > 0 ? round2((charged / sold) * 100) : 0,
    released: round2(released),
    pending: round2(pending),
    nextRelease,
    atRisk: round2(atRisk),
    riskCount,
    toReview,
    providers: withData.length,
  };
}

// ── Gráficos ─────────────────────────────────────────────────────────────────

export interface MoneySeries {
  days: string[];
  labels: string[];
  released: number[];
  pending: number[];
  charged: number[];
  sold: number[];
}

/**
 * Por día de la operación: lo que ya te acreditaron, lo que falta y lo que se
 * llevaron comisiones e impuestos (apilado suma lo vendido, aprox.).
 */
export function moneyByDay(lines: SettlementLineRow[], index: DisputeIndex, now: Date = new Date()): MoneySeries {
  const map = new Map<string, { released: number; pending: number; charged: number; sold: number }>();
  for (const l of lines) {
    const day = localDay(l.operation_at);
    const cur = map.get(day) ?? { released: 0, pending: 0, charged: 0, sold: 0 };
    const net = effectiveNet(l, lineDispute(l, index));
    if (moneyState(l, now) === "released") cur.released += net;
    else cur.pending += net;
    cur.charged += Number(l.fee) + Number(l.taxes);
    cur.sold += Number(l.gross) - Number(l.refunded);
    map.set(day, cur);
  }
  const days = [...map.keys()].sort();
  const pick = (k: "released" | "pending" | "charged" | "sold") => days.map((d) => round2(map.get(d)![k]));
  return {
    days,
    labels: days.map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`),
    released: pick("released"),
    pending: pick("pending"),
    charged: pick("charged"),
    sold: pick("sold"),
  };
}

/** Vendido por procesador (dona). */
export function soldByProvider(cards: ProviderCard[]): { key: string; label: string; value: number }[] {
  return cards
    .filter((c) => c.summary.sold > 0)
    .map((c) => ({ key: c.key, label: c.label, value: c.summary.sold }))
    .sort((a, b) => b.value - a.value);
}

export interface CalendarDay {
  day: string;
  amount: number;
  count: number;
  providers: { key: string; amount: number }[];
  isToday: boolean;
  weekend: boolean;
}

/** Día local yyyy-MM-dd de una fecha. */
function dayOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Calendario de acreditaciones: los próximos `days` días desde hoy con lo que
 * se acredita cada día (neto efectivo de lo pendiente), y lo que cae después.
 */
export function releaseCalendar(
  lines: SettlementLineRow[],
  index: DisputeIndex,
  now: Date = new Date(),
  days = 14,
): { days: CalendarDay[]; later: number; laterCount: number; undated: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out: CalendarDay[] = [];
  const byDay = new Map<string, CalendarDay>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const c: CalendarDay = {
      day: dayOf(d),
      amount: 0,
      count: 0,
      providers: [],
      isToday: i === 0,
      weekend: d.getDay() === 0 || d.getDay() === 6,
    };
    out.push(c);
    byDay.set(c.day, c);
  }
  const last = out[out.length - 1]?.day ?? dayOf(start);
  let later = 0;
  let laterCount = 0;
  let undated = 0;
  for (const l of lines) {
    if (moneyState(l, now) === "released") continue;
    const net = effectiveNet(l, lineDispute(l, index));
    if (net === 0) continue;
    if (!l.release_date) {
      undated += net;
      continue;
    }
    const day = localDay(l.release_date);
    const c = byDay.get(day);
    if (c) {
      c.amount += net;
      c.count += 1;
      const p = c.providers.find((x) => x.key === l.provider_key);
      if (p) p.amount += net;
      else c.providers.push({ key: l.provider_key, amount: net });
    } else if (day > last) {
      later += net;
      laterCount += 1;
    }
  }
  for (const c of out) {
    c.amount = round2(c.amount);
    c.providers = c.providers.map((p) => ({ ...p, amount: round2(p.amount) })).sort((a, b) => b.amount - a.amount);
  }
  return { days: out, later: round2(later), laterCount, undated: round2(undated) };
}

// ── Bandeja de pendientes ────────────────────────────────────────────────────

export type InboxKind = "missing_in_pos" | "amount_diff" | "pos_only" | "dispute" | "card_batch";

export const INBOX_KIND: Record<InboxKind, { label: string; help: string; todo: string; tone: MatchTone }> = {
  dispute: {
    label: "Contracargos y reclamos",
    help: "Plata en riesgo o avisos de Mercado Pago que todavía no viste.",
    todo: "Revisá el plazo y presentá la documentación en Mercado Pago.",
    tone: "danger",
  },
  missing_in_pos: {
    label: "Cobros sin venta",
    help: MATCH_LABEL.missing_in_pos.help,
    todo: "Vinculalo a una venta, creá la venta o marcalo revisado.",
    tone: "danger",
  },
  pos_only: {
    label: "Ventas sin cobro",
    help: MATCH_LABEL.pos_only.help,
    todo: "Revisá la venta: medio de pago equivocado, cobro rechazado o período sin actualizar.",
    tone: "danger",
  },
  amount_diff: {
    label: "Diferencias de monto",
    help: MATCH_LABEL.amount_diff.help,
    todo: "Compará la venta con el procesador y marcalo revisado.",
    tone: "warning",
  },
  card_batch: {
    label: "Lotes de tarjeta sin conciliar",
    help: "Lotes de días anteriores que todavía no marcaste como acreditados.",
    todo: "Controlalos contra la liquidación y conciliá.",
    tone: "warning",
  },
};

export const INBOX_ORDER: InboxKind[] = ["dispute", "missing_in_pos", "pos_only", "amount_diff", "card_batch"];

export interface InboxItem {
  /** Id de selección (único en la bandeja). */
  id: string;
  kind: InboxKind;
  provider: string | null;
  date: string;
  amount: number;
  title: string;
  detail: string;
  ref: string | null;
  saleId: string | null;
  line?: SettlementLineRow;
  dispute?: PaymentDisputeRow;
  /** Cobros pendientes del lote (card_batch). */
  paymentIds?: string[];
  /** Se puede conciliar en lote (set_payments_reconciled). */
  canReconcile: boolean;
  /** Se puede marcar revisado / visto en lote. */
  canReview: boolean;
  /** Plazo urgente (contracargo con 2 días o menos). */
  urgent?: boolean;
}

const lineRef = (l: SettlementLineRow) =>
  l.external_id ?? ([l.lote && `Lote ${l.lote}`, l.cupon && `Cupón ${l.cupon}`].filter(Boolean).join(" · ") || null);

const lineMedium = (l: SettlementLineRow) =>
  [l.card_brand, l.last4 ? `**** ${l.last4}` : null, l.installments && l.installments > 1 ? `${l.installments} cuotas` : null]
    .filter(Boolean)
    .join(" · ");

export function buildInbox(input: {
  lines: SettlementLineRow[];
  unmatched: HubUnmatched[];
  disputes: PaymentDisputeRow[];
  cardGroups: DayGroup[];
  canReconcileCards: boolean;
  canResolveLines: boolean;
  now?: Date;
}): InboxItem[] {
  const now = input.now ?? new Date();
  const today = dayOf(now);
  const out: InboxItem[] = [];

  for (const d of input.disputes) {
    const open = d.kind !== "refund" && !d.resolved_at;
    if (!open && d.acknowledged_at) continue;
    const st = DISPUTE_STATUS_LABEL[d.status];
    const dl = deadlineInfo(d, now);
    const reason = disputeReasonLabel(d.reason);
    out.push({
      id: `d:${d.id}`,
      kind: "dispute",
      provider: d.provider_key,
      date: d.occurred_at,
      amount: Number(d.amount) || 0,
      title: `${DISPUTE_KIND_LABEL[d.kind]} · ${st.label}`,
      detail: [
        reason,
        dl ? (dl.overdue ? "Plazo vencido" : `Plazo: ${dl.daysLeft} ${dl.daysLeft === 1 ? "día" : "días"}`) : null,
        d.acknowledged_at ? null : "Sin ver",
      ]
        .filter(Boolean)
        .join(" · "),
      ref: d.provider_case_id ?? d.provider_payment_id,
      saleId: d.sale_id,
      dispute: d,
      canReconcile: false,
      canReview: !d.acknowledged_at && input.canResolveLines,
      urgent: Boolean(dl && (dl.urgent || dl.overdue)),
    });
  }

  for (const l of input.lines) {
    if (l.match_status !== "missing_in_pos" && l.match_status !== "amount_diff") continue;
    out.push({
      id: `l:${l.id}`,
      kind: l.match_status,
      provider: l.provider_key,
      date: l.operation_at,
      amount: round2(Number(l.gross) - Number(l.refunded)),
      title: `${providerLabel(l.provider_key)}${lineMedium(l) ? ` · ${lineMedium(l)}` : ""}`,
      detail:
        l.match_status === "amount_diff"
          ? `Diferencia con la venta: ${Number(l.diff_amount).toLocaleString("es-AR", { style: "currency", currency: "ARS" })}`
          : MATCH_LABEL.missing_in_pos.help,
      ref: lineRef(l),
      saleId: l.sale_id,
      line: l,
      canReconcile: false,
      canReview: input.canResolveLines,
    });
  }

  for (const u of input.unmatched) {
    out.push({
      id: `p:${u.payment_id}`,
      kind: "pos_only",
      provider: u.provider,
      date: u.created_at,
      amount: Number(u.amount),
      title: `${providerLabel(u.provider)}${u.sale_voided ? " · venta anulada" : ""}`,
      detail: MATCH_LABEL.pos_only.help,
      ref: u.provider_payment_id ?? u.intent_id ?? ([u.lote, u.cupon].filter(Boolean).join(" / ") || null),
      saleId: u.sale_id,
      canReconcile: false,
      canReview: false,
    });
  }

  for (const d of input.cardGroups) {
    if (d.day >= today) continue;
    for (const m of d.merchants) {
      for (const b of m.batches) {
        const pending = b.rows.filter((r) => !r.reconciledAt);
        if (pending.length === 0) continue;
        out.push({
          id: `b:${b.key}`,
          kind: "card_batch",
          provider: null,
          date: `${d.day}T12:00:00`,
          amount: round2(pending.reduce((a, r) => a + r.amount, 0)),
          title: `${batchLabel(b.lote)} · ${merchantLabel(m.comercio)}`,
          detail: `${pending.length} de ${b.count} ${b.count === 1 ? "cobro pendiente" : "cobros pendientes"} · ${dayLabel(d.day)}`,
          ref: null,
          saleId: null,
          paymentIds: pending.map((r) => r.id),
          canReconcile: input.canReconcileCards,
          canReview: false,
        });
      }
    }
  }

  const rank = new Map(INBOX_ORDER.map((k, i) => [k, i]));
  return out.sort(
    (a, b) =>
      rank.get(a.kind)! - rank.get(b.kind)! ||
      Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) ||
      b.date.localeCompare(a.date),
  );
}

export function inboxGroups(items: InboxItem[]): { kind: InboxKind; items: InboxItem[]; amount: number }[] {
  return INBOX_ORDER.map((kind) => {
    const list = items.filter((i) => i.kind === kind);
    return { kind, items: list, amount: round2(list.reduce((a, i) => a + i.amount, 0)) };
  }).filter((g) => g.items.length > 0);
}

/** Qué hace cada acción en lote con lo seleccionado. */
export function bulkPlan(items: InboxItem[], selected: ReadonlySet<string>) {
  const chosen = items.filter((i) => selected.has(i.id));
  const reconcile = chosen.filter((i) => i.canReconcile);
  const reviewLines = chosen.filter((i) => i.canReview && i.line);
  const ackDisputes = chosen.filter((i) => i.canReview && i.dispute);
  return {
    chosen,
    reconcile,
    paymentIds: reconcile.flatMap((i) => i.paymentIds ?? []),
    reconcileAmount: round2(reconcile.reduce((a, i) => a + i.amount, 0)),
    reviewLines,
    ackDisputes,
    reviewAmount: round2([...reviewLines, ...ackDisputes].reduce((a, i) => a + i.amount, 0)),
  };
}

// ── Excel ────────────────────────────────────────────────────────────────────

const GOOD: XlsxStatusStyle = { fill: "E7F4EA", font: "1E6B3A" };
const WARN: XlsxStatusStyle = { fill: "FFF3DC", font: "7A5200" };
const BAD: XlsxStatusStyle = { fill: "FBE9E9", font: "9B1C1C" };
const NEUTRAL: XlsxStatusStyle = { fill: "EFEFF3", font: "4A4A55" };

/** Relleno sutil de la columna Estado en todas las hojas. */
export const XLSX_STATUS_STYLES: Record<string, XlsxStatusStyle> = {
  [MATCH_LABEL.matched.label]: GOOD,
  [MATCH_LABEL.ignored.label]: NEUTRAL,
  [MATCH_LABEL.amount_diff.label]: WARN,
  [MATCH_LABEL.missing_in_pos.label]: BAD,
  [MATCH_LABEL.pos_only.label]: BAD,
  [MONEY_LABEL.released]: GOOD,
  [MONEY_LABEL.pending]: WARN,
  [MONEY_LABEL.unknown]: NEUTRAL,
  Conciliado: GOOD,
  Pendiente: WARN,
  Parcial: WARN,
  [LINE_DISPUTE_LABEL.refunded.label]: WARN,
  [LINE_DISPUTE_LABEL.partially_refunded.label]: WARN,
  [LINE_DISPUTE_LABEL.chargeback.label]: BAD,
  [LINE_DISPUTE_LABEL.claim.label]: WARN,
  [DISPUTE_STATUS_LABEL.open.label]: BAD,
  [DISPUTE_STATUS_LABEL.in_review.label]: WARN,
  [DISPUTE_STATUS_LABEL.won.label]: GOOD,
  [DISPUTE_STATUS_LABEL.lost.label]: BAD,
  [DISPUTE_STATUS_LABEL.refunded.label]: WARN,
  [DISPUTE_STATUS_LABEL.closed.label]: NEUTRAL,
};

const withStatus = (cols: XlsxColumn[], keys: string[]): XlsxColumn[] =>
  cols.map((c) => (keys.includes(c.key) ? { ...c, status: XLSX_STATUS_STYLES } : c));

/** conciliacion_mi-negocio_2026-10-01_al_2026-10-12[_sucursal].xlsx */
export function conciliacionFileName(input: { negocio?: string | null; from: string; to: string; branch?: string | null }): string {
  const parts = ["conciliacion"];
  const n = xlsxFileSlug(input.negocio);
  if (n) parts.push(n);
  parts.push(input.from === input.to ? input.from : `${input.from}_al_${input.to}`);
  const b = xlsxFileSlug(input.branch);
  if (b) parts.push(b);
  return `${parts.join("_")}.xlsx`;
}

export interface ConciliacionExportInput {
  negocio: string | null;
  periodLabel: string;
  scopeLabel: string | null;
  /** Procesadores (null = sin acceso: no van esas hojas). */
  processors: {
    cards: ProviderCard[];
    kpis: HubKpis;
    lines: SettlementLineRow[];
    index: DisputeIndex;
    calendar: ReturnType<typeof releaseCalendar>;
    ticket: (saleId: string | null) => string;
  } | null;
  cards: { groups: DayGroup[]; summary: CardRecSummary } | null;
  inbox: InboxItem[];
  disputes: PaymentDisputeRow[];
  ticket: (saleId: string | null) => string;
  now?: Date;
}

const money = (k: string, header: string, width = 15): XlsxColumn => ({ header, key: k, type: "money", width });

export function buildConciliacionSheets(input: ConciliacionExportInput): XlsxSheet[] {
  const now = input.now ?? new Date();
  const subtitle = [input.negocio, input.periodLabel, input.scopeLabel].filter(Boolean).join(" · ");
  const sheets: XlsxSheet[] = [];
  const p = input.processors;
  const cs = input.cards;

  // Resumen: KPIs y tablas chicas.
  const sections: XlsxSheet["sections"] = [];
  if (p) {
    const k = p.kpis;
    sections.push({
      title: "Resumen del período",
      columns: [
        { header: "Concepto", key: "k", width: 40 },
        money("v", "Monto", 18),
        { header: "Detalle", key: "d", width: 34 },
      ],
      rows: [
        { k: "Vendiste", v: k.sold, d: `${k.count} ${k.count === 1 ? "cobro" : "cobros"} en ${k.providers} ${k.providers === 1 ? "procesador" : "procesadores"}` },
        { k: "Te cobraron comisiones e impuestos", v: k.charged, d: `${k.costPct.toLocaleString("es-AR")} % de lo vendido` },
        { k: "Te acreditaron", v: k.released, d: "" },
        {
          k: "Falta acreditar",
          v: k.pending,
          d: k.nextRelease ? `Lo próximo: ${dayLabel(localDay(k.nextRelease))}` : "",
        },
        { k: "En riesgo (contracargos y reclamos)", v: k.atRisk, d: k.riskCount ? `${k.riskCount} ${k.riskCount === 1 ? "caso" : "casos"}` : "" },
        { k: "Para revisar", v: null, d: `${k.toReview} ${k.toReview === 1 ? "cobro" : "cobros"}` },
      ],
    });
    const withData = p.cards.filter((c) => c.hasData);
    if (withData.length) {
      sections.push({
        title: "Por procesador",
        columns: [
          { header: "Procesador", key: "p", width: 40 },
          money("v", "Vendido", 18),
          money("n", "Neto", 34),
          { header: "Conciliado", key: "pct", type: "percent", width: 12 },
        ],
        rows: withData.map((c) => ({ p: c.label, v: c.summary.sold, n: c.summary.net, pct: c.pct / 100 })),
        totals: { v: p.kpis.sold, n: round2(withData.reduce((a, c) => a + c.summary.net, 0)) },
      });
    }
    const upcoming = p.calendar.days.filter((d) => d.amount !== 0);
    if (upcoming.length || p.calendar.later) {
      sections.push({
        title: "Próximas acreditaciones",
        columns: [
          { header: "Fecha", key: "f", type: "date", width: 40 },
          money("v", "Monto", 18),
          { header: "Procesadores", key: "pr", width: 34 },
        ],
        rows: [
          ...upcoming.map((d) => ({ f: xlsxDay(d.day), v: d.amount, pr: d.providers.map((x) => providerLabel(x.key)).join(", ") })),
          ...(p.calendar.later ? [{ f: "Más adelante", v: p.calendar.later, pr: "" }] : []),
        ],
      });
    }
  }
  if (cs) {
    sections.push({
      title: "Tarjetas por lote",
      columns: [
        { header: "Estado", key: "k", width: 40 },
        money("v", "Monto", 18),
        { header: "Cobros", key: "n", type: "number", width: 34 },
      ],
      rows: [
        { k: "Conciliado", v: cs.summary.reconciled.amount, n: cs.summary.reconciled.count },
        { k: "Pendiente", v: cs.summary.pending.amount, n: cs.summary.pending.count },
      ],
      totals: { v: cs.summary.total.amount, n: cs.summary.total.count },
    });
  }
  if (input.inbox.length) {
    sections.push({
      title: "Pendientes de revisar",
      columns: [
        { header: "Qué", key: "k", width: 40 },
        money("v", "Monto", 18),
        { header: "Cantidad", key: "n", type: "number", width: 34 },
      ],
      rows: inboxGroups(input.inbox).map((g) => ({ k: INBOX_KIND[g.kind].label, v: g.amount, n: g.items.length })),
    });
  }
  sheets.push({
    name: "Resumen",
    title: "Conciliación • NinjaPos",
    subtitle,
    columns: [],
    rows: [],
    sections: sections.length
      ? sections.map((s) => ({ ...s, columns: withStatus(s.columns, ["k"]) }))
      : [{ columns: [{ header: "Sin datos", key: "x", width: 40 }], rows: [{ x: "No hay cobros en el período." }] }],
  });

  if (p) {
    const withData = p.cards.filter((c) => c.hasData);
    sheets.push({
      name: "Por procesador",
      title: "Por procesador",
      subtitle,
      columns: [
        { header: "Procesador", key: "procesador", width: 20 },
        { header: "Origen", key: "origen", width: 12 },
        { header: "Cobros", key: "cobros", type: "number", width: 9 },
        money("vendido", "Vendido"),
        money("comisiones", "Comisiones", 14),
        money("impuestos", "Impuestos", 14),
        { header: "Costo", key: "costo", type: "percent", width: 9 },
        money("neto", "Neto"),
        money("acreditado", "Acreditado"),
        money("pendiente", "Falta acreditar"),
        { header: "Próxima acreditación", key: "proxima", type: "date", width: 14 },
        { header: "Conciliado", key: "pct", type: "percent", width: 11 },
        { header: "Para revisar", key: "revisar", type: "number", width: 12 },
        money("riesgo", "En riesgo", 13),
      ],
      rows: withData.map((c) => ({
        procesador: c.label,
        origen: c.api ? "Automático" : "Archivo",
        cobros: c.summary.count,
        vendido: c.summary.sold,
        comisiones: c.summary.fees,
        impuestos: c.summary.taxes,
        costo: c.summary.costPct / 100,
        neto: c.summary.net,
        acreditado: c.summary.released,
        pendiente: c.summary.pending,
        proxima: c.summary.nextRelease ? xlsxDay(localDay(c.summary.nextRelease)) : null,
        pct: c.pct / 100,
        revisar: c.toReview,
        riesgo: c.summary.disputes.atRisk,
      })),
      totals: {
        cobros: p.kpis.count,
        vendido: p.kpis.sold,
        comisiones: round2(withData.reduce((a, c) => a + c.summary.fees, 0)),
        impuestos: round2(withData.reduce((a, c) => a + c.summary.taxes, 0)),
        neto: round2(withData.reduce((a, c) => a + c.summary.net, 0)),
        acreditado: p.kpis.released,
        pendiente: p.kpis.pending,
        revisar: p.kpis.toReview,
        riesgo: p.kpis.atRisk,
      },
    });

    const lineRows = xlsxLineRows(p.lines, p.ticket, now, p.index).map((r, i) => ({
      ...r,
      procesador: providerLabel(p.lines[i]!.provider_key),
      fecha: xlsxDate(p.lines[i]!.operation_at),
      acreditacion: p.lines[i]!.release_date ? xlsxDay(localDay(p.lines[i]!.release_date!)) : null,
    }));
    sheets.push({
      name: "Detalle de cobros",
      title: "Detalle de cobros de los procesadores",
      subtitle,
      columns: withStatus(
        [
          { header: "Procesador", key: "procesador", width: 16 },
          ...XLSX_LINE_COLUMNS.map((c) =>
            c.key === "fecha"
              ? { ...c, type: "datetime" as const, width: 17 }
              : c.key === "acreditacion"
                ? { ...c, type: "date" as const }
                : c,
          ),
        ],
        ["estado", "plata", "disputa"],
      ),
      rows: lineRows,
      totals: {
        bruto: round2(p.lines.reduce((a, l) => a + Number(l.gross), 0)),
        devuelto: round2(p.lines.reduce((a, l) => a + Number(l.refunded), 0)),
        comisiones: round2(p.lines.reduce((a, l) => a + Number(l.fee), 0)),
        impuestos: round2(p.lines.reduce((a, l) => a + Number(l.taxes), 0)),
        neto: round2(p.lines.reduce((a, l) => a + Number(l.net), 0)),
      },
    });
  }

  if (cs && cs.groups.length) {
    sheets.push({
      name: "Por lote",
      title: "Tarjetas por día, comercio y lote",
      subtitle,
      columns: withStatus(
        [
          { header: "Fecha", key: "fecha", type: "date", width: 12 },
          { header: "Comercio", key: "comercio", width: 18 },
          { header: "Lote", key: "lote", width: 12 },
          { header: "Cobros", key: "cantidad", type: "number", width: 9 },
          money("monto", "Monto"),
          money("conciliado", "Conciliado"),
          money("pendiente", "Pendiente"),
          { header: "Estado", key: "estado", width: 13 },
        ],
        ["estado"],
      ),
      rows: cardBatchRows(cs.groups),
      totals: {
        cantidad: cs.summary.total.count,
        monto: cs.summary.total.amount,
        conciliado: cs.summary.reconciled.amount,
        pendiente: cs.summary.pending.amount,
      },
    });
    sheets.push({
      name: "Cupones",
      title: "Cupones de tarjeta",
      subtitle,
      columns: withStatus(CARD_XLSX_COLUMNS, ["estado"]),
      rows: cardDetailRows(cs.groups),
      totals: { cantidad: cs.summary.total.count, monto: cs.summary.total.amount },
    });
  }

  if (input.inbox.length) {
    sheets.push({
      name: "Pendientes",
      title: "Pendientes de revisar",
      subtitle,
      columns: withStatus(
        [
          { header: "Tipo", key: "tipo", width: 26 },
          { header: "Procesador", key: "procesador", width: 16 },
          { header: "Fecha", key: "fecha", type: "datetime", width: 17 },
          { header: "Detalle", key: "titulo", width: 36 },
          money("monto", "Monto"),
          { header: "Referencia", key: "ref", width: 22 },
          { header: "Venta", key: "venta", width: 12 },
          { header: "Estado", key: "estado", width: 20 },
          { header: "Qué hacer", key: "todo", width: 52 },
        ],
        ["estado"],
      ),
      rows: inboxXlsxRows(input.inbox, input.ticket),
      totals: { monto: round2(input.inbox.reduce((a, i) => a + i.amount, 0)) },
    });
  }

  if (input.disputes.length) {
    sheets.push({
      name: "Disputas",
      title: "Contracargos, reclamos y devoluciones",
      subtitle,
      columns: withStatus(
        [
          { header: "Tipo", key: "tipo", width: 14 },
          { header: "Estado", key: "estado", width: 26 },
          money("monto", "Monto"),
          { header: "Fecha", key: "fecha", type: "datetime", width: 17 },
          { header: "Motivo", key: "motivo", width: 28 },
          { header: "Plazo documentación", key: "plazo", type: "date", width: 14 },
          { header: "Días", key: "dias", type: "number", width: 7 },
          { header: "N° de caso", key: "caso", width: 16 },
          { header: "Id del pago", key: "pago", width: 16 },
          { header: "Venta", key: "venta", width: 12 },
          { header: "Visto", key: "visto", width: 8 },
        ],
        ["estado"],
      ),
      rows: input.disputes.map((d) => {
        const dl = deadlineInfo(d, now);
        return {
          tipo: DISPUTE_KIND_LABEL[d.kind],
          estado: DISPUTE_STATUS_LABEL[d.status].label,
          monto: Number(d.amount) || 0,
          fecha: xlsxDate(d.occurred_at),
          motivo: disputeReasonLabel(d.reason) ?? "",
          plazo: d.documentation_deadline ? xlsxDate(d.documentation_deadline) : null,
          dias: dl ? dl.daysLeft : null,
          caso: d.provider_case_id ?? "",
          pago: d.provider_payment_id,
          venta: input.ticket(d.sale_id),
          visto: d.acknowledged_at ? "Sí" : "No",
        };
      }),
      totals: { monto: round2(input.disputes.reduce((a, d) => a + (Number(d.amount) || 0), 0)) },
    });
  }

  return sheets;
}

/** Hoja "Por lote" con estado por lote (Conciliado, Parcial, Pendiente). */
export function cardBatchRows(groups: DayGroup[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const d of groups) {
    for (const m of d.merchants) {
      for (const b of m.batches) {
        const rec = round2(b.rows.filter((r) => r.reconciledAt).reduce((a, r) => a + r.amount, 0));
        out.push({
          fecha: xlsxDay(d.day),
          comercio: m.comercio || "Sin n° de comercio",
          lote: b.lote || "Sin lote",
          cantidad: b.count,
          monto: b.amount,
          conciliado: rec,
          pendiente: round2(b.amount - rec),
          estado: b.reconciledCount === b.count ? "Conciliado" : b.reconciledCount === 0 ? "Pendiente" : "Parcial",
        });
      }
    }
  }
  return out;
}

/** Hoja "Cupones": el detalle de siempre con los subtotales en negrita. */
export function cardDetailRows(groups: DayGroup[]): Record<string, unknown>[] {
  return xlsxDetailRows(groups).map((r) =>
    r.estado ? r : { ...r, [XLSX_ROW_STYLE]: String(r.fecha ?? "").startsWith("Total") ? "group" : "subtotal" },
  );
}

export function inboxXlsxRows(items: InboxItem[], ticket: (saleId: string | null) => string): Record<string, unknown>[] {
  return items.map((i) => ({
    tipo: INBOX_KIND[i.kind].label,
    procesador: i.provider ? providerLabel(i.provider) : "Tarjetas",
    fecha: xlsxDate(i.date),
    titulo: [i.title, i.detail].filter(Boolean).join(" · "),
    monto: i.amount,
    ref: i.ref ?? "",
    venta: ticket(i.saleId),
    estado: i.dispute
      ? DISPUTE_STATUS_LABEL[i.dispute.status].label
      : i.kind === "card_batch"
        ? "Pendiente"
        : MATCH_LABEL[i.kind as "missing_in_pos" | "amount_diff" | "pos_only"].label,
    todo: INBOX_KIND[i.kind].todo,
  }));
}
