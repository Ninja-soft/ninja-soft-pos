"use client";

// Flujo de fondos (F18 · H111, ADR-059; H155, ADR-158): cuánta plata vas a
// tener los próximos días si todo se cobra y se paga a tiempo.

import { useMemo, useState } from "react";
import { AlertTriangle, LineChart } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { agingBySupplier } from "@/lib/purchases/aging";
import { buildCashFlow, firstShortfall, type CashFlowGranularity } from "@/lib/treasury/cashflow";
import { treasuryTotals } from "@/lib/treasury/totals";
import { usePaymentAllocations, useSupplierEntries } from "@/modules/purchases/hooks";
import { useCheques, useReceivables, useTreasuryAccess, useTreasuryBalances } from "@/modules/treasury/hooks";
import { today } from "@/components/purchases/shared";
import { TreasuryFrame } from "./TreasuryFrame";

function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

export function CashFlowView() {
  const access = useTreasuryAccess();
  return (
    <TreasuryFrame
      title="Flujo de fondos"
      icon={LineChart}
      description="Cuánta plata vas a tener los próximos días si todo se cobra y se paga a tiempo."
    >
      {access.enabled && <CashFlowTable />}
    </TreasuryFrame>
  );
}

function CashFlowTable() {
  const [days, setDays] = useState<"30" | "60" | "90">("30");
  const [granularity, setGranularity] = useState<CashFlowGranularity>("week");
  const now = today();
  const to = addDays(now, Number(days));
  const { data: balances = [], isLoading } = useTreasuryBalances();
  const { data: receivables = [] } = useReceivables(to);
  const { data: entries = [] } = useSupplierEntries(null);
  const { data: allocations = [] } = usePaymentAllocations();
  const { data: cheques = [] } = useCheques({ statuses: ["en_cartera", "entregado"] });

  const start = treasuryTotals(balances).total;
  const payables = useMemo(() => {
    const out: Array<{ date: string; amount: number }> = [];
    for (const aging of agingBySupplier(entries, now, allocations).values()) {
      for (const d of aging.open) out.push({ date: d.due_date, amount: d.open });
    }
    return out;
  }, [entries, allocations, now]);

  const rows = buildCashFlow({
    startBalance: start,
    from: now,
    to,
    granularity,
    receivables: receivables.map((r) => ({ date: r.due_date, amount: r.amount })),
    chequesIn: cheques
      .filter((c) => c.kind === "third_party" && c.status === "en_cartera")
      .map((c) => ({ date: c.payment_date, amount: c.amount })),
    payables,
    chequesOut: cheques
      .filter((c) => c.kind === "own" && c.status === "entregado")
      .map((c) => ({ date: c.payment_date, amount: c.amount })),
  });
  const shortfall = firstShortfall(rows);
  const noAccounts = !isLoading && balances.filter((b) => b.kind !== "pos_cash" && b.kind !== "receivable").length === 0;

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<"30" | "60" | "90">
          aria-label="Horizonte"
          value={days}
          onChange={setDays}
          size="sm"
          options={[
            { value: "30", label: "30 días" },
            { value: "60", label: "60 días" },
            { value: "90", label: "90 días" },
          ]}
        />
        <Segmented<CashFlowGranularity>
          aria-label="Agrupar"
          value={granularity}
          onChange={setGranularity}
          size="sm"
          options={[
            { value: "day", label: "Por día" },
            { value: "week", label: "Por semana" },
            { value: "month", label: "Por mes" },
          ]}
        />
        <span className="text-sm text-muted-foreground sm:ml-auto">
          Saldo de hoy en tesorería <b className="tabular-nums text-foreground">{formatCurrency(start)}</b>
        </span>
      </div>
      {noAccounts && (
        <EmptyState
          compact
          icon={LineChart}
          title="Cargá tus cuentas para proyectar"
          description="El flujo arranca del saldo de tus bancos, billeteras y caja general. Sumalas en Posición."
        />
      )}
      {shortfall && (
        <Callout tone="danger" icon={AlertTriangle} title="Faltan fondos">
          Con lo que vence, el saldo queda en {formatCurrency(shortfall.balance)} en {shortfall.label.toLowerCase()}.
        </Callout>
      )}
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Período</th>
              <th className="px-4 py-3 text-right">Cobros de clientes</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Cheques a cobrar</th>
              <th className="px-4 py-3 text-right">Pagos a proveedores</th>
              <th className="hidden px-4 py-3 text-right md:table-cell">Cheques propios</th>
              <th className="px-4 py-3 text-right">Saldo proyectado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="px-4 py-3">{r.label}</td>
                <td className="px-4 py-3 text-right tabular-nums text-success">{r.receivables ? formatCurrency(r.receivables) : ""}</td>
                <td className="hidden px-4 py-3 text-right tabular-nums text-success md:table-cell">
                  {r.chequesIn ? formatCurrency(r.chequesIn) : ""}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-danger">{r.payables ? formatCurrency(r.payables) : ""}</td>
                <td className="hidden px-4 py-3 text-right tabular-nums text-danger md:table-cell">
                  {r.chequesOut ? formatCurrency(r.chequesOut) : ""}
                </td>
                <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", r.balance < 0 && "text-danger")}>
                  {formatCurrency(r.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted-foreground">
        Lo vencido y sin pagar (o sin cobrar) se proyecta en el primer período. Los comprobantes de proveedor salen de
        la cuenta corriente con la imputación de las órdenes de pago; los cobros, de la cuenta corriente de clientes.
      </p>
    </div>
  );
}
