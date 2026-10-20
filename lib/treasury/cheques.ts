// lib/treasury/cheques.ts
//
// Cheques y e-cheqs (F18 · H111, ADR-059). Máquina de estados PURA, espejo de
// cheque_transition_ok (migración 20261022100300):
//
//   en_cartera ─▶ entregado | depositado | rechazado          (sólo terceros)
//   entregado  ─▶ depositado | rechazado
//              ─▶ en_cartera  (terceros: se anula la orden de pago)
//              ─▶ anulado     (propio: se anula la orden de pago)
//   depositado ─▶ rechazado
//   rechazado, anulado: finales.
//
// Efecto en tesorería: depositar uno de terceros suma en la cuenta; debitar
// uno propio ("depositado" por quien lo cobró) resta; rechazar uno depositado
// revierte ese movimiento.

export type ChequeKind = "own" | "third_party";
export type ChequeStatus = "en_cartera" | "entregado" | "depositado" | "rechazado" | "anulado";

export const CHEQUE_STATUSES: ChequeStatus[] = ["en_cartera", "entregado", "depositado", "rechazado", "anulado"];

export const CHEQUE_STATUS_LABEL: Record<ChequeStatus, string> = {
  en_cartera: "En cartera",
  entregado: "Entregado",
  depositado: "Depositado",
  rechazado: "Rechazado",
  anulado: "Anulado",
};

export const CHEQUE_STATUS_TONE: Record<ChequeStatus, "neutral" | "brand" | "success" | "danger" | "warning"> = {
  en_cartera: "brand",
  entregado: "warning",
  depositado: "success",
  rechazado: "danger",
  anulado: "neutral",
};

export const CHEQUE_KIND_LABEL: Record<ChequeKind, string> = {
  own: "Propio",
  third_party: "De terceros",
};

export function canChequeTransition(kind: ChequeKind, from: ChequeStatus, to: ChequeStatus): boolean {
  switch (from) {
    case "en_cartera":
      return kind === "third_party" && (to === "entregado" || to === "depositado" || to === "rechazado");
    case "entregado":
      return (
        to === "depositado" ||
        to === "rechazado" ||
        (kind === "third_party" && to === "en_cartera") ||
        (kind === "own" && to === "anulado")
      );
    case "depositado":
      return to === "rechazado";
    default:
      return false;
  }
}

/** Transiciones que se hacen a mano desde Tesorería (el resto, la orden de pago). */
export const MANUAL_TRANSITIONS: ChequeStatus[] = ["depositado", "rechazado"];

export function manualActions(kind: ChequeKind, status: ChequeStatus): ChequeStatus[] {
  return MANUAL_TRANSITIONS.filter((to) => canChequeTransition(kind, status, to));
}

/** Etiqueta de la acción según el tipo (un propio "depositado" es un débito). */
export function actionLabel(kind: ChequeKind, to: ChequeStatus): string {
  if (to === "depositado") return kind === "own" ? "Marcar debitado" : "Depositar";
  if (to === "rechazado") return "Rechazado";
  return CHEQUE_STATUS_LABEL[to];
}

/**
 * Movimiento de tesorería que genera una transición (signo sobre la cuenta):
 * +importe al depositar uno de terceros, −importe al debitar uno propio, el
 * opuesto del depósito al rechazar uno depositado, 0 en el resto.
 */
export function chequeMovementSign(kind: ChequeKind, from: ChequeStatus, to: ChequeStatus): -1 | 0 | 1 {
  if (!canChequeTransition(kind, from, to)) return 0;
  if (to === "depositado") return kind === "third_party" ? 1 : -1;
  if (to === "rechazado" && from === "depositado") return kind === "third_party" ? -1 : 1;
  return 0;
}

/** Días hasta la fecha de pago (negativo = ya se puede cobrar o debitar). */
export function daysToPayment(paymentDate: string, today: string): number {
  const a = Date.UTC(+paymentDate.slice(0, 4), +paymentDate.slice(5, 7) - 1, +paymentDate.slice(8, 10));
  const b = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  return Math.round((a - b) / 86_400_000);
}

// ── Cheque repetido (F24 · H158) ────────────────────────────────────────────
// El mismo número y banco ya cargado suele ser un error de tipeo o una carga
// doble. Es un aviso: dos bancos pueden tener el mismo número.

/** Número sin espacios, guiones ni ceros a la izquierda. */
export function normalizeChequeNumber(n: string | null | undefined): string {
  return String(n ?? "").replace(/[^0-9a-z]/gi, "").replace(/^0+/, "").toUpperCase();
}

/** Banco sin acentos, mayúsculas ni "banco"/"bco" delante. */
export function normalizeBankName(b: string | null | undefined): string {
  return String(b ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/^(banco|bco\.?)\s+(del?\s+)?/, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Cheques de la lista con el mismo número (y el mismo banco cuando los dos lo
 * tienen), sin los anulados ni el que se está editando.
 */
export function chequeDuplicates<T extends { id: string; number: string; bank_name: string | null; status: string }>(
  list: readonly T[],
  number: string,
  bank: string | null,
  excludeId?: string | null,
): T[] {
  const n = normalizeChequeNumber(number);
  if (n.length < 3) return [];
  const b = normalizeBankName(bank);
  return list.filter((c) => {
    if (c.id === excludeId || c.status === "anulado") return false;
    if (normalizeChequeNumber(c.number) !== n) return false;
    const cb = normalizeBankName(c.bank_name);
    return !b || !cb || cb === b;
  });
}
