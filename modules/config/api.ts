import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import type { Printer, PrinterConnection, PrinterKind } from "@/lib/print/printers";
import type { ConfigDomain, ConfigOverride, ConfigScope } from "@/lib/config/inheritance";
import type { PaymentTerminal, TerminalKind } from "@/lib/payments/terminals";

// config_overrides, store_groups y payment_terminals (F17 · H92/H93, ADR-049)
// no están en types/database.ts (no se regenera en este PR): cliente suelto,
// mismo enfoque que modules/branches/api.ts. La base valida todo (RLS, RPC y
// triggers).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
  single: () => Res<T>;
  insert: (row: Record<string, unknown>) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
}
interface Loose {
  from: <T = unknown>(table: string) => Q<T>;
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

// Negocio actual del JWT. Las listas se filtran por negocio además de la RLS:
// el staff interno pasa la RLS de todos los negocios (is_internal()).
async function tenantId(): Promise<string | null> {
  const user = await getCurrentUser();
  return ((user?.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id as string | undefined) ?? null;
}

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface StoreGroup {
  id: string;
  name: string;
  color: string | null;
  sort: number;
  deleted_at: string | null;
}

export interface TerminalInput {
  store_id: string;
  cash_register_id?: string | null;
  provider_key: string;
  kind: TerminalKind;
  external_id?: string | null;
  environment?: "prod" | "test" | null;
  label: string;
  merchant_number?: string | null;
  acquirer?: string | null;
  is_default?: boolean;
  active?: boolean;
  notes?: string | null;
}

const TERMINAL_COLS =
  "id, store_id, cash_register_id, provider_key, kind, external_id, external_meta, environment, label, merchant_number, acquirer, is_default, active, last_seen_at, notes, deleted_at";

export const configApi = {
  // Overrides vivos del negocio (tabla chica: se resuelve en el cliente).
  overrides: async (): Promise<ConfigOverride[]> => {
    const t = await tenantId();
    if (!t) return [];
    const r = await loose()
      .from<ConfigOverride[]>("config_overrides")
      .select("id, scope, scope_id, domain, domain_key, patch, deleted_at")
      .eq("tenant_id", t)
      .is("deleted_at", null);
    // Sin la migración (front antes que la base) se sigue sin overrides.
    if (r.error) return [];
    return r.data ?? [];
  },

  set: async (v: {
    scope: ConfigScope;
    scopeId: string;
    domain: ConfigDomain;
    domainKey?: string;
    patch?: Record<string, unknown>;
    clear?: string[];
  }): Promise<Record<string, unknown>> => {
    const r = await loose().rpc<Record<string, unknown>>("config_override_set", {
      p_scope: v.scope,
      p_scope_id: v.scopeId,
      p_domain: v.domain,
      p_domain_key: v.domainKey ?? "",
      p_patch: v.patch ?? {},
      p_clear: v.clear ?? [],
    });
    return check(r) ?? {};
  },

  copy: async (v: {
    from: { scope: ConfigScope; id: string };
    to: { scope: ConfigScope; id: string };
    domains?: ConfigDomain[] | null;
    mode?: "replace" | "merge";
  }): Promise<number> => {
    const r = await loose().rpc<number>("config_override_copy", {
      p_from_scope: v.from.scope,
      p_from_id: v.from.id,
      p_to_scope: v.to.scope,
      p_to_id: v.to.id,
      p_domains: v.domains ?? null,
      p_mode: v.mode ?? "replace",
    });
    return Number(check(r) ?? 0);
  },

  resetField: async (domain: ConfigDomain, domainKey: string, field: string): Promise<number> => {
    const r = await loose().rpc<number>("config_override_reset_field", {
      p_domain: domain,
      p_domain_key: domainKey,
      p_field: field,
    });
    return Number(check(r) ?? 0);
  },

  // ── Grupos de sucursales ──
  groups: async (): Promise<StoreGroup[]> => {
    const t = await tenantId();
    if (!t) return [];
    const r = await loose()
      .from<StoreGroup[]>("store_groups")
      .select("id, name, color, sort, deleted_at")
      .eq("tenant_id", t)
      .order("sort")
      .order("name");
    if (r.error) return [];
    return r.data ?? [];
  },
  createGroup: async (name: string, color: string | null): Promise<string> => {
    const r = await loose().from<{ id: string }>("store_groups").insert({ name, color }).select("id").single();
    return check(r).id;
  },
  updateGroup: async (id: string, patch: Partial<Pick<StoreGroup, "name" | "color" | "sort">>): Promise<void> => {
    check(await loose().from("store_groups").update({ ...patch }).eq("id", id));
  },
  archiveGroup: async (id: string): Promise<void> => {
    check(await loose().from("store_groups").update({ deleted_at: new Date().toISOString() }).eq("id", id));
    // Las sucursales del grupo quedan sin grupo (heredan directo del negocio).
    check(await loose().from("stores").update({ store_group_id: null }).eq("store_group_id", id));
  },
  setStoreGroup: async (storeId: string, groupId: string | null): Promise<void> => {
    check(await loose().from("stores").update({ store_group_id: groupId }).eq("id", storeId));
  },
  storeGroupMap: async (): Promise<Record<string, string | null>> => {
    const t = await tenantId();
    if (!t) return {};
    const r = await loose()
      .from<{ id: string; store_group_id: string | null }[]>("stores")
      .select("id, store_group_id")
      .eq("tenant_id", t);
    if (r.error) return {};
    return Object.fromEntries((r.data ?? []).map((s) => [s.id, s.store_group_id]));
  },

  // ── Terminales ──
  terminals: async (): Promise<PaymentTerminal[]> => {
    const t = await tenantId();
    if (!t) return [];
    const r = await loose()
      .from<PaymentTerminal[]>("payment_terminals")
      .select(TERMINAL_COLS)
      .eq("tenant_id", t)
      .is("deleted_at", null)
      .order("label");
    if (r.error) return [];
    return r.data ?? [];
  },
  createTerminal: async (i: TerminalInput): Promise<string> => {
    const r = await loose().from<{ id: string }>("payment_terminals").insert({ ...i }).select("id").single();
    return check(r).id;
  },
  updateTerminal: async (id: string, patch: Partial<TerminalInput>): Promise<void> => {
    check(await loose().from("payment_terminals").update({ ...patch }).eq("id", id));
  },
  archiveTerminal: async (id: string): Promise<void> => {
    check(
      await loose()
        .from("payment_terminals")
        .update({ deleted_at: new Date().toISOString(), is_default: false })
        .eq("id", id),
    );
  },

  // ── Impresoras ──
  printers: async (): Promise<Printer[]> => {
    const t = await tenantId();
    if (!t) return [];
    const r = await loose()
      .from<Printer[]>("printers")
      .select(PRINTER_COLS)
      .eq("tenant_id", t)
      .is("deleted_at", null)
      .order("name");
    if (r.error) return [];
    return r.data ?? [];
  },
  createPrinter: async (i: PrinterInput): Promise<string> => {
    const r = await loose().from<{ id: string }>("printers").insert({ ...i }).select("id").single();
    return check(r).id;
  },
  updatePrinter: async (id: string, patch: Partial<PrinterInput>): Promise<void> => {
    check(await loose().from("printers").update({ ...patch }).eq("id", id));
  },
  archivePrinter: async (id: string): Promise<void> => {
    check(await loose().from("printers").update({ deleted_at: new Date().toISOString() }).eq("id", id));
  },
  markPrinterTest: async (id: string, ok: boolean): Promise<void> => {
    check(await loose().rpc("printer_mark_test", { p_printer_id: id, p_ok: ok }));
  },

  // ── Logo por sucursal ──
  storeLogos: async (): Promise<Record<string, string | null>> => {
    const t = await tenantId();
    if (!t) return {};
    const r = await loose()
      .from<{ id: string; logo_url: string | null }[]>("stores")
      .select("id, logo_url")
      .eq("tenant_id", t);
    if (r.error) return {};
    return Object.fromEntries((r.data ?? []).map((s) => [s.id, s.logo_url]));
  },
  uploadStoreLogo: async (storeId: string, file: File): Promise<string> => {
    const t = await tenantId();
    if (!t) throw new Error("no_tenant");
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "png";
    const path = `${t}/stores/${storeId}/logo-${Date.now()}.${ext}`;
    const sb = createClient();
    const up = await sb.storage.from("tenant-assets").upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) throw new Error(up.error.message);
    const url = sb.storage.from("tenant-assets").getPublicUrl(path).data.publicUrl;
    check(await loose().from("stores").update({ logo_path: path, logo_url: url }).eq("id", storeId));
    return url;
  },
  clearStoreLogo: async (storeId: string): Promise<void> => {
    check(await loose().from("stores").update({ logo_path: null, logo_url: null }).eq("id", storeId));
  },
};

export interface PrinterInput {
  store_id: string;
  cash_register_id?: string | null;
  name: string;
  kind: PrinterKind;
  connection?: PrinterConnection;
  address?: string | null;
  active?: boolean;
  notes?: string | null;
}

const PRINTER_COLS =
  "id, store_id, cash_register_id, name, kind, connection, address, active, notes, last_test_at, last_test_ok, deleted_at";

export function terminalErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes("payment_terminals_external_key") || msg.includes("duplicate key"))
    return "Esa terminal ya está registrada en el negocio.";
  if (msg.includes("register_store_mismatch")) return "La caja elegida no es de esa sucursal.";
  if (msg.includes("terminal_kind_mismatch")) return "El tipo no corresponde a ese medio.";
  if (msg.includes("row-level security") || msg.includes("42501")) return "No tenés permiso para esa sucursal.";
  return "No se pudo guardar la terminal.";
}
