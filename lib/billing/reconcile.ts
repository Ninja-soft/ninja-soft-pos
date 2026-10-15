// =============================================================================
// Conciliación con Mercado Pago (F20-10 · H136 · ADR-131): la lógica pura vive
// en supabase/functions/_shared/billing/reconcile.ts (la usa la Edge
// platform_mp_reconcile) y se reexporta acá para la pantalla y los tests, con
// los textos de la bandeja y las acciones que acepta internal_recon_resolve.
// =============================================================================

export {
  parseMpPayment,
  reconcile,
  reconWindow,
  type LocalPayment,
  type MpPayment,
  type ReconcileInput,
  type ReconDiff,
  type ReconFee,
  type ReconKind,
  type ReconMpOut,
  type ReconResult,
  type ReconSeverity,
  type SeenRef,
  type SubRef,
} from "@/supabase/functions/_shared/billing/reconcile";

import type { ReconKind } from "@/supabase/functions/_shared/billing/reconcile";

export type ReconAction = "impute" | "keep_credit" | "refund" | "chargeback" | "accept" | "ignore";
export type ReconResolution =
  | "imputed"
  | "duplicate_kept"
  | "refund_registered"
  | "chargeback_registered"
  | "accepted"
  | "ignored"
  | "auto";

export const RECON_KIND_LABELS: Record<ReconKind, string> = {
  missing_local: "Pagado en MP y falta acá",
  missing_mp: "Está acá y no aparece en MP",
  duplicate: "Posible pago duplicado",
  amount_mismatch: "Montos distintos",
  chargeback: "Contracargo o mediación",
  refund: "Reintegro en MP",
  status_mismatch: "Estado distinto en MP",
};

export const RECON_KIND_HELP: Record<ReconKind, string> = {
  missing_local: "Mercado Pago cobró y el pago no está en la cuenta corriente: suele ser un aviso del webhook que se perdió.",
  missing_mp: "El pago figura acá como cobrado con Mercado Pago pero no aparece en la cuenta de NinjaSoft en la ventana revisada.",
  duplicate: "Dos pagos del mismo negocio por el mismo período o por el mismo monto en pocas horas. El segundo queda a favor.",
  amount_mismatch: "El pago cruzó con Mercado Pago pero el importe no coincide.",
  chargeback: "El pagador desconoció el cobro o abrió una mediación. Registrarlo vuelve a abrir la deuda.",
  refund: "El pago se devolvió (total o en parte) en Mercado Pago y todavía no está registrado acá.",
  status_mismatch: "Acá figura aprobado y en Mercado Pago está rechazado o cancelado.",
};

export const RECON_RESOLUTION_LABELS: Record<ReconResolution, string> = {
  imputed: "Imputado",
  duplicate_kept: "Queda a cuenta",
  refund_registered: "Reintegro registrado",
  chargeback_registered: "Contracargo registrado",
  accepted: "Aceptado",
  ignored: "Ignorado",
  auto: "Se resolvió solo",
};

export const RECON_ACTION_LABELS: Record<ReconAction, string> = {
  impute: "Imputar",
  keep_credit: "Dejar a cuenta",
  refund: "Registrar reintegro",
  chargeback: "Registrar contracargo",
  accept: "Aceptar",
  ignore: "Ignorar",
};

const ACTIONS: Record<ReconKind, ReconAction[]> = {
  missing_local: ["impute", "ignore"],
  duplicate: ["keep_credit", "refund", "ignore"],
  amount_mismatch: ["accept", "ignore"],
  chargeback: ["chargeback", "accept", "ignore"],
  refund: ["refund", "accept", "ignore"],
  status_mismatch: ["chargeback", "accept", "ignore"],
  missing_mp: ["accept", "ignore"],
};

/** Acciones que acepta internal_recon_resolve para cada tipo de diferencia. */
export function reconActionsFor(kind: ReconKind | string): ReconAction[] {
  return ACTIONS[kind as ReconKind] ?? ["ignore"];
}
