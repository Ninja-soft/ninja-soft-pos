// =============================================================================
// _shared/tenantMember.ts (SEC-27)
//
// Lógica pura de "¿este usuario es miembro activo del tenant de su JWT?" que
// usan las Edge Functions vía `_shared/tenantAuth.ts` (requireTenantMember).
// Sin imports de URL ni Deno.*: la prueban los tests de Vitest con un cliente
// fake.
//
// Semántica (la misma que el chequeo inline que repetían las Edges):
//   1. auth.getUser() con error o sin usuario      → "unauthorized" (401)
//   2. sin app_metadata.current_tenant_id          → "no_tenant"    (400)
//   3. sin fila tenant_users (tenant, user,
//      status = 'active')                          → "forbidden"    (403)
//   + SEC-27: usuario baneado en Auth (User.banned_until en el futuro, sin
//     consulta extra), suspendido (users.suspended_at, espejo del ban de
//     staff_admin), rol fuera de `roles` o error de lectura → "forbidden" (403).
//     Falla cerrado: si la consulta da error, no pasa.
//   Sin bypass de staff: el staff interno que no es miembro recibe 403 (un
//   acceso de staff se diseña aparte, con internal_scope() y el MFA de SEC-23).
// =============================================================================

export type TenantAuthFailure = "unauthorized" | "no_tenant" | "forbidden";

/** Motivo interno del 403 (para logs / tests; la respuesta es siempre la misma). */
export type MemberRejectReason = "banned" | "not_member" | "user_suspended" | "role_not_allowed" | "lookup_failed";

/** Respuesta por defecto de cada falla: idéntica a la que daban las Edges inline. */
export const TENANT_AUTH_DENIAL: Record<TenantAuthFailure, { status: number; body: { error: string } }> = {
  unauthorized: { status: 401, body: { error: "unauthorized" } },
  no_tenant: { status: 400, body: { error: "no_tenant" } },
  forbidden: { status: 403, body: { error: "forbidden" } },
};

export interface TenantUserLike {
  id: string;
  app_metadata?: unknown;
  /** GoTrue lo devuelve en /user; el tipo de supabase-js no siempre lo declara. */
  banned_until?: unknown;
}

/** current_tenant_id del app_metadata, o null si falta / está vacío. */
export function claimTenantId(appMetadata: unknown): string | null {
  if (!appMetadata || typeof appMetadata !== "object") return null;
  const raw = (appMetadata as { current_tenant_id?: unknown }).current_tenant_id;
  if (raw === null || raw === undefined) return null;
  const tenantId = String(raw).trim();
  return tenantId ? tenantId : null;
}

/** true si el usuario de getUser() tiene un ban de Auth vigente (banned_until futuro). */
export function isBanned(user: TenantUserLike, now: Date = new Date()): boolean {
  const raw = (user as { banned_until?: unknown }).banned_until;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const until = Date.parse(raw);
  return Number.isFinite(until) && until > now.getTime();
}

export type AuthOutcome<U extends TenantUserLike> =
  | { ok: true; user: U; tenantId: string }
  | { ok: false; failure: "unauthorized" | "no_tenant" };

/** Pasos 1 y 2: resultado de auth.getUser() → usuario + tenant del claim. */
export function authOutcome<U extends TenantUserLike>(res: {
  data: { user: U | null } | null;
  error: unknown;
}): AuthOutcome<U> {
  const user = res?.data?.user ?? null;
  if (res?.error || !user) return { ok: false, failure: "unauthorized" };
  const tenantId = claimTenantId(user.app_metadata);
  if (!tenantId) return { ok: false, failure: "no_tenant" };
  return { ok: true, user, tenantId };
}

// Forma mínima del cliente (service_role) que se necesita: from().select().eq()…maybeSingle().
type QueryResult = { data: unknown; error: unknown };
export interface MemberQuery {
  eq(column: string, value: unknown): MemberQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}
export interface MembershipDb {
  from(table: string): { select(columns: string): MemberQuery };
}

export interface MembershipOptions {
  /** Roles admitidos (p. ej. ["owner", "manager"]). Sin roles: cualquier miembro activo. */
  roles?: readonly string[];
  /** Reloj (tests). */
  now?: Date;
}

export type MembershipOutcome =
  | { ok: true; role: string }
  | { ok: false; failure: "forbidden"; reason: MemberRejectReason };

const deny = (reason: MemberRejectReason): MembershipOutcome => ({ ok: false, failure: "forbidden", reason });

/** Paso 3: usuario no baneado, membresía activa, no suspendido (+ rol). */
export async function membershipOutcome(
  db: MembershipDb,
  user: TenantUserLike,
  tenantId: string,
  opts: MembershipOptions = {},
): Promise<MembershipOutcome> {
  if (isBanned(user, opts.now)) return deny("banned");

  let mem: QueryResult;
  let usr: QueryResult;
  try {
    [mem, usr] = await Promise.all([
      db
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId)
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle(),
      db.from("users").select("suspended_at").eq("id", user.id).maybeSingle(),
    ]);
  } catch {
    return deny("lookup_failed");
  }
  if (mem.error || usr.error) return deny("lookup_failed");
  if (!mem.data) return deny("not_member");
  if ((usr.data as { suspended_at?: unknown } | null)?.suspended_at) return deny("user_suspended");
  const role = String((mem.data as { role?: unknown }).role ?? "");
  if (opts.roles && !opts.roles.includes(role)) return deny("role_not_allowed");
  return { ok: true, role };
}
