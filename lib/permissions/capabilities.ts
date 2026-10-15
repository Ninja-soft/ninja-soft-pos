// =============================================================================
// Catálogo de capacidades (permisos) y roles del negocio (ADR-138).
//
// FUENTE ÚNICA EN CÓDIGO. La migración 20261204100100_permisos_capacidades
// siembra la tabla permission_capabilities y los roles de sistema con estos
// mismos datos; tests/unit/permissionsCatalog.test.ts compara la migración con
// este archivo y falla si se separan.
//
// Reglas:
//   · Una capacidad pertenece a un módulo, tiene un nivel (ver, operar,
//     administrar), un riesgo y dependencias directas (depends_on). Sólo es
//     efectiva si TODAS sus dependencias (transitivas) también lo son.
//   · min_base: nivel base mínimo del rol para que la capacidad cuente. Las
//     capacidades de "owner" son del dueño y no se conceden a nadie más.
//   · enforced: "server" = la base la hace cumplir con has_capability();
//     "ui" = organiza la pantalla (los datos del negocio los lee cualquier
//     miembro por su sucursal, ADR-045).
//   · grantFeature: feature del plan con la que el dueño puede dar o quitar
//     esta capacidad a una persona (permiso puntual) aunque el plan no tenga
//     roles_permisos. Son las "otorgables" de Inventario (ADR-137): sin
//     ella, los permisos puntuales piden roles_permisos.
//   · optIn: no entra con los niveles del modo simple ni en la plantilla de
//     Encargado; se suma aparte (aprobar ajustes y configurar la aprobación).
//   · El dueño tiene todo, siempre. Los roles de sistema reproducen 1 a 1 lo
//     que hoy hace cumplir la base por rol (docs/06-permissions-roles.md §4.7).
//     Inventario (ADR-137) usa este mismo catálogo: no hay otro.
//
// Funciones puras (sin React ni Supabase) para testearlas.
// =============================================================================

export type BaseRole = "owner" | "manager" | "cashier" | "viewer";
export type CapabilityLevel = "view" | "operate" | "admin";
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type Enforcement = "server" | "ui";

export type ModuleKey =
  | "ventas"
  | "caja"
  | "productos"
  | "stock"
  | "clientes"
  | "compras"
  | "finanzas"
  | "reportes"
  | "configuracion"
  | "equipo"
  | "integraciones";

export interface CapabilityDef {
  key: string;
  module: ModuleKey;
  label: string;
  description: string;
  level: CapabilityLevel;
  risk: CapabilityRisk;
  dependsOn: string[];
  minBase: BaseRole;
  enforced: Enforcement;
  grantFeature: string | null;
  optIn: boolean;
}

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  description: string;
  icon: string;
}

export const MODULES: readonly ModuleDef[] = [
  { key: "ventas", label: "Ventas", description: "Cobrar, anular y devolver.", icon: "shopping-cart" },
  { key: "caja", label: "Caja", description: "Turnos, ingresos y retiros.", icon: "wallet" },
  { key: "productos", label: "Productos", description: "Catálogo y precios.", icon: "package" },
  { key: "stock", label: "Stock", description: "Existencias, ajustes y conteos.", icon: "boxes" },
  { key: "clientes", label: "Clientes", description: "Alta, edición y baja de clientes.", icon: "users" },
  { key: "compras", label: "Compras", description: "Proveedores y compras.", icon: "truck" },
  { key: "finanzas", label: "Finanzas", description: "Tesorería, impuestos y contabilidad.", icon: "landmark" },
  { key: "reportes", label: "Reportes", description: "Números del negocio, costos y auditoría.", icon: "bar-chart" },
  { key: "configuracion", label: "Configuración", description: "Ajustes del POS, seguridad y plan.", icon: "settings" },
  { key: "equipo", label: "Equipo", description: "Personal, roles y permisos.", icon: "user-cog" },
  { key: "integraciones", label: "Integraciones", description: "Logísticas y medios de pago.", icon: "plug" },
] as const;

const cap = (
  key: string,
  module: ModuleKey,
  label: string,
  description: string,
  level: CapabilityLevel,
  risk: CapabilityRisk,
  dependsOn: string[] = [],
  minBase: BaseRole = "cashier",
  enforced: Enforcement = "server",
  extra: { grantFeature?: string; optIn?: boolean } = {},
): CapabilityDef => ({
  key,
  module,
  label,
  description,
  level,
  risk,
  dependsOn,
  minBase,
  enforced,
  grantFeature: extra.grantFeature ?? null,
  optIn: extra.optIn ?? false,
});

// Inventario (ADR-137): otorgables por persona en todo plan con ajustes_stock
// (BASE); aprobar y configurar la aprobación, con aprobacion_ajustes.
const INV = { grantFeature: "ajustes_stock" };
const INV_APPROVAL = { grantFeature: "aprobacion_ajustes", optIn: true };

// El orden de este arreglo es el orden en pantalla (sort de la tabla).
export const CAPABILITIES: readonly CapabilityDef[] = [
  // Ventas
  cap("sales.view", "ventas", "Ver ventas", "Ver el listado y el detalle de las ventas de sus sucursales.", "view", "low", [], "viewer", "ui"),
  cap("sales.create", "ventas", "Vender y cobrar", "Cobrar ventas en el POS dentro de su turno de caja.", "operate", "medium", ["sales.view", "products.view"]),
  cap("sales.void", "ventas", "Anular ventas del día", "Anular una venta de hoy: vuelve el stock y sale la plata de la caja.", "operate", "high", ["sales.view"]),
  cap("sales.void.past_days", "ventas", "Anular ventas de días anteriores", "Anular ventas de otros días (hora de Argentina). Toca cierres ya hechos.", "admin", "critical", ["sales.void"]),
  cap("sales.return", "ventas", "Devoluciones y cambios", "Registrar devoluciones, cambios y reintegros de una venta.", "operate", "high", ["sales.view"]),
  // Caja
  cap("cash.view", "caja", "Ver cajas y turnos", "Ver las cajas, los turnos y los cierres de sus sucursales.", "view", "low", [], "viewer", "ui"),
  cap("cash.open", "caja", "Abrir turno de caja", "Abrir su propio turno en una caja de su sucursal.", "operate", "medium", ["cash.view"]),
  cap("cash.close", "caja", "Cerrar turno de caja", "Cerrar su turno con el arqueo y el cierre Z.", "operate", "medium", ["cash.open"]),
  cap("cash.movements", "caja", "Ingresos y retiros de caja", "Cargar ingresos y retiros de plata en su turno.", "operate", "high", ["cash.open"]),
  // Productos
  cap("products.view", "productos", "Ver productos y precios", "Ver el catálogo, las variantes y los precios.", "view", "low", [], "viewer", "ui"),
  cap("products.edit", "productos", "Crear y editar productos", "Alta, edición y baja de productos, variantes, categorías y marcas.", "admin", "medium", ["products.view"]),
  cap("products.price", "productos", "Cambiar precios y costos", "Cambiar el precio de venta y el costo de un producto.", "admin", "high", ["products.edit"]),
  cap("prices.manage", "productos", "Listas de precios y cambios masivos", "Listas de precios, escalas, condiciones de pago y aumentos masivos.", "admin", "high", ["products.price"]),
  // Stock
  cap("stock.view", "stock", "Ver stock e inventario", "Stock por sucursal y depósito, movimientos e historial de ajustes.", "view", "low", [], "viewer", "server"),
  cap("stock.valuation", "stock", "Ver costos y valuación del stock", "Costo de cada producto, valor del stock y valor de cada ajuste.", "admin", "medium", ["stock.view"], "viewer", "server", INV),
  cap("stock.export", "stock", "Exportar planillas de stock", "Descargar el stock en Excel y la planilla para contar.", "operate", "low", ["stock.view"], "viewer", "ui", INV),
  cap("stock.adjust", "stock", "Ajustar stock a mano", "Sumar, restar o fijar stock con motivo, mermas y producción. Desde el umbral, queda pendiente de aprobación.", "admin", "high", ["stock.view"], "cashier", "server", INV),
  cap("stock.count", "stock", "Contar stock", "Conteos cíclicos y ajustes con motivo Conteo (inventario físico), aunque no pueda hacer otros ajustes.", "operate", "medium", ["stock.view"], "cashier", "server", INV),
  cap("stock.import", "stock", "Importar ajustes y conteos desde Excel", "Carga rápida desde la planilla. Además pide la importación desde Excel en el plan.", "admin", "high", ["stock.view"], "manager", "server", INV),
  cap("stock.adjust.approve", "stock", "Aprobar ajustes de stock", "Aprobar o rechazar los ajustes pendientes que cargó otra persona (auditor de inventario).", "admin", "critical", ["stock.view"], "cashier", "server", INV_APPROVAL),
  cap("stock.settings", "stock", "Configurar la aprobación de ajustes", "Prender la aprobación, el umbral, la foto obligatoria y quién aprueba.", "admin", "high", ["stock.view"], "cashier", "server", INV_APPROVAL),
  // Clientes
  cap("customers.view", "clientes", "Ver clientes", "Ver la lista y la ficha de los clientes.", "view", "low", [], "viewer", "ui"),
  cap("customers.create", "clientes", "Dar de alta clientes", "Crear clientes nuevos desde Clientes o desde el POS.", "operate", "low", ["customers.view"]),
  cap("customers.edit", "clientes", "Editar clientes", "Cambiar datos de contacto y fiscales de un cliente.", "operate", "low", ["customers.view"]),
  cap("customers.delete", "clientes", "Dar de baja clientes", "Dar de baja un cliente (queda en la historia).", "admin", "medium", ["customers.edit"]),
  // Compras
  cap("purchases.manage", "compras", "Compras y proveedores", "Cargar compras, proveedores, recepciones y costos de compra.", "admin", "high", ["products.view"], "manager"),
  // Finanzas
  cap("treasury.manage", "finanzas", "Tesorería", "Cuentas, cheques, pagos y cobranzas de tesorería.", "admin", "high", [], "manager"),
  cap("taxes.manage", "finanzas", "Impuestos", "Regímenes, alícuotas, percepciones y retenciones del negocio.", "admin", "high", [], "manager"),
  cap("accounting.manage", "finanzas", "Contabilidad", "Plan de cuentas, asientos y períodos contables.", "admin", "high", [], "manager"),
  // Reportes
  cap("reports.view", "reportes", "Ver reportes", "Ver los reportes de ventas, caja y stock de sus sucursales.", "view", "low", [], "viewer", "ui"),
  cap("reports.costs", "reportes", "Ver costos y márgenes", "Ver márgenes, costo de lo vendido y alertas de margen.", "admin", "medium", ["reports.view"], "viewer"),
  cap("audit.view", "reportes", "Ver la auditoría", "Ver quién hizo qué en el negocio (no sólo lo propio).", "admin", "medium", [], "viewer"),
  // Configuración
  cap("config.edit", "configuracion", "Editar la configuración del POS", "Topes de descuento, venta sin stock, tickets y reglas del POS.", "admin", "critical", [], "manager"),
  cap("config.security", "configuracion", "Seguridad y PIN de supervisor", "Quién autoriza con PIN y qué acciones lo piden.", "admin", "critical", [], "owner"),
  cap("billing.manage", "configuracion", "Plan y suscripción", "Cambiar el plan, pagar y ceder la titularidad.", "admin", "critical", [], "owner"),
  // Equipo
  cap("team.view", "equipo", "Ver el equipo", "Ver quién trabaja en el negocio y en qué sucursal.", "view", "low", [], "viewer", "ui"),
  cap("team.manage", "equipo", "Invitar y gestionar personal", "Invitar, editar, suspender y asignar roles (nunca más permisos que los propios).", "admin", "critical", ["team.view"], "manager"),
  cap("team.roles", "equipo", "Crear y editar roles", "Crear roles, cambiar sus permisos y dar permisos puntuales.", "admin", "critical", ["team.manage"], "owner"),
  // Integraciones
  cap("integrations.manage", "integraciones", "Conectar logísticas y medios de pago", "Credenciales de logísticas y comisiones de los medios de pago.", "admin", "high", [], "manager"),
] as const;

export const CAPABILITY_BY_KEY: ReadonlyMap<string, CapabilityDef> = new Map(CAPABILITIES.map((c) => [c.key, c]));

export const LEVEL_LABEL: Record<CapabilityLevel, string> = { view: "Ver", operate: "Operar", admin: "Administrar" };
export const RISK_LABEL: Record<CapabilityRisk, string> = { low: "Bajo", medium: "Medio", high: "Alto", critical: "Crítico" };
export const BASE_LABEL: Record<BaseRole, string> = { owner: "Dueño", manager: "Encargado", cashier: "Cajero", viewer: "Solo lectura" };

const BASE_RANK: Record<BaseRole, number> = { viewer: 0, cashier: 1, manager: 2, owner: 3 };

export function baseAllows(base: BaseRole, minBase: BaseRole): boolean {
  return BASE_RANK[base] >= BASE_RANK[minBase];
}

/** Dependencias transitivas de una capacidad (sin ella misma), en orden estable. */
export function requiresAll(key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([key]);
  const stack = [...(CAPABILITY_BY_KEY.get(key)?.dependsOn ?? [])];
  while (stack.length) {
    const k = stack.shift()!;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    stack.push(...(CAPABILITY_BY_KEY.get(k)?.dependsOn ?? []));
  }
  return out.sort();
}

/** Capacidades que dependen (directa o indirectamente) de esta. */
export function dependents(key: string): string[] {
  return CAPABILITIES.filter((c) => requiresAll(c.key).includes(key)).map((c) => c.key);
}

// -----------------------------------------------------------------------------
// Roles de sistema
// -----------------------------------------------------------------------------

export type SystemRoleKey = "owner" | "manager" | "cashier" | "viewer" | "seller" | "auditor";

export interface SystemRoleDef {
  key: SystemRoleKey;
  /** uuid fijo, igual en la migración. */
  id: string;
  name: string;
  description: string;
  base: BaseRole;
  color: RoleColor;
  icon: RoleIcon;
  capabilities: string[];
}

export const ROLE_COLORS = ["flame", "gold", "green", "blue", "violet", "pink", "teal", "slate"] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];
export const ROLE_ICONS = ["crown", "shield", "store", "eye", "tag", "search", "user", "wrench", "truck", "calculator"] as const;
export type RoleIcon = (typeof ROLE_ICONS)[number];

const ALL_KEYS = CAPABILITIES.map((c) => c.key);
const VIEW_KEYS = CAPABILITIES.filter((c) => c.level === "view" && c.minBase === "viewer").map((c) => c.key);

// Encargado: todo lo que no es del dueño, salvo la configuración del POS y lo
// que se suma aparte (aprobar ajustes y configurar la aprobación).
const MANAGER_CAPS = CAPABILITIES.filter((c) => c.minBase !== "owner" && c.key !== "config.edit" && !c.optIn).map((c) => c.key);
const CASHIER_CAPS = [
  "sales.view", "sales.create", "sales.void", "sales.return",
  "cash.view", "cash.open", "cash.close", "cash.movements",
  "products.view", "stock.view",
  "customers.view", "customers.create", "customers.edit",
  "reports.view", "team.view",
];
const VIEWER_CAPS = ["sales.view", "cash.view", "products.view", "stock.view", "stock.valuation", "stock.export", "customers.view", "reports.view", "team.view"];
const SELLER_CAPS = ["sales.view", "products.view", "stock.view", "customers.view", "customers.create", "customers.edit", "team.view"];
const AUDITOR_CAPS = [...VIEW_KEYS, "stock.valuation", "stock.export", "reports.costs", "audit.view"];

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  { key: "owner", id: "00000000-0000-4000-8000-0000000000a1", name: "Dueño", description: "Todo el negocio, siempre. No se edita.", base: "owner", color: "flame", icon: "crown", capabilities: ALL_KEYS },
  { key: "manager", id: "00000000-0000-4000-8000-0000000000a2", name: "Encargado", description: "Opera todo el negocio salvo la configuración del POS, la seguridad y el plan.", base: "manager", color: "gold", icon: "shield", capabilities: MANAGER_CAPS },
  { key: "cashier", id: "00000000-0000-4000-8000-0000000000a3", name: "Cajero", description: "Vende y cobra en su turno, anula ventas del día y hace devoluciones.", base: "cashier", color: "blue", icon: "store", capabilities: CASHIER_CAPS },
  { key: "viewer", id: "00000000-0000-4000-8000-0000000000a4", name: "Solo lectura", description: "Mira ventas, caja, stock y reportes. No cambia nada.", base: "viewer", color: "slate", icon: "eye", capabilities: VIEWER_CAPS },
  { key: "seller", id: "00000000-0000-4000-8000-0000000000a5", name: "Vendedor", description: "Atiende y arma pedidos para que cobre la caja. No abre caja, no cobra ni anula.", base: "cashier", color: "green", icon: "tag", capabilities: SELLER_CAPS },
  { key: "auditor", id: "00000000-0000-4000-8000-0000000000a6", name: "Auditor", description: "Mira todo, incluso costos y auditoría, sin tocar nada.", base: "viewer", color: "violet", icon: "search", capabilities: AUDITOR_CAPS },
] as const;

export const SYSTEM_ROLE_BY_KEY: ReadonlyMap<string, SystemRoleDef> = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));
export const SYSTEM_ROLE_BY_ID: ReadonlyMap<string, SystemRoleDef> = new Map(SYSTEM_ROLES.map((r) => [r.id, r]));

/** Rol de sistema que corresponde a un nivel base (owner, manager, cashier, viewer). */
export function systemRoleForBase(base: BaseRole): SystemRoleDef {
  return SYSTEM_ROLE_BY_KEY.get(base)!;
}

// -----------------------------------------------------------------------------
// Resolución de capacidades efectivas (espejo de capabilities_for en SQL)
// -----------------------------------------------------------------------------

export type CapabilitySource = "role" | "override" | "owner";
export type BlockReason = "missing_dependency" | "base_too_low" | "revoked" | "feature_off" | "not_granted";

export interface Override {
  capability: string;
  effect: "grant" | "revoke";
}

export interface ResolveInput {
  base: BaseRole;
  /** Capacidades del rol (de sistema o personalizado). */
  roleCapabilities: readonly string[];
  /** El rol asignado es personalizado (necesita la feature roles_permisos). */
  customRole?: boolean;
  overrides?: readonly Override[];
  /** Plan con roles_permisos. Sin la feature: rol personalizado cae a su nivel base y no hay overrides. */
  featureOn?: boolean;
  /**
   * Features del plan prendidas (las grantFeature del catálogo). Sin
   * roles_permisos, un permiso puntual cuenta si su capacidad tiene
   * grantFeature y el plan la tiene (otorgables de Inventario, ADR-137).
   */
  features?: Iterable<string>;
}

/** ¿Cuenta un permiso puntual de esta capacidad con este plan? (espejo de capabilities_for). */
export function overrideAllowed(capability: string, featureOn: boolean, features?: Iterable<string>): boolean {
  if (featureOn) return true;
  const gf = CAPABILITY_BY_KEY.get(capability)?.grantFeature;
  if (!gf || !features) return false;
  for (const f of features) if (f === gf) return true;
  return false;
}

export interface EffectiveCapability {
  key: string;
  granted: boolean;
  source: CapabilitySource | null;
  blocked: BlockReason | null;
  /** Dependencias que faltan (si blocked = missing_dependency). */
  missing: string[];
}

export interface ResolveResult {
  effective: Set<string>;
  detail: Map<string, EffectiveCapability>;
  /** Rol que realmente cuenta (puede caer al de sistema sin la feature). */
  usedSystemFallback: boolean;
}

export function resolveCapabilities(input: ResolveInput): ResolveResult {
  const featureOn = input.featureOn ?? true;
  const detail = new Map<string, EffectiveCapability>();
  if (input.base === "owner") {
    for (const k of ALL_KEYS) detail.set(k, { key: k, granted: true, source: "owner", blocked: null, missing: [] });
    return { effective: new Set(ALL_KEYS), detail, usedSystemFallback: false };
  }
  const fallback = Boolean(input.customRole) && !featureOn;
  const roleCaps = new Set(fallback ? systemRoleForBase(input.base).capabilities : input.roleCapabilities);
  const granted = new Set<string>();
  const source = new Map<string, CapabilitySource>();
  for (const k of roleCaps) {
    if (!CAPABILITY_BY_KEY.has(k)) continue;
    granted.add(k);
    source.set(k, "role");
  }
  const revoked = new Set<string>();
  const features = input.features ? [...input.features] : undefined;
  // Permisos puntuales: con roles_permisos, todos; sin ella, sólo los de
  // capacidades con grantFeature prendida en el plan.
  for (const o of input.overrides ?? []) {
    if (!CAPABILITY_BY_KEY.has(o.capability)) continue;
    if (!overrideAllowed(o.capability, featureOn, features)) continue;
    if (o.effect === "grant") {
      granted.add(o.capability);
      source.set(o.capability, "override");
    } else {
      revoked.add(o.capability);
    }
  }
  for (const k of revoked) granted.delete(k);
  // min_base: lo que pide un nivel mayor no cuenta (las de dueño, nunca).
  const allowed = new Set([...granted].filter((k) => baseAllows(input.base, CAPABILITY_BY_KEY.get(k)!.minBase)));
  const effective = new Set([...allowed].filter((k) => requiresAll(k).every((d) => allowed.has(d))));
  for (const c of CAPABILITIES) {
    const k = c.key;
    let blocked: BlockReason | null = null;
    let missing: string[] = [];
    if (!effective.has(k)) {
      if (revoked.has(k)) blocked = "revoked";
      else if (!granted.has(k)) {
        const overridden = (input.overrides ?? []).some((o) => o.capability === k && o.effect === "grant");
        blocked = overridden && !overrideAllowed(k, featureOn, features) ? "feature_off" : "not_granted";
      } else if (!baseAllows(input.base, c.minBase)) blocked = "base_too_low";
      else {
        blocked = "missing_dependency";
        missing = requiresAll(k).filter((d) => !allowed.has(d));
      }
    }
    detail.set(k, {
      key: k,
      granted: effective.has(k),
      source: effective.has(k) ? (source.get(k) ?? "role") : null,
      blocked,
      missing,
    });
  }
  return { effective, detail, usedSystemFallback: fallback };
}

// -----------------------------------------------------------------------------
// Edición: activar o desactivar resolviendo dependencias
// -----------------------------------------------------------------------------

export interface ToggleResult {
  next: string[];
  /** Capacidades que se prendieron solas (dependencias). */
  addedDeps: string[];
  /** Capacidades que se apagaron solas (dependían de la que se apagó). */
  removedDependents: string[];
}

/** Prende (con sus dependencias) o apaga (con lo que depende de ella) una capacidad. */
export function toggleCapability(current: readonly string[], key: string, on: boolean, base: BaseRole): ToggleResult {
  const set = new Set(current);
  const addedDeps: string[] = [];
  const removedDependents: string[] = [];
  if (on) {
    for (const d of requiresAll(key)) {
      if (!set.has(d)) {
        set.add(d);
        addedDeps.push(d);
      }
    }
    set.add(key);
  } else {
    set.delete(key);
    for (const d of dependents(key)) {
      if (set.delete(d)) removedDependents.push(d);
    }
  }
  const next = CAPABILITIES.filter((c) => set.has(c.key) && baseAllows(base, c.minBase)).map((c) => c.key);
  return { next, addedDeps: addedDeps.filter((k) => next.includes(k)), removedDependents };
}

/** Normaliza una lista: sólo claves conocidas, permitidas por el nivel, con dependencias completas. */
export function normalizeCapabilities(list: readonly string[], base: BaseRole): string[] {
  const set = new Set(list.filter((k) => CAPABILITY_BY_KEY.has(k)));
  for (const k of [...set]) for (const d of requiresAll(k)) set.add(d);
  return CAPABILITIES.filter((c) => set.has(c.key) && baseAllows(base, c.minBase)).map((c) => c.key);
}

// -----------------------------------------------------------------------------
// Modo simple: niveles por módulo (Ver / Operar / Administrar)
// -----------------------------------------------------------------------------

export type ModuleLevel = "none" | CapabilityLevel;
const LEVEL_ORDER: ModuleLevel[] = ["none", "view", "operate", "admin"];

export function capabilitiesOfModule(module: ModuleKey): CapabilityDef[] {
  return CAPABILITIES.filter((c) => c.module === module);
}

/** Niveles que tiene un módulo (hay módulos sin "Operar", p. ej. Compras). */
export function levelsOfModule(module: ModuleKey): CapabilityLevel[] {
  const present = new Set(capabilitiesOfModule(module).map((c) => c.level));
  return (["view", "operate", "admin"] as const).filter((l) => present.has(l));
}

/** Nivel del módulo: el más alto con todas sus capacidades (y las de abajo) prendidas. */
export function moduleLevel(caps: readonly string[], module: ModuleKey, base: BaseRole): ModuleLevel {
  const set = new Set(caps);
  let lvl: ModuleLevel = "none";
  for (const l of ["view", "operate", "admin"] as const) {
    const need = capabilitiesOfModule(module).filter(
      (c) =>
        LEVEL_ORDER.indexOf(c.level) <= LEVEL_ORDER.indexOf(l) &&
        baseAllows(base, c.minBase) &&
        c.minBase !== "owner" &&
        !c.optIn,
    );
    const atLevel = need.filter((c) => c.level === l);
    if (atLevel.length === 0) continue;
    if (need.every((c) => set.has(c.key))) lvl = l;
    else break;
  }
  return lvl;
}

/** ¿Hay capacidades prendidas por encima del nivel calculado? (nivel "a medida"). */
export function moduleIsPartial(caps: readonly string[], module: ModuleKey, base: BaseRole): boolean {
  const lvl = moduleLevel(caps, module, base);
  const set = new Set(caps);
  return capabilitiesOfModule(module).some(
    (c) => set.has(c.key) && LEVEL_ORDER.indexOf(c.level) > LEVEL_ORDER.indexOf(lvl),
  );
}

/** Lleva un módulo a un nivel: prende todo hasta ese nivel y apaga lo de arriba. */
export function setModuleLevel(caps: readonly string[], module: ModuleKey, level: ModuleLevel, base: BaseRole): string[] {
  const set = new Set(caps);
  const removed: string[] = [];
  for (const c of capabilitiesOfModule(module)) {
    if (c.minBase === "owner") continue;
    const within = level !== "none" && LEVEL_ORDER.indexOf(c.level) <= LEVEL_ORDER.indexOf(level);
    // Lo que se suma aparte no lo prende el nivel; sólo se apaga al bajar.
    if (c.optIn && within) continue;
    if (within && baseAllows(base, c.minBase)) set.add(c.key);
    else if (set.delete(c.key)) removed.push(c.key);
  }
  // Lo que dependía de lo apagado (también de otros módulos) se apaga; lo
  // prendido suma sus dependencias.
  for (const r of removed) for (const d of dependents(r)) set.delete(d);
  return normalizeCapabilities([...set], base);
}

// -----------------------------------------------------------------------------
// Comparar roles
// -----------------------------------------------------------------------------

export interface RoleDiffRow {
  key: string;
  inA: boolean;
  inB: boolean;
}

export function compareRoles(a: readonly string[], b: readonly string[]): { onlyA: string[]; onlyB: string[]; both: string[]; rows: RoleDiffRow[] } {
  const A = new Set(a);
  const B = new Set(b);
  const rows = CAPABILITIES.map((c) => ({ key: c.key, inA: A.has(c.key), inB: B.has(c.key) }));
  return {
    onlyA: rows.filter((r) => r.inA && !r.inB).map((r) => r.key),
    onlyB: rows.filter((r) => r.inB && !r.inA).map((r) => r.key),
    both: rows.filter((r) => r.inA && r.inB).map((r) => r.key),
    rows,
  };
}

/** Riesgo más alto de una lista (para avisar al guardar). */
export function maxRisk(keys: readonly string[]): CapabilityRisk | null {
  const order: CapabilityRisk[] = ["low", "medium", "high", "critical"];
  let best = -1;
  for (const k of keys) {
    const r = CAPABILITY_BY_KEY.get(k)?.risk;
    if (r) best = Math.max(best, order.indexOf(r));
  }
  return best < 0 ? null : (order[best] ?? null);
}

/** Búsqueda sin acentos ni mayúsculas sobre etiqueta, descripción, clave y módulo. */
export function searchCapabilities(term: string, list: readonly CapabilityDef[] = CAPABILITIES): CapabilityDef[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const t = norm(term.trim());
  if (!t) return [...list];
  const modLabel = new Map(MODULES.map((m) => [m.key, m.label]));
  return list.filter((c) => norm(`${c.label} ${c.description} ${c.key} ${modLabel.get(c.module) ?? ""}`).includes(t));
}

// -----------------------------------------------------------------------------
// Pantallas que preguntan por una capacidad (Inventario, ADR-137)
// -----------------------------------------------------------------------------

/**
 * ¿Puede? Con las capacidades efectivas cargadas (my_capabilities), lo que
 * diga el servidor; mientras cargan, las del rol de sistema de su nivel. Sin
 * rol (cargando o sin membresía), no. La base revalida cada acción.
 */
export function capabilityAllowed(
  base: BaseRole | null,
  effective: readonly string[] | null | undefined,
  cap: string,
): boolean {
  if (base === null) return false;
  if (base === "owner") return true;
  if (effective) return effective.includes(cap);
  return systemRoleForBase(base).capabilities.includes(cap);
}

/**
 * Motivo por el que el dueño no le puede dar esta capacidad a alguien de ese
 * nivel como permiso puntual, o null si puede (espejo de
 * permission_override_set y de min_base en capabilities_for).
 */
export function grantBlockedReason(base: BaseRole | null, cap: string): string | null {
  const def = CAPABILITY_BY_KEY.get(cap);
  if (!def) return "Permiso desconocido.";
  if (base === null) return "No es miembro activo del negocio.";
  if (base === "owner") return "El dueño ya tiene todos los permisos.";
  if (def.minBase === "owner") return "Sólo el dueño.";
  if (!baseAllows(base, def.minBase)) {
    return base === "viewer"
      ? "Solo lectura no puede modificar datos. Cambiale el rol a cajero o encargado."
      : `Pide nivel base ${BASE_LABEL[def.minBase]}.`;
  }
  return null;
}
