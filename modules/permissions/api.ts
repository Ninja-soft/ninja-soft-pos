import { createClient } from "@/lib/supabase/client";
import type { BaseRole } from "@/lib/permissions/capabilities";

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

export const permissionsApi = {
  /** null: sin membresía o base sin la migración (la UI usa la regla por rol). */
  mine: async (): Promise<MyCapabilities | null> => {
    const r = await loose().rpc<MyCapabilities>("my_capabilities");
    if (r.error || !r.data) return null;
    return r.data;
  },
};
