// Estado de cuenta: concepto legible de cada movimiento y descarga en PDF.
// Compartido por la ficha de cuenta corriente y la ficha del cliente 360
// (ADR-169) para que el PDF sea el mismo en los dos lados.
import { downloadStatementPdf, type StatementPdfRow } from "@/lib/account/statementPdf";
import { interestConcept } from "@/lib/account/interest";
import type { AccountStatement, StatementMovement } from "@/modules/customers/account";
import { KIND_LABEL, METHOD_LABEL, fmtDate, fmtDateTime } from "@/components/account/shared";

export function movementConcept(m: StatementMovement): string {
  const base = KIND_LABEL[m.kind];
  if (m.kind === "payment") {
    return `${base}${m.receipt_no ? ` recibo #${m.receipt_no}` : ""}${m.method ? ` · ${METHOD_LABEL[m.method] ?? m.method}` : ""}`;
  }
  if (m.kind === "charge") return m.reason ?? base;
  if (m.kind === "interest") {
    const label = m.accrued_through ? interestConcept(m.period, m.accrued_through) : base;
    return `${label}${m.note ? ` · ${m.note}` : ""}`;
  }
  return `${base}${m.note ? ` · ${m.note}` : m.reason ? ` · ${m.reason}` : ""}`;
}

/** Filas Debe / Haber con saldo corrido (débito suma deuda, crédito la baja). */
export function statementRows(s: AccountStatement): StatementPdfRow[] {
  return s.movements.map((x) => ({
    date: fmtDateTime(x.created_at),
    concept: `${movementConcept(x)}${x.voided_at ? " (anulado)" : ""}`,
    due: fmtDate(x.due_date),
    debit: x.delta > 0 ? Number(x.delta) : null,
    credit: x.delta < 0 ? -Number(x.delta) : null,
    running: Number(x.running),
  }));
}

export async function downloadCustomerStatement(s: AccountStatement, business = ""): Promise<void> {
  await downloadStatementPdf({
    business,
    customer: s.customer.name,
    from: fmtDate(s.from),
    to: fmtDate(s.to),
    opening: Number(s.opening_balance),
    balance: Number(s.balance),
    overdue: Number(s.overdue),
    rows: statementRows(s),
    fileName: `estado-de-cuenta-${s.customer.name.replace(/\W+/g, "-").toLowerCase()}.pdf`,
  });
}
