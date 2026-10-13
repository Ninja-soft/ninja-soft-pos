// =============================================================================
// Ficha del cliente 360 (H31b · ADR-067): lógica pura. Sin red ni React.
//
//  * Tipos del resumen (customer_360_summary) y de la línea de tiempo
//    (customer_360_timeline).
//  * Segmentos automáticos a partir de los indicadores (nuevo, frecuente,
//    VIP, en riesgo, inactivo, con deuda, deuda vencida, devuelve mucho).
//  * Título, detalle, signo y tono de cada movimiento de la línea de tiempo.
//  * Filas para exportar a XLSX.
// =============================================================================

export type TimelineKind =
  | "sale"
  | "return"
  | "account"
  | "collection"
  | "store_credit"
  | "pending_charge"
  | "mp_refund"
  | "dispute"
  | "note";

export const TIMELINE_KINDS: TimelineKind[] = [
  "sale",
  "return",
  "account",
  "collection",
  "store_credit",
  "pending_charge",
  "mp_refund",
  "dispute",
  "note",
];

export interface C360Kpis {
  purchases: number;
  total: number;
  avg_ticket: number;
  first_at: string | null;
  last_at: string | null;
  days_since_last: number | null;
  frequency_days: number | null;
  purchases_90d: number;
  total_365d: number;
  returns: number;
  returns_total: number;
  account_balance: number;
  account_overdue: number;
  account_next_due: string | null;
  credit_limit: number | null;
  store_credit: number;
  pending_charges: number;
  pending_charges_total: number;
  open_disputes: number;
}

export interface C360Summary {
  profile: Record<string, unknown> & {
    id: string;
    name: string;
    group_name?: string | null;
    store_alta_name?: string | null;
  };
  kpis: C360Kpis;
  vip_threshold: number | null;
  is_manager: boolean;
  by_store: { store_id: string; name: string; count: number; total: number; avg_ticket: number; last_at: string }[];
  monthly: { month: string; total: number; count: number }[];
  top_products: { product_id: string | null; name: string; qty: number; total: number; purchases: number }[];
  payment_methods: { method: string; total: number; count: number }[];
  pinned_notes: { id: string; body: string; created_at: string; created_by: string | null; author: string | null }[];
}

export interface TimelineItem {
  kind: TimelineKind;
  sub: string | null;
  id: string;
  at: string;
  amount: number;
  ref: string | null;
  status: string | null;
  store_id: string | null;
  store_name: string | null;
  sale_id: string | null;
  detail: string | null;
}

export interface TimelinePage {
  items: TimelineItem[];
  next_cursor: { at: string; id: string } | null;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : num(v));

/** Normaliza el resumen que llega del servidor (numerics como string). */
export function normalizeSummary(raw: C360Summary): C360Summary {
  const k = (raw.kpis ?? {}) as unknown as Record<string, unknown>;
  return {
    ...raw,
    kpis: {
      purchases: num(k.purchases),
      total: num(k.total),
      avg_ticket: num(k.avg_ticket),
      first_at: (k.first_at as string | null) ?? null,
      last_at: (k.last_at as string | null) ?? null,
      days_since_last: numOrNull(k.days_since_last),
      frequency_days: numOrNull(k.frequency_days),
      purchases_90d: num(k.purchases_90d),
      total_365d: num(k.total_365d),
      returns: num(k.returns),
      returns_total: num(k.returns_total),
      account_balance: num(k.account_balance),
      account_overdue: num(k.account_overdue),
      account_next_due: (k.account_next_due as string | null) ?? null,
      credit_limit: numOrNull(k.credit_limit),
      store_credit: num(k.store_credit),
      pending_charges: num(k.pending_charges),
      pending_charges_total: num(k.pending_charges_total),
      open_disputes: num(k.open_disputes),
    },
    vip_threshold: numOrNull(raw.vip_threshold),
    by_store: (raw.by_store ?? []).map((s) => ({ ...s, count: num(s.count), total: num(s.total), avg_ticket: num(s.avg_ticket) })),
    monthly: (raw.monthly ?? []).map((m) => ({ ...m, total: num(m.total), count: num(m.count) })),
    top_products: (raw.top_products ?? []).map((p) => ({ ...p, qty: num(p.qty), total: num(p.total), purchases: num(p.purchases) })),
    payment_methods: (raw.payment_methods ?? []).map((p) => ({ ...p, total: num(p.total), count: num(p.count) })),
    pinned_notes: raw.pinned_notes ?? [],
  };
}

// ── Segmentos ────────────────────────────────────────────────────────────────

export type SegmentKey =
  | "nuevo"
  | "frecuente"
  | "vip"
  | "en_riesgo"
  | "inactivo"
  | "sin_compras"
  | "con_deuda"
  | "deuda_vencida"
  | "devuelve_mucho";

export type SegmentTone = "brand" | "gold" | "success" | "warning" | "danger" | "info" | "neutral";

export const SEGMENT_META: Record<SegmentKey, { label: string; tone: SegmentTone; help: string }> = {
  sin_compras: { label: "Sin compras", tone: "neutral", help: "Todavía no compró." },
  nuevo: { label: "Nuevo", tone: "info", help: "Primera compra hace menos de 30 días." },
  frecuente: { label: "Frecuente", tone: "success", help: "3 o más compras en los últimos 90 días." },
  vip: { label: "VIP", tone: "gold", help: "Está entre el 10% que más compró en los últimos 12 meses." },
  en_riesgo: {
    label: "En riesgo",
    tone: "warning",
    help: "Compraba seguido y hace más del doble de su frecuencia habitual que no vuelve.",
  },
  inactivo: { label: "Inactivo", tone: "neutral", help: "Más de 180 días sin comprar." },
  con_deuda: { label: "Con deuda", tone: "warning", help: "Tiene saldo deudor en cuenta corriente." },
  deuda_vencida: { label: "Deuda vencida", tone: "danger", help: "Tiene cargos vencidos sin cobrar." },
  devuelve_mucho: { label: "Devuelve mucho", tone: "warning", help: "Devolvió más del 20% de lo que compró." },
};

/** Segmentos del cliente, en orden de importancia. */
export function customerSegments(k: C360Kpis, vipThreshold: number | null): SegmentKey[] {
  const out: SegmentKey[] = [];
  if (k.purchases === 0) {
    out.push("sin_compras");
  } else {
    const days = k.days_since_last ?? 0;
    const firstDays = k.first_at ? (Date.now() - Date.parse(k.first_at)) / 86_400_000 : Infinity;
    if (vipThreshold != null && vipThreshold > 0 && k.total_365d >= vipThreshold) out.push("vip");
    if (firstDays <= 30) out.push("nuevo");
    if (k.purchases_90d >= 3) out.push("frecuente");
    if (days > 180) out.push("inactivo");
    else if (
      k.purchases >= 3 &&
      k.frequency_days != null &&
      k.frequency_days > 0 &&
      days > 30 &&
      days > 2 * k.frequency_days
    ) {
      out.push("en_riesgo");
    }
    if (k.purchases >= 3 && k.total > 0 && k.returns_total / k.total > 0.2) out.push("devuelve_mucho");
  }
  if (k.account_overdue > 0.009) out.push("deuda_vencida");
  else if (k.account_balance > 0.009) out.push("con_deuda");
  return out;
}

// ── Línea de tiempo ──────────────────────────────────────────────────────────

export const KIND_LABEL: Record<TimelineKind, string> = {
  sale: "Ventas",
  return: "Devoluciones",
  account: "Cuenta corriente",
  collection: "Cobranza",
  store_credit: "Vales y saldo a favor",
  pending_charge: "Cobros en espera",
  mp_refund: "Reintegros por Mercado Pago",
  dispute: "Contracargos y reclamos",
  note: "Notas",
};

const ACCOUNT_SUB: Record<string, string> = {
  charge: "Cargo en cuenta corriente",
  payment: "Cobro de cuenta corriente",
  interest: "Interés por mora",
  interest_waiver: "Condonación de interés",
  adjust_debit: "Ajuste débito",
  adjust_credit: "Ajuste crédito",
  reversal: "Reversa",
};

const COLLECTION_SUB: Record<string, string> = {
  note: "Nota de cobranza",
  promise: "Promesa de pago",
  task: "Tarea de cobranza",
  reminder_log: "Recordatorio enviado",
};

const REFUND_SUB: Record<string, string> = {
  cash: "en efectivo",
  store_credit: "con vale",
  account: "a la cuenta corriente",
  mercadopago: "por Mercado Pago",
};

const PENDING_STATUS: Record<string, string> = {
  waiting: "esperando el pago",
  paid: "pagado",
  completed: "cobrado",
  cancelled: "cancelado",
  expired: "vencido",
};

const MP_REFUND_STATUS: Record<string, string> = {
  pending: "por enviar",
  processing: "enviando",
  approved: "hecho",
  in_process: "en proceso",
  failed: "Mercado Pago no pudo",
  error: "sin respuesta",
  fallback: "pasado a efectivo o vale",
};

const DISPUTE_SUB: Record<string, string> = {
  refund: "Devolución en Mercado Pago",
  chargeback: "Contracargo",
  claim: "Reclamo",
};

export type ItemTone = "success" | "warning" | "danger" | "neutral" | "info" | "brand";

/** Título, detalle y tono de un movimiento. */
export function describeItem(it: TimelineItem): { title: string; detail: string | null; tone: ItemTone } {
  switch (it.kind) {
    case "sale":
      return {
        title: `Venta #${it.ref ?? ""}${it.status === "voided" ? " (anulada)" : ""}`,
        detail: it.detail ? `Cobro: ${it.detail}` : null,
        tone: it.status === "voided" ? "neutral" : "success",
      };
    case "return":
      return {
        title: `Devolución #${it.ref ?? ""} ${REFUND_SUB[it.sub ?? ""] ?? ""}`.trim(),
        detail: it.detail,
        tone: "warning",
      };
    case "account":
      return {
        title: `${ACCOUNT_SUB[it.sub ?? ""] ?? "Movimiento de cuenta corriente"}${it.ref ? ` · recibo ${it.ref}` : ""}${it.status === "voided" ? " (anulado)" : ""}`,
        detail: it.detail,
        tone: it.status === "voided" ? "neutral" : it.amount > 0 ? "warning" : "success",
      };
    case "collection":
      return {
        title: `${COLLECTION_SUB[it.sub ?? ""] ?? "Gestión de cobranza"}${it.ref ? ` · ${it.ref}` : ""}`,
        detail: it.detail,
        tone: it.status === "broken" || it.status === "failed" ? "danger" : "info",
      };
    case "store_credit":
      return {
        title: it.amount >= 0 ? "Saldo a favor acreditado" : "Saldo a favor usado",
        detail: it.detail,
        tone: it.amount >= 0 ? "brand" : "neutral",
      };
    case "pending_charge":
      return {
        title: `Cobro en espera (${it.sub === "qr" ? "QR" : "link"}) · ${PENDING_STATUS[it.status ?? ""] ?? it.status ?? ""}`,
        detail: null,
        tone: it.status === "completed" || it.status === "paid" ? "success" : it.status === "waiting" ? "warning" : "neutral",
      };
    case "mp_refund":
      return {
        title: `Reintegro por Mercado Pago · ${MP_REFUND_STATUS[it.status ?? ""] ?? it.status ?? ""}`,
        detail: it.ref ? `Devolución MP ${it.ref}` : null,
        tone: it.status === "approved" || it.status === "in_process" ? "success" : it.status === "failed" ? "danger" : "warning",
      };
    case "dispute":
      return {
        title: `${DISPUTE_SUB[it.sub ?? ""] ?? "Disputa"}${it.detail === "pos" ? " (desde el POS)" : ""}`,
        detail: it.ref ? `Caso ${it.ref}` : null,
        tone: it.sub === "refund" ? "warning" : it.status === "won" ? "success" : "danger",
      };
    case "note":
      return {
        title: it.sub === "pinned" ? "Nota fijada" : "Nota",
        detail: it.detail,
        tone: "neutral",
      };
  }
}

/** ¿El monto se muestra? (las notas y gestiones sin promesa no tienen monto) */
export function showsAmount(it: TimelineItem): boolean {
  if (it.kind === "note") return false;
  if (it.kind === "collection") return it.sub === "promise" && Math.abs(it.amount) > 0;
  return true;
}

/** Une páginas de la línea de tiempo sin repetir filas. */
export function mergePages(pages: TimelinePage[]): TimelineItem[] {
  const seen = new Set<string>();
  const out: TimelineItem[] = [];
  for (const p of pages) {
    for (const it of p.items) {
      const k = `${it.kind}:${it.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...it, amount: Number(it.amount) || 0 });
    }
  }
  return out;
}

/** Rango [desde, hasta) en ISO a partir de fechas yyyy-mm-dd (hora argentina). */
export function dateRange(from: string | null, to: string | null): { from: string | null; to: string | null } {
  const at = (d: string, plusDay = false) => {
    const t = new Date(`${d}T00:00:00-03:00`);
    if (plusDay) t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString();
  };
  return { from: from ? at(from) : null, to: to ? at(to, true) : null };
}

// ── Exportación ──────────────────────────────────────────────────────────────

export function timelineXlsxRows(items: TimelineItem[]): Record<string, unknown>[] {
  return items.map((it) => {
    const d = describeItem(it);
    return {
      fecha: new Date(it.at),
      tipo: KIND_LABEL[it.kind],
      movimiento: d.title,
      detalle: d.detail ?? "",
      sucursal: it.store_name ?? "",
      monto: showsAmount(it) ? it.amount : null,
      estado: it.status ?? "",
    };
  });
}

export const TIMELINE_XLSX_COLUMNS = [
  { header: "Fecha", key: "fecha", type: "date" as const, width: 18 },
  { header: "Tipo", key: "tipo", width: 22 },
  { header: "Movimiento", key: "movimiento", width: 40 },
  { header: "Detalle", key: "detalle", width: 40 },
  { header: "Sucursal", key: "sucursal", width: 18 },
  { header: "Monto", key: "monto", type: "money" as const, width: 14 },
  { header: "Estado", key: "estado", width: 14 },
];
