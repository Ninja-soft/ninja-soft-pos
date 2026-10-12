"use client";

// Tesorería (F18 · H111, ADR-059): cuentas (caja general y bancos), saldos,
// movimientos, conciliación manual, cheques y datos del flujo de fondos.
// Cuentas por tabla con RLS (el servidor exige rol y plan); todo lo demás por
// RPC SECURITY DEFINER con auditoría. Las listas filtran por el negocio activo
// además de la RLS (ADR-052). Tablas y RPC fuera de los tipos generados: se
// castean.

import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import type { ChequeKind, ChequeStatus } from "@/lib/treasury/cheques";

export type TreasuryAccountKind = "cash" | "bank";

export interface TreasuryAccount {
  id: string;
  kind: TreasuryAccountKind;
  name: string;
  store_id: string | null;
  bank_name: string | null;
  account_number: string | null;
  cbu: string | null;
  alias: string | null;
  currency: string;
  opening_balance: number;
  opening_date: string;
  transfer_account_id: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export type TreasuryAccountInput = Omit<TreasuryAccount, "id" | "created_at" | "transfer_account_id">;

export interface TreasuryBalance {
  account_id: string;
  kind: TreasuryAccountKind;
  name: string;
  currency: string;
  store_id: string | null;
  is_active: boolean;
  balance: number;
  reconciled_balance: number;
  unreconciled_count: number;
  last_movement: string | null;
}

export type TreasuryMovementType =
  | "deposit"
  | "withdrawal"
  | "transfer_in"
  | "transfer_out"
  | "supplier_payment"
  | "supplier_payment_void"
  | "cheque_deposit"
  | "cheque_debit"
  | "cheque_rejected"
  | "adjustment"
  | "other";

export const MOVEMENT_TYPE_LABEL: Record<TreasuryMovementType, string> = {
  deposit: "Depósito / ingreso",
  withdrawal: "Retiro / gasto",
  transfer_in: "Transferencia recibida",
  transfer_out: "Transferencia enviada",
  supplier_payment: "Orden de pago",
  supplier_payment_void: "Anulación de orden de pago",
  cheque_deposit: "Depósito de cheque",
  cheque_debit: "Débito de cheque propio",
  cheque_rejected: "Cheque rechazado",
  adjustment: "Ajuste",
  other: "Otro",
};

export interface TreasuryMovement {
  id: string;
  account_id: string;
  movement_date: string;
  amount: number;
  type: TreasuryMovementType;
  description: string | null;
  counterpart_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
  cheque_id: string | null;
  reconciled_at: string | null;
  statement_ref: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface Cheque {
  id: string;
  kind: ChequeKind;
  is_echeq: boolean;
  number: string;
  bank_name: string | null;
  issue_date: string | null;
  payment_date: string;
  amount: number;
  currency: string;
  drawer_name: string | null;
  drawer_cuit: string | null;
  status: ChequeStatus;
  account_id: string | null;
  received_from_customer_id: string | null;
  received_from: string | null;
  delivered_to_supplier_id: string | null;
  payment_id: string | null;
  deposited_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  notes: string | null;
  created_at: string;
}

export interface ChequeInput {
  number: string;
  bank_name?: string | null;
  issue_date?: string | null;
  payment_date: string;
  amount: number;
  drawer_name?: string | null;
  drawer_cuit?: string | null;
  customer_id?: string | null;
  received_from?: string | null;
  is_echeq?: boolean;
  notes?: string | null;
}

export interface MovementInput {
  account_id: string;
  type: "deposit" | "withdrawal" | "adjustment" | "other";
  amount: number;
  direction?: "in" | "out";
  date?: string | null;
  description?: string | null;
}

export interface ReceivableRow {
  due_date: string;
  amount: number;
  docs: number;
}

export interface MyOpenShift {
  id: string;
  cash_register_id: string;
  store_id: string | null;
  opened_at: string;
}

const from = (table: string) => createClient().from(table as never);

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

async function tenantId(): Promise<string> {
  const user = await getCurrentUser();
  const id = (user?.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id;
  if (!id) throw new Error("no_tenant");
  return id;
}

const n = (v: unknown) => (v == null ? (v as null) : Number(v));

const ACCOUNT_COLS =
  "id, kind, name, store_id, bank_name, account_number, cbu, alias, currency, opening_balance, opening_date, transfer_account_id, is_active, notes, created_at";
const MOVEMENT_COLS =
  "id, account_id, movement_date, amount, type, description, counterpart_id, reference_type, reference_id, cheque_id, reconciled_at, statement_ref, voided_at, void_reason, created_at";
const CHEQUE_COLS =
  "id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount, currency, drawer_name, drawer_cuit, status, account_id, received_from_customer_id, received_from, delivered_to_supplier_id, payment_id, deposited_at, rejected_at, reject_reason, notes, created_at";

const blank = (v: string | null | undefined) => (v == null || String(v).trim() === "" ? null : v);

export const treasuryApi = {
  accounts: async (opts: { includeArchived?: boolean } = {}): Promise<TreasuryAccount[]> => {
    let q = from("treasury_accounts").select(ACCOUNT_COLS).eq("tenant_id", await tenantId()).order("name");
    if (!opts.includeArchived) q = q.is("deleted_at", null);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as TreasuryAccount[]).map((a) => ({
      ...a,
      opening_balance: Number(a.opening_balance),
    }));
  },

  saveAccount: async (id: string | null, v: TreasuryAccountInput): Promise<void> => {
    const row = {
      ...v,
      bank_name: blank(v.bank_name),
      account_number: blank(v.account_number),
      cbu: blank(v.cbu),
      alias: blank(v.alias),
      notes: blank(v.notes),
      store_id: blank(v.store_id),
    };
    const { error } = id
      ? await from("treasury_accounts").update(row as never).eq("id", id)
      : await from("treasury_accounts").insert(row as never);
    if (error) throw error;
  },

  archiveAccount: async (id: string): Promise<void> => {
    const { error } = await from("treasury_accounts")
      .update({ deleted_at: new Date().toISOString(), is_active: false } as never)
      .eq("id", id);
    if (error) throw error;
  },

  balances: async (): Promise<TreasuryBalance[]> => {
    const { data, error } = await from("treasury_balances")
      .select("account_id, kind, name, currency, store_id, is_active, balance, reconciled_balance, unreconciled_count, last_movement")
      .eq("tenant_id", await tenantId())
      .order("name");
    if (error) throw error;
    return ((data ?? []) as unknown as TreasuryBalance[]).map((b) => ({
      ...b,
      balance: Number(b.balance),
      reconciled_balance: Number(b.reconciled_balance),
      unreconciled_count: Number(b.unreconciled_count),
    }));
  },

  movements: async (f: {
    accountId?: string | null;
    from?: string | null;
    to?: string | null;
    includeVoided?: boolean;
    onlyUnreconciled?: boolean;
  }): Promise<TreasuryMovement[]> => {
    let q = from("treasury_movements")
      .select(MOVEMENT_COLS)
      .eq("tenant_id", await tenantId())
      .order("movement_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000);
    if (f.accountId) q = q.eq("account_id", f.accountId);
    if (f.from) q = q.gte("movement_date", f.from);
    if (f.to) q = q.lte("movement_date", f.to);
    if (!f.includeVoided) q = q.is("voided_at", null);
    if (f.onlyUnreconciled) q = q.is("reconciled_at", null);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as TreasuryMovement[]).map((m) => ({ ...m, amount: Number(m.amount) }));
  },

  createMovement: (v: MovementInput) => rpc<string>("treasury_movement_create", { p: v }),

  transfer: (v: { from: string; to: string; amount: number; date?: string | null; description?: string | null }) =>
    rpc<string>("treasury_transfer", {
      p_from: v.from,
      p_to: v.to,
      p_amount: v.amount,
      p_date: v.date ?? null,
      p_description: v.description ?? null,
    }),

  voidMovement: (id: string, reason: string) => rpc<void>("treasury_movement_void", { p_id: id, p_reason: reason }),

  reconcile: (ids: string[], reconciled: boolean, statementRef: string | null) =>
    rpc<number>("treasury_reconcile", { p_ids: ids, p_reconciled: reconciled, p_statement_ref: statementRef }),

  cheques: async (f: { kind?: ChequeKind | null; statuses?: ChequeStatus[] | null } = {}): Promise<Cheque[]> => {
    let q = from("cheques")
      .select(CHEQUE_COLS)
      .eq("tenant_id", await tenantId())
      .order("payment_date")
      .limit(1000);
    if (f.kind) q = q.eq("kind", f.kind);
    if (f.statuses && f.statuses.length) q = q.in("status", f.statuses);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as Cheque[]).map((c) => ({ ...c, amount: Number(c.amount) }));
  },

  registerCheque: (v: ChequeInput) => rpc<string>("cheque_register", { p: v }),

  transitionCheque: (id: string, to: ChequeStatus, p: { account_id?: string | null; date?: string | null; reason?: string | null }) =>
    rpc<void>("cheque_transition", { p_id: id, p_to: to, p }),

  receivables: async (to: string): Promise<ReceivableRow[]> => {
    const rows = await rpc<ReceivableRow[]>("treasury_receivables", { p_to: to });
    return (rows ?? []).map((r) => ({ due_date: r.due_date, amount: Number(r.amount), docs: Number(n(r.docs)) }));
  },

  /** Turno de caja abierto por el usuario (para pagar en efectivo). */
  myOpenShift: async (): Promise<MyOpenShift | null> => {
    const user = await getCurrentUser();
    if (!user) return null;
    const { data, error } = await from("cash_shifts")
      .select("id, cash_register_id, store_id, opened_at")
      .eq("tenant_id", await tenantId())
      .eq("status", "open")
      .eq("opened_by", user.id)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as unknown as MyOpenShift | null) ?? null;
  },
};
