// Cuenta corriente v2: cliente de las RPC server-side.
//
// Todas las ESCRITURAS del ledger van por RPC security definer (el insert
// directo está revocado): cobro (account_collect), anulación de cobro,
// condonación de interés, ajustes, config y cobranza. Las lecturas pesadas
// (estado de cuenta, aging) también se resuelven en el server.
import { createClient } from "@/lib/supabase/client";
import type { Json } from "@/types/database";
import {
  ACCOUNT_CONFIG_DEFAULT,
  effectiveAccountConfig,
  parseOverride,
  type AccountConfig,
  type AccountConfigOverride,
} from "@/lib/account/config";

export type MovementKind =
  | "charge"
  | "payment"
  | "interest"
  | "interest_waiver"
  | "adjust_debit"
  | "adjust_credit"
  | "reversal";

export type CollectMethod = "cash" | "debit" | "credit" | "transfer" | "qr" | "other";

export interface StatementMovement {
  id: string;
  kind: MovementKind;
  delta: number;
  reason: string | null;
  note: string | null;
  created_at: string;
  due_date: string | null;
  sale_id: string | null;
  installment_no: number | null;
  installments: number | null;
  parent_id: string | null;
  method: string | null;
  receipt_no: number | null;
  period: string | null;
  voided_at: string | null;
  running: number;
}

export interface OpenItemRow {
  id: string;
  kind: "charge" | "interest" | "adjust_debit";
  reason: string | null;
  due_date: string | null;
  created_at: string;
  amount: number;
  open: number;
  sale_id: string | null;
  installment_no: number | null;
  installments: number | null;
  parent_id: string | null;
  days_overdue: number;
}

export interface CollectionItem {
  id: string;
  type: "note" | "promise" | "task" | "reminder_log";
  body: string | null;
  promise_date: string | null;
  promise_amount: number | null;
  status: "open" | "done" | "kept" | "broken" | "cancelled" | "sent" | "failed";
  due_at: string | null;
  assignee: string | null;
  done_at: string | null;
  channel: string | null;
  created_at: string;
  created_by: string | null;
}

export interface AccountStatement {
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    document_type: string | null;
    document_number: string | null;
    credit_limit: number;
    credit_status: "ok" | "watch" | "blocked";
    collector_user_id: string | null;
    account_config: AccountConfigOverride | null;
    group_id: string | null;
  };
  config: AccountConfig;
  as_of: string;
  from: string;
  to: string;
  balance: number;
  available: number | null;
  opening_balance: number;
  movements: StatementMovement[];
  open_items: OpenItemRow[];
  overdue: number;
  interest_open: number;
  max_days_overdue: number;
  items: CollectionItem[];
}

export interface AgingRow {
  customer_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  credit_status: "ok" | "watch" | "blocked";
  credit_limit: number;
  collector_user_id: string | null;
  balance: number;
  total: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  overdue: number;
  interest: number;
  max_days_overdue: number;
  oldest_due: string | null;
  next_due: string | null;
  last_payment_at: string | null;
  promise: { id: string; date: string; amount: number; broken: boolean } | null;
  open_tasks: number;
}

export interface AgingResult {
  as_of: string;
  totals: {
    total: number;
    current: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90_plus: number;
    overdue: number;
    due_next_7: number;
    customers: number;
    customers_overdue: number;
    interest_month: number;
    collected_month: number;
  };
  customers: AgingRow[];
}

export interface PosAccountInfo {
  balance: number;
  credit_limit: number;
  available: number | null;
  overdue: number;
  max_days_overdue: number;
  credit_status: "ok" | "watch" | "blocked";
  blocked: "account_blocked" | "account_overdue_blocked" | null;
  override_allowed: boolean;
  can_override: boolean;
  installments: AccountConfig["installments"];
  terms: AccountConfig["terms"];
  first_due: string;
}

export interface CollectResult {
  payment_id: string;
  receipt_no: number;
  amount: number;
  method: string;
  created_at: string;
  customer_id: string;
  customer_name: string;
  note: string | null;
  balance: number;
  allocations: { charge_id: string; amount: number; reason: string | null; kind: string; due_date: string | null }[];
  unapplied: number;
  idempotent?: boolean;
}

export interface TeamMember {
  user_id: string;
  name: string;
  role: string;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  // Las RPC nuevas están en types/database.ts; el cast evita acoplar cada
  // llamada a la firma generada (args opcionales con null).
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export const accountApi = {
  posInfo: (customerId: string) =>
    rpc<PosAccountInfo>("account_pos_info", { p_customer_id: customerId }),

  statement: (customerId: string, from?: string | null, to?: string | null) =>
    rpc<AccountStatement>("account_statement", {
      p_customer_id: customerId,
      p_from: from || null,
      p_to: to || null,
    }),

  aging: (asOf?: string | null) => rpc<AgingResult>("account_aging", { p_as_of: asOf || null }),

  collect: (input: {
    customerId: string;
    amount: number;
    method: CollectMethod;
    allocations?: { id: string; amount: number }[] | null;
    idempotencyKey: string;
    note?: string | null;
  }) =>
    rpc<CollectResult>("account_collect", {
      p_customer_id: input.customerId,
      p_amount: input.amount,
      p_method: input.method,
      p_allocations: (input.allocations && input.allocations.length > 0
        ? input.allocations
        : null) as unknown as Json,
      p_idempotency_key: input.idempotencyKey,
      p_note: input.note || null,
    }),

  voidPayment: (movementId: string, reason: string) =>
    rpc<{ ok: boolean; balance: number }>("account_void_payment", {
      p_movement_id: movementId,
      p_reason: reason,
    }),

  waiveInterest: (movementId: string, amount: number, reason: string) =>
    rpc<{ ok: boolean; waived: number; balance: number }>("account_waive_interest", {
      p_movement_id: movementId,
      p_amount: amount,
      p_reason: reason,
    }),

  adjust: (input: {
    customerId: string;
    kind: "adjust_debit" | "adjust_credit";
    amount: number;
    reason: string;
    dueDate?: string | null;
  }) =>
    rpc<{ ok: boolean; balance: number }>("account_adjust", {
      p_customer_id: input.customerId,
      p_kind: input.kind,
      p_amount: input.amount,
      p_reason: input.reason,
      p_due_date: input.dueDate || null,
    }),

  accrueInterest: () => rpc<{ as_of: string; movements: number }>("account_accrue_interest", {}),

  // Config del negocio (override parcial guardado) + efectiva.
  tenantConfig: async (): Promise<{ saved: AccountConfigOverride | null; effective: AccountConfig }> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("pos_settings")
      .select("account_config, account_due_days")
      .maybeSingle();
    const saved = parseOverride(data?.account_config ?? null);
    return {
      saved,
      effective: effectiveAccountConfig(saved, null, null, data?.account_due_days ?? null),
    };
  },

  saveSettings: (config: AccountConfig) =>
    rpc<AccountConfig>("account_save_settings", { p_config: config as unknown as Json }),

  setCustomerTerms: (input: {
    customerId: string;
    config: AccountConfigOverride | null;
    creditLimit: number;
    creditStatus: "ok" | "watch" | "blocked";
    collector: string | null;
  }) =>
    rpc<{ ok: boolean; config: AccountConfig }>("account_set_customer_terms", {
      p_customer_id: input.customerId,
      p_config: (input.config as unknown as Json) ?? null,
      p_credit_limit: input.creditLimit,
      p_credit_status: input.creditStatus,
      p_collector: input.collector,
    }),

  addItem: (input: {
    customerId: string;
    type: "note" | "promise" | "task" | "reminder_log";
    body?: string | null;
    promiseDate?: string | null;
    promiseAmount?: number | null;
    dueAt?: string | null;
    assignee?: string | null;
    channel?: "whatsapp" | null;
  }) =>
    rpc<string>("account_add_collection_item", {
      p_customer_id: input.customerId,
      p_type: input.type,
      p_body: input.body || null,
      p_promise_date: input.promiseDate || null,
      p_promise_amount: input.promiseAmount ?? null,
      p_due_at: input.dueAt || null,
      p_assignee: input.assignee || null,
      p_channel: input.channel || null,
    }),

  updateItem: (id: string, status: CollectionItem["status"], remove = false) =>
    rpc<null>("account_update_collection_item", { p_id: id, p_status: status, p_delete: remove }),

  // Envío manual del estado de cuenta por email (Edge account_reminders).
  sendStatement: async (customerId: string, to?: string | null): Promise<void> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("account_reminders", {
      body: { customer_id: customerId, to: to || undefined },
    });
    if (error) {
      // supabase-js envuelve el body de error: lo leemos para dar un mensaje útil.
      const ctx = (error as { context?: Response }).context;
      let detail = "";
      try {
        const body = ctx ? await ctx.json() : null;
        detail = body?.error ?? "";
      } catch {
        /* noop */
      }
      throw new Error(detail || error.message);
    }
    if ((data as { error?: string } | null)?.error) throw new Error((data as { error: string }).error);
  },

  // Miembros del equipo (cobrador / responsable de tareas).
  team: async (): Promise<TeamMember[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("tenant_members");
    if (error) return [];
    return (data ?? [])
      .filter((m) => m.status === "active")
      .map((m) => ({
        user_id: m.user_id,
        name: m.display_name || m.full_name || m.email || "Sin nombre",
        role: m.role,
      }));
  },
};

export { ACCOUNT_CONFIG_DEFAULT };

// Mensajes de error de las RPC de cuenta corriente (códigos estables del SQL).
const ERRORS: [string, string][] = [
  ["feature_not_in_plan: cc_punitorios", "Los punitorios no están incluidos en tu plan"],
  ["feature_not_in_plan: cc_cobranza", "La gestión de cobranza no está incluida en tu plan"],
  ["feature_not_in_plan: cuenta_corriente", "La cuenta corriente no está incluida en tu plan"],
  ["account_overdue_blocked", "El cliente tiene deuda vencida y la cuenta está bloqueada"],
  ["account_blocked", "La cuenta del cliente está bloqueada"],
  ["credit_limit_exceeded", "Supera el límite de cuenta corriente del cliente"],
  ["installments_not_allowed", "Esa cantidad de cuotas no está habilitada"],
  ["no_open_shift", "Abrí la caja para registrar el cobro"],
  ["allocation_exceeds_open", "La imputación supera el saldo de un cargo"],
  ["allocation_exceeds_payment", "La imputación supera el monto cobrado"],
  ["allocation_unknown_item", "Uno de los cargos elegidos ya no está pendiente"],
  ["reason_required", "Escribí el motivo"],
  ["already_voided", "Ese cobro ya estaba anulado"],
  ["invalid_amount", "Revisá el monto"],
  ["invalid_account_config", "Revisá la configuración: hay valores fuera de rango"],
  ["collector_not_member", "El cobrador elegido no es parte del equipo"],
  ["tenant_smtp_not_configured", "Configurá el email de tu negocio en Configuración, sección Email"],
  ["invalid_to", "El cliente no tiene un email válido"],
  ["payment_method_not_allowed", "Ese medio de pago no está incluido en tu plan"],
  ["forbidden", "No tenés permiso para esta acción"],
];

export function accountErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [code, text] of ERRORS) if (msg.includes(code)) return text;
  return msg || "No se pudo completar la operación";
}

// Clave de idempotencia para un intento de cobro (se genera al abrir el form).
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function configOrDefault(c: AccountConfig | null | undefined): AccountConfig {
  return c ?? ACCOUNT_CONFIG_DEFAULT;
}
