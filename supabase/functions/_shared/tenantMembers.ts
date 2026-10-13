// =============================================================================
// Miembros de un negocio gestionados desde el panel interno (F7 · H11c,
// ADR-084). Lógica pura: la usan la Edge internal_tenant_members (Deno) y la
// tarjeta de miembros del detalle del negocio (Next). Sin imports de Deno ni
// de Node. Las reglas se repiten en la RPC internal_member_admin: la UI sólo
// oculta lo que el servidor igual rechazaría.
// =============================================================================

// Mismos topes que tenantAdmin.ts (sin import relativo: el front lo importa
// con el alias @/ y Deno exige la extensión).
const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;

export const MEMBER_ROLES = ["owner", "manager", "cashier", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

export type StaffLevel = "super_admin" | "admin" | "support" | null;

export type MemberAction =
  | "invite"
  | "resend_invite"
  | "set_role"
  | "suspend"
  | "reactivate"
  | "reset_access";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isMemberRole(v: unknown): v is MemberRole {
  return typeof v === "string" && (MEMBER_ROLES as readonly string[]).includes(v);
}

export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const r = raw.trim();
  return r.length >= MIN_REASON_LENGTH && r.length <= MAX_REASON_LENGTH ? r : null;
}

export interface InviteMemberInput {
  tenantId: string;
  email: string;
  role: MemberRole;
  displayName: string | null;
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function parseInviteMemberInput(
  body: Record<string, unknown>,
): { ok: true; value: InviteMemberInput } | { ok: false; error: string } {
  if (!isUuid(body.tenant_id)) return { ok: false, error: "missing_tenant_id" };
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: "invalid_email" };
  if (!isMemberRole(body.role)) return { ok: false, error: "invalid_role" };
  const reason = cleanReason(body.reason);
  if (!reason) return { ok: false, error: "reason_required" };
  const dn = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 80) : "";
  return {
    ok: true,
    value: {
      tenantId: body.tenant_id,
      email,
      role: body.role,
      displayName: dn || null,
      reason,
    },
  };
}

// Qué puede hacer cada nivel de staff (matriz H11: soporte sólo resetea el
// acceso; dar o quitar el rol de dueño es de super_admin).
export function canStaffDo(level: StaffLevel, action: MemberAction): boolean {
  if (action === "reset_access") return true;
  return level !== "support";
}

export function canAssignRole(level: StaffLevel, from: MemberRole, to: MemberRole): boolean {
  if (level === "support") return false;
  if (from === to) return false;
  if (from === "owner" || to === "owner") return level === "super_admin";
  return true;
}

export interface MemberRow {
  user_id: string;
  email: string;
  full_name: string | null;
  display_name: string | null;
  role: MemberRole;
  status: "active" | "suspended" | "invited" | "inactive";
  invited_at: string | null;
  joined_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  is_staff: boolean;
}

// Invitación pendiente: la cuenta nunca confirmó el email ni ingresó.
export function isInvitePending(m: Pick<MemberRow, "status" | "email_confirmed_at" | "last_sign_in_at">): boolean {
  if (m.status === "invited") return true;
  return !m.email_confirmed_at && !m.last_sign_in_at;
}

export type MemberState = "active" | "pending" | "suspended" | "inactive";

export function memberState(m: MemberRow): MemberState {
  if (m.status === "inactive") return "inactive";
  if (m.status === "suspended") return "suspended";
  if (isInvitePending(m)) return "pending";
  return "active";
}

export const MEMBER_STATE_LABELS: Record<MemberState, string> = {
  active: "Activo",
  pending: "Invitación pendiente",
  suspended: "Suspendido",
  inactive: "Dado de baja por el negocio",
};

// Acciones visibles para un miembro según el nivel del staff y el estado.
export function memberActions(
  level: StaffLevel,
  member: MemberRow,
  meId: string | null,
  activeOwners: number,
): MemberAction[] {
  if (meId && member.user_id === meId) return [];
  const state = memberState(member);
  const out: MemberAction[] = [];
  const lastOwner = member.role === "owner" && member.status === "active" && activeOwners <= 1;
  if (state === "pending" && canStaffDo(level, "resend_invite")) out.push("resend_invite");
  if (state !== "inactive" && canStaffDo(level, "set_role")) {
    const anyRole = MEMBER_ROLES.some((r) => canAssignRole(level, member.role, r));
    if (anyRole && !lastOwner) out.push("set_role");
  }
  if ((state === "active" || state === "pending") && canStaffDo(level, "suspend") && !lastOwner) {
    out.push("suspend");
  }
  if (state === "suspended" && canStaffDo(level, "reactivate")) out.push("reactivate");
  if (state !== "inactive" && state !== "pending") out.push("reset_access");
  return out;
}

export function memberErrorMessage(code: string | null | undefined): string {
  const c = String(code ?? "");
  const known: Record<string, string> = {
    forbidden: "Tu nivel de staff no permite esta acción.",
    forbidden_super_admin_only: "Dar o quitar el rol de dueño es sólo para super admin.",
    reason_required: "Escribí un motivo de al menos 5 caracteres.",
    reason_too_long: "El motivo es demasiado largo (máximo 500 caracteres).",
    cannot_change_self: "No podés modificar tu propia membresía desde el panel interno.",
    member_not_found: "La persona ya no es miembro de este negocio.",
    last_owner: "El negocio no puede quedar sin un dueño activo.",
    invalid_transition: "Esa acción no corresponde al estado actual del miembro.",
    member_terminated: "Fue dado de baja por el negocio: vuelve con Reingreso desde el panel del dueño.",
    nothing_to_update: "Ya tiene ese rol.",
    invalid_role: "Rol inválido.",
    invalid_email: "Email inválido.",
    already_member: "Ya es miembro activo de este negocio.",
    already_invited: "Ya tiene una invitación pendiente: usá Reenviar invitación.",
    member_suspended: "Está suspendido en este negocio: reactivalo en vez de invitarlo.",
    owner_exists: "El negocio ya tiene dueño. Para cambiarlo, invitá con otro rol y después cambiá el rol.",
    limit_reached: "El plan llegó al máximo de usuarios. Ajustá el límite del negocio antes de invitar.",
    already_confirmed: "La cuenta ya está confirmada: usá Resetear acceso.",
    tenant_not_found: "El negocio no existe o está dado de baja.",
    invite_failed: "No se pudo enviar la invitación.",
  };
  if (known[c]) return known[c];
  // El mensaje de PostgREST puede envolver el código: gana la clave más larga
  // ("forbidden_super_admin_only" antes que "forbidden").
  const keys = Object.keys(known).sort((a, b) => b.length - a.length);
  for (const k of keys) if (c.includes(k)) return known[k]!;
  return "No se pudo completar la acción.";
}
