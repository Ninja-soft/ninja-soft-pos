"use client";

import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { formatCurrency } from "@/lib/utils/format";
import { ENTRY_KIND_LABEL, EVENT_LABEL, SOURCE_LABEL, sourceLabel } from "@/lib/accounting/sources";
import { AccountSelect, AccountingFrame, RangeFields, currentMonthRange, fmtDate, selectCls } from "@/components/accounting/shared";
import { EntryDetailModal, ManualEntryModal } from "@/components/accounting/EntryModals";
import { useAccAccounts, useAccEntries } from "@/modules/accounting/hooks";
import type { AccEntry } from "@/modules/accounting/api";
import { useStores } from "@/modules/stock/hooks";
import { cn } from "@/lib/utils/cn";

const PAGE_SIZE = 50;

// Asientos (ADR-066): filtros, detalle con link al documento y manuales.
export default function AsientosPage() {
  const [manual, setManual] = useState(false);
  return (
    <PageContainer size="2xl">
      <AccountingFrame
        title="Asientos"
        description="El Libro Diario del negocio: lo automático de cada operación y lo que cargues a mano."
        actions={
          <Button onClick={() => setManual(true)}>
            <Plus size={16} /> Asiento manual
          </Button>
        }
      >
        <EntriesList />
        <ManualEntryModal open={manual} onOpenChange={setManual} />
      </AccountingFrame>
    </PageContainer>
  );
}

function EntriesList() {
  const [range, setRange] = useState(currentMonthRange());
  const [sourceType, setSourceType] = useState("");
  const [storeId, setStoreId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AccEntry | null>(null);
  const { data: stores = [] } = useStores();
  const { data: accounts = [] } = useAccAccounts();
  const { data, isLoading, isFetching } = useAccEntries(
    { from: range.from, to: range.to, sourceType: sourceType || null, storeId: storeId || null, accountId: accountId || null, search },
    page,
    PAGE_SIZE,
  );
  const rows = data?.rows ?? [];
  const reset = () => setPage(1);

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <RangeFields
          from={range.from}
          to={range.to}
          onChange={(v) => {
            setRange(v);
            reset();
          }}
        />
        <SearchField
          value={search}
          onValueChange={(v: string) => {
            setSearch(v);
            reset();
          }}
          placeholder="Buscar en la leyenda"
          className="min-w-[200px] flex-1"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select
          aria-label="Origen"
          className={cn(selectCls, "h-10")}
          value={sourceType}
          onChange={(e) => {
            setSourceType(e.target.value);
            reset();
          }}
        >
          <option value="" className="bg-popover text-popover-foreground">Todos los orígenes</option>
          <option value="manual" className="bg-popover text-popover-foreground">Manuales y aperturas</option>
          {Object.entries(SOURCE_LABEL)
            .filter(([k]) => k !== "acc_entry")
            .map(([k, label]) => (
              <option key={k} value={k} className="bg-popover text-popover-foreground">
                {label}
              </option>
            ))}
        </select>
        <select
          aria-label="Sucursal"
          className={cn(selectCls, "h-10")}
          value={storeId}
          onChange={(e) => {
            setStoreId(e.target.value);
            reset();
          }}
        >
          <option value="" className="bg-popover text-popover-foreground">Todas las sucursales</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
              {s.name}
            </option>
          ))}
        </select>
        <AccountSelect
          accounts={accounts}
          value={accountId}
          placeholder="Todas las cuentas"
          onChange={(v) => {
            setAccountId(v);
            reset();
          }}
        />
      </div>

      <TableWrap>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">N°</th>
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Leyenda</th>
              <th className="hidden px-4 py-3 md:table-cell">Origen</th>
              <th className="px-4 py-3 text-right">Importe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {!isLoading && rows.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState
                  compact
                  icon={FileText}
                  title="Sin asientos en esta vista"
                  description="Cambiá el rango o generá los asientos del período desde el Resumen."
                />
              </TableStateRow>
            )}
            {rows.map((e) => (
              <tr key={e.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(e)}>
                <td className="px-4 py-3 tabular-nums text-muted-foreground">{e.official_number ?? e.number}</td>
                <td className="whitespace-nowrap px-4 py-3">{fmtDate(e.entry_date)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{e.description}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {e.kind !== "auto" && <Badge tone={e.kind === "reversal" ? "warning" : "brand"}>{ENTRY_KIND_LABEL[e.kind] ?? e.kind}</Badge>}
                    {e.reversed_by && <Badge tone="warning">Revertido</Badge>}
                    {e.source_event === "void" && <Badge tone="danger">Anulación</Badge>}
                  </div>
                </td>
                <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                  {sourceLabel(e.source_type)}
                  {e.source_event && e.source_type ? ` · ${EVENT_LABEL[e.source_event] ?? e.source_event}` : ""}
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatCurrency(e.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <Pagination page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPageChange={setPage} loading={isFetching} />
      <EntryDetailModal entry={open} onOpenChange={(o) => !o && setOpen(null)} />
    </div>
  );
}
