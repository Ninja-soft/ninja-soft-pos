"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, CreditCard, Download, Info, Lock } from "lucide-react";
import { startOfDay, startOfMonth, subDays } from "date-fns";
import { Button } from "@/components/ui/Button";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Callout } from "@/components/ui/Callout";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import {
  reconcileErrorMessage,
  useCardPayments,
  useSetReconciled,
} from "@/modules/reports/cardReconciliation";
import {
  DEFAULT_FILTERS,
  KIND_LABEL,
  XLSX_COLUMNS,
  batchLabel,
  brandOptions,
  dayLabel,
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
  type CardRecFilters,
  type CardRecRow,
  type ReconcileStatus,
} from "@/lib/reports/cardReconciliation";

const FEATURE = "conciliacion_tarjetas";
const PAYMENTS_SETTINGS = "/configuracion?seccion=pagos" as Route;
const COLS = 12;

const SELECT =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:w-44";

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "success" | "warning" }) {
  return (
    <div className="min-w-0 rounded-lg bg-card p-4 ring-1 ring-border">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 truncate font-price text-xl font-black tabular-nums",
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

/** Checkbox con estado intermedio (lote con algunos cobros conciliados). */
function Check({
  state,
  disabled,
  onChange,
  label,
}: {
  state: "all" | "some" | "none";
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "all"}
      disabled={disabled}
      onChange={() => onChange(state !== "all")}
      aria-label={label}
      className="h-4 w-4 cursor-pointer accent-ninja-flame disabled:cursor-not-allowed disabled:opacity-50"
    />
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

export default function ConciliacionTarjetasPage() {
  const { toast } = useToast();
  const enabled = useFeature(FEATURE);
  const { data: me } = useMyTenant();
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

  const { data, isLoading, isError, refetch } = useCardPayments(fromISO, toISO, enabled !== false);
  const mutation = useSetReconciled();
  const [busy, setBusy] = useState<string | null>(null);

  const all = useMemo(() => normalizeCardPayments(data ?? []), [data]);
  const brands = useMemo(() => brandOptions(all), [all]);
  const merchants = useMemo(() => merchantOptions(all), [all]);
  const rows = useMemo(() => filterCardRows(all, filters), [all, filters]);
  const groups = useMemo(() => groupCardRows(rows), [rows]);
  const summary = useMemo(() => summarizeCardRows(rows), [rows]);
  const withoutMerchant = useMemo(() => all.filter((r) => !r.comercio).length, [all]);

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
    await exportXlsx(`conciliacion-tarjetas_${localISODate(range?.from ?? new Date())}`, [
      {
        name: "Detalle",
        title: `Conciliación de tarjetas ${from}${to && to !== from ? ` al ${to}` : ""} • NinjaPos`,
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

  return (
    <PageContainer>
      <Link href="/reportes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Reportes
      </Link>
      <PageHeader
        className="mt-2"
        eyebrow="Reportes"
        title="Conciliación de tarjetas"
        description="Compará los cobros con tarjeta contra la liquidación de cada adquirente, por día, número de comercio y lote, y marcá lo que ya te acreditaron."
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
                    className="rounded-md border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:border-ninja-flameSoft hover:text-foreground"
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
            <Kpi
              label="Total tarjetas"
              value={formatCurrency(summary.total.amount)}
              sub={`${summary.total.count} ${summary.total.count === 1 ? "cobro" : "cobros"}`}
            />
            <Kpi
              label="Conciliado"
              tone="success"
              value={formatCurrency(summary.reconciled.amount)}
              sub={`${summary.reconciled.count} ${summary.reconciled.count === 1 ? "cobro" : "cobros"}`}
            />
            <Kpi
              label="Pendiente"
              tone={summary.pending.count > 0 ? "warning" : undefined}
              value={formatCurrency(summary.pending.amount)}
              sub={`${summary.pending.count} ${summary.pending.count === 1 ? "cobro" : "cobros"}`}
            />
          </div>

          {!canManage && me && (
            <Callout tone="neutral" icon={Info} className="mt-4">
              Sólo el dueño o un encargado pueden marcar cobros como conciliados.
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

          {/* Tabla agrupada */}
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
                    className="inline-flex h-9 items-center rounded-lg border border-input bg-background px-3 text-sm font-medium transition hover:border-ninja-flameSoft"
                  >
                    Ir a Medios de pago
                  </Link>
                }
              />
            </div>
          ) : (
            <TableWrap className="mt-6">
              <table className="w-full min-w-[1040px] text-sm">
                <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-3">
                      <span className="sr-only">Conciliado</span>
                    </th>
                    <th className="px-3 py-3">Fecha y hora</th>
                    <th className="px-3 py-3">Ticket</th>
                    <th className="px-3 py-3">Marca</th>
                    <th className="px-3 py-3">Tipo</th>
                    <th className="px-3 py-3">Cuotas</th>
                    <th className="px-3 py-3">Lote</th>
                    <th className="px-3 py-3">Cupón</th>
                    <th className="px-3 py-3">Autorización</th>
                    <th className="px-3 py-3">Últ. 4</th>
                    <th className="px-3 py-3">Comercio</th>
                    <th className="px-3 py-3 text-right">Monto</th>
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
                  groups.map((d) => (
                    <tbody key={d.day} className="border-t border-border first:border-t-0">
                      <tr className="bg-muted/60">
                        <td colSpan={COLS - 1} className="px-3 py-2.5 font-semibold">
                          {dayLabel(d.day)}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {d.count} {d.count === 1 ? "cobro" : "cobros"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{formatCurrency(d.amount)}</td>
                      </tr>
                      {d.merchants.map((m) => (
                        <MerchantBlock
                          key={m.key}
                          comercio={m.comercio}
                          count={m.count}
                          amount={m.amount}
                          batches={m.batches}
                          canManage={canManage}
                          busy={busy}
                          onToggle={toggle}
                          ticket={(n) => (n == null ? "-" : formatSaleNumber(n, numFmt))}
                        />
                      ))}
                    </tbody>
                  ))
                )}
              </table>
            </TableWrap>
          )}
        </>
      )}
    </PageContainer>
  );
}

function localISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function MerchantBlock({
  comercio,
  count,
  amount,
  batches,
  canManage,
  busy,
  onToggle,
  ticket,
}: {
  comercio: string;
  count: number;
  amount: number;
  batches: ReturnType<typeof groupCardRows>[number]["merchants"][number]["batches"];
  canManage: boolean;
  busy: string | null;
  onToggle: (key: string, rows: CardRecRow[], target: boolean) => void;
  ticket: (n: number | null) => string;
}) {
  return (
    <>
      <tr className="border-t border-border">
        <td />
        <td colSpan={COLS - 2} className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {merchantLabel(comercio)}
          <span className="ml-2 font-normal normal-case tracking-normal">
            {count} {count === 1 ? "cobro" : "cobros"}
          </span>
        </td>
        <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-muted-foreground">
          {formatCurrency(amount)}
        </td>
      </tr>
      {batches.map((b) => {
        const state = groupCheckState(b.rows);
        const groupBusy = busy === b.key;
        return (
          <BatchRows
            key={b.key}
            label={batchLabel(b.lote)}
            state={state}
            count={b.count}
            reconciledCount={b.reconciledCount}
            amount={b.amount}
            rows={b.rows}
            disabled={!canManage || busy !== null}
            loading={groupBusy}
            onToggleGroup={(target) => onToggle(b.key, b.rows, target)}
            onToggleRow={(r, target) => onToggle(r.id, [r], target)}
            busy={busy}
            ticket={ticket}
          />
        );
      })}
    </>
  );
}

function BatchRows({
  label,
  state,
  count,
  reconciledCount,
  amount,
  rows,
  disabled,
  loading,
  onToggleGroup,
  onToggleRow,
  busy,
  ticket,
}: {
  label: string;
  state: "all" | "some" | "none";
  count: number;
  reconciledCount: number;
  amount: number;
  rows: CardRecRow[];
  disabled: boolean;
  loading: boolean;
  onToggleGroup: (target: boolean) => void;
  onToggleRow: (r: CardRecRow, target: boolean) => void;
  busy: string | null;
  ticket: (n: number | null) => string;
}) {
  return (
    <>
      <tr className={cn("border-t border-border/60 bg-muted/25", loading && "opacity-60")}>
        <td className="px-3 py-2">
          <Check
            state={state}
            disabled={disabled}
            onChange={onToggleGroup}
            label={`${label}: marcar ${state === "all" ? "como pendiente" : "como conciliado"}`}
          />
        </td>
        <td colSpan={COLS - 2} className="px-3 py-2 font-medium">
          {label}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {count} {count === 1 ? "cobro" : "cobros"}
            {reconciledCount > 0 && reconciledCount < count ? `, ${reconciledCount} conciliados` : ""}
            {state === "all" ? ", conciliado" : ""}
          </span>
        </td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(amount)}</td>
      </tr>
      {rows.map((r) => (
        <tr
          key={r.id}
          className={cn(
            "border-t border-border/40 transition-colors hover:bg-muted/30",
            (loading || busy === r.id) && "opacity-60",
          )}
        >
          <td className="px-3 py-2">
            <Check
              state={r.reconciledAt ? "all" : "none"}
              disabled={disabled}
              onChange={(target) => onToggleRow(r, target)}
              label={`Cobro de ${formatCurrency(r.amount)}: marcar ${r.reconciledAt ? "como pendiente" : "como conciliado"}`}
            />
          </td>
          <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
            {dayLabel(r.day).slice(0, 5)} {localTime(r.createdAt)}
          </td>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{ticket(r.ticket)}</td>
          <td className="px-3 py-2">
            <span className="inline-flex items-center gap-2">
              {r.brandKey ? (
                <CardBrandLogo brand={r.brandKey} label={r.brandLabel} height={16} />
              ) : null}
              <span className="whitespace-nowrap">{r.brandLabel || "Sin marca"}</span>
            </span>
          </td>
          <td className="px-3 py-2">{KIND_LABEL[r.kind]}</td>
          <td className="px-3 py-2 tabular-nums">{r.installments ?? "-"}</td>
          <td className="px-3 py-2 font-mono text-xs">{r.lote || "-"}</td>
          <td className="px-3 py-2 font-mono text-xs">{r.cupon || "-"}</td>
          <td className="px-3 py-2 font-mono text-xs" title={r.reference ? `Referencia ${r.reference}` : undefined}>
            {r.autorizacion || "-"}
          </td>
          <td className="px-3 py-2 font-mono text-xs">{r.ultimos4 || "-"}</td>
          <td className="px-3 py-2 font-mono text-xs">{r.comercio || "-"}</td>
          <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(r.amount)}</td>
        </tr>
      ))}
    </>
  );
}
