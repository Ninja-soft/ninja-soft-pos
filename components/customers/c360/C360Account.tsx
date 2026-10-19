"use client";

import Link from "next/link";
import { useState } from "react";
import { FileDown, Mail, Wallet } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { useAccountMutations, useAccountStatement } from "@/modules/customers/hooks";
import { accountErrorMessage } from "@/modules/customers/account";
import { downloadCustomerStatement, statementRows } from "@/components/account/statementExport";

const SHOWN = 8;

// Cuenta Debe / Haber (ADR-169): los últimos movimientos de la cuenta
// corriente con saldo corrido, el estado de cuenta en PDF (el mismo de la
// ficha de cuenta corriente) y el envío por email. No duplica la cuenta:
// lee account_statement.
export function C360Account({ customerId }: { customerId: string }) {
  const { toast } = useToast();
  const { data: st, isLoading, isError } = useAccountStatement(customerId);
  const m = useAccountMutations();
  const [pdfBusy, setPdfBusy] = useState(false);

  const rows = st ? statementRows(st) : [];
  const last = rows.slice(-SHOWN).reverse();

  async function pdf() {
    if (!st) return;
    setPdfBusy(true);
    try {
      await downloadCustomerStatement(st);
    } catch {
      toast({ title: "No se pudo armar el PDF", variant: "error" });
    } finally {
      setPdfBusy(false);
    }
  }

  async function send() {
    if (!st) return;
    try {
      await m.sendStatement.mutateAsync({ customerId: st.customer.id });
      toast({ title: `Estado de cuenta enviado a ${st.customer.email}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo enviar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Wallet size={15} className="text-muted-foreground" /> Cuenta Debe / Haber
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Debe suma deuda (compras en cuenta, intereses); Haber la baja (pagos, ajustes).
          </p>
        </div>
        {st && (
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Saldo</div>
            <div className={cn("text-lg font-semibold tabular-nums", Number(st.balance) > 0 && Number(st.overdue) > 0 && "text-danger")}>
              {formatCurrency(Number(st.balance))}
            </div>
            {Number(st.overdue) > 0 && <div className="text-xs text-danger">{formatCurrency(Number(st.overdue))} vencido</div>}
          </div>
        )}
      </div>

      <div className="mt-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando la cuenta...</p>
        ) : isError || !st ? (
          <p className="text-sm text-danger">No se pudo cargar la cuenta corriente.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin movimientos en la cuenta corriente.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">Fecha</th>
                  <th className="py-1.5 pr-2 font-medium">Concepto</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Debe</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Haber</th>
                  <th className="py-1.5 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {last.map((r, i) => (
                  <tr key={`${r.date}-${i}`}>
                    <td className="whitespace-nowrap py-2 pr-2 text-xs text-muted-foreground">{r.date}</td>
                    <td className="py-2 pr-2">{r.concept}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.debit != null ? formatCurrency(r.debit) : ""}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-success">{r.credit != null ? formatCurrency(r.credit) : ""}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{formatCurrency(r.running)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > SHOWN && (
              <p className="mt-2 text-xs text-muted-foreground">
                Últimos {SHOWN} de {rows.length} movimientos. El PDF trae todos.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void pdf()} loading={pdfBusy} disabled={!st}>
          <FileDown size={15} /> Estado de cuenta PDF
        </Button>
        <Button
          variant="secondary"
          onClick={() => void send()}
          loading={m.sendStatement.isPending}
          disabled={!st?.customer.email}
          title={!st?.customer.email ? "El cliente no tiene email cargado" : undefined}
        >
          <Mail size={15} /> Enviar por email
        </Button>
        <Link href={`/clientes/cuentas/${customerId}`} className={buttonVariants({ variant: "ghost" })}>
          Ver la cuenta completa
        </Link>
      </div>
    </section>
  );
}
