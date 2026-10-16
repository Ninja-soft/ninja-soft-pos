"use client";

// A acreditar (F23 · H155, ADR-158): lo que ya vendiste con tarjeta, QR o
// billeteras y el procesador todavía no te depositó, por procesador.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Clock3, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { formatCurrency } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { providerLabel } from "@/lib/treasury/accounts";
import { groupPendingByDate, pendingWithin } from "@/lib/treasury/cashflow";
import { usePendingCollections, useTreasuryAccess, useTreasuryPosition } from "@/modules/treasury/hooks";
import { fmtDate } from "@/components/purchases/shared";
import { TreasuryFrame, TreasuryStat } from "./TreasuryFrame";

export function PendingView() {
  const access = useTreasuryAccess();
  return (
    <TreasuryFrame
      title="A acreditar"
      icon={Clock3}
      description="Lo que ya vendiste y el procesador todavía no te depositó. Es un estimado de los últimos 180 días: se baja cuando la liquidación se concilia."
      actions={
        <Link href="/tesoreria/conciliacion">
          <Button variant="secondary">Ir a Conciliación</Button>
        </Link>
      }
    >
      {access.enabled && <PendingBody />}
    </TreasuryFrame>
  );
}

function PendingBody() {
  const [provider, setProvider] = useState<string>("all");
  const { data: position = [] } = useTreasuryPosition();
  const { data: rows = [], isLoading } = usePendingCollections(provider === "all" ? null : provider);
  const receivables = useMemo(
    () => position.filter((p) => p.kind === "receivable" && p.is_active).sort((a, b) => b.balance - a.balance),
    [position],
  );
  const total = receivables.reduce((t, r) => t + (r.currency === "ARS" ? r.balance : 0), 0);
  const byDate = useMemo(() => groupPendingByDate(rows), [rows]);
  const week = useMemo(() => pendingWithin(rows, 7), [rows]);
  const options = [
    { value: "all", label: "Todos" },
    ...receivables.filter((r) => r.provider_key).map((r) => ({ value: r.provider_key!, label: providerLabel(r.provider_key) })),
  ];

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <TreasuryStat label="Total a acreditar" value={formatCurrency(total)} hint="Estimado" />
        <TreasuryStat label="Entra en los próximos 7 días" value={formatCurrency(week)} hint="Por la fecha de cada liquidación o la estimada" />
        {receivables.slice(0, 1).map((r) => (
          <TreasuryStat
            key={r.account_id}
            label={providerLabel(r.provider_key)}
            value={formatCurrency(r.balance)}
            hint={r.detail?.pending_count ? `${r.detail.pending_count} cobros` : undefined}
          />
        ))}
      </div>
      {options.length > 2 && (
        <Segmented<string> scrollOnMobile aria-label="Procesador" value={provider} onChange={setProvider} size="sm" options={options} />
      )}
      {byDate.length > 0 && (
        <div className="slim-scrollbar flex gap-2 overflow-x-auto pb-1">
          {byDate.slice(0, 10).map((d) => (
            <div key={d.date} className="min-w-[8.5rem] shrink-0 rounded-md bg-muted/40 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {d.date ? fmtDate(d.date) : "Sin fecha"}
                {d.estimated ? " · estimado" : ""}
              </div>
              <div className="font-semibold tabular-nums">{formatCurrency(d.amount)}</div>
              <div className="text-xs text-muted-foreground">
                {d.count} {d.count === 1 ? "cobro" : "cobros"}
              </div>
            </div>
          ))}
        </div>
      )}
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Cobro</th>
              <th className="hidden px-4 py-3 md:table-cell">Procesador</th>
              <th className="px-4 py-3">Se acredita</th>
              <th className="px-4 py-3 text-right">Importe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {!isLoading && rows.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState
                  compact
                  icon={Clock3}
                  title="No tenés cobros pendientes de acreditar"
                  description="Conectá Mercado Pago o subí la liquidación de tu adquirente para que se concilie sola."
                  action={
                    <Link href="/tesoreria/conciliacion">
                      <Button size="sm" variant="secondary">
                        Ir a Conciliación
                      </Button>
                    </Link>
                  }
                />
              </TableStateRow>
            )}
            {rows.map((r) => (
              <tr key={r.payment_id}>
                <td className="whitespace-nowrap px-4 py-3">{fmtDate(r.created_at.slice(0, 10))}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{PAYMENT_METHOD_LABELS[r.method] ?? r.method}</div>
                  {r.sale_id && (
                    <Link
                      href={`/ventas?venta=${r.sale_id}` as never}
                      className="inline-flex items-center gap-1 text-xs text-ninja-flameSoft hover:underline"
                    >
                      Venta {r.sale_number ? `#${r.sale_number}` : ""} <ExternalLink size={11} />
                    </Link>
                  )}
                  <div className="text-xs text-muted-foreground md:hidden">{providerLabel(r.provider_key)}</div>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">{providerLabel(r.provider_key)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  {r.expected_date ? fmtDate(r.expected_date) : "Sin fecha"}
                  {r.expected_date && !r.expected_known && (
                    <span className="block text-xs text-muted-foreground">estimado</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatCurrency(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted-foreground">
        Mercado Pago se concilia solo todos los días. Para tarjetas con posnet (Payway, Fiserv, Getnet, Nave) subí la
        liquidación en Conciliación: lo que coincide deja de figurar acá y el neto entra al banco o billetera donde te
        acreditan. Sin liquidación, la fecha es un estimado: débito 2 días, crédito 14, QR y billeteras 1.
      </p>
    </div>
  );
}
