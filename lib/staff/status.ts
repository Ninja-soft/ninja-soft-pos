// Ciclo de vida del personal (F17 · H113, ADR-051). PURO.
//
// ESPEJO del SQL: staff_status_detail(), staff_set_status(), staff_end_status()
// y staff_rehire() en supabase/migrations/20261017100000_personal_estados.sql.
// El servidor revalida todo; esto alimenta la UI (chips, timeline, qué acciones
// ofrecer) y los tests.

export type StaffStatus = "active" | "suspended" | "on_leave" | "terminated";
export type StatusEventKind = "suspension" | "leave" | "termination" | "rehire";
export type LeaveType = "vacaciones" | "enfermedad" | "maternidad" | "paternidad" | "estudio" | "otra";
export type TerminationType = "despido" | "renuncia" | "fin_contrato" | "otro";
export type ActorRole = "owner" | "manager" | "cashier" | "viewer";

export interface StatusEvent {
  id: string;
  kind: StatusEventKind;
  subtype: string | null;
  starts_on: string; // YYYY-MM-DD
  ends_on: string | null;
  reason: string | null;
  notes?: string | null;
  deleted_at: string | null;
  created_at?: string;
  created_by?: string | null;
}

export interface StatusDetail {
  status: StaffStatus;
  event_id?: string;
  subtype?: string | null;
  since?: string;
  until?: string | null;
  reason?: string | null;
}

export const STATUS_LABEL: Record<StaffStatus, string> = {
  active: "Activo",
  suspended: "Suspendido",
  on_leave: "De licencia",
  terminated: "De baja",
};

export const LEAVE_LABEL: Record<LeaveType, string> = {
  vacaciones: "Vacaciones",
  enfermedad: "Enfermedad",
  maternidad: "Maternidad",
  paternidad: "Paternidad",
  estudio: "Estudio",
  otra: "Otra",
};

export const TERMINATION_LABEL: Record<TerminationType, string> = {
  despido: "Despido",
  renuncia: "Renuncia",
  fin_contrato: "Fin de contrato",
  otro: "Otro motivo",
};

export const EVENT_LABEL: Record<StatusEventKind, string> = {
  suspension: "Suspensión",
  leave: "Licencia",
  termination: "Baja",
  rehire: "Reingreso",
};

const PRIORITY: Record<Exclude<StatusEventKind, "rehire">, number> = {
  termination: 0,
  suspension: 1,
  leave: 2,
};

const STATUS_OF: Record<Exclude<StatusEventKind, "rehire">, StaffStatus> = {
  termination: "terminated",
  suspension: "suspended",
  leave: "on_leave",
};

/** ¿El evento rige en esa fecha? (no cancelado, desde <= fecha <= hasta). */
export function eventActiveOn(e: StatusEvent, on: string): boolean {
  return !e.deleted_at && e.starts_on <= on && (e.ends_on === null || e.ends_on >= on);
}

/** Estado efectivo en una fecha. Prioridad: baja > suspensión > licencia. */
export function effectiveStatus(events: StatusEvent[], on: string): StatusDetail {
  const candidates = events
    .filter((e) => e.kind !== "rehire" && eventActiveOn(e, on))
    .sort((a, b) => {
      const pa = PRIORITY[a.kind as keyof typeof PRIORITY];
      const pb = PRIORITY[b.kind as keyof typeof PRIORITY];
      return pa - pb || b.starts_on.localeCompare(a.starts_on);
    });
  const e = candidates[0];
  if (!e) return { status: "active" };
  return {
    status: STATUS_OF[e.kind as keyof typeof STATUS_OF],
    event_id: e.id,
    subtype: e.subtype,
    since: e.starts_on,
    until: e.ends_on,
    reason: e.reason,
  };
}

/** Eventos programados (empiezan después de la fecha), del más próximo al más lejano. */
export function upcomingEvents(events: StatusEvent[], on: string): StatusEvent[] {
  return events
    .filter((e) => !e.deleted_at && e.kind !== "rehire" && e.starts_on > on)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

export interface ManageCheck {
  actorRole: ActorRole | null;
  actorId: string | null;
  targetRole: ActorRole | null; // null = perfil sin cuenta
  targetId: string | null;
}

/** ¿El que actúa puede cambiar el estado de la persona? (espejo de staff_assert_can_manage) */
export function canManageStaff({ actorRole, actorId, targetRole, targetId }: ManageCheck): boolean {
  if (actorRole !== "owner" && actorRole !== "manager") return false;
  if (targetId && actorId && targetId === actorId) return false;
  if (targetRole === "owner") return false;
  if (targetRole === "manager" && actorRole !== "owner") return false;
  return true;
}

export type StaffAction = "suspend" | "leave" | "terminate" | "lift" | "rehire" | "transfer";

/** Acciones que tiene sentido ofrecer según el estado de hoy. */
export function availableActions(status: StaffStatus): StaffAction[] {
  switch (status) {
    case "active":
      return ["transfer", "leave", "suspend", "terminate"];
    case "suspended":
    case "on_leave":
      return ["lift", "terminate"];
    case "terminated":
      return ["rehire"];
  }
}

export interface StatusDraft {
  kind: Exclude<StatusEventKind, "rehire">;
  subtype: string | null;
  from: string;
  until: string | null;
  reason: string;
}

/** Problema del formulario en palabras, o null si se puede enviar. */
export function statusDraftProblem(d: StatusDraft, today: string, existing: StatusEvent[] = []): string | null {
  if (d.from < today) return "La fecha de inicio no puede ser anterior a hoy.";
  if (d.until && d.until < d.from) return "La fecha de vuelta tiene que ser posterior al inicio.";
  if ((d.kind === "suspension" || d.kind === "termination") && d.reason.trim().length < 3) {
    return "Escribí el motivo (queda en el historial).";
  }
  if (d.kind === "termination" && !d.subtype) return "Elegí el tipo de baja.";
  if (effectiveStatus(existing, d.from).status === "terminated") return "Esa persona ya está de baja.";
  const end = d.kind === "termination" ? null : d.until;
  const overlaps = existing.some(
    (e) =>
      !e.deleted_at &&
      e.kind === d.kind &&
      e.starts_on <= (end ?? "9999-12-31") &&
      (e.ends_on ?? "9999-12-31") >= d.from,
  );
  if (overlaps) return "Ya hay una igual en esas fechas.";
  return null;
}

/** Resultado de levantar un evento hoy: cancelado si todavía no empezó, terminado ayer si ya rige. */
export function liftOutcome(e: StatusEvent, today: string): "cancelled" | "ended" | "invalid" {
  if (e.deleted_at || e.kind === "termination" || e.kind === "rehire") return "invalid";
  if (e.ends_on !== null && e.ends_on < today) return "invalid";
  return e.starts_on >= today ? "cancelled" : "ended";
}

/** Texto corto del estado para el chip: "Licencia · hasta 20/10". */
export function statusChipText(d: StatusDetail): string {
  const base =
    d.status === "on_leave" && d.subtype && d.subtype in LEAVE_LABEL
      ? LEAVE_LABEL[d.subtype as LeaveType]
      : STATUS_LABEL[d.status];
  if (d.status !== "terminated" && d.until) {
    const [, m, day] = d.until.split("-");
    return `${base} · hasta ${day}/${m}`;
  }
  return base;
}

/** Mensaje de error del servidor en palabras. */
export function staffErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String((err as { message?: string })?.message ?? "");
  if (/cannot_change_owner/.test(msg)) return "Al dueño no se le cambia el estado.";
  if (/forbidden_manager|forbidden_role/.test(msg)) return "Sólo el dueño puede cambiar el estado de un encargado.";
  if (/cannot_change_self/.test(msg)) return "No podés cambiar tu propio estado.";
  if (/reason_required/.test(msg)) return "Falta el motivo.";
  if (/subtype_required/.test(msg)) return "Elegí el tipo de baja.";
  if (/status_overlap/.test(msg)) return "Ya hay una igual en esas fechas.";
  if (/staff_terminated/.test(msg)) return "Esa persona está de baja.";
  if (/date_in_past/.test(msg)) return "La fecha no puede ser anterior a hoy.";
  if (/invalid_dates/.test(msg)) return "Revisá las fechas.";
  if (/not_terminated/.test(msg)) return "Esa persona no está de baja.";
  if (/limit_reached/.test(msg)) return "Llegaste al máximo de usuarios de tu plan.";
  if (/use_rehire/.test(msg)) return "La baja se revierte con un reingreso.";
  if (/already_ended/.test(msg)) return "Ya había terminado.";
  if (/forbidden/.test(msg)) return "No tenés permiso para hacer esto.";
  return "No se pudo guardar.";
}
