// =============================================================================
// Pago al staff por Mercado Pago (F21 · ADR-121): lectura de la operación
// desde la cuenta de NinjaSoft (GET /v1/payments/{id} con el access token de
// plataforma) y controles contra el pago que se registra. Lógica pura: la Edge
// `staff_payouts` hace el fetch; los tests usan respuestas simuladas.
//
// Se guarda un resumen sin datos de tarjeta (MP no devuelve PAN de todos
// modos): monto, estado, fechas, medio, pagador y destinatario.
// =============================================================================

export interface MpPayoutSummary {
  id: string;
  status: string;
  status_detail: string | null;
  amount_cents: number;
  currency: string;
  date_created: string | null;
  date_approved: string | null;
  description: string | null;
  operation_type: string | null;
  payment_method_id: string | null;
  payer: { id: string | null; email: string | null; name: string | null; identification: string | null };
  collector_id: string | null;
  /** Destinatario según MP (cuenta bancaria o usuario), si lo informa. */
  counterpart: { name: string | null; identification: string | null; account: string | null; bank: string | null };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** Monto de MP (número con decimales) → centavos enteros. */
export function mpAmountToCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Número de operación de MP: sólo dígitos (6 a 20). */
export function normalizeMpOperationId(raw: string): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 6 && d.length <= 20 ? d : null;
}

export function parseMpPayment(json: unknown): MpPayoutSummary | null {
  const p = obj(json);
  const id = str(p.id);
  const amount = mpAmountToCents(p.transaction_amount);
  if (!id || amount === null) return null;
  const payer = obj(p.payer);
  const ident = obj(payer.identification);
  const poi = obj(obj(p.point_of_interaction).transaction_data);
  const bank = obj(poi.bank_info);
  const collectorBank = obj(bank.collector);
  const fullName = [str(payer.first_name), str(payer.last_name)].filter(Boolean).join(" ") || null;
  return {
    id,
    status: str(p.status) ?? "unknown",
    status_detail: str(p.status_detail),
    amount_cents: amount,
    currency: str(p.currency_id) ?? "ARS",
    date_created: str(p.date_created),
    date_approved: str(p.date_approved),
    description: str(p.description),
    operation_type: str(p.operation_type),
    payment_method_id: str(p.payment_method_id),
    payer: {
      id: str(payer.id),
      email: str(payer.email),
      name: fullName,
      identification: ident.number ? `${str(ident.type) ?? ""} ${str(ident.number)}`.trim() : null,
    },
    collector_id: str(p.collector_id) ?? str(obj(p.collector).id),
    counterpart: {
      name: str(collectorBank.account_holder_name) ?? str(obj(p.collector).nickname),
      identification: str(collectorBank.identification_number) ?? null,
      account: str(collectorBank.account_id) ?? str(collectorBank.long_name) ?? null,
      bank: str(collectorBank.long_name) ?? null,
    },
  };
}

export interface MpPayoutCheck {
  ok: boolean;
  direction: "outgoing" | "incoming" | "unknown";
  issues: string[];
}

/**
 * Controles para registrar el pago: aprobado, en pesos, monto igual (con
 * tolerancia) y que la plata haya SALIDO de la cuenta de NinjaSoft (si MP dice
 * que NinjaSoft es quien cobró, es un pago recibido, no un pago al staff).
 */
export function checkMpPayout(
  s: MpPayoutSummary,
  opts: { expected_cents: number; own_user_id: string | null; tolerance_cents?: number },
): MpPayoutCheck {
  const issues: string[] = [];
  if (s.status !== "approved") issues.push(`La operación está "${s.status}" en Mercado Pago, no aprobada.`);
  if (s.currency !== "ARS") issues.push(`La operación es en ${s.currency}, no en pesos.`);
  const tol = Math.max(0, opts.tolerance_cents ?? 0);
  if (Math.abs(s.amount_cents - opts.expected_cents) > tol) {
    issues.push(
      `El monto de Mercado Pago ($ ${(s.amount_cents / 100).toFixed(2)}) no coincide con el pago que registrás ($ ${(opts.expected_cents / 100).toFixed(2)}).`,
    );
  }
  let direction: MpPayoutCheck["direction"] = "unknown";
  if (opts.own_user_id) {
    if (s.payer.id === opts.own_user_id) direction = "outgoing";
    else if (s.collector_id === opts.own_user_id) direction = "incoming";
  }
  if (direction === "incoming") issues.push("En esa operación NinjaSoft RECIBIÓ la plata: no es un pago al staff.");
  return { ok: issues.length === 0, direction, issues };
}
