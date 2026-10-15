// =============================================================================
// Catálogo de capacidades por miembro (ADR-137, docs/06-permissions-roles.md
// §4.8). Espejo de la base (migración 20261203100100):
//   · capability_catalog()       = CAPABILITY_KEYS
//   · capability_role_default()  = ROLE_CAPABILITIES
//   · member_has_capability()    = rol + otorgadas (tabla member_capabilities)
//
// Una capacidad se SUMA al rol: el dueño las tiene todas; al resto se le
// otorgan con member_capability_set (sólo el dueño, auditado). El editor de
// roles y permisos (rama feat/permisos-editor) toma este catálogo: grupos,
// etiquetas y descripciones salen de acá, y para guardar escribe
// otorgamientos con la misma RPC. El servidor nunca confía en la UI: cada RPC
// vuelve a preguntar member_has_capability.
//
// Funciones puras para poder testearlas sin React.
// =============================================================================

import { normalizeRole, type TenantRole } from "./roles";

export const CAPABILITY_KEYS = [
  "stock.view",
  "stock.valuation",
  "stock.export",
  "stock.adjust",
  "stock.count",
  "stock.import",
  "stock.adjust.approve",
  "stock.settings",
] as const;

export type Capability = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityInfo {
  key: Capability;
  /** Grupo del editor de permisos. */
  group: "inventario";
  label: string;
  description: string;
  /** Escribe datos: no se le puede dar a "Solo lectura" (ADR-071). */
  writes: boolean;
}

export const CAPABILITY_GROUP_LABEL: Record<CapabilityInfo["group"], string> = {
  inventario: "Inventario",
};

export const CAPABILITIES: readonly CapabilityInfo[] = [
  {
    key: "stock.view",
    group: "inventario",
    label: "Ver stock e inventario",
    description: "Stock por sucursal y depósito, movimientos e historial de ajustes.",
    writes: false,
  },
  {
    key: "stock.valuation",
    group: "inventario",
    label: "Ver costos y valuación",
    description: "Costo de cada producto, valor del stock y valor de cada ajuste.",
    writes: false,
  },
  {
    key: "stock.export",
    group: "inventario",
    label: "Exportar planillas de stock",
    description: "Descargar el stock en Excel y la planilla para contar.",
    writes: false,
  },
  {
    key: "stock.adjust",
    group: "inventario",
    label: "Hacer ajustes de stock",
    description: "Sumar, restar o fijar stock con motivo. Desde el umbral, queda pendiente de aprobación.",
    writes: true,
  },
  {
    key: "stock.count",
    group: "inventario",
    label: "Cargar conteos",
    description: "Ajustes con motivo Conteo (inventario físico), aunque no pueda hacer otros ajustes.",
    writes: true,
  },
  {
    key: "stock.import",
    group: "inventario",
    label: "Importar ajustes y conteos desde Excel",
    description: "Carga rápida desde la planilla. Además pide la importación desde Excel en el plan.",
    writes: true,
  },
  {
    key: "stock.adjust.approve",
    group: "inventario",
    label: "Aprobar ajustes (auditor)",
    description: "Aprueba o rechaza los ajustes pendientes de otros cuando el dueño eligió que aprueben los auditores.",
    writes: true,
  },
  {
    key: "stock.settings",
    group: "inventario",
    label: "Configurar la aprobación de ajustes",
    description: "Prender la aprobación, el umbral y quiénes son auditores.",
    writes: true,
  },
];

/** Lo que trae cada rol sin otorgar nada (espejo de capability_role_default). */
export const ROLE_CAPABILITIES: Record<TenantRole, readonly Capability[]> = {
  owner: CAPABILITY_KEYS,
  manager: ["stock.view", "stock.valuation", "stock.export", "stock.adjust", "stock.count", "stock.import"],
  cashier: ["stock.view"],
  viewer: ["stock.view", "stock.valuation", "stock.export"],
};

/** Conjunto de capacidades que hace a alguien "auditor" de inventario. */
export const AUDITOR_PRESET: readonly Capability[] = ["stock.view", "stock.valuation", "stock.adjust.approve"];

export function isCapability(v: string): v is Capability {
  return (CAPABILITY_KEYS as readonly string[]).includes(v);
}

export function capabilityInfo(key: Capability): CapabilityInfo {
  return CAPABILITIES.find((c) => c.key === key)!;
}

/** Capacidades efectivas: las del rol más las otorgadas (ordenadas como el catálogo). */
export function effectiveCapabilities(
  role: string | null | undefined,
  granted: readonly string[] = [],
): Capability[] {
  const r = normalizeRole(role);
  if (r === null) return [];
  const set = new Set<string>([...ROLE_CAPABILITIES[r], ...granted]);
  return CAPABILITY_KEYS.filter((k) => set.has(k));
}

export function hasCapability(
  role: string | null | undefined,
  granted: readonly string[],
  cap: Capability,
): boolean {
  return effectiveCapabilities(role, granted).includes(cap);
}

/**
 * Motivo por el que no se le puede otorgar la capacidad a ese rol, o null si
 * se puede (espejo de member_capability_set).
 */
export function grantBlockedReason(role: string | null | undefined, cap: Capability): string | null {
  const r = normalizeRole(role);
  if (r === null) return "No es miembro activo del negocio.";
  if (r === "owner") return "El dueño ya tiene todos los permisos.";
  if (r === "viewer" && capabilityInfo(cap).writes) {
    return "Solo lectura no puede modificar datos. Cambiale el rol a cajero o encargado.";
  }
  return null;
}
