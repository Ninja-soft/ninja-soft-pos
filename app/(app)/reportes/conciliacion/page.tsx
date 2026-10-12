"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, CreditCard, Download, Info, Lock, Pencil, PencilLine } from "lucide-react";
import { startOfDay, startOfMonth, subDays } from "date-fns";
import { Button } from "@/components/ui/Button";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Callout } from "@/components/ui/Callout";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { NoData } from "@/components/ui/NoData";
import { Spinner } from "@/components/ui/Spinner";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { VoucherEditModal, formatEditStamp } from "@/components/reports/VoucherEditModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useCurrentUserId } from "@/modules/stock/hooks";
import { branchFileTag, reportScopeLabel } from "@/lib/reports/branchScope";
import {
  reconcileErrorMessage,
  useCardPayments,
  useSetReconciled,
  useVoucherEdits,
} from "@/modules/reports/cardReconciliation";
import {
  DEFAULT_FILTERS,
  KIND_LABEL,
  XLSX_COLUMNS,
  batchLabel,
  brandOptions,
  dayLabel,
  dayLongLabel,
  filterCardRows,
  groupCardRows,
  groupCheckState,
  idsToToggle,
  localTime,
  merchantLabel,
  merchantOptions,
  normalizeCardPayments,
  summarizeCardRows,
  xlsxBatchRows,
  xlsxDetailRows,
  type BatchGroup,
  type CardRecFilters,
  type CardRecRow,
  type DayGroup,
  type ReconcileStatus,
} from "@/lib/reports/cardReconciliation";
import {
  VOUCHER_ACCESS_REASON,
  groupVoucherEdits,
  voucherEditAccess,
  type VoucherEdit,
  type VoucherEditAccess,
} from "@/lib/reports/voucherEdit";

const FEATURE = "conciliacion_tarjetas";
const PAYMENTS_SETTINGS = "/configuracion?seccion=pagos" as Route;

const SELECT =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:w-44";

// Columnas de la tabla (desktop). Etiquetas cortas que nunca se parten; el
// nombre completo va en el tooltip. Índices fijos: los renglones de grupo
// (día, comercio, lote) usan colSpan para alinear el monto con su columna.
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
const COLS = COLUMNS.length; // 14
const MONTO_IDX = 11;

const CELL = "whitespace-nowrap px-2.5 py-2.5";

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "success" | "warning" }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 truncate font-price text-xl font-bold tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function Locked() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
      <Lock className="mx-auto text-ninja-flameSoft" size={28} />
      <p className="mt-3 font-semibold">La conciliación de tarjetas no está incluida en tu plan</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Controlá los cobros con tarjeta por día, número de comercio y lote contra la liquidación de cada
        adquirente, y marcá lo que ya te acreditaron.
      </p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Ver planes
      </Button>
      <UpgradeModal open={open} onOpenChange={setOpen} featureKey={FEATURE} featureLabel="Conciliación de tarjetas" />
    </div>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? "cobro" : "cobros"}`;

export default function ConciliacionTarjetasPage() {
  const { toast } = useToast();
  const enabled = useFeature(FEATURE);
  const { data: me } = useMyTenant();
  const { data: userId } = useCurrentUserId();
  const canManage = Boolean(me?.canManage);
  const { data: numFmt } = useSaleNumberFormat();

  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: startOfDay(subDays(new Date(), 6)),
    to: startOfDay(new Date()),
  }));
  const { fromISO, toISO } = useMemo(() => {
    const f = startOfDay(range?.from ?? new Date());
    const t = startOfDay(range?.to ?? range?.from ?? new Date());
    t.setDate(t.getDate() + 1); // inclusivo del día "hasta"
    return { fromISO: f.toISOString(), toISO: t.toISOString() };
  }, [range]);

  const [filters, setFilters] = useState<CardRecFilters>(DEFAULT_FILTERS);
  const setFilter = <K extends keyof CardRecFilters>(k: K, v: CardRecFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  // Sucursal del chip del panel (F17 · H97).
  const branch = useBranchContext();
  const scopeLabel = reportScopeLabel(branch.isMulti, branch.filterStore);
  const { data, isLoading, isError, refetch } = useCardPayments(
    fromISO,
    toISO,
    enabled !== false,
    branch.filterStoreId,
  );
  const { data: rawEdits } = useVoucherEdits(fromISO, toISO, enabled !== false);
  const mutation = useSetReconciled();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<CardRecRow | null>(null);

  const all = useMemo(() => normalizeCardPayments(data ?? []), [data]);
  const brands = useMemo(() => brandOptions(all), [all]);
  const merchants = useMemo(() => merchantOptions(all), [all]);
  const rows = useMemo(() => filterCardRows(all, filters), [all, filters]);
  const groups = useMemo(() => groupCardRows(rows), [rows]);
  const summary = useMemo(() => summarizeCardRows(rows), [rows]);
  const withoutMerchant = useMemo(() => all.filter((r) => !r.comercio).length, [all]);
  const edits = useMemo(() => groupVoucherEdits(rawEdits ?? []), [rawEdits]);

  const access = (r: CardRecRow): VoucherEditAccess =>
    voucherEditAccess({ role: me?.role, userId, shiftOpenedBy: r.shiftOpenedBy, reconciled: Boolean(r.reconciledAt) });
  const ticket = (n: number | null) => (n == null ? null : formatSaleNumber(n, numFmt));

  async function toggle(key: string, list: CardRecRow[], target: boolean) {
    const ids = idsToToggle(list, target);
    if (ids.length === 0) return;
    setBusy(key);
    try {
      await mutation.mutateAsync({ ids, reconciled: target });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: reconcileErrorMessage(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function exportList() {
    const from = range?.from ? dayLabel(localISODate(range.from)) : "";
    const to = range?.to ? dayLabel(localISODate(range.to)) : from;
    const fileTag = branchFileTag(branch.isMulti, branch.filterStore);
    await exportXlsx(`conciliacion-tarjetas_${fileTag ? `${fileTag}_` : ""}${localISODate(range?.from ?? new Date())}`, [
      {
        name: "Detalle",
        title: `Conciliación de tarjetas ${from}${to && to !== from ? ` al ${to}` : ""}${scopeLabel ? ` · ${scopeLabel}` : ""} • NinjaPos`,
        columns: XLSX_COLUMNS,
        rows: xlsxDetailRows(groups),
        totals: { cantidad: summary.total.count, monto: summary.total.amount },
      },
      {
        name: "Por lote",
        title: "Resumen por día, comercio y lote",
        columns: [
          { header: "Fecha", key: "fecha", width: 14 },
          { header: "Comercio", key: "comercio", width: 18 },
          { header: "Lote", key: "lote", width: 12 },
          { header: "Cobros", key: "cantidad", type: "number", width: 9 },
          { header: "Monto", key: "monto", type: "money", width: 14 },
          { header: "Conciliado", key: "conciliado", type: "money", width: 14 },
          { header: "Pendiente", key: "pendiente", type: "money", width: 14 },
        ],
        rows: xlsxBatchRows(groups),
        totals: {
          cantidad: summary.total.count,
          monto: summary.total.amount,
          conciliado: summary.reconciled.amount,
          pendiente: summary.pending.amount,
        },
      },
    ]);
  }

  const hasFilters =
    filters.kind !== "all" || filters.brand !== "all" || filters.comercio !== "all" || filters.status !== "all";

  const view: GroupViewProps = {
    groups,
    canManage,
    busy,
    onToggle: toggle,
    onEdit: setEditing,
    access,
    edits,
    ticket,
  };

  return (
    <PageContainer>
      <Link href="/reportes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Reportes
      </Link>
      <PageHeader
        className="mt-2"
        eyebrow="Reportes"
        title="Conciliación de tarjetas"
        description={
          <>
            Compará los cobros con tarjeta contra la liquidación de cada adquirente, por día, número de comercio y lote, y marcá lo que ya te acreditaron.
            {scopeLabel && (
              <span className="mt-1 block">
                Mirando <span className="font-medium text-foreground">{scopeLabel}</span>.
              </span>
            )}
          </>
        }
        actions={
          enabled !== false ? (
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              onClick={exportList}
              disabled={rows.length === 0}
            >
              <Download size={16} /> Exportar XLSX
            </GatedButton>
          ) : undefined
        }
      />

      {enabled === false ? (
        <Locked />
      ) : (
        <>
          {/* Filtros */}
          <div className="mt-6 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Período</span>
              <DateRangePicker value={range} onChange={setRange} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Rápido</span>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { label: "Hoy", days: 0 },
                    { label: "Ayer", days: 1, single: true },
                    { label: "7 días", days: 6 },
                    { label: "Mes", month: true },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      const today = startOfDay(new Date());
                      if ("month" in p) setRange({ from: startOfMonth(today), to: today });
                      else if ("single" in p) setRange({ from: subDays(today, 1), to: subDays(today, 1) });
                      else setRange({ from: subDays(today, p.days), to: today });
                    }}
                    className="rounded-md border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
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
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)} className="justify-self-start">
                Limpiar filtros
              </Button>
            )}
          </div>

          {/* Resumen */}
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Kpi label="Total tarjetas" value={formatCurrency(summary.total.amount)} sub={plural(summary.total.count)} />
            <Kpi
              label="Conciliado"
              tone="success"
              value={formatCurrency(summary.reconciled.amount)}
              sub={plural(summary.reconciled.count)}
            />
            <Kpi
              label="Pendiente"
              tone={summary.pending.count > 0 ? "warning" : undefined}
              value={formatCurrency(summary.pending.amount)}
              sub={plural(summary.pending.count)}
            />
          </div>

          {!canManage && me && (
            <Callout tone="neutral" icon={Info} className="mt-4">
              Sólo el dueño o un encargado pueden marcar cobros como conciliados.
              {me.role === "cashier" ? " Podés corregir el cupón de los cobros de tus turnos de caja mientras estén pendientes." : ""}
            </Callout>
          )}
          {all.length > 0 && withoutMerchant > 0 && (
            <Callout tone="info" icon={Info} className="mt-4">
              {withoutMerchant === 1 ? "Hay 1 cobro" : `Hay ${withoutMerchant} cobros`} sin número de comercio. Cargá el
              número de cada marca en{" "}
              <Link href={PAYMENTS_SETTINGS} className="font-medium text-foreground underline underline-offset-2">
                Medios de pago, Planes de cuotas
              </Link>{" "}
              para separar las liquidaciones por adquirente.
            </Callout>
          )}

          {!isLoading && !isError && all.length === 0 ? (
            <div className="mt-6 rounded-xl border border-border bg-card">
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
              <TableWrap className="mt-6 hidden max-h-[calc(100dvh-10rem)] md:block">
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
                            <span className="sr-only">Conciliado</span>
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
              <div className="mt-6 md:hidden">
                {isLoading ? (
                  <div className="flex justify-center rounded-xl border border-border bg-card py-10">
                    <Spinner size={22} />
                  </div>
                ) : isError ? (
                  <div className="rounded-xl border border-border bg-card px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">No se pudieron cargar los cobros.</p>
                    <Button variant="secondary" size="sm" className="mt-3" onClick={() => refetch()}>
                      Reintentar
                    </Button>
                  </div>
                ) : groups.length === 0 ? (
                  <div className="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
                    Ningún cobro coincide con los filtros.
                  </div>
                ) : (
                  <MobileGroups {...view} />
                )}
              </div>
            </>
          )}

          <VoucherEditModal
            row={editing}
            ticket={editing ? ticket(editing.ticket) : null}
            edits={editing ? (edits.get(editing.id) ?? []) : []}
            asSupervisor={canManage}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
          />
        </>
      )}
    </PageContainer>
  );
}

function localISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Piezas compartidas ───────────────────────────────────────────────────────

interface GroupViewProps {
  groups: DayGroup[];
  canManage: boolean;
  busy: string | null;
  onToggle: (key: string, rows: CardRecRow[], target: boolean) => void;
  onEdit: (row: CardRecRow) => void;
  access: (row: CardRecRow) => VoucherEditAccess;
  edits: Map<string, VoucherEdit[]>;
  ticket: (n: number | null) => string | null;
}

/** Código del cupón (lote, cupón, etc.) o el marcador de vacío. */
function Code({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === "") return <NoData />;
  return <span className="tabular-nums">{value}</span>;
}

function StatusBadge({ reconciled }: { reconciled: boolean }) {
  return reconciled ? (
    <Badge tone="success" className="rounded-md px-2">
      Conciliado
    </Badge>
  ) : (
    <Badge tone="neutral" className="rounded-md px-2">
      Pendiente
    </Badge>
  );
}

function BatchBadge({ batch }: { batch: BatchGroup }) {
  if (batch.reconciledCount === 0) return <StatusBadge reconciled={false} />;
  if (batch.reconciledCount === batch.count) return <StatusBadge reconciled />;
  return (
    <Badge tone="warning" className="rounded-md px-2 tabular-nums">
      {batch.reconciledCount} de {batch.count}
    </Badge>
  );
}

/** Ícono de "editado" con quién y cuándo; en ámbar si se editó ya conciliado. */
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
  const { groups } = props;
  return (
    <>
      {groups.map((d) => {
        const rec = d.merchants.reduce((a, m) => a + m.batches.reduce((x, b) => x + b.reconciledCount, 0), 0);
        return (
          <tbody key={d.day}>
            <tr className="bg-muted/60">
              <td colSpan={MONTO_IDX} className="border-b border-border px-2.5 py-2.5">
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

function DesktopMerchant({
  merchant: m,
  ...props
}: GroupViewProps & { merchant: DayGroup["merchants"][number] }) {
  const { canManage, busy, onToggle } = props;
  return (
    <>
      <tr>
        <td className="border-b border-border" />
        <td colSpan={MONTO_IDX - 1} className="border-b border-border px-2.5 pb-2 pt-4 text-xs font-medium text-muted-foreground">
          <span className="text-foreground">{merchantLabel(m.comercio)}</span>
          <span className="ml-2">{plural(m.count)}</span>
        </td>
        <td className="whitespace-nowrap border-b border-border px-2.5 pb-2 pt-4 text-right text-xs font-medium tabular-nums text-muted-foreground">
          {formatCurrency(m.amount)}
        </td>
        <td colSpan={2} className="border-b border-border" />
      </tr>
      {m.batches.map((b) => {
        const state = groupCheckState(b.rows);
        const label = batchLabel(b.lote);
        const groupBusy = busy === b.key;
        return (
          <Fragment key={b.key}>
            <tr className={cn("bg-muted/25", groupBusy && "opacity-60")}>
              <td className="border-b border-border/70 px-2.5 py-2">
                <Checkbox
                  checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
                  disabled={!canManage || busy !== null}
                  busy={groupBusy}
                  onCheckedChange={() => onToggle(b.key, b.rows, state !== "all")}
                  aria-label={`${label}: marcar ${state === "all" ? "como pendiente" : "como conciliado"}`}
                />
              </td>
              <td colSpan={MONTO_IDX - 1} className="border-b border-border/70 px-2.5 py-2">
                <span className="font-medium">{label}</span>
                <span className="ml-2 text-xs text-muted-foreground">{plural(b.count)}</span>
              </td>
              <td className="whitespace-nowrap border-b border-border/70 px-2.5 py-2 text-right font-semibold tabular-nums">
                {formatCurrency(b.amount)}
              </td>
              <td className="border-b border-border/70 px-2.5 py-2">
                <BatchBadge batch={b} />
              </td>
              <td className="border-b border-border/70" />
            </tr>
            {b.rows.map((r) => (
              <DesktopRow key={r.id} row={r} groupBusy={groupBusy} {...props} />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

function DesktopRow({ row: r, groupBusy, ...props }: GroupViewProps & { row: CardRecRow; groupBusy: boolean }) {
  const { canManage, busy, onToggle, onEdit, access, edits, ticket } = props;
  const reconciled = Boolean(r.reconciledAt);
  const rowBusy = busy === r.id;
  const t = ticket(r.ticket);
  const td = cn(CELL, "border-b border-border/50");
  return (
    <tr className={cn("transition-colors hover:bg-muted/30", (groupBusy || rowBusy) && "opacity-60")}>
      <td className={cn(td, "py-2")}>
        <Checkbox
          checked={reconciled}
          disabled={!canManage || busy !== null}
          busy={rowBusy}
          onCheckedChange={(next) => onToggle(r.id, [r], next)}
          aria-label={`Cobro de ${formatCurrency(r.amount)}: marcar ${reconciled ? "como pendiente" : "como conciliado"}`}
        />
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
      <td className={cn(td, "text-right")}>
        {/* Débito sin cuotas: no aplica, celda vacía. */}
        {r.kind === "debit" && !r.installments ? null : <Code value={r.installments} />}
      </td>
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
          <StatusBadge reconciled={reconciled} />
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
  const { groups, canManage, busy, onToggle } = props;
  return (
    <div className="space-y-6">
      {groups.map((d) => (
        <section key={d.day} aria-label={dayLongLabel(d.day)}>
          <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{dayLongLabel(d.day)}</h3>
              <p className="text-xs text-muted-foreground">{plural(d.count)}</p>
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(d.amount)}</span>
          </div>
          {d.merchants.map((m) => (
            <div key={m.key} className="mt-3">
              <div className="flex items-baseline justify-between gap-3 px-0.5 text-xs font-medium text-muted-foreground">
                <span className="min-w-0 truncate">
                  <span className="text-foreground">{merchantLabel(m.comercio)}</span> · {plural(m.count)}
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(m.amount)}</span>
              </div>
              <div className="mt-2 space-y-2">
                {m.batches.map((b) => {
                  const state = groupCheckState(b.rows);
                  const label = batchLabel(b.lote);
                  const groupBusy = busy === b.key;
                  return (
                    <div
                      key={b.key}
                      className={cn("overflow-hidden rounded-lg border border-border bg-card", groupBusy && "opacity-60")}
                    >
                      <div className="flex items-center gap-3 bg-muted/40 px-3 py-2.5">
                        <Checkbox
                          checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
                          disabled={!canManage || busy !== null}
                          busy={groupBusy}
                          onCheckedChange={() => onToggle(b.key, b.rows, state !== "all")}
                          aria-label={`${label}: marcar ${state === "all" ? "como pendiente" : "como conciliado"}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{label}</p>
                          <p className="text-xs text-muted-foreground">{plural(b.count)}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-sm font-semibold tabular-nums">{formatCurrency(b.amount)}</span>
                          <BatchBadge batch={b} />
                        </div>
                      </div>
                      <ul>
                        {b.rows.map((r) => (
                          <MobileRow key={r.id} row={r} groupBusy={groupBusy} {...props} />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
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

function MobileRow({ row: r, groupBusy, ...props }: GroupViewProps & { row: CardRecRow; groupBusy: boolean }) {
  const { canManage, busy, onToggle, onEdit, access, edits, ticket } = props;
  const reconciled = Boolean(r.reconciledAt);
  const rowBusy = busy === r.id;
  const t = ticket(r.ticket);
  return (
    <li className={cn("border-t border-border/60 px-3 py-3", (groupBusy || rowBusy) && "opacity-60")}>
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-0.5"
          checked={reconciled}
          disabled={!canManage || busy !== null}
          busy={rowBusy}
          onCheckedChange={(next) => onToggle(r.id, [r], next)}
          aria-label={`Cobro de ${formatCurrency(r.amount)}: marcar ${reconciled ? "como pendiente" : "como conciliado"}`}
        />
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
              <StatusBadge reconciled={reconciled} />
              <EditedMark edits={edits.get(r.id)} />
            </span>
            <EditButton row={r} access={access(r)} onEdit={onEdit} className="-my-1 -mr-1.5" />
          </div>
        </div>
      </div>
    </li>
  );
}
