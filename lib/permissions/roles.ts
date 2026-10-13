// =============================================================================
// Permisos por rol del lado del front (ADR-071, docs/06-permissions-roles.md §4.7).
//
// Espejo de lo que hace cumplir la base (trigger role_write_guard y void_sale):
// la UI oculta o deshabilita lo que va a fallar, pero NUNCA es la única barrera.
// Funciones puras para poder testearlas sin React.
//
// Rol desconocido (null: cargando, staff interno sin membresía) => permitido.
// Es optimista como el gating de plan: no parpadea el bloqueo y la base igual
// rechaza si no corresponde.
// =============================================================================

export type TenantRole = "owner" | "manager" | "cashier" | "viewer";

export type RoleAction =
  // Catálogo: crear, editar o dar de baja productos y variantes; precios.
  | "catalog:write"
  // Categorías y marcas.
  | "catalog:taxonomy"
  // Importación masiva de productos.
  | "catalog:import"
  // Ajuste manual de stock, merma y producción.
  | "stock:adjust"
  // Clientes: alta, edición de contacto, baja.
  | "customers:create"
  | "customers:update"
  | "customers:delete"
  // Ventas: devolución/cambio y anulación (ver ctx.saleDate).
  | "sales:return"
  | "sales:void"
  // Cualquier escritura operativa (todo menos solo lectura).
  | "operate";

export interface RoleContext {
  /** Fecha de la venta (ISO o Date) para sales:void. */
  saleDate?: string | Date | null;
  /** Instante de referencia (tests). Por defecto, ahora. */
  now?: number;
}

export const HINT_MANAGER = "Requiere encargado o dueño";
export const HINT_READ_ONLY = "Tu usuario es de solo lectura";
export const HINT_VOID_PAST_DAY = "Anular ventas de días anteriores requiere encargado o dueño";

const MANAGER_ONLY: ReadonlySet<RoleAction> = new Set([
  "catalog:write",
  "catalog:taxonomy",
  "catalog:import",
  "stock:adjust",
  "customers:delete",
]);

export function normalizeRole(role: string | null | undefined): TenantRole | null {
  return role === "owner" || role === "manager" || role === "cashier" || role === "viewer" ? role : null;
}

/** Fecha calendario en Argentina (YYYY-MM-DD), UTC-3 sin horario de verano. */
export function argentinaDay(at: number | string | Date): string {
  const ms = typeof at === "number" ? at : new Date(at).getTime();
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Motivo por el que el rol NO puede hacer la acción, o null si puede.
 * El texto sirve directo como tooltip.
 */
export function deniedReason(
  role: string | null | undefined,
  action: RoleAction,
  ctx: RoleContext = {},
): string | null {
  const r = normalizeRole(role);
  if (r === null || r === "owner" || r === "manager") return null;
  if (r === "viewer") return HINT_READ_ONLY;
  // cashier
  if (MANAGER_ONLY.has(action)) return HINT_MANAGER;
  if (action === "sales:void" && ctx.saleDate) {
    const now = ctx.now ?? Date.now();
    if (argentinaDay(ctx.saleDate) !== argentinaDay(now)) return HINT_VOID_PAST_DAY;
  }
  return null;
}

export function can(role: string | null | undefined, action: RoleAction, ctx?: RoleContext): boolean {
  return deniedReason(role, action, ctx) === null;
}

export function isReadOnlyRole(role: string | null | undefined): boolean {
  return normalizeRole(role) === "viewer";
}
