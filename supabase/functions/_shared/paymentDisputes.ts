// =============================================================================
// Contracargos, reclamos y devoluciones de Mercado Pago (ADR-064). Puro: sin
// red ni Deno (lo importan las Edges `settlements` y `mp_webhook` y Vitest).
//
//  * mpDisputesFromPayment(pago): de un pago de GET /v1/payments/{id} o de
//    /v1/payments/search saca las disputas que tiene:
//      - una devolución por cada `refunds[]` (o una sola con
//        `transaction_amount_refunded` si la búsqueda no trae el detalle),
//      - un contracargo si `status = charged_back`
//        (status_detail in_process | settled | reimbursed),
//      - un reclamo si `status = in_mediation`.
//    La clave de un contracargo y de un reclamo es por pago (mp_cb:<pago>,
//    mp_claim:<pago>) para que el sondeo y el webhook (que trae el id del
//    caso) caigan en la misma fila.
//  * mergeMpChargeback(item, contracargo): completa con GET
//    /v1/chargebacks/{id}: id del caso, monto, motivo, documentation_status,
//    date_documentation_deadline, coverage_applied y coverage_eligible.
//  * staleDisputeUpdates(abiertas, pagos): cierra los reclamos y contracargos
//    abiertos cuyo pago ya no está en mediación ni en contracargo.
//  * webhookTopicKind / claimPaymentId: avisos de contracargos y reclamos.
//
// Qué merece aviso al dueño lo decide el servidor (_payment_disputes_upsert):
// contracargos y reclamos siempre; devoluciones sólo si la venta no está
// anulada ni tiene una devolución registrada en el POS.
// =============================================================================

type Obj = Record<string, unknown>;

export type DisputeKind = "refund" | "chargeback" | "claim";

/**
 * Estado normalizado:
 *  open       abierto, sin resolver (reclamo abierto, contracargo nuevo, devolución en curso)
 *  in_review  contracargo con documentación presentada, esperando a Mercado Pago
 *  won        resuelto a favor del vendedor (cobertura aplicada, plata devuelta)
 *  lost       resuelto en contra (la plata se descontó)
 *  refunded   devolución hecha
 *  closed     cerrado sin efecto (reclamo cerrado, devolución rechazada o cancelada)
 */
export type DisputeStatus = "open" | "in_review" | "won" | "lost" | "refunded" | "closed";

export interface DisputeInput {
  provider_key: string;
  kind: DisputeKind;
  dispute_key: string;
  provider_payment_id: string;
  provider_case_id: string | null;
  external_reference: string | null;
  amount: number;
  currency: string | null;
  status: DisputeStatus;
  provider_status: string | null;
  provider_status_detail: string | null;
  reason: string | null;
  /** Quién hizo la devolución según MP (refunds[].source.type: collector, admin...). */
  refund_source: string | null;
  documentation_status: string | null;
  documentation_deadline: string | null;
  coverage_applied: boolean | null;
  coverage_eligible: boolean | null;
  occurred_at: string;
  resolved: boolean;
  raw: unknown;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj | null => (isObj(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function iso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const lower = (v: unknown) => (str(v) ?? "").toLowerCase();

// ── Devoluciones ─────────────────────────────────────────────────────────────

/** Estado de una devolución de MP (refunds[].status). */
export function refundStatus(v: unknown): { status: DisputeStatus; resolved: boolean } {
  switch (lower(v)) {
    case "rejected":
    case "cancelled":
      return { status: "closed", resolved: true };
    case "in_process":
    case "pending":
    case "authorized":
      return { status: "open", resolved: false };
    default:
      // approved o sin dato: MP sólo informa refunds[] ya hechas.
      return { status: "refunded", resolved: true };
  }
}

// ── Contracargos ─────────────────────────────────────────────────────────────

/**
 * Estado de un contracargo. Prioridad: coverage_applied del caso (true = a
 * favor del vendedor, false = en contra); después documentation_status
 * (review_pending = presentada); después el status_detail del pago
 * (reimbursed = devuelto al vendedor, settled = descontado, in_process =
 * abierto).
 */
export function chargebackStatus(p: {
  coverage_applied?: boolean | null;
  documentation_status?: string | null;
  status_detail?: string | null;
}): { status: DisputeStatus; resolved: boolean } {
  if (p.coverage_applied === true) return { status: "won", resolved: true };
  if (p.coverage_applied === false) return { status: "lost", resolved: true };
  const doc = lower(p.documentation_status);
  const detail = lower(p.status_detail);
  if (detail === "reimbursed") return { status: "won", resolved: true };
  if (detail === "settled") return { status: "lost", resolved: true };
  if (doc === "review_pending") return { status: "in_review", resolved: false };
  if (doc === "not_supplied" || doc === "invalid") return { status: "open", resolved: false };
  return { status: "open", resolved: false };
}

/** Disputas que surgen de un pago de Mercado Pago. */
export function mpDisputesFromPayment(raw: unknown): DisputeInput[] {
  const p = obj(raw);
  if (!p) return [];
  const paymentId = str(p.id);
  if (!paymentId) return [];
  const status = lower(p.status);
  const detail = str(p.status_detail);
  const currency = str(p.currency_id);
  const ref = str(p.external_reference);
  const gross = num(p.transaction_amount) ?? 0;
  const refundedTotal = round2(num(p.transaction_amount_refunded) ?? 0);
  const lastUpdate = iso(p.date_last_updated) ?? iso(p.date_created) ?? new Date(0).toISOString();
  const out: DisputeInput[] = [];
  const base = {
    provider_key: "mercadopago",
    provider_payment_id: paymentId,
    external_reference: ref,
    currency,
    documentation_status: null,
    documentation_deadline: null,
    coverage_applied: null,
    coverage_eligible: null,
  };

  // Devoluciones (una fila por devolución de MP).
  const refunds = arr(p.refunds).map(obj).filter((r): r is Obj => r !== null);
  for (const r of refunds) {
    const rid = str(r.id);
    const amount = round2(num(r.amount) ?? 0);
    if (!rid || amount <= 0) continue;
    const st = refundStatus(r.status);
    const source = obj(r.source);
    out.push({
      ...base,
      kind: "refund",
      dispute_key: `mp_refund:${rid}`,
      provider_case_id: rid,
      amount,
      status: st.status,
      provider_status: str(r.status),
      provider_status_detail: null,
      reason: str(r.reason) ?? str(obj(r.metadata)?.reason) ?? null,
      refund_source: str(source?.type) ?? str(source?.name),
      occurred_at: iso(r.date_created) ?? lastUpdate,
      resolved: st.resolved,
      raw: r,
    });
  }
  // La búsqueda a veces no trae refunds[]: una devolución por el total devuelto.
  if (refunds.length === 0 && refundedTotal > 0) {
    out.push({
      ...base,
      kind: "refund",
      dispute_key: `mp_refund_total:${paymentId}`,
      provider_case_id: null,
      amount: refundedTotal,
      status: "refunded",
      provider_status: status || null,
      provider_status_detail: detail,
      reason: null,
      refund_source: null,
      occurred_at: lastUpdate,
      resolved: true,
      raw: { transaction_amount_refunded: refundedTotal, status, status_detail: detail },
    });
  }

  if (status === "charged_back") {
    const st = chargebackStatus({ status_detail: detail });
    out.push({
      ...base,
      kind: "chargeback",
      dispute_key: `mp_cb:${paymentId}`,
      provider_case_id: null,
      amount: round2(Math.max(0, gross - refundedTotal) || gross),
      status: st.status,
      provider_status: status,
      provider_status_detail: detail,
      reason: null,
      refund_source: null,
      occurred_at: lastUpdate,
      resolved: st.resolved,
      raw: { status, status_detail: detail, transaction_amount: gross },
    });
  }

  if (status === "in_mediation") {
    out.push({
      ...base,
      kind: "claim",
      dispute_key: `mp_claim:${paymentId}`,
      provider_case_id: null,
      amount: round2(gross),
      status: "open",
      provider_status: status,
      provider_status_detail: detail,
      reason: null,
      refund_source: null,
      occurred_at: lastUpdate,
      resolved: false,
      raw: { status, status_detail: detail, transaction_amount: gross },
    });
  }
  return out;
}

/**
 * Completa un contracargo con el caso de GET /v1/chargebacks/{id}. Si el ítem
 * no es un contracargo (p. ej. llegó primero el webhook), arma uno desde el
 * caso para el pago indicado.
 */
export function mergeMpChargeback(item: DisputeInput | null, cbRaw: unknown, paymentId?: string | null): DisputeInput | null {
  const cb = obj(cbRaw);
  if (!cb) return item;
  const caseId = str(cb.id);
  const pid = item?.provider_payment_id ?? paymentId ?? str(arr(cb.payments)[0]);
  if (!pid) return item;
  const coverage = typeof cb.coverage_applied === "boolean" ? cb.coverage_applied : null;
  const eligible = typeof cb.coverage_eligible === "boolean" ? cb.coverage_eligible : null;
  const docStatus = str(cb.documentation_status);
  const st = chargebackStatus({
    coverage_applied: coverage,
    documentation_status: docStatus,
    status_detail: item?.provider_status_detail ?? null,
  });
  const amount = num(cb.amount);
  const base: DisputeInput = item ?? {
    provider_key: "mercadopago",
    kind: "chargeback",
    dispute_key: `mp_cb:${pid}`,
    provider_payment_id: pid,
    provider_case_id: null,
    external_reference: null,
    amount: 0,
    currency: null,
    status: "open",
    provider_status: "charged_back",
    provider_status_detail: null,
    reason: null,
    refund_source: null,
    documentation_status: null,
    documentation_deadline: null,
    coverage_applied: null,
    coverage_eligible: null,
    occurred_at: iso(cb.date_created) ?? new Date(0).toISOString(),
    resolved: false,
    raw: null,
  };
  return {
    ...base,
    provider_case_id: caseId ?? base.provider_case_id,
    amount: amount != null && amount > 0 ? round2(amount) : base.amount,
    currency: str(cb.currency) ?? base.currency,
    reason: str(cb.reason) ?? base.reason,
    documentation_status: docStatus,
    documentation_deadline: iso(cb.date_documentation_deadline),
    coverage_applied: coverage,
    coverage_eligible: eligible,
    occurred_at: iso(cb.date_created) ?? base.occurred_at,
    status: st.status,
    resolved: st.resolved,
    raw: { payment: base.raw, chargeback: cb },
  };
}

// ── Cierre de lo que dejó de estar en disputa ────────────────────────────────

export interface OpenDispute {
  dispute_key: string;
  kind: DisputeKind;
  provider_payment_id: string;
  provider_case_id: string | null;
  status: DisputeStatus;
}

/**
 * Reclamos y contracargos abiertos cuyo pago (visto en esta corrida) ya no
 * está en mediación ni en contracargo: se cierran. Un reclamo que termina con
 * el pago devuelto queda `closed` (la devolución entra como su propia fila).
 */
export function staleDisputeUpdates(open: OpenDispute[], payments: unknown[]): DisputeInput[] {
  const byId = new Map<string, Obj>();
  for (const raw of payments) {
    const p = obj(raw);
    const id = str(p?.id);
    if (p && id) byId.set(id, p);
  }
  const out: DisputeInput[] = [];
  for (const d of open) {
    if (d.kind === "refund") continue;
    const p = byId.get(d.provider_payment_id);
    if (!p) continue;
    const status = lower(p.status);
    if (d.kind === "claim" && status === "in_mediation") continue;
    if (d.kind === "chargeback" && status === "charged_back") continue;
    out.push({
      provider_key: "mercadopago",
      kind: d.kind,
      dispute_key: d.dispute_key,
      provider_payment_id: d.provider_payment_id,
      provider_case_id: d.provider_case_id,
      external_reference: str(p.external_reference),
      amount: 0,
      currency: str(p.currency_id),
      // Contracargo que vuelve a aprobado: se resolvió a favor del vendedor.
      status: d.kind === "chargeback" && status === "approved" ? "won" : "closed",
      provider_status: status || null,
      provider_status_detail: str(p.status_detail),
      reason: null,
      refund_source: null,
      documentation_status: null,
      documentation_deadline: null,
      coverage_applied: null,
      coverage_eligible: null,
      occurred_at: iso(p.date_last_updated) ?? new Date(0).toISOString(),
      resolved: true,
      raw: null,
    });
  }
  return out;
}

/** Une por clave (la última gana, salvo campos del caso que el pago no trae). */
export function dedupeDisputes(items: DisputeInput[]): DisputeInput[] {
  const map = new Map<string, DisputeInput>();
  for (const it of items) {
    const prev = map.get(it.dispute_key);
    map.set(
      it.dispute_key,
      prev
        ? {
            ...prev,
            ...it,
            provider_case_id: it.provider_case_id ?? prev.provider_case_id,
            documentation_status: it.documentation_status ?? prev.documentation_status,
            documentation_deadline: it.documentation_deadline ?? prev.documentation_deadline,
            coverage_applied: it.coverage_applied ?? prev.coverage_applied,
            coverage_eligible: it.coverage_eligible ?? prev.coverage_eligible,
            reason: it.reason ?? prev.reason,
            amount: it.amount > 0 ? it.amount : prev.amount,
          }
        : it,
    );
  }
  return [...map.values()];
}

/** Ids de pago de un aviso de MP (topic_chargebacks_wh / topic_claims_integration_wh). */
export function webhookTopicKind(topic: string | null | undefined): "chargeback" | "claim" | null {
  const t = (topic ?? "").toLowerCase();
  if (t === "chargebacks" || t === "topic_chargebacks_wh" || t.startsWith("chargeback")) return "chargeback";
  if (t === "claims" || t === "topic_claims_integration_wh" || t.startsWith("claim")) return "claim";
  return null;
}

/**
 * Reclamo de GET /post-purchase/v1/claims/{id} sobre un pago: completa el
 * reclamo armado desde el pago (o lo crea si el pago todavía no figura en
 * mediación). status opened = abierto; closed = cerrado.
 */
export function mergeMpClaim(item: DisputeInput | null, claimRaw: unknown, payment: unknown): DisputeInput | null {
  const c = obj(claimRaw);
  const p = obj(payment);
  const pid = item?.provider_payment_id ?? str(p?.id) ?? claimPaymentId(c);
  if (!c || !pid) return item;
  const open = lower(c.status) !== "closed";
  const base: DisputeInput = item ?? {
    provider_key: "mercadopago",
    kind: "claim",
    dispute_key: `mp_claim:${pid}`,
    provider_payment_id: pid,
    provider_case_id: null,
    external_reference: str(p?.external_reference),
    amount: round2(num(p?.transaction_amount) ?? 0),
    currency: str(p?.currency_id),
    status: "open",
    provider_status: str(p?.status),
    provider_status_detail: str(p?.status_detail),
    reason: null,
    refund_source: null,
    documentation_status: null,
    documentation_deadline: null,
    coverage_applied: null,
    coverage_eligible: null,
    occurred_at: iso(c.date_created) ?? new Date(0).toISOString(),
    resolved: false,
    raw: null,
  };
  return {
    ...base,
    provider_case_id: str(c.id) ?? base.provider_case_id,
    reason: str(c.reason_id) ?? base.reason,
    occurred_at: iso(c.date_created) ?? base.occurred_at,
    status: open ? "open" : "closed",
    resolved: !open,
    raw: { payment: base.raw, claim: { id: c.id, type: c.type, stage: c.stage, status: c.status, reason_id: c.reason_id } },
  };
}

/** Pago de un reclamo de GET /post-purchase/v1/claims/{id} (sólo si el recurso es un pago). */
export function claimPaymentId(claimRaw: unknown): string | null {
  const c = obj(claimRaw);
  if (!c) return null;
  const resource = lower(c.resource);
  if (resource === "payment" || resource === "payments") return str(c.resource_id);
  return null;
}
