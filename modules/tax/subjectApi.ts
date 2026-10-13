import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { IibbPreview } from "@/lib/tax/iibb";
import type { SufferedImportRow, SufferedRow } from "@/lib/tax/suffered";

// Impuestos como sujeto (ADR-095): retenciones y percepciones sufridas y
// liquidación de IIBB. Las tablas y RPC nuevas no están en types/database.ts
// (no se regenera en este PR): cliente suelto, como modules/tax/api.ts. La
// base valida todo (RLS, RPC y triggers).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  insert: (row: Record<string, unknown> | Record<string, unknown>[]) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  lt: (col: string, v: unknown) => Q<T>;
  gte: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
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

const num = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

function normRow(r: Record<string, unknown>): SufferedRow {
  return {
    ...(r as unknown as SufferedRow),
    amount: num(r.amount),
    base_amount: numOrNull(r.base_amount),
    rate: numOrNull(r.rate),
    operation_date: String(r.operation_date ?? "").slice(0, 10),
    period: String(r.period ?? "").slice(0, 10),
  };
}

export interface SufferedRegisterInput {
  tax: string;
  kind: string;
  regime?: string;
  jurisdiction?: string | null;
  origin?: "cliente" | "banco" | "manual";
  operation_date: string;
  period?: string | null;
  amount: number;
  base_amount?: number | null;
  rate?: number | null;
  agent_cuit?: string | null;
  agent_name?: string | null;
  certificate?: string | null;
  customer_id?: string | null;
  payment_id?: string | null;
  cc_movement_id?: string | null;
  treasury_movement_id?: string | null;
  treasury_account_id?: string | null;
  store_id?: string | null;
  notes?: string | null;
}

export interface IibbActivity {
  id: string;
  jurisdiction: string;
  code: string | null;
  name: string;
  rate: number;
  min_tax: number;
  is_default: boolean;
  category_ids: string[];
  sort: number;
  is_active: boolean;
  notes: string | null;
}

export interface IibbActivityTemplate {
  jurisdiction: string;
  code: string;
  name: string;
  rate: number;
  source: string;
  verify: boolean;
  notes: string | null;
}

export interface IibbCoefficient {
  id: string;
  jurisdiction: string;
  valid_from: string;
  coefficient: number;
  notes: string | null;
}

export interface IibbLiquidation {
  id: string;
  jurisdiction: string;
  period: string;
  regime: "local" | "cm";
  base_total: number;
  determined: number;
  deductions_total: number;
  previous_credit: number;
  to_pay: number;
  credit_next: number;
  status: "confirmed" | "voided";
  confirmed_at: string;
  void_reason: string | null;
  snapshot?: IibbPreview;
}

export interface LinkCandidate {
  id: string;
  label: string;
  amount: number;
  date: string;
}

export const taxSubjectApi = {
  // ── Retenciones y percepciones sufridas ──────────────────────────────────
  sufferedList: async (period: string): Promise<SufferedRow[]> => {
    const r = check(await loose().rpc<Record<string, unknown>[]>("tax_suffered_list", { p_period: period }));
    return (r ?? []).map(normRow);
  },

  sufferedExport: async (period: string): Promise<{ period: string; rows: SufferedRow[]; agent: Record<string, unknown> }> => {
    const r = check(
      await loose().rpc<{ period: string; rows: Record<string, unknown>[]; agent: Record<string, unknown> }>(
        "tax_suffered_export",
        { p_period: period },
      ),
    );
    return { ...r, rows: (r.rows ?? []).map(normRow) };
  },

  sufferedRegister: async (p: SufferedRegisterInput): Promise<string> =>
    check(await loose().rpc<string>("tax_suffered_register", { p })),

  sufferedUpdate: async (id: string, p: Record<string, unknown>): Promise<void> => {
    check(await loose().rpc<null>("tax_suffered_update", { p_id: id, p }));
  },

  sufferedVoid: async (id: string, reason: string): Promise<void> => {
    check(await loose().rpc<null>("tax_suffered_void", { p_id: id, p_reason: reason }));
  },

  sufferedImport: async (
    rows: SufferedImportRow[],
    source: string,
  ): Promise<{ rows: number; inserted: number; duplicates: number; errors: { row: number; message: string }[] }> =>
    check(await loose().rpc("tax_suffered_import", { p_rows: rows, p_source: source })),

  sufferedSyncSettlements: async (from: string, to: string): Promise<{ lines: number; inserted: number }> =>
    check(await loose().rpc("tax_suffered_sync_settlements", { p_from: from, p_to: to })),

  /** Débitos del banco (últimos 120 días) para vincular un SIRCREB o un débito y crédito. */
  bankDebits: async (since: string): Promise<LinkCandidate[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<Record<string, unknown>[]>("treasury_movements")
      .select("id, movement_date, amount, description, type")
      .eq("tenant_id", t)
      .is("voided_at", null)
      .lt("amount", 0)
      .gte("movement_date", since)
      .order("movement_date", { ascending: false })
      .limit(200);
    if (r.error) return [];
    return (r.data ?? []).map((m) => ({
      id: String(m.id),
      date: String(m.movement_date),
      amount: Math.abs(num(m.amount)),
      label: String(m.description ?? m.type ?? "Débito"),
    }));
  },

  /** Recibos de cuenta corriente de un cliente (últimos 120 días). */
  customerReceipts: async (customerId: string, since: string): Promise<LinkCandidate[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = await loose()
      .from<Record<string, unknown>[]>("customer_account_movements")
      .select("id, created_at, delta, receipt_no, method")
      .eq("tenant_id", t)
      .eq("customer_id", customerId)
      .eq("kind", "payment")
      .is("voided_at", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100);
    if (r.error) return [];
    return (r.data ?? []).map((m) => ({
      id: String(m.id),
      date: String(m.created_at).slice(0, 10),
      amount: Math.abs(num(m.delta)),
      label: `Recibo${m.receipt_no ? ` #${m.receipt_no}` : ""}${m.method ? ` · ${String(m.method)}` : ""}`,
    }));
  },

  // ── Ingresos Brutos ──────────────────────────────────────────────────────
  activities: async (): Promise<IibbActivity[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = check(
      await loose()
        .from<Record<string, unknown>[]>("iibb_activities")
        .select("id, jurisdiction, code, name, rate, min_tax, is_default, category_ids, sort, is_active, notes")
        .eq("tenant_id", t)
        .order("jurisdiction")
        .order("sort"),
    );
    return (r ?? []).map((a) => ({
      ...(a as unknown as IibbActivity),
      rate: num(a.rate),
      min_tax: num(a.min_tax),
      category_ids: Array.isArray(a.category_ids) ? (a.category_ids as string[]) : [],
    }));
  },

  activityTemplates: async (): Promise<IibbActivityTemplate[]> => {
    const r = check(
      await loose()
        .from<Record<string, unknown>[]>("iibb_activity_templates")
        .select("jurisdiction, code, name, rate, source, verify, notes")
        .order("jurisdiction"),
    );
    return (r ?? []).map((a) => ({ ...(a as unknown as IibbActivityTemplate), rate: num(a.rate) }));
  },

  saveActivity: async (a: Partial<IibbActivity> & { jurisdiction: string; name: string; rate: number }): Promise<void> => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    const row = {
      jurisdiction: a.jurisdiction,
      code: a.code || null,
      name: a.name,
      rate: a.rate,
      min_tax: a.min_tax ?? 0,
      is_default: a.is_default ?? false,
      category_ids: a.category_ids ?? [],
      sort: a.sort ?? 0,
      is_active: a.is_active ?? true,
      notes: a.notes || null,
    };
    if (a.id) check(await loose().from("iibb_activities").update(row).eq("id", a.id));
    else check(await loose().from("iibb_activities").insert({ ...row, tenant_id: t }));
  },

  coefficients: async (): Promise<IibbCoefficient[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = check(
      await loose()
        .from<Record<string, unknown>[]>("iibb_cm_coefficients")
        .select("id, jurisdiction, valid_from, coefficient, notes")
        .eq("tenant_id", t)
        .order("valid_from", { ascending: false }),
    );
    return (r ?? []).map((c) => ({ ...(c as unknown as IibbCoefficient), coefficient: num(c.coefficient) }));
  },

  saveCoefficient: async (c: Partial<IibbCoefficient> & { jurisdiction: string; valid_from: string; coefficient: number }) => {
    const t = await getCurrentTenantId();
    if (!t) throw new Error("no_tenant");
    const row = { jurisdiction: c.jurisdiction, valid_from: c.valid_from, coefficient: c.coefficient, notes: c.notes || null };
    if (c.id) check(await loose().from("iibb_cm_coefficients").update(row).eq("id", c.id));
    else check(await loose().from("iibb_cm_coefficients").insert({ ...row, tenant_id: t }));
  },

  liquidations: async (): Promise<IibbLiquidation[]> => {
    const t = await getCurrentTenantId();
    if (!t) return [];
    const r = check(
      await loose()
        .from<Record<string, unknown>[]>("iibb_liquidations")
        .select(
          "id, jurisdiction, period, regime, base_total, determined, deductions_total, previous_credit, to_pay, credit_next, status, confirmed_at, void_reason, snapshot",
        )
        .eq("tenant_id", t)
        .order("period", { ascending: false })
        .limit(60),
    );
    return (r ?? []).map((l) => ({
      ...(l as unknown as IibbLiquidation),
      base_total: num(l.base_total),
      determined: num(l.determined),
      deductions_total: num(l.deductions_total),
      previous_credit: num(l.previous_credit),
      to_pay: num(l.to_pay),
      credit_next: num(l.credit_next),
    }));
  },

  preview: async (jurisdiction: string, period: string, opening: number | null): Promise<IibbPreview & { confirmed: IibbLiquidation | null }> =>
    check(
      await loose().rpc("iibb_liquidation_preview", {
        p_jurisdiction: jurisdiction,
        p_period: period,
        p_opening_credit: opening,
      }),
    ),

  confirm: async (p: { jurisdiction: string; period: string; to_pay: number; credit_next: number; opening: number | null }): Promise<string> =>
    check(
      await loose().rpc<string>("iibb_liquidation_confirm", {
        p_jurisdiction: p.jurisdiction,
        p_period: p.period,
        p_expected_to_pay: p.to_pay,
        p_expected_credit: p.credit_next,
        p_opening_credit: p.opening,
      }),
    ),

  voidLiquidation: async (id: string, reason: string): Promise<void> => {
    check(await loose().rpc<null>("iibb_liquidation_void", { p_id: id, p_reason: reason }));
  },
};
