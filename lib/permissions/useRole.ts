"use client";

import { useMyTenant } from "@/modules/tenants/hooks";
import { can, deniedReason, isReadOnlyRole, normalizeRole, type RoleAction, type RoleContext } from "./roles";

// Rol del usuario en el negocio activo + helpers de permiso (ADR-071).
// Mientras carga, el rol es null y todo se ve permitido (la base revalida).
export function useRolePermissions() {
  const { data } = useMyTenant();
  const role = normalizeRole(data?.role);
  return {
    role,
    readOnly: isReadOnlyRole(role),
    can: (action: RoleAction, ctx?: RoleContext) => can(role, action, ctx),
    denied: (action: RoleAction, ctx?: RoleContext) => deniedReason(role, action, ctx),
  };
}
