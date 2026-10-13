// Propiedad de la caja (F17 · H114, ADR-051). PURO.
//
// ESPEJO del SQL: shift_owner_ok(), assert_shift_owner(), open_cash_shift() y
// cash_force_close() en supabase/migrations/20261017120000_propiedad_caja.sql.

import { roleErrorMessage } from "@/lib/permissions/errors";

export interface ShiftLite {
  id: string;
  opened_by: string;
  status: "open" | "closed" | string;
  store_id?: string | null;
  cash_register_id?: string;
  opened_at?: string;
}

export type ShiftUse = "sell" | "operate"; // operate = retiro, ingreso, cierre

/** ¿El usuario puede usar el turno? Vender admite caja compartida; operar, nunca. */
export function canUseShift(
  shift: ShiftLite | null | undefined,
  userId: string | null,
  use: ShiftUse,
  opts: { sharedShift?: boolean; storeAllowed?: boolean } = {},
): boolean {
  if (!shift || shift.status !== "open" || !userId) return false;
  if (shift.opened_by === userId) return true;
  return use === "sell" && Boolean(opts.sharedShift) && opts.storeAllowed !== false;
}

/** Turno abierto propio en cualquier caja (un turno por usuario). */
export function myOpenShift<T extends ShiftLite>(shifts: T[], userId: string | null): T | null {
  if (!userId) return null;
  return shifts.find((s) => s.status === "open" && s.opened_by === userId) ?? null;
}

export type OpenShiftCheck = "ok" | "register_busy" | "user_has_open_shift";

/** ¿Puede abrir esta caja? (una por caja, una por usuario). */
export function canOpenRegister(registerId: string, openShifts: ShiftLite[], userId: string | null): OpenShiftCheck {
  if (openShifts.some((s) => s.status === "open" && s.cash_register_id === registerId)) return "register_busy";
  if (myOpenShift(openShifts, userId)) return "user_has_open_shift";
  return "ok";
}

/** Situación del dispositivo frente a la caja que tiene elegida. */
export type RegisterSituation = "free" | "mine" | "foreign" | "shared";

export function registerSituation(
  shift: ShiftLite | null | undefined,
  userId: string | null,
  sharedShift = false,
): RegisterSituation {
  if (!shift || shift.status !== "open") return "free";
  if (shift.opened_by === userId) return "mine";
  return sharedShift ? "shared" : "foreign";
}

/** ¿Puede forzar el cierre? Nunca el propio (se cierra normal); sí un supervisor. */
export function canForceClose(shift: ShiftLite | null | undefined, userId: string | null, isSupervisor: boolean): boolean {
  if (!shift || shift.status !== "open" || !userId) return false;
  return shift.opened_by !== userId && isSupervisor;
}

/** "2 h 05 min", "12 min", "45 s" desde la apertura. */
export function elapsedLabel(fromIso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  if (h < 24) return `${h} h ${mm} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** Nivel de alerta por antigüedad del turno (para el monitor). */
export function shiftAgeTone(fromIso: string, now: Date = new Date()): "ok" | "long" | "stale" {
  const h = (now.getTime() - new Date(fromIso).getTime()) / 3_600_000;
  if (h >= 16) return "stale";
  if (h >= 10) return "long";
  return "ok";
}

/** Mensaje del error del servidor sobre la caja. */
export function cashErrorMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? err ?? "");
  const byRole = roleErrorMessage(msg);
  if (byRole) return byRole;
  if (/shift_not_owned/.test(msg)) return "Esa caja la tiene abierta otra persona. Abrí la tuya para operar.";
  if (/user_has_open_shift/.test(msg)) return "Ya tenés una caja abierta. Cerrala antes de abrir otra.";
  if (/shift_already_open/.test(msg)) return "Esa caja ya está abierta.";
  if (/staff_suspended/.test(msg)) return "Tu acceso está suspendido: no podés operar la caja.";
  if (/staff_on_leave/.test(msg)) return "Estás de licencia: no podés operar la caja.";
  if (/staff_terminated/.test(msg)) return "Tu usuario está dado de baja en este negocio.";
  if (/cash_movement_immutable|shift_immutable/.test(msg)) return "Los movimientos de caja no se editan ni se borran.";
  if (/cash_movement_forbidden|use_open_cash_shift/.test(msg)) return "Ese movimiento no se puede cargar a mano.";
  if (/no_open_shift/.test(msg)) return "No tenés una caja abierta. Abrí la tuya para vender.";
  if (/reason_required/.test(msg)) return "Falta el motivo.";
  return null;
}
