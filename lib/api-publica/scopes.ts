// API pública v1 (ADR-094): alcances (scopes) de las credenciales.
// Espejo de api_scopes_all() en 20261109400100_api_publica_credenciales.sql.

export const API_SCOPES = [
  "products:read",
  "products:write",
  "stock:read",
  "stock:write",
  "prices:write",
  "sales:read",
  "customers:read",
  "customers:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_INFO: Record<ApiScope, { label: string; desc: string }> = {
  "products:read": { label: "Leer productos", desc: "Catálogo con precio, costo y stock consolidado." },
  "products:write": { label: "Crear y editar productos", desc: "Alta y edición en lote por SKU." },
  "stock:read": { label: "Leer stock", desc: "Sucursales y stock por sucursal." },
  "stock:write": { label: "Ajustar stock", desc: "Ajustes y conteos por sucursal con motivo." },
  "prices:write": { label: "Cambiar precios", desc: "Precio y costo en lote por SKU." },
  "sales:read": { label: "Leer ventas", desc: "Ventas por rango con ítems y cobros. Sólo lectura." },
  "customers:read": { label: "Leer clientes", desc: "Datos de contacto y fiscales de los clientes." },
  "customers:write": { label: "Crear y editar clientes", desc: "Alta y edición en lote por id o id externo." },
};

export function isApiScope(s: string): s is ApiScope {
  return (API_SCOPES as readonly string[]).includes(s);
}

/** Normaliza una lista de alcances (sin repetidos, orden fijo) o null si hay alguno inválido. */
export function cleanScopes(input: readonly string[]): ApiScope[] | null {
  const set = new Set(input.map((s) => s.trim()).filter(Boolean));
  if (set.size === 0) return null;
  for (const s of set) if (!isApiScope(s)) return null;
  return API_SCOPES.filter((s) => set.has(s));
}

/**
 * Rol de integración (ADR-071 + ADR-094): lo que la API puede hacer en
 * nombre del negocio. Actúa como un encargado recortado por alcances; nunca
 * toca caja, personal, permisos, plan ni anula ventas.
 */
export const INTEGRATION_ROLE = {
  key: "integration",
  canWrite: ["products", "stock", "prices", "customers"] as const,
  readOnly: ["sales", "stores"] as const,
  never: ["cash", "staff", "permissions", "plan", "sales_write", "account_terms"] as const,
};
