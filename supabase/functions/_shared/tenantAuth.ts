// =============================================================================
// _shared/tenantAuth.ts (SEC-27)
//
// requireTenantMember: el chequeo de membresía de las Edge Functions que usan
// el tenant del JWT (app_metadata.current_tenant_id) con service_role. Antes
// cada Edge repetía getUser + claim + consulta a tenant_users; la lógica pura
// vive en tenantMember.ts (testeada con Vitest).
//
// Dos formas de uso:
//   • Todo junto:
//       const auth = await requireTenantMember(req, { respond: json });
//       if (auth instanceof Response) return auth;
//   • En dos pasos, para conservar el orden de los errores de la Edge (p. ej.
//     invalid_json va ANTES del 403 de membresía):
//       const session = await authenticateTenantUser(req, { respond: json });
//       if (session instanceof Response) return session;   // 401 / 400 no_tenant
//       …parseo del body…
//       const auth = await requireTenantMember(session, { respond: json });
//       if (auth instanceof Response) return auth;          // 403 forbidden
//
// Respuestas por defecto (las mismas que las Edges inline):
//   401 { error: "unauthorized" } · 400 { error: "no_tenant" } · 403 { error: "forbidden" }
// `respond(body, status, failure)` permite reusar el `json` de la Edge (CORS,
// headers de timing) o remapear el cuerpo; `headers` alcanza si sólo hace falta CORS.
// =============================================================================
import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  TENANT_AUTH_DENIAL,
  authOutcome,
  membershipOutcome,
  type MembershipDb,
  type TenantAuthFailure,
} from "./tenantMember.ts";

export type TenantRespond = (body: Record<string, unknown>, status: number, failure: TenantAuthFailure) => Response;

export interface TenantAuthOptions {
  /** Arma la Response de error (normalmente el `json` de la Edge). */
  respond?: TenantRespond;
  /** Headers para la Response por defecto (CORS) si no se pasa `respond`. */
  headers?: Record<string, string>;
}

export interface TenantMemberOptions extends TenantAuthOptions {
  /** Roles admitidos; sin roles, cualquier miembro activo. */
  roles?: readonly string[];
}

/** Sesión autenticada con tenant en el claim (todavía sin chequear membresía). */
export interface TenantSession {
  readonly kind: "tenant_session";
  user: User;
  tenantId: string;
  /** Cliente con el JWT del usuario (RLS). */
  userClient: SupabaseClient;
  /** Cliente service_role (saltea RLS): usar SIEMPRE con tenantId. */
  admin: SupabaseClient;
}

export interface TenantMember extends Omit<TenantSession, "kind"> {
  /** Rol en tenant_users. */
  role: string;
}

function deny(failure: TenantAuthFailure, opts: TenantAuthOptions): Response {
  const { status, body } = TENANT_AUTH_DENIAL[failure];
  if (opts.respond) return opts.respond({ ...body }, status, failure);
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...(opts.headers ?? {}), "Content-Type": "application/json" },
  });
}

/** Pasos 1-2: getUser + claim current_tenant_id. 401 / 400 no_tenant. */
export async function authenticateTenantUser(
  req: Request,
  opts: TenantAuthOptions = {},
): Promise<TenantSession | Response> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const out = authOutcome<User>(await userClient.auth.getUser());
  if (!out.ok) return deny(out.failure, opts);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  return { kind: "tenant_session", user: out.user, tenantId: out.tenantId, userClient, admin };
}

/**
 * Valida que el usuario sea miembro activo (no suspendido) del tenant de su
 * JWT. Con un Request hace todo; con una TenantSession sólo la membresía.
 * Devuelve el miembro o la Response 401 / 400 / 403 lista para retornar.
 */
export async function requireTenantMember(
  reqOrSession: Request | TenantSession,
  opts: TenantMemberOptions = {},
): Promise<TenantMember | Response> {
  const session = reqOrSession instanceof Request ? await authenticateTenantUser(reqOrSession, opts) : reqOrSession;
  if (session instanceof Response) return session;
  const res = await membershipOutcome(session.admin as unknown as MembershipDb, session.user, session.tenantId, {
    roles: opts.roles,
  });
  if (!res.ok) {
    console.warn("[tenantAuth] forbidden", res.reason);
    return deny(res.failure, opts);
  }
  const { user, tenantId, userClient, admin } = session;
  return { user, tenantId, userClient, admin, role: res.role };
}
