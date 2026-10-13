// =============================================================================
// Contracargos, reclamos y devoluciones (ADR-064): lógica pura para la
// conciliación de procesadores, la lista de ventas, el detalle de la venta y
// el Panel del dueño. Sin red ni React.
//
//  * Estado de disputa de una línea de liquidación: Devuelto, Devuelto
//    parcial, Contracargo, Reclamo abierto (del estado del pago en MP y de las
//    disputas guardadas).
//  * Neto efectivo: una devolución total o un contracargo no ganado dejan el
//    neto en 0; un reclamo abierto retiene la plata (cuenta como "en riesgo").
//    La devolución parcial no se recalcula: el neto de MP (o el calculado,
//    bruto menos devuelto menos comisiones) ya la descuenta.
//  * Marcas para Ventas, plazo para presentar documentación y línea de tiempo.
// =============================================================================

export type DisputeKind = "refund" | "chargeback" | "claim";
export type DisputeStatus = "open" | "in_review" | "won" | "lost" | "refunded" | "closed";

export interface PaymentDisputeRow {
  id: string;
  provider_key: string;
  kind: DisputeKind;
  provider_payment_id: string;
  provider_case_id: string | null;
  payment_id: string | null;
  sale_id: string | null;
  settlement_line_id: string | null;
  amount: number;
  currency: string | null;
  status: DisputeStatus;
  provider_status: string | null;
  provider_status_detail: string | null;
  reason: string | null;
  refund_source: string | null;
  origin: "provider" | "pos";
  documentation_status: string | null;
  documentation_deadline: string | null;
  coverage_applied: boolean | null;
  coverage_eligible: boolean | null;
  occurred_at: string;
  first_seen_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
}

export type Tone = "success" | "warning" | "danger" | "neutral";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Etiquetas ────────────────────────────────────────────────────────────────

export const DISPUTE_KIND_LABEL: Record<DisputeKind, string> = {
  refund: "Devolución",
  chargeback: "Contracargo",
  claim: "Reclamo",
};

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, { label: string; tone: Tone }> = {
  open: { label: "Abierto", tone: "danger" },
  in_review: { label: "En revisión de Mercado Pago", tone: "warning" },
  won: { label: "Resuelto a tu favor", tone: "success" },
  lost: { label: "Resuelto en contra", tone: "danger" },
  refunded: { label: "Devuelto", tone: "warning" },
  closed: { label: "Cerrado", tone: "neutral" },
};

const DOC_STATUS_LABEL: Record<string, string> = {
  pending: "Falta presentar la documentación",
  review_pending: "Documentación presentada, en revisión",
  valid: "Documentación aceptada",
  invalid: "Documentación rechazada",
  not_supplied: "No se presentó la documentación a tiempo",
  not_applicable: "No hace falta documentación",
};
export const docStatusLabel = (s: string | null) => (s ? (DOC_STATUS_LABEL[s] ?? s) : null);

const REASON_LABEL: Record<string, string> = {
  unauthorized: "El titular no reconoce la compra",
  fraud: "Fraude",
  not_received: "El comprador dice que no recibió el producto",
  not_as_described: "El producto no es como se describió",
  duplicated: "Cobro duplicado",
  canceled: "Compra cancelada",
  cancelled: "Compra cancelada",
  buyer_request: "Pedido del comprador",
};
export const disputeReasonLabel = (r: string | null) => (r ? (REASON_LABEL[r.toLowerCase()] ?? r.replace(/_/g, " ")) : null);

// ── Estado de una línea de liquidación ───────────────────────────────────────

export type LineDisputeState = "refunded" | "partially_refunded" | "chargeback" | "claim";

export const LINE_DISPUTE_LABEL: Record<LineDisputeState, { label: string; tone: Tone; help: string }> = {
  refunded: { label: "Devuelto", tone: "warning", help: "Mercado Pago devolvió el pago completo al comprador." },
  partially_refunded: { label: "Devuelto parcial", tone: "warning", help: "Mercado Pago devolvió una parte del pago." },
  chargeback: {
    label: "Contracargo",
    tone: "danger",
    help: "El titular de la tarjeta desconoció el pago. Si no se resuelve a tu favor, la plata se descuenta.",
  },
  claim: {
    label: "Reclamo abierto",
    tone: "warning",
    help: "El comprador abrió un reclamo. Mercado Pago retiene la plata hasta que se resuelva.",
  },
};

/**
 * ADR-067: devoluciones hechas desde el POS (reintegro por Mercado Pago de una
 * devolución registrada). Si todas las devoluciones de la línea son del POS,
 * la conciliación la muestra "Devuelto (POS)" en vez de "Devuelto".
 */
export function refundsFromPos(disputes: Pick<PaymentDisputeRow, "kind" | "origin" | "status">[]): boolean {
  const refunds = disputes.filter((d) => d.kind === "refund" && d.status !== "closed");
  return refunds.length > 0 && refunds.every((d) => d.origin === "pos");
}

/** Etiqueta del estado de la línea, con el origen POS de las devoluciones. */
export function lineDisputeLabel(
  state: LineDisputeState,
  disputes: Pick<PaymentDisputeRow, "kind" | "origin" | "status">[] = [],
): { label: string; tone: Tone; help: string } {
  const base = LINE_DISPUTE_LABEL[state];
  if ((state === "refunded" || state === "partially_refunded") && refundsFromPos(disputes)) {
    return {
      label: state === "refunded" ? "Devuelto (POS)" : "Devuelto parcial (POS)",
      tone: "neutral",
      help: "Se devolvió por Mercado Pago desde una devolución registrada en el POS.",
    };
  }
  return base;
}

export interface LineLike {
  external_id: string | null;
  status: string;
  gross: number;
  refunded: number;
  net: number;
}

/** Disputas por id del pago en el procesador. */
export type DisputeIndex = Map<string, PaymentDisputeRow[]>;

export function indexDisputes(rows: PaymentDisputeRow[]): DisputeIndex {
  const m: DisputeIndex = new Map();
  for (const d of rows) {
    const list = m.get(d.provider_payment_id) ?? [];
    list.push(d);
    m.set(d.provider_payment_id, list);
  }
  return m;
}

const isOpen = (d: PaymentDisputeRow) => !d.resolved_at && d.status !== "closed";

/** Contracargo vigente de la línea (abierto o perdido; no los ganados ni cerrados). */
function activeChargeback(list: PaymentDisputeRow[]): PaymentDisputeRow | null {
  return list.find((d) => d.kind === "chargeback" && d.status !== "won" && d.status !== "closed") ?? null;
}

export function lineDisputeState(l: LineLike, disputes: PaymentDisputeRow[] = []): LineDisputeState | null {
  const status = (l.status ?? "").toLowerCase();
  const cbWon = disputes.some((d) => d.kind === "chargeback" && d.status === "won");
  if ((status === "charged_back" && !cbWon) || activeChargeback(disputes)) return "chargeback";
  if (status === "in_mediation" || disputes.some((d) => d.kind === "claim" && isOpen(d))) return "claim";
  const gross = Number(l.gross);
  const refunded = Number(l.refunded);
  if (status === "refunded" || (gross > 0 && refunded >= gross - 0.01)) return "refunded";
  if (refunded > 0 || status === "partially_refunded") return "partially_refunded";
  return null;
}

/** Neto que queda para el negocio según la disputa. */
export function effectiveNet(l: LineLike, state: LineDisputeState | null): number {
  if (state === "refunded" || state === "chargeback") return 0;
  return round2(Number(l.net));
}

/** Plata en riesgo de la línea: contracargo abierto o reclamo (lo que retiene MP). */
export function amountAtRisk(l: LineLike, state: LineDisputeState | null, disputes: PaymentDisputeRow[] = []): number {
  if (state === "claim") return round2(Number(l.gross) - Number(l.refunded));
  if (state === "chargeback") {
    const cb = activeChargeback(disputes);
    if (cb && cb.status === "lost") return 0;
    return round2(cb && Number(cb.amount) > 0 ? Number(cb.amount) : Number(l.gross) - Number(l.refunded));
  }
  return 0;
}

export interface DisputeSummary {
  counts: Record<LineDisputeState, number>;
  amounts: Record<LineDisputeState, number>;
  /** Neto que se pierde por devoluciones totales y contracargos (frente al neto informado). */
  netLost: number;
  /** Contracargos abiertos y reclamos: plata retenida o por descontarse. */
  atRisk: number;
  total: number;
}

export function disputeSummary(lines: LineLike[], index: DisputeIndex = new Map()): DisputeSummary {
  const counts = { refunded: 0, partially_refunded: 0, chargeback: 0, claim: 0 };
  const amounts = { refunded: 0, partially_refunded: 0, chargeback: 0, claim: 0 };
  let netLost = 0;
  let atRisk = 0;
  for (const l of lines) {
    const ds = l.external_id ? (index.get(l.external_id) ?? []) : [];
    const st = lineDisputeState(l, ds);
    if (!st) continue;
    counts[st] += 1;
    if (st === "refunded" || st === "partially_refunded") amounts[st] += Number(l.refunded) || (st === "refunded" ? Number(l.gross) : 0);
    else if (st === "chargeback") {
      const cb = activeChargeback(ds);
      amounts[st] += cb && Number(cb.amount) > 0 ? Number(cb.amount) : Number(l.gross) - Number(l.refunded);
    } else amounts[st] += Number(l.gross) - Number(l.refunded);
    netLost += round2(Number(l.net)) - effectiveNet(l, st);
    atRisk += amountAtRisk(l, st, ds);
  }
  for (const k of Object.keys(amounts) as LineDisputeState[]) amounts[k] = round2(amounts[k]);
  return {
    counts,
    amounts,
    netLost: round2(netLost),
    atRisk: round2(atRisk),
    total: counts.refunded + counts.partially_refunded + counts.chargeback + counts.claim,
  };
}

// ── Plazo y línea de tiempo ──────────────────────────────────────────────────

export interface DeadlineInfo {
  at: string;
  daysLeft: number;
  overdue: boolean;
  urgent: boolean;
}

/** Plazo para presentar documentación de un contracargo abierto. */
export function deadlineInfo(d: Pick<PaymentDisputeRow, "kind" | "documentation_deadline" | "documentation_status" | "resolved_at">, now: Date = new Date()): DeadlineInfo | null {
  if (d.kind !== "chargeback" || !d.documentation_deadline || d.resolved_at) return null;
  if (d.documentation_status && !["pending", "not_supplied"].includes(d.documentation_status)) return null;
  const t = Date.parse(d.documentation_deadline);
  if (Number.isNaN(t)) return null;
  const ms = t - now.getTime();
  const daysLeft = Math.ceil(ms / 86_400_000);
  return { at: d.documentation_deadline, daysLeft, overdue: ms < 0, urgent: ms >= 0 && daysLeft <= 2 };
}

export interface TimelineEvent {
  at: string;
  label: string;
  tone: Tone;
}

export function disputeTimeline(d: PaymentDisputeRow): TimelineEvent[] {
  const kind = DISPUTE_KIND_LABEL[d.kind];
  const ev: TimelineEvent[] = [
    { at: d.occurred_at, label: `${kind} en Mercado Pago`, tone: d.kind === "refund" ? "warning" : "danger" },
  ];
  if (Math.abs(Date.parse(d.first_seen_at) - Date.parse(d.occurred_at)) > 60_000) {
    ev.push({ at: d.first_seen_at, label: "Lo detectó NinjaPos", tone: "neutral" });
  }
  if (d.documentation_deadline) {
    ev.push({ at: d.documentation_deadline, label: "Plazo para presentar la documentación", tone: "warning" });
  }
  if (d.resolved_at) {
    const st = DISPUTE_STATUS_LABEL[d.status];
    ev.push({ at: d.resolved_at, label: st.label, tone: st.tone });
  }
  if (d.acknowledged_at) ev.push({ at: d.acknowledged_at, label: "Marcado como visto", tone: "neutral" });
  return ev.sort((a, b) => a.at.localeCompare(b.at));
}

// ── Ventas ───────────────────────────────────────────────────────────────────

export interface SaleAlertBadge {
  key: string;
  label: string;
  tone: Tone;
  title: string;
}

/** Disputas que merecen marca en Ventas (las devoluciones hechas desde el POS no). */
export const isSaleAlert = (d: Pick<PaymentDisputeRow, "kind" | "origin" | "status">) =>
  !(d.kind === "refund" && (d.origin === "pos" || d.status === "closed"));

export function saleAlertBadges(disputes: PaymentDisputeRow[]): SaleAlertBadge[] {
  const out: SaleAlertBadge[] = [];
  const alerts = disputes.filter(isSaleAlert);
  const cb = alerts.filter((d) => d.kind === "chargeback");
  if (cb.length > 0) {
    const won = cb.every((d) => d.status === "won");
    out.push({
      key: "chargeback",
      label: won ? "Contracargo ganado" : "Contracargo",
      tone: won ? "success" : "danger",
      title: won ? "Mercado Pago resolvió el contracargo a tu favor." : LINE_DISPUTE_LABEL.chargeback.help,
    });
  }
  if (alerts.some((d) => d.kind === "claim" && !d.resolved_at)) {
    out.push({ key: "claim", label: "Reclamo abierto", tone: "warning", title: LINE_DISPUTE_LABEL.claim.help });
  }
  const refunds = alerts.filter((d) => d.kind === "refund");
  if (refunds.length > 0) {
    const total = round2(refunds.reduce((a, d) => a + Number(d.amount), 0));
    out.push({
      key: "refund",
      label: "Devuelto por MP",
      tone: "warning",
      title: `Mercado Pago devolvió ${total.toLocaleString("es-AR", { style: "currency", currency: "ARS" })} y la venta sigue vigente en el POS.`,
    });
  }
  return out;
}

/** Cuenta para el Panel del dueño: avisos que el dueño todavía no marcó como vistos. */
export function pendingAlertCount(disputes: Pick<PaymentDisputeRow, "kind" | "origin" | "status" | "acknowledged_at">[]): number {
  return disputes.filter((d) => isSaleAlert(d) && !d.acknowledged_at && d.status !== "closed").length;
}
