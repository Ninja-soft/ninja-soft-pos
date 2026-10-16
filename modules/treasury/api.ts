"use client";

// Tesorería (F18 · H111, ADR-059; F23 · H150-H154, ADR-158): cuentas de dinero
// (caja general, bancos, billeteras, cajas del POS y a acreditar), saldos,
// movimientos, conciliación manual, cheques y datos del flujo de fondos.
// Cuentas por tabla con RLS (el servidor exige rol y plan); todo lo demás por
// RPC SECURITY DEFINER con auditoría. Las listas filtran por el negocio activo
// además de la RLS (ADR-052). Tablas y RPC fuera de los tipos generados: se
// castean. Tolerante a una base sin la migración H150: las columnas y RPC
// nuevas se piden y, si faltan, se vuelve a lo anterior.

import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import type { ChequeKind, ChequeStatus } from "@/lib/treasury/cheques";
import { isMissingSchema } from "@/lib/treasury/accounts";

// pos_cash y receivable las crea y mueve el sistema (is_system): se ven, no se editan.
export type TreasuryAccountKind = "cash" | "bank" | "pos_cash" | "wallet" | "receivable";

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
  is_active: boolean;
  notes: string | null;
  created_at: string;
  /** Billetera o procesador (wallet, receivable). Null sin la migración H150. */
  provider_key: string | null;
  cash_register_id: string | null;
  is_system: boolean;
}

export type TreasuryAccountInput = Omit<TreasuryAccount, "id" | "created_at" | "cash_register_id" | "is_system">;

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

/** Una cuenta en la pantalla Posición (RPC treasury_position). */
export interface TreasuryPosition {
  account_id: string;
  kind: TreasuryAccountKind;
  name: string;
  currency: string;
  store_id: string | null;
  provider_key: string | null;
  cash_register_id: string | null;
  is_active: boolean;
  is_system: boolean;
  balance: number;
  reconciled_balance: number;
  unreconciled_count: number;
  last_movement: string | null;
  detail: {
    shift_open?: boolean;
    opened_at?: string | null;
    closed_at?: string | null;
    counted?: number | null;
    pending_count?: number;
    oldest_date?: string | null;
  } | null;
  transfer_accounts: Array<{ id: string; bank_name: string | null; alias: string | null; holder_name: string | null }>;
  ledger_account: { id: string; code: string; name: string } | null;
}

/** Cobro todavía no acreditado por el procesador (RPC treasury_pending_collections). */
export interface PendingCollection {
  payment_id: string;
  sale_id: string | null;
  sale_number: number | null;
  method: string;
  provider_key: string | null;
  amount: number;
  created_at: string;
  store_id: string | null;
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
  | "other"
  | "sale_collection"
  | "sale_collection_void";

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
  sale_collection: "Cobro por transferencia",
  sale_collection_void: "Venta anulada",
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
  /** H150 / H154 (ADR-158). Null sin la migración. */
  sale_id: string | null;
  expense_account_id: string | null;
  receipt_number: string | null;
  receipt_vat: number | null;
  proof_path: string | null;
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
  /** Gasto (H154): cuenta de gasto, comprobante, IVA y adjunto. Sólo en withdrawal. */
  expense_account_id?: string | null;
  receipt_number?: string | null;
  receipt_vat?: number | null;
  proof_path?: string | null;
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

const ACCOUNT_BASE_COLS =
  "id, kind, name, store_id, bank_name, account_number, cbu, alias, currency, opening_balance, opening_date, is_active, notes, created_at";
const ACCOUNT_COLS = `${ACCOUNT_BASE_COLS}, provider_key, cash_register_id, is_system`;
const MOVEMENT_BASE_COLS =
  "id, account_id, movement_date, amount, type, description, counterpart_id, reference_type, reference_id, cheque_id, reconciled_at, statement_ref, voided_at, void_reason, created_at";
const MOVEMENT_COLS = `${MOVEMENT_BASE_COLS}, sale_id, expense_account_id, receipt_number, receipt_vat, proof_path`;
const CHEQUE_COLS =
  "id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount, currency, drawer_name, drawer_cuit, status, account_id, received_from_customer_id, received_from, delivered_to_supplier_id, payment_id, deposited_at, rejected_at, reject_reason, notes, created_at";

/** Bucket privado de comprobantes de gastos (H154). Carpeta = negocio. */
export const PROOF_BUCKET = "treasury-proofs";

const blank = (v: string | null | undefined) => (v == null || String(v).trim() === "" ? null : v);

type RawAccount = Omit<TreasuryAccount, "provider_key" | "cash_register_id" | "is_system" | "opening_balance"> &
  Partial<Pick<TreasuryAccount, "provider_key" | "cash_register_id" | "is_system">> & { opening_balance: unknown };

function normAccount(a: RawAccount): TreasuryAccount {
  return {
    ...a,
    opening_balance: Number(a.opening_balance),
    provider_key: a.provider_key ?? null,
    cash_register_id: a.cash_register_id ?? null,
    is_system: Boolean(a.is_system),
  };
}

type RawMovement = Omit<TreasuryMovement, "sale_id" | "expense_account_id" | "receipt_number" | "receipt_vat" | "proof_path" | "amount"> &
  Partial<Pick<TreasuryMovement, "sale_id" | "expense_account_id" | "receipt_number" | "proof_path">> & {
    amount: unknown;
    receipt_vat?: unknown;
  };

function normMovement(m: RawMovement): TreasuryMovement {
  return {
    ...m,
    amount: Number(m.amount),
    sale_id: m.sale_id ?? null,
    expense_account_id: m.expense_account_id ?? null,
    receipt_number: m.receipt_number ?? null,
    receipt_vat: m.receipt_vat == null ? null : Number(m.receipt_vat),
    proof_path: m.proof_path ?? null,
  };
}

export const treasuryApi = {
  accounts: async (opts: { includeArchived?: boolean } = {}): Promise<TreasuryAccount[]> => {
    const tid = await tenantId();
    const run = async (cols: string) => {
      let q = from("treasury_accounts").select(cols).eq("tenant_id", tid).order("name");
      if (!opts.includeArchived) q = q.is("deleted_at", null);
      return q;
    };
    let { data, error } = await run(ACCOUNT_COLS);
    // Base sin la migración H150: columnas nuevas ausentes.
    if (error && isMissingSchema(error)) ({ data, error } = await run(ACCOUNT_BASE_COLS));
    if (error) throw error;
    return ((data ?? []) as unknown as RawAccount[]).map(normAccount);
  },

  saveAccount: async (id: string | null, v: TreasuryAccountInput): Promise<void> => {
    const { provider_key, ...rest } = v;
    const row = {
      ...rest,
      ...(v.kind === "wallet" ? { provider_key: provider_key ?? "otro" } : {}),
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

  /**
   * Posición (H150): todas las cuentas con su saldo, incluidas las cajas del POS
   * y lo a acreditar. Sin la migración, arma lo mismo con la vista de saldos.
   */
  position: async (): Promise<TreasuryPosition[]> => {
    const { data, error } = await createClient().rpc("treasury_position" as never);
    if (error) {
      if (!isMissingSchema(error)) throw error;
      const [accounts, balances] = await Promise.all([treasuryApi.accounts(), treasuryApi.balances()]);
      const byId = new Map(balances.map((b) => [b.account_id, b]));
      return accounts.map((a) => {
        const b = byId.get(a.id);
        return {
          account_id: a.id,
          kind: a.kind,
          name: a.name,
          currency: a.currency,
          store_id: a.store_id,
          provider_key: a.provider_key,
          cash_register_id: a.cash_register_id,
          is_active: a.is_active,
          is_system: a.is_system,
          balance: b?.balance ?? a.opening_balance,
          reconciled_balance: b?.reconciled_balance ?? a.opening_balance,
          unreconciled_count: b?.unreconciled_count ?? 0,
          last_movement: b?.last_movement ?? null,
          detail: null,
          transfer_accounts: [],
          ledger_account: null,
        };
      });
    }
    const rows = (Array.isArray(data) ? data : []) as unknown as TreasuryPosition[];
    return rows.map((r) => ({
      ...r,
      balance: Number(r.balance) || 0,
      reconciled_balance: Number(r.reconciled_balance) || 0,
      unreconciled_count: Number(r.unreconciled_count) || 0,
      is_system: Boolean(r.is_system),
      transfer_accounts: Array.isArray(r.transfer_accounts) ? r.transfer_accounts : [],
      ledger_account: r.ledger_account ?? null,
      detail: r.detail
        ? {
            ...r.detail,
            counted: r.detail.counted == null ? null : Number(r.detail.counted),
            pending_count: Number(r.detail.pending_count ?? 0),
          }
        : null,
    }));
  },

  /** Crea las cuentas de sistema que falten (cajas del POS, a acreditar). Silenciosa sin la migración. */
  syncAccounts: async (): Promise<number> => {
    const { data, error } = await createClient().rpc("treasury_accounts_sync" as never);
    if (error) {
      if (isMissingSchema(error)) return 0;
      throw error;
    }
    return Number(data ?? 0);
  },

  linkTransfer: (treasuryId: string, transferId: string, linked: boolean) =>
    rpc<number>("treasury_account_link_transfer", { p_treasury: treasuryId, p_transfer: transferId, p_linked: linked }),

  createLedgerAccount: (accountId: string) => rpc<string>("treasury_account_ledger_create", { p_account: accountId }),

  pendingCollections: async (provider: string | null): Promise<PendingCollection[]> => {
    const { data, error } = await createClient().rpc("treasury_pending_collections" as never, { p_provider: provider } as never);
    if (error) {
      if (isMissingSchema(error)) return [];
      throw error;
    }
    return ((data ?? []) as unknown as PendingCollection[]).map((r) => ({
      ...r,
      amount: Number(r.amount),
      sale_number: r.sale_number == null ? null : Number(r.sale_number),
    }));
  },

  movements: async (f: {
    accountId?: string | null;
    from?: string | null;
    to?: string | null;
    includeVoided?: boolean;
    onlyUnreconciled?: boolean;
  }): Promise<TreasuryMovement[]> => {
    const tid = await tenantId();
    const run = async (cols: string) => {
      let q = from("treasury_movements")
        .select(cols)
        .eq("tenant_id", tid)
        .order("movement_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1000);
      if (f.accountId) q = q.eq("account_id", f.accountId);
      if (f.from) q = q.gte("movement_date", f.from);
      if (f.to) q = q.lte("movement_date", f.to);
      if (!f.includeVoided) q = q.is("voided_at", null);
      if (f.onlyUnreconciled) q = q.is("reconciled_at", null);
      return q;
    };
    let { data, error } = await run(MOVEMENT_COLS);
    if (error && isMissingSchema(error)) ({ data, error } = await run(MOVEMENT_BASE_COLS));
    if (error) throw error;
    return ((data ?? []) as unknown as RawMovement[]).map(normMovement);
  },

  /** Un movimiento por id (para resaltarlo desde "Ver origen" aunque esté fuera del filtro). */
  movement: async (id: string): Promise<TreasuryMovement | null> => {
    const tid = await tenantId();
    const run = async (cols: string) => from("treasury_movements").select(cols).eq("tenant_id", tid).eq("id", id).maybeSingle();
    let { data, error } = await run(MOVEMENT_COLS);
    if (error && isMissingSchema(error)) ({ data, error } = await run(MOVEMENT_BASE_COLS));
    if (error) throw error;
    return data ? normMovement(data as unknown as RawMovement) : null;
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

  /** Sube el comprobante de un gasto al bucket privado y devuelve la ruta (`<tenant>/<uuid>.<ext>`). */
  uploadProof: async (file: File): Promise<string> => {
    const tid = await tenantId();
    const raw = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const ext = raw === "jpeg" ? "jpg" : raw || "bin";
    const path = `${tid}/${crypto.randomUUID()}.${ext}`;
    const { error } = await createClient()
      .storage.from(PROOF_BUCKET)
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw error;
    return path;
  },

  /** Link temporal (5 minutos) para ver el adjunto. */
  proofUrl: async (path: string): Promise<string> => {
    const { data, error } = await createClient().storage.from(PROOF_BUCKET).createSignedUrl(path, 300);
    if (error) throw error;
    return data.signedUrl;
  },

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
