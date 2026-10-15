import { createClient } from "@/lib/supabase/client";
import type { BaseRole, Override, RoleColor, RoleIcon } from "@/lib/permissions/capabilities";

// Permisos por capacidad (ADR-138). RPC sin tipos generados: cliente "suelto".
// La base resuelve y hace cumplir todo; esto sólo lee.
type RpcRes<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Loose {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => RpcRes<T>;
}
export const loose = () => createClient() as unknown as Loose;

export function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface MyCapabilities {
  base: BaseRole;
  role_id: string | null;
  role_key: string | null;
  role_name: string | null;
  custom: boolean;
  feature: boolean;
  capabilities: string[];
  /** Capacidades por sucursal donde tiene un rol propio. */
  stores: Record<string, string[]>;
}

export interface PermRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: RoleColor;
  icon: RoleIcon;
  base: BaseRole;
  system: boolean;
  template_key: string | null;
  capabilities: string[];
  members: number;
  updated_at: string;
}

export interface PermPersonStore {
  store_id: string;
  kind: "home" | "cover" | "extra";
  base: BaseRole | null;
  role_id: string | null;
}

export interface PermPerson {
  user_id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  status: string;
  base: BaseRole;
  role_id: string;
  overrides: (Override & { reason: string | null })[];
  stores: PermPersonStore[];
  /** Capacidades efectivas en el negocio según la base. */
  effective: string[];
}

export interface PermStore {
  id: string;
  name: string;
  short_name: string | null;
  color: string | null;
}

export interface PermOverview {
  feature: boolean;
  /**
   * Features del plan que habilitan permisos puntuales sin roles_permisos
   * (grantFeature del catálogo: las otorgables de Inventario, ADR-137).
   */
  grant_features: string[];
  multi_sucursal: boolean;
  is_owner: boolean;
  can_manage: boolean;
  me: string;
  my_capabilities: string[];
  roles: PermRole[];
  people: PermPerson[];
  stores: PermStore[];
}

export interface SaveRoleInput {
  id: string | null;
  name: string;
  description: string | null;
  color: RoleColor;
  icon: RoleIcon;
  base: BaseRole;
  capabilities: string[];
  template: string | null;
}

export const permissionsApi = {
  overview: async (): Promise<PermOverview> => check(await loose().rpc<PermOverview>("permission_overview")),
  saveRole: async (i: SaveRoleInput): Promise<string> =>
    check(
      await loose().rpc<string>("permission_role_save", {
        p_role_id: i.id,
        p_name: i.name,
        p_description: i.description,
        p_color: i.color,
        p_icon: i.icon,
        p_base: i.base,
        p_capabilities: i.capabilities,
        p_template: i.template,
      }),
    ),
  duplicateRole: async (source: string, name: string): Promise<string> =>
    check(await loose().rpc<string>("permission_role_duplicate", { p_source: source, p_name: name })),
  deleteRole: async (id: string, reassignTo: string): Promise<number> =>
    check(await loose().rpc<number>("permission_role_delete", { p_role_id: id, p_reassign_to: reassignTo })),
  assignRole: async (userId: string, roleId: string): Promise<void> => {
    check(await loose().rpc("permission_assign_role", { p_user: userId, p_role_id: roleId }));
  },
  setBranchRole: async (userId: string, storeId: string, roleId: string | null): Promise<number> =>
    check(await loose().rpc<number>("permission_branch_role_set", { p_user: userId, p_store: storeId, p_role_id: roleId })),
  setOverride: async (userId: string, capability: string, effect: "grant" | "revoke" | null, reason: string | null): Promise<void> => {
    check(
      await loose().rpc("permission_override_set", {
        p_user: userId,
        p_capability: capability,
        p_effect: effect,
        p_reason: reason,
      }),
    );
  },
  /** null: sin membresía o base sin la migración (la UI usa la regla por rol). */
  mine: async (): Promise<MyCapabilities | null> => {
    const r = await loose().rpc<MyCapabilities>("my_capabilities");
    if (r.error || !r.data) return null;
    return r.data;
  },
};
