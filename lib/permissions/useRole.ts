"use client";

import { useMyTenant } from "@/modules/tenants/hooks";
import { useMyCapabilities } from "@/modules/permissions/hooks";
import { deniedReasonByCapability, isReadOnlyRole, normalizeRole, type RoleAction, type RoleContext } from "./roles";

// Rol del usuario en el negocio activo + helpers de permiso (ADR-071, ADR-138).
// Con las capacidades cargadas la UI sigue al rol real (también personalizados
// y permisos puntuales); mientras cargan, la regla por rol. Mientras el rol es
// null todo se ve permitido (la base revalida).
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
    can: (action: RoleAction, ctx?: RoleContext) => deniedReasonByCapability(role, caps, action, ctx) === null,
    denied: (action: RoleAction, ctx?: RoleContext) => deniedReasonByCapability(role, caps, action, ctx),
  };
}
