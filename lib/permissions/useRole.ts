"use client";

import { useMyTenant } from "@/modules/tenants/hooks";
import { useMyCapabilities } from "@/modules/permissions/hooks";
import { capabilityAllowed } from "./capabilities";
import { deniedReasonByCapability, isReadOnlyRole, normalizeRole, type RoleAction, type RoleContext } from "./roles";

// Rol del usuario en el negocio activo + helpers de permiso (ADR-071, ADR-138).
// Con las capacidades cargadas la UI sigue al rol real (también personalizados
// y permisos puntuales); mientras cargan, la regla por rol. Mientras el rol es
// null todo se ve permitido (la base revalida). Hook único de permisos: las
// pantallas que preguntan por capacidad (Inventario, ADR-137) usan allows().
export function useRolePermissions() {
  const { data } = useMyTenant();
  const role = normalizeRole(data?.role);
  const { data: mine } = useMyCapabilities(role !== null);
  const caps = mine?.capabilities ?? null;
  return {
    role,
    readOnly: isReadOnlyRole(role),
    capabilities: caps,
    has: (cap: string) => (role === "owner" ? true : caps ? caps.includes(cap) : null),
    /** Capacidad efectiva; mientras cargan, la del rol de sistema de su nivel. */
    allows: (cap: string) => capabilityAllowed(role, caps, cap),
    can: (action: RoleAction, ctx?: RoleContext) => deniedReasonByCapability(role, caps, action, ctx) === null,
    denied: (action: RoleAction, ctx?: RoleContext) => deniedReasonByCapability(role, caps, action, ctx),
  };
}
