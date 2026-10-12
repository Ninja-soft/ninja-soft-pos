import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type {
  AssignmentKind,
  Branch,
  BranchRegister,
  OpenShiftLite,
  OpeningHours,
  RegisterKind,
  StaffAssignment,
} from "./logic";

// types/database.ts no se regenera en este PR: las columnas nuevas de stores y
// cash_registers, staff_branch_assignments y las RPC de F17 no están tipadas.
// Se usa un cliente "suelto" para esas llamadas (mismo enfoque que
// modules/sales/api.ts). La base valida todo (RLS, triggers y RPC).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null; count?: number | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
  in: (col: string, v: unknown[]) => Q<T>;
  or: (filter: string) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
  limit: (n: number) => Q<T>;
  single: () => Res<T>;
  insert: (row: Record<string, unknown>) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
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

const STORE_COLS =
  "id, name, short_name, code, color, address, city, province, postal_code, phone, email, timezone, afip_pos_number, opening_hours, notes, is_default, is_active, deleted_at, archived_reason, sort, created_at";
const REGISTER_COLS =
  "id, store_id, name, code, kind, is_active, deleted_at, sort, device_notes, printer_notes, afip_pos_number, created_at";

export interface StoreInput {
  name: string;
  short_name?: string | null;
  code?: string | null;
  color?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  email?: string | null;
  afip_pos_number?: number | null;
  opening_hours?: OpeningHours;
  notes?: string | null;
  is_active?: boolean;
  sort?: number;
}

export interface RegisterInput {
  store_id: string;
  name: string;
  code?: string | null;
  kind?: RegisterKind;
  device_notes?: string | null;
  printer_notes?: string | null;
  afip_pos_number?: number | null;
  is_active?: boolean;
  sort?: number;
}

export interface ScheduleInput {
  storeId: string;
  kind: AssignmentKind;
  userId?: string | null;
  cashierProfileId?: string | null;
  from?: string | null;
  until?: string | null;
  role?: "manager" | "cashier" | "viewer" | null;
  reason?: string | null;
}

export const branchesAdminApi = {
  // Sucursales con sus cajas (incluye archivadas: la UI decide qué mostrar).
  list: async (): Promise<Branch[]> => {
    const sb = loose();
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    const [stores, registers] = await Promise.all([
      sb.from<Branch[]>("stores").select(STORE_COLS).eq("tenant_id", tenantId).order("sort").order("created_at"),
      sb
        .from<BranchRegister[]>("cash_registers")
        .select(REGISTER_COLS)
        .eq("tenant_id", tenantId)
        .order("sort")
        .order("created_at"),
    ]);
    const s = check(stores) ?? [];
    const r = check(registers) ?? [];
    return s.map((b) => ({
      ...b,
      opening_hours: (b.opening_hours ?? {}) as OpeningHours,
      registers: r.filter((x) => x.store_id === b.id),
    }));
  },

  allowedStoreIds: async (): Promise<string[]> => {
    const r = await loose().rpc<string[]>("user_allowed_store_ids");
    return check(r) ?? [];
  },

  createStore: async (input: StoreInput): Promise<string> => {
    const r = await loose().from<{ id: string }>("stores").insert({ ...input }).select("id").single();
    return check(r).id;
  },
  updateStore: async (id: string, patch: Partial<StoreInput>): Promise<void> => {
    check(await loose().from("stores").update({ ...patch }).eq("id", id));
  },
  archiveStore: async (id: string, reason: string | null): Promise<void> => {
    check(
      await loose()
        .from("stores")
        .update({ deleted_at: new Date().toISOString(), archived_reason: reason })
        .eq("id", id),
    );
  },
  restoreStore: async (id: string): Promise<void> => {
    check(await loose().from("stores").update({ deleted_at: null }).eq("id", id));
  },
  setDefaultStore: async (id: string): Promise<void> => {
    check(await loose().rpc("set_default_store", { p_store_id: id }));
  },

  createRegister: async (input: RegisterInput): Promise<string> => {
    const r = await loose().from<{ id: string }>("cash_registers").insert({ ...input }).select("id").single();
    return check(r).id;
  },
  updateRegister: async (id: string, patch: Partial<RegisterInput>): Promise<void> => {
    check(await loose().from("cash_registers").update({ ...patch }).eq("id", id));
  },
  archiveRegister: async (id: string, reason: string | null): Promise<void> => {
    check(
      await loose()
        .from("cash_registers")
        .update({ deleted_at: new Date().toISOString(), archived_reason: reason })
        .eq("id", id),
    );
  },
  restoreRegister: async (id: string): Promise<void> => {
    check(await loose().from("cash_registers").update({ deleted_at: null }).eq("id", id));
  },

  // Turnos abiertos de una sucursal (para elegir caja y mostrar "ocupada").
  openShifts: async (storeId: string): Promise<OpenShiftLite[]> => {
    const r = await loose()
      .from<OpenShiftLite[]>("cash_shifts")
      .select("id, cash_register_id, opened_by, opened_at")
      .eq("store_id", storeId)
      .eq("status", "open");
    return check(r) ?? [];
  },

  // Personal por sucursal (todas las filas del negocio; incluye historia).
  assignments: async (): Promise<StaffAssignment[]> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    const r = await loose()
      .from<StaffAssignment[]>("staff_branch_assignments")
      .eq("tenant_id", tenantId)
      .select(
        "id, store_id, user_id, cashier_profile_id, kind, role, valid_from, valid_until, reason, transfer_id, superseded_by, deleted_at, cancel_reason, created_at",
      )
      .eq("tenant_id", tenantId)
      .order("valid_from", { ascending: false })
      .order("created_at", { ascending: false });
    return check(r) ?? [];
  },
  schedule: async (i: ScheduleInput): Promise<string> => {
    const r = await loose().rpc<string>("staff_branch_schedule", {
      p_store_id: i.storeId,
      p_kind: i.kind,
      p_user_id: i.userId ?? null,
      p_cashier_profile_id: i.cashierProfileId ?? null,
      p_from: i.from ?? null,
      p_until: i.until ?? null,
      p_role: i.role ?? null,
      p_reason: i.reason ?? null,
    });
    return check(r) as string;
  },
  cancel: async (id: string, reason: string | null): Promise<"cancelled" | "ended"> => {
    const r = await loose().rpc<"cancelled" | "ended">("staff_branch_cancel", {
      p_assignment_id: id,
      p_reason: reason,
    });
    return check(r) as "cancelled" | "ended";
  },
};
