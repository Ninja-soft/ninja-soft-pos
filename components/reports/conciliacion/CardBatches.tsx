"use client";

// Vista "Tarjetas por lote" (ADR-044): cobros con tarjeta agrupados como la
// liquidación del adquirente (día → n° de comercio → lote), con selección
// múltiple y acciones en lote (conciliar, volver a pendiente, exportar).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { CheckCheck, CreditCard, Download, Info, Lock, Pencil, PencilLine, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { NoData } from "@/components/ui/NoData";
import { Spinner } from "@/components/ui/Spinner";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { useToast } from "@/components/ui/Toast";
import { VoucherEditModal, formatEditStamp } from "@/components/reports/VoucherEditModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { acquirerByKey, acquirerLabel } from "@/lib/payments/acquirers";
import {
  DEFAULT_FILTERS,
  KIND_LABEL,
  NO_ACQUIRER,
  acquirerOptions,
  batchLabel,
  brandOptions,
  dayLabel,
  dayLongLabel,
  filterCardRows,
  groupCardRows,
  localTime,
  merchantLabel,
  merchantOptions,
  type BatchGroup,
  type CardRecFilters,
  type CardRecRow,
  type DayGroup,
  type ReconcileStatus,
} from "@/lib/reports/cardReconciliation";
import {
  VOUCHER_ACCESS_REASON,
  type VoucherEdit,
  type VoucherEditAccess,
} from "@/lib/reports/voucherEdit";
import {
  batchResultText,
  pruneSelection,
  selectionState,
  selectionTotals,
  setIds,
  toggleGroup,
  type SelectionState,
} from "@/lib/reports/selection";
import { reconcileErrorMessage } from "@/modules/reports/cardReconciliation";
import { useBulkReconcile } from "@/modules/reports/reconciliationHub";
import { BulkBar, useBulkRunner } from "./BulkBar";
import { ProviderTile, StatusChip } from "./ui";

const PAYMENTS_SETTINGS = "/configuracion?seccion=pagos" as Route;

const SELECT =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:w-44";

// Columnas de la tabla (desktop). Etiquetas cortas que nunca se parten; el
// nombre completo va en el tooltip.
const COLUMNS: Array<{ key: string; label: string; tip?: string; className?: string }> = [
  { key: "check", label: "", className: "w-10" },
  { key: "fecha", label: "Fecha", tip: "Fecha y hora del cobro" },
  { key: "ticket", label: "Ticket", tip: "Número de venta" },
  { key: "marca", label: "Marca", tip: "Marca de la tarjeta" },
  { key: "tipo", label: "Tipo", tip: "Débito o crédito" },
  { key: "cuotas", label: "Cuotas", tip: "Cantidad de cuotas", className: "text-right" },
  { key: "lote", label: "Lote", tip: "Número de lote del posnet" },
  { key: "cupon", label: "Cupón", tip: "Número de cupón" },
  { key: "aut", label: "Aut.", tip: "Código de autorización" },
  { key: "ult4", label: "Últ. 4", tip: "Últimos 4 números de la tarjeta" },
  { key: "comercio", label: "Comercio", tip: "Número de comercio" },
  { key: "monto", label: "Monto", tip: "Monto cobrado", className: "text-right" },
  { key: "estado", label: "Estado", tip: "Conciliado o pendiente" },
  { key: "edit", label: "", className: "w-10" },
];
const COLS = COLUMNS.length;
const MONTO_IDX = 11;
const CELL = "whitespace-nowrap px-2.5 py-2.5";

const plural = (n: number) => `${n} ${n === 1 ? "cobro" : "cobros"}`;
const cbState = (s: SelectionState) => (s === "all" ? true : s === "some" ? ("indeterminate" as const) : false);
const idsOf = (rows: CardRecRow[]) => rows.map((r) => r.id);
const dayRows = (d: DayGroup) => d.merchants.flatMap((m) => m.batches.flatMap((b) => b.rows));

export interface CardBatchesProps {
  all: CardRecRow[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  edits: Map<string, VoucherEdit[]>;
  canManage: boolean;
  role: string | undefined;
  access: (r: CardRecRow) => VoucherEditAccess;
  ticket: (n: number | null) => string | null;
  /** Exporta los cobros elegidos (selección) al Excel. */
  onExportSelection: (rows: CardRecRow[]) => void;
  canExport: boolean;
}

export function CardBatches(props: CardBatchesProps) {
  const { all, isLoading, isError, refetch, edits, canManage, role, access, ticket } = props;
  const { toast } = useToast();
  const bulk = useBulkReconcile();
  const runner = useBulkRunner();

  const [filters, setFilters] = useState<CardRecFilters>(DEFAULT_FILTERS);
  const setFilter = <K extends keyof CardRecFilters>(k: K, v: CardRecFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const [editing, setEditing] = useState<CardRecRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const brands = useMemo(() => brandOptions(all), [all]);
  const merchants = useMemo(() => merchantOptions(all), [all]);
  const acquirers = useMemo(() => acquirerOptions(all), [all]);
  const showAcquirer = acquirers.some((a) => a.value !== NO_ACQUIRER);
  const rows = useMemo(() => filterCardRows(all, filters), [all, filters]);
  const groups = useMemo(() => groupCardRows(rows), [rows]);
  const withoutMerchant = useMemo(() => all.filter((r) => !r.comercio).length, [all]);
  const visibleIds = useMemo(() => idsOf(rows), [rows]);
  const pendingIds = useMemo(() => rows.filter((r) => !r.reconciledAt).map((r) => r.id), [rows]);

  // Al cambiar filtros o datos, la selección sólo guarda lo visible.
  useEffect(() => {
    setSelected((s) => pruneSelection(s, visibleIds));
  }, [visibleIds]);

  const clear = useCallback(() => setSelected(new Set()), []);
  const toggle = (ids: string[]) => setSelected((s) => toggleGroup(s, ids));

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const totals = selectionTotals(rows, selected, (r) => r.id, (r) => r.amount);
  const toReconcile = chosen.filter((r) => !r.reconciledAt);
  const toUnreconcile = chosen.filter((r) => r.reconciledAt);
  const batchesOf = (list: CardRecRow[]) => new Set(list.map((r) => `${r.day}|${r.comercio}|${r.lote}`)).size;

  function ask(target: boolean) {
    const list = target ? toReconcile : toUnreconcile;
    const amount = list.reduce((a, r) => a + r.amount, 0);
    runner.ask({
      title: target ? "Conciliar lo seleccionado" : "Volver a pendiente",
      confirmLabel: target ? `Conciliar ${plural(list.length)}` : `Volver a pendiente ${plural(list.length)}`,
      rows: [
        ["Cobros", String(list.length)],
        ["Lotes", String(batchesOf(list))],
        ["Monto", formatCurrency(amount)],
      ],
      note: target
        ? "Marcalos sólo si ya controlaste que el adquirente te los acreditó. Queda registrado quién y cuándo."
        : "Vuelven a figurar como pendientes de acreditación.",
      run: async (onProgress) => {
        try {
          const r = await bulk.mutateAsync({ ids: idsOf(list), reconciled: target, onProgress });
          const text = batchResultText(r, { one: "cobro", many: "cobros" }, {
            done: target ? "Conciliados" : "Volvieron a pendiente",
            partial: target ? "Se conciliaron" : "Volvieron a pendiente",
          });
          toast({
            title: text,
            description: r.failed[0] ? reconcileErrorMessage(r.failed[0].error) : undefined,
            variant: r.failedCount ? "error" : "success",
          });
          if (r.failedCount === 0) clear();
        } catch (e) {
          toast({ title: "No se pudo guardar", description: reconcileErrorMessage(e), variant: "error" });
        }
      },
    });
  }

  const hasFilters =
    filters.kind !== "all" ||
    filters.brand !== "all" ||
    filters.comercio !== "all" ||
    filters.status !== "all" ||
    (filters.acquirer ?? "all") !== "all";

  const view: GroupViewProps = {
    groups,
    canManage,
    selected,
    onToggle: toggle,
    onEdit: setEditing,
    access,
    edits,
    ticket,
  };

  return (
    <div className="mt-5">
      {/* Filtros */}
      <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Tipo</span>
          <Segmented
            aria-label="Tipo de tarjeta"
            size="sm"
            value={filters.kind}
            onChange={(v) => setFilter("kind", v)}
            options={[
              { value: "all", label: "Todas" },
              { value: "debit", label: "Débito" },
              { value: "credit", label: "Crédito" },
            ]}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Estado</span>
          <Segmented<ReconcileStatus>
            aria-label="Estado de conciliación"
            size="sm"
            value={filters.status}
            onChange={(v) => setFilter("status", v)}
            options={[
              { value: "all", label: "Todos" },
              { value: "pending", label: "Pendientes" },
              { value: "reconciled", label: "Conciliados" },
            ]}
          />
        </div>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Marca</span>
          <select value={filters.brand} onChange={(e) => setFilter("brand", e.target.value)} className={SELECT}>
            <option value="all">Todas las marcas</option>
            {brands.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">N° de comercio</span>
          <select value={filters.comercio} onChange={(e) => setFilter("comercio", e.target.value)} className={SELECT}>
            <option value="all">Todos</option>
            {merchants.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {showAcquirer && (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Adquirente</span>
            <select value={filters.acquirer ?? "all"} onChange={(e) => setFilter("acquirer", e.target.value)} className={SELECT}>
              <option value="all">Todos</option>
              {acquirers.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)} className="justify-self-start">
            Limpiar filtros
          </Button>
        )}
      </div>

      {!canManage && role && (
        <Callout tone="neutral" icon={Info} className="mt-4">
          Sólo el dueño o un encargado pueden marcar cobros como conciliados.
          {role === "cashier" ? " Podés corregir el cupón de los cobros de tus turnos de caja mientras estén pendientes." : ""}
        </Callout>
      )}
      {all.length > 0 && withoutMerchant > 0 && (
        <Callout tone="info" icon={Info} className="mt-4">
          {withoutMerchant === 1 ? "Hay 1 cobro" : `Hay ${withoutMerchant} cobros`} sin número de comercio. Cargá el número de
          cada marca en{" "}
          <Link href={PAYMENTS_SETTINGS} className="font-medium text-foreground underline underline-offset-2">
            Medios de pago, Planes de cuotas
          </Link>{" "}
          para separar las liquidaciones por adquirente.
        </Callout>
      )}

      {/* Selección rápida */}
      {canManage && rows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Seleccionar:</span>
          <button
            type="button"
            className="font-medium text-foreground underline-offset-2 hover:underline"
            onClick={() => setSelected((s) => setIds(s, visibleIds, true))}
          >
            Todo lo filtrado ({visibleIds.length})
          </button>
          {pendingIds.length > 0 && pendingIds.length !== visibleIds.length && (
            <button
              type="button"
              className="font-medium text-foreground underline-offset-2 hover:underline"
              onClick={() => setSelected(new Set(pendingIds))}
            >
              Sólo pendientes ({pendingIds.length})
            </button>
          )}
          {selected.size > 0 && (
            <button type="button" className="underline-offset-2 hover:underline" onClick={clear}>
              Ninguno
            </button>
          )}
        </div>
      )}

      {!isLoading && !isError && all.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-card">
          <EmptyState
            icon={CreditCard}
            title="No hay cobros con tarjeta en este período"
            description={
              <>
                El lote y el cupón salen de los datos que carga el cajero al cobrar con &quot;Tarjeta en posnet&quot;. El
                número de comercio de cada marca se configura en Medios de pago, Planes de cuotas.
              </>
            }
            action={
              <Link
                href={PAYMENTS_SETTINGS}
                className="inline-flex h-9 items-center rounded-lg border border-input bg-background px-3 text-sm font-medium transition hover:border-foreground/30"
              >
                Ir a Medios de pago
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {/* Desktop: tabla agrupada con encabezado fijo y scroll propio. */}
          <TableWrap className="mt-3 hidden max-h-[calc(100dvh-10rem)] md:block">
            <table className="w-full min-w-[1060px] border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.tip}
                      className={cn(
                        "sticky top-0 z-10 whitespace-nowrap border-b border-border bg-card px-2.5 py-2.5 text-left text-xs font-medium text-muted-foreground",
                        c.className,
                      )}
                    >
                      {c.key === "check" ? (
                        canManage && rows.length > 0 ? (
                          <Checkbox
                            checked={cbState(selectionState(selected, visibleIds))}
                            onCheckedChange={() => toggle(visibleIds)}
                            aria-label="Seleccionar todo lo filtrado"
                          />
                        ) : (
                          <span className="sr-only">Seleccionar</span>
                        )
                      ) : c.key === "edit" ? (
                        <span className="sr-only">Editar</span>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              {isLoading ? (
                <tbody>
                  <TableStateRow colSpan={COLS} loading />
                </tbody>
              ) : isError ? (
                <tbody>
                  <TableStateRow colSpan={COLS}>
                    <p className="text-sm text-muted-foreground">No se pudieron cargar los cobros.</p>
                    <Button variant="secondary" size="sm" className="mt-3" onClick={() => refetch()}>
                      Reintentar
                    </Button>
                  </TableStateRow>
                </tbody>
              ) : groups.length === 0 ? (
                <tbody>
                  <TableStateRow colSpan={COLS}>
                    <p className="text-sm text-muted-foreground">Ningún cobro coincide con los filtros.</p>
                  </TableStateRow>
                </tbody>
              ) : (
                <DesktopGroups {...view} />
              )}
            </table>
          </TableWrap>

          {/* Mobile: tarjetas por lote. */}
          <div className="mt-3 md:hidden">
            {isLoading ? (
              <div className="flex justify-center rounded-lg border border-border bg-card py-10">
                <Spinner size={22} />
              </div>
            ) : isError ? (
              <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No se pudieron cargar los cobros.</p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => refetch()}>
                  Reintentar
                </Button>
              </div>
            ) : groups.length === 0 ? (
              <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
                Ningún cobro coincide con los filtros.
              </div>
            ) : (
              <MobileGroups {...view} />
            )}
          </div>
        </>
      )}

      {canManage && (
        <BulkBar
          count={totals.count}
          amount={totals.amount}
          onClear={clear}
          actions={[
            {
              key: "rec",
              label: `Conciliar ${toReconcile.length}`,
              variant: "primary",
              icon: <CheckCheck size={15} aria-hidden />,
              disabled: toReconcile.length === 0 || runner.running,
              onClick: () => ask(true),
            },
            ...(toUnreconcile.length > 0
              ? [
                  {
                    key: "unrec",
                    label: `Volver a pendiente ${toUnreconcile.length}`,
                    icon: <RotateCcw size={15} aria-hidden />,
                    disabled: runner.running,
                    onClick: () => ask(false),
                  },
                ]
              : []),
            ...(props.canExport
              ? [
                  {
                    key: "xlsx",
                    label: "Exportar selección",
                    icon: <Download size={15} aria-hidden />,
                    onClick: () => props.onExportSelection(chosen),
                  },
                ]
              : []),
          ]}
        />
      )}
      {runner.dialog}

      <VoucherEditModal
        row={editing}
        ticket={editing ? ticket(editing.ticket) : null}
        edits={editing ? (edits.get(editing.id) ?? []) : []}
        asSupervisor={canManage}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}

// ── Piezas compartidas ───────────────────────────────────────────────────────

interface GroupViewProps {
  groups: DayGroup[];
  canManage: boolean;
  selected: ReadonlySet<string>;
  onToggle: (ids: string[]) => void;
  onEdit: (row: CardRecRow) => void;
  access: (row: CardRecRow) => VoucherEditAccess;
  edits: Map<string, VoucherEdit[]>;
  ticket: (n: number | null) => string | null;
}

function Code({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === "") return <NoData />;
  return <span className="tabular-nums">{value}</span>;
}

function RowStatus({ reconciled }: { reconciled: boolean }) {
  return reconciled ? <StatusChip label="Conciliado" tone="success" /> : <StatusChip label="Pendiente" tone="warning" />;
}

function BatchStatus({ batch }: { batch: BatchGroup }) {
  if (batch.reconciledCount === 0) return <RowStatus reconciled={false} />;
  if (batch.reconciledCount === batch.count) return <RowStatus reconciled />;
  return <StatusChip label={`${batch.reconciledCount} de ${batch.count}`} tone="warning" icon="review" />;
}

/** Logos de los adquirentes de un comercio (terminal del posnet, ADR-054). */
function AcquirerMarks({ rows }: { rows: CardRecRow[] }) {
  const keys = [...new Set(rows.map((r) => r.adquirente).filter(Boolean))];
  if (keys.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <ProviderTile key={k} logo={acquirerByKey(k)?.logoKey ?? null} label={acquirerLabel(k)} size={20} />
      ))}
    </span>
  );
}

function EditedMark({ edits }: { edits: VoucherEdit[] | undefined }) {
  const last = edits?.[0];
  if (!last) return null;
  const flagged = edits!.some((e) => e.wasReconciled);
  const text = `${flagged ? "Editado después de conciliar. " : "Editado. "}Último cambio: ${last.editedBy}, ${formatEditStamp(last.editedAt)}`;
  return (
    <span title={text} className={cn("inline-flex", flagged ? "text-warning" : "text-muted-foreground")}>
      <PencilLine size={14} aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  );
}

function EditButton({
  row,
  access,
  onEdit,
  className,
}: {
  row: CardRecRow;
  access: VoucherEditAccess;
  onEdit: (row: CardRecRow) => void;
  className?: string;
}) {
  if (!access.canEdit) {
    if (access.reason !== "reconciled") return null;
    return (
      <span
        title={VOUCHER_ACCESS_REASON.reconciled}
        className={cn("inline-flex h-8 w-8 items-center justify-center text-muted-foreground/60", className)}
      >
        <Lock size={14} aria-hidden />
        <span className="sr-only">{VOUCHER_ACCESS_REASON.reconciled}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onEdit(row)}
      title="Editar cupón"
      aria-label={`Editar cupón del cobro de ${formatCurrency(row.amount)}`}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Pencil size={14} aria-hidden />
    </button>
  );
}

// ── Desktop ──────────────────────────────────────────────────────────────────

function DesktopGroups(props: GroupViewProps) {
  const { groups, canManage, selected, onToggle } = props;
  return (
    <>
      {groups.map((d) => {
        const rec = d.merchants.reduce((a, m) => a + m.batches.reduce((x, b) => x + b.reconciledCount, 0), 0);
        const ids = idsOf(dayRows(d));
        return (
          <tbody key={d.day}>
            <tr className="bg-muted/60">
              <td className="border-b border-border px-2.5 py-2.5">
                {canManage && (
                  <Checkbox
                    checked={cbState(selectionState(selected, ids))}
                    onCheckedChange={() => onToggle(ids)}
                    aria-label={`Seleccionar los cobros del ${dayLongLabel(d.day)}`}
                  />
                )}
              </td>
              <td colSpan={MONTO_IDX - 1} className="border-b border-border px-2.5 py-2.5">
                <span className="font-semibold">{dayLongLabel(d.day)}</span>
                <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                  {plural(d.count)} · {rec} {rec === 1 ? "conciliado" : "conciliados"}
                </span>
              </td>
              <td className="whitespace-nowrap border-b border-border px-2.5 py-2.5 text-right font-semibold tabular-nums">
                {formatCurrency(d.amount)}
              </td>
              <td colSpan={2} className="border-b border-border" />
            </tr>
            {d.merchants.map((m) => (
              <DesktopMerchant key={m.key} merchant={m} {...props} />
            ))}
          </tbody>
        );
      })}
    </>
  );
}

function DesktopMerchant({ merchant: m, ...props }: GroupViewProps & { merchant: DayGroup["merchants"][number] }) {
  const { canManage, selected, onToggle } = props;
  const mRows = m.batches.flatMap((b) => b.rows);
  return (
    <>
      <tr>
        <td className="border-b border-border" />
        <td colSpan={MONTO_IDX - 1} className="border-b border-border px-2.5 pb-2 pt-4 text-xs font-medium text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <AcquirerMarks rows={mRows} />
            <span className="text-foreground">{merchantLabel(m.comercio)}</span>
            <span>{plural(m.count)}</span>
          </span>
        </td>
        <td className="whitespace-nowrap border-b border-border px-2.5 pb-2 pt-4 text-right text-xs font-medium tabular-nums text-muted-foreground">
          {formatCurrency(m.amount)}
        </td>
        <td colSpan={2} className="border-b border-border" />
      </tr>
      {m.batches.map((b) => {
        const ids = idsOf(b.rows);
        const label = batchLabel(b.lote);
        return (
          <Fragment key={b.key}>
            <tr className="bg-muted/25">
              <td className="border-b border-border/70 px-2.5 py-2">
                {canManage && (
                  <Checkbox
                    checked={cbState(selectionState(selected, ids))}
                    onCheckedChange={() => onToggle(ids)}
                    aria-label={`Seleccionar ${label.toLowerCase()} (${plural(b.count)})`}
                  />
                )}
              </td>
              <td colSpan={MONTO_IDX - 1} className="border-b border-border/70 px-2.5 py-2">
                <span className="font-medium">{label}</span>
                <span className="ml-2 text-xs text-muted-foreground">{plural(b.count)}</span>
              </td>
              <td className="whitespace-nowrap border-b border-border/70 px-2.5 py-2 text-right font-semibold tabular-nums">
                {formatCurrency(b.amount)}
              </td>
              <td className="border-b border-border/70 px-2.5 py-2">
                <BatchStatus batch={b} />
              </td>
              <td className="border-b border-border/70" />
            </tr>
            {b.rows.map((r) => (
              <DesktopRow key={r.id} row={r} {...props} />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

function DesktopRow({ row: r, ...props }: GroupViewProps & { row: CardRecRow }) {
  const { canManage, selected, onToggle, onEdit, access, edits, ticket } = props;
  const reconciled = Boolean(r.reconciledAt);
  const isSel = selected.has(r.id);
  const t = ticket(r.ticket);
  const td = cn(CELL, "border-b border-border/50");
  return (
    <tr className={cn("transition-colors hover:bg-muted/30", isSel && "bg-muted/50")}>
      <td className={cn(td, "py-2")}>
        {canManage && (
          <Checkbox
            checked={isSel}
            onCheckedChange={() => onToggle([r.id])}
            aria-label={`Seleccionar el cobro de ${formatCurrency(r.amount)}`}
          />
        )}
      </td>
      <td className={cn(td, "tabular-nums")} title={`${dayLabel(r.day)} ${localTime(r.createdAt)}`}>
        {dayLabel(r.day).slice(0, 5)} {localTime(r.createdAt)}
      </td>
      <td className={td}>
        <Code value={t} />
      </td>
      <td className={td}>
        <span className="inline-flex items-center gap-2">
          {r.brandKey ? <CardBrandLogo brand={r.brandKey} label={r.brandLabel} height={16} /> : null}
          <span>{r.brandLabel || "Sin marca"}</span>
        </span>
      </td>
      <td className={td}>{KIND_LABEL[r.kind]}</td>
      <td className={cn(td, "text-right")}>{r.kind === "debit" && !r.installments ? null : <Code value={r.installments} />}</td>
      <td className={td}>
        <Code value={r.lote} />
      </td>
      <td className={td}>
        <Code value={r.cupon} />
      </td>
      <td className={td} title={r.reference ? `Referencia ${r.reference}` : undefined}>
        <Code value={r.autorizacion} />
      </td>
      <td className={td}>
        <Code value={r.ultimos4} />
      </td>
      <td className={td}>
        <Code value={r.comercio} />
      </td>
      <td className={cn(td, "text-right font-medium tabular-nums")}>{formatCurrency(r.amount)}</td>
      <td className={td}>
        <span className="inline-flex items-center gap-2">
          <RowStatus reconciled={reconciled} />
          <EditedMark edits={edits.get(r.id)} />
        </span>
      </td>
      <td className={cn(td, "px-1.5 py-1 text-right")}>
        <EditButton row={r} access={access(r)} onEdit={onEdit} />
      </td>
    </tr>
  );
}

// ── Mobile ───────────────────────────────────────────────────────────────────

function MobileGroups(props: GroupViewProps) {
  const { groups, canManage, selected, onToggle } = props;
  return (
    <div className="space-y-6">
      {groups.map((d) => {
        const ids = idsOf(dayRows(d));
        return (
          <section key={d.day} aria-label={dayLongLabel(d.day)}>
            <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
              <div className="flex min-w-0 items-center gap-3">
                {canManage && (
                  <Checkbox
                    checked={cbState(selectionState(selected, ids))}
                    onCheckedChange={() => onToggle(ids)}
                    aria-label={`Seleccionar los cobros del ${dayLongLabel(d.day)}`}
                  />
                )}
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{dayLongLabel(d.day)}</h3>
                  <p className="text-xs text-muted-foreground">{plural(d.count)}</p>
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(d.amount)}</span>
            </div>
            {d.merchants.map((m) => (
              <div key={m.key} className="mt-3">
                <div className="flex items-center justify-between gap-3 px-0.5 text-xs font-medium text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-2">
                    <AcquirerMarks rows={m.batches.flatMap((b) => b.rows)} />
                    <span className="truncate">
                      <span className="text-foreground">{merchantLabel(m.comercio)}</span> · {plural(m.count)}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCurrency(m.amount)}</span>
                </div>
                <div className="mt-2 space-y-2">
                  {m.batches.map((b) => {
                    const bIds = idsOf(b.rows);
                    const label = batchLabel(b.lote);
                    return (
                      <div key={b.key} className="overflow-hidden rounded-lg border border-border bg-card">
                        <div className="flex items-center gap-3 bg-muted/40 px-3 py-2.5">
                          {canManage && (
                            <Checkbox
                              checked={cbState(selectionState(selected, bIds))}
                              onCheckedChange={() => onToggle(bIds)}
                              aria-label={`Seleccionar ${label.toLowerCase()}`}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{label}</p>
                            <p className="text-xs text-muted-foreground">{plural(b.count)}</p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className="text-sm font-semibold tabular-nums">{formatCurrency(b.amount)}</span>
                            <BatchStatus batch={b} />
                          </div>
                        </div>
                        <ul>
                          {b.rows.map((r) => (
                            <MobileRow key={r.id} row={r} {...props} />
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function MobileField({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">
        <Code value={value} />
      </dd>
    </div>
  );
}

function MobileRow({ row: r, ...props }: GroupViewProps & { row: CardRecRow }) {
  const { canManage, selected, onToggle, onEdit, access, edits, ticket } = props;
  const reconciled = Boolean(r.reconciledAt);
  const isSel = selected.has(r.id);
  const t = ticket(r.ticket);
  return (
    <li className={cn("border-t border-border/60 px-3 py-3", isSel && "bg-muted/50")}>
      <div className="flex items-start gap-3">
        {canManage && (
          <Checkbox
            className="mt-0.5"
            checked={isSel}
            onCheckedChange={() => onToggle([r.id])}
            aria-label={`Seleccionar el cobro de ${formatCurrency(r.amount)}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                {r.brandKey ? <CardBrandLogo brand={r.brandKey} label={r.brandLabel} height={14} /> : null}
                <span className="truncate">{r.brandLabel || "Sin marca"}</span>
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                {KIND_LABEL[r.kind]}
                {r.installments ? ` · ${r.installments} ${r.installments === 1 ? "cuota" : "cuotas"}` : ""} · {localTime(r.createdAt)}
                {t ? ` · Ticket ${t}` : ""}
              </p>
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(r.amount)}</span>
          </div>
          <dl className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-2">
            <MobileField label="Cupón" value={r.cupon} />
            <MobileField label="Aut." value={r.autorizacion} />
            <MobileField label="Últ. 4" value={r.ultimos4} />
          </dl>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <RowStatus reconciled={reconciled} />
              <EditedMark edits={edits.get(r.id)} />
            </span>
            <EditButton row={r} access={access(r)} onEdit={onEdit} className="-my-1 -mr-1.5" />
          </div>
        </div>
      </div>
    </li>
  );
}
