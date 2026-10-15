// =============================================================================
// Lógica pura del editor de roles y permisos (ADR-138). Sin React.
// =============================================================================
import {
  BASE_LABEL,
  CAPABILITIES,
  CAPABILITY_BY_KEY,
  resolveCapabilities,
  type BaseRole,
  type BlockReason,
  type CapabilitySource,
  type Override,
  type RoleColor,
} from "./capabilities";

/** Color de cada rol: puntos y avatares, con contraste en los 4 temas. */
export const ROLE_COLOR_HEX: Record<RoleColor, string> = {
  flame: "#f26b1d",
  gold: "#d4a017",
  green: "#22a06b",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#e0457b",
  teal: "#14b8a6",
  slate: "#64748b",
};

export const ROLE_COLOR_LABEL: Record<RoleColor, string> = {
  flame: "Naranja",
  gold: "Dorado",
  green: "Verde",
  blue: "Azul",
  violet: "Violeta",
  pink: "Rosa",
  teal: "Turquesa",
  slate: "Gris",
};

export const SOURCE_LABEL: Record<CapabilitySource, string> = {
  owner: "Dueño",
  role: "Del rol",
  override: "Permiso puntual",
};

export const BLOCK_LABEL: Record<BlockReason, string> = {
  not_granted: "No la tiene",
  revoked: "Quitada a esta persona",
  missing_dependency: "Le falta una capacidad previa",
  base_too_low: "Pide un nivel base mayor",
  feature_off: "Tu plan no incluye permisos puntuales",
};

export interface RoleLike {
  id: string;
  name: string;
  base: BaseRole;
  system: boolean;
  capabilities: string[];
}

export interface PersonLike {
  base: BaseRole;
  role_id: string;
  overrides: Override[];
}

/** Lo que puede hacer una persona y de dónde sale cada cosa (mismo cálculo que la base). */
export function explainPerson(
  person: PersonLike,
  roles: readonly RoleLike[],
  featureOn: boolean,
  grantFeatures: readonly string[] = [],
) {
  const role = roles.find((r) => r.id === person.role_id) ?? null;
  return resolveCapabilities({
    base: person.base,
    roleCapabilities: role?.capabilities ?? [],
    customRole: role ? !role.system : false,
    overrides: person.overrides,
    featureOn,
    features: grantFeatures,
  });
}

/** Etiqueta de nivel para mostrar: "Nivel Cajero". */
export function baseLabel(base: BaseRole): string {
  return `Nivel ${BASE_LABEL[base]}`;
}

/** Roles que una persona puede recibir de quien asigna (espejo de _perm_assert_can_assign). */
export function assignableRoles(
  roles: readonly RoleLike[],
  opts: { actorIsOwner: boolean; actorCaps: readonly string[]; featureOn: boolean },
): RoleLike[] {
  return roles.filter((r) => {
    if (r.base === "owner") return false;
    if (!r.system && !opts.featureOn) return false;
    if (opts.actorIsOwner) return true;
    if (r.base === "manager") return false;
    return r.capabilities.every((c) => opts.actorCaps.includes(c));
  });
}

/** Nombre sugerido para un duplicado que no choque con los existentes. */
export function copyName(name: string, taken: readonly string[]): string {
  const low = new Set(taken.map((t) => t.trim().toLowerCase()));
  const base = `${name} (copia)`.slice(0, 40);
  if (!low.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${name} (copia ${i})`.slice(0, 40);
    if (!low.has(n.toLowerCase())) return n;
  }
  return base;
}

/** Cuántas capacidades sensibles (alto o crítico) trae una lista. */
export function sensitiveCount(keys: readonly string[]): number {
  return keys.filter((k) => {
    const r = CAPABILITY_BY_KEY.get(k)?.risk;
    return r === "high" || r === "critical";
  }).length;
}

/** Cantidad de capacidades editables (sin las del dueño). */
export const EDITABLE_TOTAL = CAPABILITIES.filter((c) => c.minBase !== "owner").length;

const CODES: [RegExp, string][] = [
  [/feature_not_in_plan: roles_permisos/, "Los roles a medida y los permisos puntuales vienen en el plan Business."],
  [/feature_not_in_plan: multi_sucursal/, "El rol por sucursal necesita Multi-sucursal en tu plan."],
  [/role_name_taken/, "Ya hay un rol con ese nombre."],
  [/too_many_roles/, "Llegaste al máximo de 30 roles propios."],
  [/invalid_name/, "El nombre tiene que tener entre 1 y 40 letras."],
  [/invalid_base/, "Elegí un nivel base: Encargado, Cajero o Solo lectura."],
  [/invalid_capability/, "Hay un permiso que no existe. Recargá la página."],
  [/escalation_not_allowed/, "No podés dar un rol con permisos que vos no tenés."],
  [/cannot_assign_owner/, "El rol Dueño no se asigna desde acá."],
  [/cannot_change_owner/, "Al dueño no se le cambian los permisos."],
  [/cannot_change_self/, "No podés cambiar tu propio rol."],
  [/cannot_duplicate_owner/, "El rol Dueño no se duplica."],
  [/owner_only_capability/, "Ese permiso es sólo del dueño."],
  [/capability_needs_higher_base: viewer/, "Solo lectura no puede modificar datos. Cambiale el rol a cajero o encargado."],
  [/capability_needs_higher_base/, "Ese permiso pide un nivel base más alto. Cambiale el rol primero."],
  [/no_assignment/, "Primero asignale esa sucursal en Sucursales y traslados."],
  [/invalid_reassign/, "Elegí a qué rol pasan las personas."],
  [/role_not_found/, "Ese rol ya no existe. Recargá la página."],
  [/member_not_found/, "Esa persona ya no está en el equipo."],
  [/forbidden_role/, "Sólo el dueño cambia encargados o da roles de nivel Encargado."],
  [/\bforbidden\b/, "No tenés permiso para esto."],
  [/could not find the function|PGRST202|permission_overview/i, "Falta actualizar la base para usar el editor de permisos."],
];

export function permissionErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  for (const [re, text] of CODES) if (re.test(msg)) return text;
  return "No se pudo guardar. Probá de nuevo.";
}
