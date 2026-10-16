// lib/cash/closeControls.ts
//
// Controles de caja (F23 · H156, ADR-158). Lógica PURA, espejo de lo que exige
// el servidor:
//   - Cerrar con $0 contados y un esperado positivo pide confirmarlo con motivo
//     (cash_shift_confirm_zero_close); sin eso close_cash_shift falla con
//     close_zero_needs_confirmation.
//   - Un Z con diferencia se concilia con un tipo y un motivo (cash_z_review).

export const MIN_REASON = 3;

/** true si el cierre necesita la confirmación de "contado $0". */
export function zeroCloseNeedsConfirm(counted: number, expected: number | null | undefined): boolean {
  return Math.round((Number(counted) || 0) * 100) === 0 && Math.round((Number(expected) || 0) * 100) > 0;
}

export type ZReviewKind = "conteo" | "faltante_real" | "sobrante_real" | "retiro_sin_registrar" | "otro";

export const Z_REVIEW_KINDS: Array<{ value: ZReviewKind; label: string; hint: string }> = [
  { value: "conteo", label: "Error de conteo", hint: "La plata estaba: se contó mal al cerrar." },
  { value: "faltante_real", label: "Faltante real", hint: "Falta plata del cajón." },
  { value: "sobrante_real", label: "Sobrante real", hint: "Sobró plata (por ejemplo, un vuelto mal dado)." },
  { value: "retiro_sin_registrar", label: "Retiro sin registrar", hint: "Se sacó plata y no se cargó el retiro." },
  { value: "otro", label: "Otro motivo", hint: "Contalo en el motivo." },
];

export function zReviewLabel(kind: string | null | undefined): string {
  return Z_REVIEW_KINDS.find((k) => k.value === kind)?.label ?? "Revisado";
}

export interface ZReviewLike {
  difference: number | null;
  reviewed_at?: string | null;
  review_kind?: string | null;
  review_reason?: string | null;
}

/** Z con diferencia distinta de cero que nadie revisó todavía. */
export function zNeedsReview(z: ZReviewLike): boolean {
  return Math.round((Number(z.difference) || 0) * 100) !== 0 && !z.reviewed_at;
}

export function validReason(reason: string): boolean {
  return reason.trim().length >= MIN_REASON;
}
