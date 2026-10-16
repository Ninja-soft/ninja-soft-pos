"use client";

// Cheques (F18 · H111, ADR-059; F23 · H154-H155, ADR-158): cartera de terceros
// y propios con su vencimiento, depositar, debitar y rechazar. Recibir uno de
// terceros arma su asiento; el rechazo de uno propio vuelve a dejar la deuda.

import { useState } from "react";
import { Banknote, Plus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  CHEQUE_KIND_LABEL,
  CHEQUE_STATUS_LABEL,
  CHEQUE_STATUS_TONE,
  actionLabel,
  daysToPayment,
  manualActions,
  type ChequeKind,
  type ChequeStatus,
} from "@/lib/treasury/cheques";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import { useCheques, useTreasuryAccess } from "@/modules/treasury/hooks";
import type { Cheque } from "@/modules/treasury/api";
import { ViewEntryButton } from "@/components/accounting/ViewEntryButton";
import { fmtDate, supplierName, today } from "@/components/purchases/shared";
import { ChequeActionModal, ChequeFormModal } from "./TreasuryModals";
import { TreasuryFrame, TreasuryStat } from "./TreasuryFrame";

export function ChequesView() {
  const access = useTreasuryAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const [chequeOpen, setChequeOpen] = useState(false);
  return (
    <TreasuryFrame
      title="Cheques"
      icon={Banknote}
      description="Cheques que recibiste y que diste, con su vencimiento. Los propios nacen en las órdenes de pago."
      actions={
        canManage ? (
          <Button onClick={() => setChequeOpen(true)}>
            <Plus size={16} /> Cheque de terceros
          </Button>
        ) : undefined
      }
    >
      {access.enabled && <ChequesTable canManage={canManage} onNew={() => setChequeOpen(true)} />}
      <ChequeFormModal open={chequeOpen} onOpenChange={setChequeOpen} />
    </TreasuryFrame>
  );
}

function ChequesTable({ canManage, onNew }: { canManage: boolean; onNew: () => void }) {
  const [kind, setKind] = useState<ChequeKind | "all">("third_party");
  const [status, setStatus] = useState<"open" | "all">("open");
  const { data: cheques = [], isLoading } = useCheques({
    kind: kind === "all" ? null : kind,
    statuses: status === "open" ? ["en_cartera", "entregado"] : null,
  });
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true });
  const [action, setAction] = useState<{ cheque: Cheque; to: ChequeStatus } | null>(null);
  const now = today();
  const inWallet = cheques.filter((c) => c.kind === "third_party" && c.status === "en_cartera");
  const ownPending = cheques.filter((c) => c.kind === "own" && c.status === "entregado");

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TreasuryStat label={`En cartera (${inWallet.length})`} value={formatCurrency(inWallet.reduce((t, c) => t + c.amount, 0))} />
        <TreasuryStat
          label={`Propios a debitar (${ownPending.length})`}
          value={formatCurrency(ownPending.reduce((t, c) => t + c.amount, 0))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Segmented<ChequeKind | "all">
          aria-label="Tipo"
          value={kind}
          onChange={setKind}
          size="sm"
          options={[
            { value: "third_party", label: "De terceros" },
            { value: "own", label: "Propios" },
            { value: "all", label: "Todos" },
          ]}
        />
        <Segmented<"open" | "all">
          aria-label="Estado"
          value={status}
          onChange={setStatus}
          size="sm"
          options={[
            { value: "open", label: "Pendientes" },
            { value: "all", label: "Historial" },
          ]}
        />
      </div>
      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cheque</th>
              <th className="px-4 py-3">Fecha de pago</th>
              <th className="hidden px-4 py-3 md:table-cell">De / para</th>
              <th className="px-4 py-3 text-right">Importe</th>
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {!isLoading && cheques.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState
                  compact
                  icon={Banknote}
                  title="No tenés cheques en cartera"
                  description="Registrá los cheques de terceros que recibís; los propios nacen en las órdenes de pago."
                  action={
                    canManage ? (
                      <Button size="sm" onClick={onNew}>
                        <Plus size={14} /> Cheque de terceros
                      </Button>
                    ) : undefined
                  }
                />
              </TableStateRow>
            )}
            {cheques.map((c) => {
              const days = daysToPayment(c.payment_date, now);
              return (
                <tr key={c.id}>
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium">
                      {c.is_echeq ? "E-cheq" : "Cheque"} N° {c.number}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {CHEQUE_KIND_LABEL[c.kind]}
                      {c.bank_name ? ` · ${c.bank_name}` : ""}
                    </div>
                    <div className="mt-1">
                      <Badge tone={CHEQUE_STATUS_TONE[c.status]}>{CHEQUE_STATUS_LABEL[c.status]}</Badge>
                    </div>
                    <ViewEntryButton sourceType="cheque" sourceId={c.id} className="-ml-2 mt-1" />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div>{fmtDate(c.payment_date)}</div>
                    {(c.status === "en_cartera" || c.status === "entregado") && (
                      <div className={cn("text-xs", days <= 0 ? "text-warning" : "text-muted-foreground")}>
                        {days <= 0 ? "Ya se puede cobrar" : `En ${days} días`}
                      </div>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 align-top md:table-cell">
                    {c.kind === "third_party" ? (
                      <>
                        <div>{c.drawer_name ?? c.received_from ?? ""}</div>
                        {c.delivered_to_supplier_id && (
                          <div className="text-xs text-muted-foreground">
                            Entregado a {supplierName(suppliers, c.delivered_to_supplier_id)}
                          </div>
                        )}
                      </>
                    ) : (
                      <div>{c.delivered_to_supplier_id ? supplierName(suppliers, c.delivered_to_supplier_id) : ""}</div>
                    )}
                    {c.reject_reason && <div className="text-xs text-danger">{c.reject_reason}</div>}
                  </td>
                  <td className="px-4 py-3 text-right align-top font-semibold tabular-nums">{formatCurrency(c.amount)}</td>
                  <td className="px-2 py-3 text-right align-top">
                    {canManage && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {manualActions(c.kind, c.status).map((to) => (
                          <Button
                            key={to}
                            size="sm"
                            variant={to === "rechazado" ? "ghost" : "secondary"}
                            className={cn(to === "rechazado" && "text-danger")}
                            onClick={() => setAction({ cheque: c, to })}
                          >
                            {actionLabel(c.kind, to)}
                          </Button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <ChequeActionModal cheque={action?.cheque ?? null} to={action?.to ?? null} onOpenChange={(o) => !o && setAction(null)} />
    </div>
  );
}
