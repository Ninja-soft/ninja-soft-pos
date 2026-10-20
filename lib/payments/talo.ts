// Talo (ADR-175): textos y reglas del cobro por transferencia (pantalla del
// POS) y de las devoluciones desde la conciliación de cobros QR. Puro (sin
// React ni Supabase) para testearlo.

import { formatCurrency } from "@/lib/utils/format";

/** CVU en bloques de 4 para leerlo en voz alta ("0000 6305 0000 ..."). */
export function formatCvu(cvu: string | null | undefined): string {
  const d = String(cvu ?? "").replace(/\D/g, "");
  if (d.length !== 22) return String(cvu ?? "");
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
}

export type TaloNote = { tone: "warning" | "info"; title: string; text: string };

/**
 * Aviso mientras se espera la transferencia:
 *   * UNDERPAID: llegó menos; el cliente transfiere lo que falta al mismo CVU.
 *   * otro estado: nada.
 */
export function taloWaitingNote(s: { state?: string; paid?: number | null; missing?: number } | null | undefined): TaloNote | null {
  if (!s || String(s.state ?? "").toUpperCase() !== "UNDERPAID") return null;
  const paid = typeof s.paid === "number" ? s.paid : null;
  const missing = typeof s.missing === "number" ? s.missing : null;
  return {
    tone: "warning",
    title: missing !== null ? `Faltan ${formatCurrency(missing)}` : "Llegó menos plata",
    text:
      (paid !== null ? `Llegaron ${formatCurrency(paid)}. ` : "") +
      "La venta no se cierra hasta completar el total: pedile al cliente que transfiera lo que falta al mismo CVU o alias.",
  };
}

/** Aviso al aprobar con transferencia de más (OVERPAID). */
export function taloOverpaidNote(overpaid: number | null | undefined): TaloNote | null {
  if (typeof overpaid !== "number" || !(overpaid > 0)) return null;
  return {
    tone: "info",
    title: `El cliente transfirió ${formatCurrency(overpaid)} de más`,
    text: "La venta se registra por el total. Devolvé la diferencia desde Ventas, Cobros QR, o por fuera de Talo.",
  };
}

// ── Devoluciones ─────────────────────────────────────────────────────────────

export interface TaloRefundRow {
  intent_id: string;
  kind: string;
  status: string;
  amount: number;
  created_at: string;
}

/** Devoluciones por cobro, la más nueva primero. */
export function refundsByIntent(rows: TaloRefundRow[]): Map<string, TaloRefundRow[]> {
  const out = new Map<string, TaloRefundRow[]>();
  for (const r of [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    const list = out.get(r.intent_id) ?? [];
    list.push(r);
    out.set(r.intent_id, list);
  }
  return out;
}

const LIVE = new Set(["requested", "initiated"]);

export type TaloRefundIntent = {
  provider_key: string;
  status: string;
  amount: number;
  saleNumber: number | null;
  saleStatus: string | null;
  paidAmount: number | null;
};

/**
 * ¿Qué devoluciones se pueden pedir? (el servidor vuelve a validar todo)
 *   * full: cobro aprobado (o cerrado sin venta al que igual llegó plata), sin
 *     venta vigente, sin devolución en curso ni una total hecha.
 *   * excess: cobro aprobado con más plata recibida que el total, sin
 *     devolución en curso ni una de diferencia hecha.
 */
export function taloRefundOptions(
  intent: TaloRefundIntent,
  refunds: TaloRefundRow[] | null | undefined,
): { full: boolean; excess: number | null } {
  const list = refunds ?? [];
  if (intent.provider_key !== "talo") return { full: false, excess: null };
  if (list.some((r) => LIVE.has(r.status))) return { full: false, excess: null };
  const done = (k: string) => list.some((r) => r.kind === k && r.status === "refunded");
  const paid = intent.paidAmount ?? 0;
  const noLiveSale = intent.saleNumber === null || intent.saleStatus === "voided";
  const paidSomething = intent.status === "approved" || (["cancelled", "rejected"].includes(intent.status) && paid > 0);
  const full = paidSomething && noLiveSale && !done("full");
  const diff = Math.round((paid - intent.amount) * 100) / 100;
  const excess = intent.status === "approved" && diff > 0 && !done("excess") && !done("full") ? diff : null;
  return { full, excess };
}

export function taloRefundLabel(r: { kind: string; status: string }): { label: string; tone: "info" | "success" | "danger" } {
  switch (r.status) {
    case "refunded":
      return { label: r.kind === "excess" ? "Diferencia devuelta" : "Pago devuelto", tone: "success" };
    case "failed":
      return { label: "No se pudo devolver", tone: "danger" };
    default:
      return { label: "Devolución en curso", tone: "info" };
  }
}

export function taloRefundErrorCopy(code: string | null | undefined): string {
  switch (code) {
    case "sale_active":
      return "Este cobro tiene una venta vigente. Anulá la venta primero y después devolvé el pago.";
    case "refund_in_progress":
      return "Ya hay una devolución en curso para este cobro.";
    case "not_refundable":
    case "nothing_to_refund":
      return "No hay nada para devolver en este cobro.";
    case "no_excess":
      return "Este cobro no tiene plata de más para devolver.";
    case "not_paid":
      return "Talo todavía no registra plata recibida en este cobro.";
    case "no_email":
      return "Tu usuario no tiene email: Talo lo pide para registrar quién hace la devolución.";
    case "forbidden":
      return "Sólo el dueño o un encargado pueden devolver cobros.";
    case "payment_method_not_allowed":
      return "Tu plan no incluye Talo.";
    case "not_connected":
      return "Conectá Talo en Configuración, Medios de pago.";
    default:
      if (code && code.startsWith("retry_")) return "Talo no respondió. Probá de nuevo en unos minutos.";
      return "Talo no aceptó la devolución. Revisá el cobro en tu Dashboard de Talo.";
  }
}
