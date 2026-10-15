// Aislamiento entre cuentas en el navegador (ADR-152).
//
// Un usuario puede ser miembro de varios negocios y además staff interno. La
// RLS ya acota cada consulta al negocio activo del JWT (current_tenant_id(),
// ADR-083), pero el navegador guarda resultados: la caché de React Query y el
// estado en memoria. Si el negocio activo cambia (alta de un segundo negocio,
// invitación aceptada, autocuración del claim, otra cuenta en el mismo
// navegador) o el staff pasa de /internal (ve todos los clientes) al panel de
// su negocio, lo cacheado pertenece a otro alcance y no se puede mostrar.
//
// Lo puro vive acá (testeado en tests/unit/tenantScope.test.ts); el componente
// TenantCacheGuard lo conecta a Supabase Auth y al router.

import { QueryClient } from "@tanstack/react-query";

type UserLike =
  | { id?: string | null; app_metadata?: Record<string, unknown> | null }
  | null
  | undefined;

/** Negocio activo del JWT (app_metadata.current_tenant_id) o null. */
export function activeTenantIdOf(user: UserLike): string | null {
  const v = user?.app_metadata?.current_tenant_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Filtra una consulta de `tenant_users` por el negocio activo. La RLS deja ver
 * al usuario TODAS sus membresías (las necesita para elegir negocio), así que
 * `.eq("user_id", ...).limit(1)` sin esto devuelve cualquiera de ellas: el
 * nombre, el rol o el estado de la cuenta de otro negocio.
 */
export function onlyActiveTenant<Q>(query: Q, user: UserLike): Q {
  const tenantId = activeTenantIdOf(user);
  if (!tenantId) return query;
  return (query as unknown as { eq: (c: string, v: string) => Q }).eq("tenant_id", tenantId);
}

export type CacheArea = "internal" | "app";

/** /internal manda el header de alcance interno; todo lo demás es del negocio. */
export function areaOf(pathname: string | null | undefined): CacheArea {
  return pathname === "/internal" || (pathname ?? "").startsWith("/internal/") ? "internal" : "app";
}

/**
 * La caché se parte en dos QueryClient (ver app/providers.tsx): uno para el
 * panel del negocio y otro para /internal. Lo que el staff leyó con el header
 * interno (todos los clientes) nunca lo encuentra una pantalla del negocio
 * con la misma key, ni al revés.
 */
export function createScopedQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false },
    },
  });
}

/** Cuenta dueña de lo cacheado: usuario + negocio activo del JWT. */
export interface CacheScope {
  userId: string | null;
  tenantId: string | null;
}

export function cacheScopeOf(user: UserLike): CacheScope {
  return {
    userId: (user?.id as string | null | undefined) ?? null,
    tenantId: activeTenantIdOf(user),
  };
}

export type ScopeAction = "none" | "clear" | "reload";

// Rutas que ya navegan solas después de cambiar la sesión (login, alta de
// negocio, onboarding, canje de acceso del staff): ahí alcanza con limpiar.
const SELF_NAVIGATING = [
  "/login",
  "/login-internal",
  "/signup",
  "/recover",
  "/reset-password",
  "/onboarding",
  "/auth",
];

function selfNavigating(pathname: string | null | undefined): boolean {
  const p = pathname ?? "";
  return SELF_NAVIGATING.some((r) => p === r || p.startsWith(`${r}/`));
}

/**
 * Qué hacer cuando cambia la cuenta dueña de la caché.
 * - Primera observación (prev null) o misma cuenta: nada.
 * - Se cerró la sesión, o recién se abrió (antes no había usuario): limpiar.
 * - Cambió el usuario o el negocio activo: limpiar y, si la pantalla es del
 *   panel, recargar (el estado en memoria —carrito, formularios abiertos—
 *   también es del negocio anterior). En login, alta u onboarding sólo
 *   limpiar: esas pantallas navegan solas.
 */
export function decideScopeChange(
  prev: CacheScope | null,
  next: CacheScope,
  pathname: string | null | undefined,
): ScopeAction {
  if (!prev) return "none";
  if (prev.userId === next.userId && prev.tenantId === next.tenantId) return "none";
  if (!next.userId || !prev.userId) return "clear";
  return selfNavigating(pathname) ? "clear" : "reload";
}

/**
 * Vacía la caché de React Query: cancela lo que está en vuelo (puede traer el
 * alcance anterior), borra lo inactivo y resetea lo montado (pierde los datos
 * y vuelve a pedirlos con la sesión nueva). Las mutaciones pendientes también.
 */
export async function resetScopedCache(qc: QueryClient): Promise<void> {
  qc.removeQueries({ type: "inactive" });
  qc.getMutationCache().clear();
  await qc.cancelQueries();
  await qc.resetQueries({ type: "active" });
}
