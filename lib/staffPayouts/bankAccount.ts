// Cuentas de cobro del staff (F21 · ADR-121) ↔ editor compartido
// components/billing/BankAccountEditor (ADR-120). El payload normalizado es
// toAccountRow de lib/payments/transfer; el servidor vuelve a validar.

import { formatCuit, toAccountRow, type TransferAccountInput } from "@/lib/payments/transfer";
import type { BankAccountRow } from "@/modules/staffPayouts/api";

export function staffAccountInput(a: BankAccountRow): TransferAccountInput {
  return {
    bank_slug: a.bank_slug,
    bank_name: a.bank_name,
    holder_name: a.holder_name,
    cuit: a.cuit ? formatCuit(a.cuit) : "",
    cbu: a.cbu ?? "",
    alias: a.alias ?? "",
    account_type: a.account_type,
    currency: a.currency,
    note: a.note ?? "",
  };
}

export const staffAccountPayload = (v: TransferAccountInput) => toAccountRow(v);
