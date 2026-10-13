import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { parseRegisterHardware, type RegisterHardware } from "@/lib/hardware/config";
import type { DrawerKind } from "@/lib/hardware/drawer";

// Balanza y cajón por caja (ADR-063). register_hardware y cash_drawer_events
// no están en types/database.ts (no se regenera en este PR): cliente suelto,
// mismo enfoque que modules/config/api.ts. La base valida todo (RLS y RPC).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
  limit: (n: number) => Q<T>;
}
interface Loose {
  from: <T = unknown>(table: string) => Q<T>;
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface DrawerOpenResult {
  allowed: boolean;
  denied_reason: string | null;
  event_id: string;
  supervisor_id: string | null;
  cash_shift_id: string | null;
  kind: DrawerKind;
}

export interface DrawerEvent {
  id: string;
  cash_register_id: string;
  cash_shift_id: string | null;
  user_id: string;
  kind: DrawerKind;
  reason: string | null;
  allowed: boolean;
  denied_reason: string | null;
  supervisor_id: string | null;
  sale_id: string | null;
  created_at: string;
}

export const hardwareApi = {
  /** Equipos de todas las cajas visibles (la RLS recorta por sucursal). */
  list: async (): Promise<RegisterHardware[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<Record<string, unknown>[]>("register_hardware")
      .select("cash_register_id, store_id, scale, drawer, updated_at")
      .eq("tenant_id", t);
    // Sin la migración (front antes que la base): sin equipos cargados.
    if (r.error) return [];
    return (r.data ?? []).map(parseRegisterHardware);
  },

  set: async (v: {
    registerId: string;
    scale?: Record<string, unknown> | null;
    drawer?: Record<string, unknown> | null;
  }): Promise<RegisterHardware> => {
    const r = await loose().rpc<Record<string, unknown>>("register_hardware_set", {
      p_register_id: v.registerId,
      p_scale: v.scale ?? null,
      p_drawer: v.drawer ?? null,
    });
    return parseRegisterHardware(check(r) ?? {});
  },

  /** Pide la apertura: el servidor decide, registra y contesta. */
  openDrawer: async (v: {
    registerId: string;
    kind: DrawerKind;
    reason?: string | null;
    saleId?: string | null;
  }): Promise<DrawerOpenResult> => {
    const r = await loose().rpc<DrawerOpenResult>("cash_drawer_open", {
      p_register_id: v.registerId,
      p_kind: v.kind,
      p_reason: v.reason ?? null,
      p_sale_id: v.saleId ?? null,
    });
    return check(r);
  },

  events: async (registerId: string, limit = 20): Promise<DrawerEvent[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<DrawerEvent[]>("cash_drawer_events")
      .select(
        "id, cash_register_id, cash_shift_id, user_id, kind, reason, allowed, denied_reason, supervisor_id, sale_id, created_at",
      )
      .eq("tenant_id", t)
      .eq("cash_register_id", registerId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (r.error) return [];
    return r.data ?? [];
  },
};

/** Mensaje amable para los errores de las RPC de hardware. */
export function hardwareErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes("feature_not_in_plan: balanza")) return "Tu plan no incluye balanza y códigos pesables.";
  if (msg.includes("feature_not_in_plan: cajon_dinero")) return "Tu plan no incluye el cajón de dinero.";
  if (msg.includes("printer_not_found")) return "La impresora elegida no es de esta caja ni de su sucursal.";
  if (msg.includes("invalid_scale") || msg.includes("invalid_drawer")) return "Revisá los datos: hay un valor fuera de rango.";
  if (msg.includes("reason_required")) return "Escribí el motivo (al menos 3 letras).";
  if (msg.includes("register_not_found")) return "La caja ya no existe.";
  if (msg.includes("forbidden")) return "No tenés permiso para esa caja.";
  if (msg.includes("supervisor_token_invalid")) return "La autorización del supervisor venció: pedila de nuevo.";
  return "No se pudo completar.";
}
