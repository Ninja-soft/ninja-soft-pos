"use client";

// Señas de turnos (ADR-088). La seña se cobra al reservar (entra a la caja de
// quien la cobra) y se descuenta al cobrar el turno en el POS: create_sale
// exige el pago 'sena' por lo disponible (hasta el total) y enlaza el turno.
// Escritura sólo por RPC (appointment_deposit_register / _refund); la tabla
// nueva no está en los tipos generados: se castea.

import { createClient } from "@/lib/supabase/client";

export type DepositMethod = "cash" | "transfer" | "debit" | "credit" | "qr";
export type DepositStatus = "held" | "applied" | "refunded";

export interface AppointmentDeposit {
  id: string;
  appointment_id: string;
  method: DepositMethod;
  reference: string | null;
  amount: number;
  applied_amount: number;
  refunded_amount: number;
  status: DepositStatus;
  sale_id: string | null;
  refund_reason: string | null;
  created_at: string;
}

export const DEPOSIT_METHODS: { value: DepositMethod; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "transfer", label: "Transferencia" },
  { value: "debit", label: "Débito" },
  { value: "credit", label: "Crédito" },
  { value: "qr", label: "QR o billetera" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Lo que queda de una seña (sin aplicar ni devolver). */
export function depositLeft(d: Pick<AppointmentDeposit, "amount" | "applied_amount" | "refunded_amount">): number {
  return Math.max(0, round2(Number(d.amount) - Number(d.applied_amount) - Number(d.refunded_amount)));
}

/** Seña disponible para descontar al cobrar el turno (espejo de create_sale). */
export function depositAvailable(deposits: AppointmentDeposit[]): number {
  return round2(deposits.filter((d) => d.status === "held").reduce((a, d) => a + depositLeft(d), 0));
}

/** Lo que el POS manda como pago 'sena': la seña disponible, hasta el total. */
export function depositToApply(available: number, total: number): number {
  if (!(available > 0) || !(total > 0)) return 0;
  return round2(Math.min(available, total));
}

export function depositErrorMessage(msg: string): string {
  if (msg.includes("feature_not_in_plan: agenda_senas")) return "Tu plan no incluye señas de turnos.";
  if (msg.includes("no_open_shift")) return "Abrí tu caja para cobrar o devolver la seña.";
  if (msg.includes("appointment_already_charged")) return "El turno ya se cobró.";
  if (msg.includes("appointment_not_active")) return "El turno está cancelado o ausente.";
  if (msg.includes("invalid_amount")) return "Ingresá un monto válido.";
  if (msg.includes("method_not_in_plan")) return "Ese medio de pago no está en tu plan.";
  if (msg.includes("reason_required")) return "Escribí el motivo de la devolución.";
  if (msg.includes("deposit_not_refundable")) return "Esa seña ya no tiene saldo para devolver.";
  if (msg.includes("forbidden")) return "No tenés permiso para esta acción.";
  return "No se pudo guardar la seña.";
}

export const depositsApi = {
  list: async (appointmentId: string): Promise<AppointmentDeposit[]> => {
    const { data, error } = await createClient()
      .from("appointment_deposits" as never)
      .select(
        "id, appointment_id, method, reference, amount, applied_amount, refunded_amount, status, sale_id, refund_reason, created_at",
      )
      .eq("appointment_id", appointmentId)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as unknown as AppointmentDeposit[];
  },

  register: async (input: {
    appointmentId: string;
    amount: number;
    method: DepositMethod;
    reference?: string | null;
  }): Promise<string> => {
    const { data, error } = await createClient().rpc("appointment_deposit_register" as never, {
      p_appointment_id: input.appointmentId,
      p_amount: input.amount,
      p_method: input.method,
      p_reference: input.reference ?? null,
    } as never);
    if (error) throw error;
    return data as unknown as string;
  },

  refund: async (depositId: string, reason: string): Promise<void> => {
    const { error } = await createClient().rpc("appointment_deposit_refund" as never, {
      p_deposit_id: depositId,
      p_reason: reason,
    } as never);
    if (error) throw error;
  },
};
