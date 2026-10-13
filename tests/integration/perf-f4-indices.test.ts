// @vitest-environment node
// =============================================================================
// F4 · rendimiento de base (ADR-090, migración 20261108500000).
//
// Verifica sobre el catálogo de un Supabase LOCAL con todas las migraciones:
//   * existen los índices críticos de las tablas operativas grandes;
//   * ninguna FK de esas tablas queda sin índice que la cubra;
//   * ninguna policy de public deja una llamada sin "(select ...)" que podría
//     ser initplan (rls_policies_without_initplan);
//   * siguen en 0 los guardarraíles de ADR-083 (current_tenant_id suelto) y
//     ADR-052 (fuga de staff interno).
// Mismas variables que tests/integration/rls.test.ts. Sin ellas se salta.
// Sólo lee: no crea datos.
// =============================================================================
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && SERVICE);

const LARGE_TABLES = [
  "sales",
  "sale_items",
  "payments",
  "stock_movements",
  "cash_movements",
  "audit_logs",
  "fiscal_documents",
  "table_order_items",
];

const CRITICAL_INDEXES = [
  // ADR-090
  "payments_tenant_created_idx",
  "payments_reconciled_by_idx",
  "sales_promo_idx",
  "sales_coupon_idx",
  "cash_movements_tenant_created_idx",
  "stock_movements_store_created_idx",
  "table_order_items_product_idx",
  "fiscal_documents_tenant_status_created_idx",
  "fiscal_documents_store_created_idx",
  "fiscal_documents_return_idx",
  "fiscal_documents_assoc_idx",
  "fiscal_documents_caea_idx",
  // Existentes de los que dependen las listas y las policies por sucursal
  "sales_tenant_created_idx",
  "sales_tenant_store_created_idx",
  "payments_sale_idx",
  "sale_items_sale_idx",
  "stock_movements_tenant_idx",
  "cash_movements_shift_idx",
  "audit_logs_tenant_created_idx",
  "fiscal_documents_sale_idx",
  "table_order_items_order_idx",
  "tenant_users_tenant_idx",
  "tenant_users_user_idx",
];

type RpcResult<T> = { data: T | null; error: { message: string } | null };
const rpc = <T>(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult<T>>;

describe.skipIf(!enabled)("F4 · índices y RLS initplan (ADR-090)", () => {
  let admin: SupabaseClient;

  beforeAll(() => {
    admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
  });

  it("existen los índices críticos", async () => {
    const { data, error } = await rpc<{ indexname: string }[]>(admin, "perf_indexes_present", {
      p_names: CRITICAL_INDEXES,
    });
    expect(error).toBeNull();
    const present = new Set((data ?? []).map((r) => r.indexname));
    expect(CRITICAL_INDEXES.filter((n) => !present.has(n))).toEqual([]);
  });

  it("ninguna FK de las tablas grandes queda sin índice", async () => {
    const { data, error } = await rpc<unknown[]>(admin, "perf_fk_without_index", { p_tables: LARGE_TABLES });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("todas las policies usan initplan para las llamadas sin dependencia de la fila", async () => {
    const { data, error } = await rpc<unknown[]>(admin, "rls_policies_without_initplan");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("guardarraíles ADR-083 y ADR-052 siguen en 0", async () => {
    const bare = await rpc<unknown[]>(admin, "rls_bare_current_tenant_policies");
    expect(bare.error).toBeNull();
    expect(bare.data).toEqual([]);
    const leaks = await rpc<unknown[]>(admin, "rls_internal_scope_leaks");
    expect(leaks.error).toBeNull();
    expect(leaks.data).toEqual([]);
  });

  it("los guardarraíles no se exponen a clientes", async () => {
    const anon = createClient(URL_!, process.env.SUPABASE_TEST_ANON_KEY ?? SERVICE!, {
      auth: { persistSession: false },
    });
    if (!process.env.SUPABASE_TEST_ANON_KEY) return;
    const { error } = await rpc<unknown[]>(anon, "perf_fk_without_index", { p_tables: LARGE_TABLES });
    expect(error).not.toBeNull();
  });
});
