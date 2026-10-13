// Choques de horario en la agenda (F12 · H38, ADR-082). Lógica pura, espejo del
// trigger appointments_resource_guard: dos turnos ACTIVOS se pisan si sus rangos
// [inicio, inicio + duración) se cruzan. El servidor bloquea el choque por
// recurso ('resource_busy'); el de profesional es sólo un aviso en la UI (un
// profesional puede atender dos cosas a la vez, p. ej. color en pausa + corte).

import type { AppointmentStatus } from "./api";

export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ["reservado", "confirmado", "en_curso"];

export function isActiveStatus(s: AppointmentStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

export interface SlotLike {
  id?: string;
  starts_at: string;
  duration_min: number;
  status: AppointmentStatus;
  professional_id: string | null;
  resource_id?: string | null;
}

// Rangos semiabiertos: un turno que termina 10:30 no choca con uno que empieza
// 10:30.
export function rangesOverlap(aStart: string, aMin: number, bStart: string, bMin: number): boolean {
  const a0 = new Date(aStart).getTime();
  const b0 = new Date(bStart).getTime();
  if (!Number.isFinite(a0) || !Number.isFinite(b0)) return false;
  const a1 = a0 + Math.max(0, aMin) * 60_000;
  const b1 = b0 + Math.max(0, bMin) * 60_000;
  return a0 < b1 && b0 < a1;
}

export interface Conflicts {
  professional: SlotLike[];
  resource: SlotLike[];
}

// Turnos activos de `existing` que chocan con `candidate` por profesional o por
// recurso. Un candidato inactivo (cancelado, no vino, realizado) no choca.
export function findConflicts(existing: SlotLike[], candidate: SlotLike): Conflicts {
  const out: Conflicts = { professional: [], resource: [] };
  if (!isActiveStatus(candidate.status)) return out;
  for (const a of existing) {
    if (candidate.id && a.id === candidate.id) continue;
    if (!isActiveStatus(a.status)) continue;
    if (!rangesOverlap(a.starts_at, a.duration_min, candidate.starts_at, candidate.duration_min)) continue;
    if (candidate.professional_id && a.professional_id === candidate.professional_id) out.professional.push(a);
    if (candidate.resource_id && a.resource_id === candidate.resource_id) out.resource.push(a);
  }
  return out;
}

// Mensaje claro para los errores del servidor de la agenda.
export function agendaErrorMessage(raw: string | undefined | null): string {
  const msg = raw ?? "";
  if (msg.includes("resource_busy")) return "Ese recurso ya está ocupado en ese horario.";
  if (msg.includes("resource_not_found")) return "El recurso no existe o está inactivo.";
  if (msg.includes("feature_not_in_plan: agenda_recursos")) return "Tu plan no incluye recursos de agenda.";
  if (msg.includes("feature_not_in_plan: lista_espera")) return "Tu plan no incluye la lista de espera.";
  if (msg.includes("feature_not_in_plan: agenda")) return "Tu plan no incluye la agenda.";
  if (msg.includes("waitlist_entry_closed")) return "Esa entrada ya fue agendada o cancelada.";
  if (msg.includes("waitlist_entry_not_found")) return "No encontramos esa entrada de la lista de espera.";
  if (msg.includes("use_waitlist_schedule")) return "Para agendar usá el botón Agendar de la lista de espera.";
  if (msg.includes("professional_not_found")) return "El profesional no existe o fue dado de baja.";
  if (msg.includes("forbidden") || msg.includes("row-level security")) return "Tu rol no puede hacer esta acción.";
  return msg || "No se pudo completar la acción.";
}
