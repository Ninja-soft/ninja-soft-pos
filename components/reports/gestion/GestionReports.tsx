"use client";

// F24 · H161 (ADR-174): Reportes > Gestión. Rentabilidad mes a mes con el
// costo guardado en cada venta, cobranzas de cuenta corriente, movimientos de
// stock de todo el catálogo (kardex de un producto) y mercadería parada. Cada
// reporte lo controla el servidor (capacidad, plan y sucursales).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3, Download, X } from "lucide-react";
import { buttonVariants, Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { GatedButton } from "@/components/saas/GatedAction";
import { FeatureGate } from "@/components/saas/FeatureGate";
import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import { useBranchContext } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useCan } from "@/modules/logistics/api";
import {
  useCollectionsReport,
  useDeadStockReport,
  useProfitabilityReport,
  useStockMovementsReport,
  type ProfitRow,
} from "@/modules/reports/gestion";
import { deltaPct, marginPct, monthLabel, rangeToInstants, stockReasonLabel, STOCK_REASON_LABEL, ymd } from "@/lib/reports/gestion";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { exportXlsx } from "@/lib/utils/xlsx";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Tab = "rentabilidad" | "cobranzas" | "stock" | "parada";

const TH = "whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2 text-sm";
const NUM = "text-right tabular-nums";

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  if (/forbidden|42501/.test(m)) return "Tu usuario no tiene permiso para ver este reporte.";
  if (/feature_not_in_plan/.test(m)) return "Este reporte no está incluido en tu plan.";
  if (/invalid_range/.test(m)) return "Elegí un período de hasta 400 días.";
  return "No se pudo cargar el reporte. Probá de nuevo.";
}

function defaultRange(days: number): DateRange {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days + 1);
  return { from, to };
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string | null; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums", tone === "danger" && "text-danger", tone === "success" && "text-success")}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function deltaHint(cur: number, prev: number | null | undefined): string | null {
  const d = deltaPct(cur, prev);
  if (d === null) return null;
  return `${d > 0 ? "+" : ""}${d.toLocaleString("es-AR")} % vs período anterior`;
}

export function GestionReports() {
  const [tab, setTab] = useState<Tab>("rentabilidad");
  const branch = useBranchContext();
  const storeId = branch.filterStoreId ?? null;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-6 sm:px-6 sm:pt-8">
      <PageHeader
        eyebrow="Reportes"
        title="Gestión"
        icon={BarChart3}
        description="Rentabilidad con el costo de cada venta, cobranzas, movimientos de stock y mercadería parada."
      />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link href="/reportes" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          <ArrowLeft size={15} /> Reportes
        </Link>
        <Segmented
          size="sm"
          aria-label="Reporte"
          value={tab}
          onChange={setTab}
          options={[
            { value: "rentabilidad", label: "Rentabilidad" },
            { value: "cobranzas", label: "Cobranzas" },
            { value: "stock", label: "Movimientos de stock" },
            { value: "parada", label: "Mercadería parada" },
          ]}
        />
      </div>
      <div className="mt-5">
        {tab === "rentabilidad" && <ProfitTab storeId={storeId} />}
        {tab === "cobranzas" && <CollectionsTab storeId={storeId} />}
        {tab === "stock" && <StockTab storeId={storeId} />}
        {tab === "parada" && <DeadTab storeId={storeId} />}
      </div>
    </div>
  );
}

// ── Rentabilidad ────────────────────────────────────────────────────────────

function ProfitTab({ storeId }: { storeId: string | null }) {
  const feature = useFeature("metricas_avanzadas");
  const canCosts = useCan("reports.costs");
  const [range, setRange] = useState<DateRange | undefined>();
  useEffect(() => setRange(defaultRange(90)), []);
  const from = range?.from ? ymd(range.from) : null;
  const to = range?.to ? ymd(range.to) : from;
  const q = useProfitabilityReport(from, to, storeId, feature !== false && canCosts);
  const r = q.data;
  const t = r?.totals;

  if (!canCosts) {
    return <Callout tone="info" title="Necesitás el permiso de ver costos y márgenes">Pedíselo al dueño del negocio.</Callout>;
  }
  return (
    <FeatureGate feature="metricas_avanzadas" featureLabel="Rentabilidad y mercadería parada">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <GatedButton
            feature="export_xlsx"
            featureLabel="Exportar a Excel"
            variant="secondary"
            size="sm"
            disabled={!r}
            onClick={() =>
              r &&
              void exportXlsx(`rentabilidad-${from}-${to}`, [
                {
                  name: "Rentabilidad",
                  title: "Rentabilidad mes a mes",
                  subtitle: `${from} a ${to}`,
                  columns: [
                    { header: "Mes", key: "month" },
                    { header: "Ventas", key: "sales", type: "money" },
                    { header: "Impuestos", key: "taxes", type: "money" },
                    { header: "Ventas netas", key: "net_sales", type: "money" },
                    { header: "Devoluciones", key: "returns", type: "money" },
                    { header: "Costo de lo vendido", key: "cmv", type: "money" },
                    { header: "Margen bruto", key: "gross_margin", type: "money" },
                    { header: "Gastos", key: "expenses", type: "money" },
                    { header: "Resultado", key: "result", type: "money" },
                  ],
                  rows: r.months.map((m) => ({ ...m, month: monthLabel(m.month) })),
                },
              ])
            }
          >
            <Download size={15} /> XLSX
          </GatedButton>
        </div>
        {q.isLoading && <SpinnerBlock label="Calculando" />}
        {q.error && <Callout tone="danger" title={errorText(q.error)} />}
        {r && t && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Ventas netas" value={formatCurrency(t.net_sales)} hint={deltaHint(t.net_sales, r.previous?.net_sales)} />
              <Kpi label="Costo de lo vendido" value={formatCurrency(t.cmv)} hint={deltaHint(t.cmv, r.previous?.cmv)} />
              <Kpi
                label="Margen bruto"
                value={formatCurrency(t.gross_margin)}
                hint={marginPct(t.gross_margin, t.net_sales) !== null ? `${marginPct(t.gross_margin, t.net_sales)!.toLocaleString("es-AR")} % de las ventas netas` : null}
              />
              <Kpi
                label="Resultado"
                value={formatCurrency(t.result)}
                tone={t.result < 0 ? "danger" : "success"}
                hint={deltaHint(t.result, r.previous?.result)}
              />
            </div>
            <ProfitNotes r={t} expensesIncluded={r.expenses_included} />
            <ProfitTable months={r.months} />
          </>
        )}
        {r && !t && <p className="text-sm text-muted-foreground">No hay ventas en el período.</p>}
      </div>
    </FeatureGate>
  );
}

function ProfitNotes({ r, expensesIncluded }: { r: ProfitRow; expensesIncluded: boolean }) {
  const notes: string[] = [];
  if (r.cost_coverage_pct != null && r.cost_coverage_pct < 95) {
    notes.push(`Sólo el ${r.cost_coverage_pct.toLocaleString("es-AR")} % de lo vendido tiene costo cargado: el margen real es menor.`);
  }
  if (r.approx) notes.push("Las ventas anteriores al 20/10/2026 usan el costo de ese día (aproximado).");
  if (!expensesIncluded) notes.push("Con una sucursal elegida no se restan los gastos: son del negocio.");
  if (notes.length === 0) return null;
  return (
    <Callout tone="warning" title="Para leer bien el margen">
      <ul className="list-disc space-y-0.5 pl-4">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </Callout>
  );
}

function ProfitTable({ months }: { months: ProfitRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full">
        <thead className="bg-muted">
          <tr>
            <th className={TH}>Mes</th>
            <th className={cn(TH, "text-right")}>Ventas netas</th>
            <th className={cn(TH, "text-right")}>Devoluciones</th>
            <th className={cn(TH, "text-right")}>Costo</th>
            <th className={cn(TH, "text-right")}>Margen bruto</th>
            <th className={cn(TH, "text-right")}>Gastos</th>
            <th className={cn(TH, "text-right")}>Resultado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {months.map((m) => (
            <tr key={m.month}>
              <td className={TD}>{monthLabel(m.month)}</td>
              <td className={cn(TD, NUM)}>{formatCurrency(m.net_sales)}</td>
              <td className={cn(TD, NUM)}>{formatCurrency(m.returns ?? 0)}</td>
              <td className={cn(TD, NUM)}>{formatCurrency(m.cmv)}</td>
              <td className={cn(TD, NUM)}>
                {formatCurrency(m.gross_margin)}
                {marginPct(m.gross_margin, m.net_sales) !== null && (
                  <span className="ml-1 text-xs text-muted-foreground">({marginPct(m.gross_margin, m.net_sales)} %)</span>
                )}
              </td>
              <td className={cn(TD, NUM)}>{formatCurrency(m.expenses)}</td>
              <td className={cn(TD, NUM, "font-semibold", m.result < 0 && "text-danger")}>{formatCurrency(m.result)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Cobranzas ───────────────────────────────────────────────────────────────

function CollectionsTab({ storeId }: { storeId: string | null }) {
  const [range, setRange] = useState<DateRange | undefined>();
  useEffect(() => setRange(defaultRange(30)), []);
  const inst = rangeToInstants(range?.from, range?.to);
  const q = useCollectionsReport(inst?.from ?? null, inst?.to ?? null, storeId);
  const r = q.data;
  const method = (m: string) => PAYMENT_METHOD_LABELS[m] ?? m;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <GatedButton
          feature="export_xlsx"
          featureLabel="Exportar a Excel"
          variant="secondary"
          size="sm"
          disabled={!r}
          onClick={() =>
            r &&
            void exportXlsx("cobranzas", [
              {
                name: "Cobranzas",
                title: "Cobranzas de cuenta corriente",
                columns: [
                  { header: "Fecha", key: "created_at", type: "datetime" },
                  { header: "Recibo", key: "receipt_no", type: "number" },
                  { header: "Cliente", key: "customer_name" },
                  { header: "Medio", key: "method_label" },
                  { header: "Cobró", key: "user_name" },
                  { header: "Caja", key: "register_name" },
                  { header: "Importe", key: "amount", type: "money" },
                ],
                rows: r.rows.map((x) => ({ ...x, created_at: new Date(x.created_at), method_label: method(x.method) })),
                totals: { amount: r.total },
              },
            ])
          }
        >
          <Download size={15} /> XLSX
        </GatedButton>
      </div>
      {q.isLoading && <SpinnerBlock label="Cargando" />}
      {q.error && <Callout tone="danger" title={errorText(q.error)} />}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Cobrado" value={formatCurrency(r.total)} hint={`${r.count} cobro${r.count === 1 ? "" : "s"}`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <GroupTable title="Por medio" rows={r.by_method.map((x) => ({ key: x.method, name: method(x.method), amount: x.amount, count: x.count }))} />
            <GroupTable title="Por persona" rows={r.by_user.map((x) => ({ key: x.user_id ?? "-", name: x.name, amount: x.amount, count: x.count }))} />
            <GroupTable title="Por caja" rows={r.by_register.map((x) => ({ key: x.register_id ?? "-", name: x.name, amount: x.amount, count: x.count }))} />
          </div>
          {r.rows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full">
                <thead className="bg-muted">
                  <tr>
                    <th className={TH}>Fecha</th>
                    <th className={TH}>Recibo</th>
                    <th className={TH}>Cliente</th>
                    <th className={TH}>Medio</th>
                    <th className={TH}>Cobró</th>
                    <th className={cn(TH, "text-right")}>Importe</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {r.rows.map((x) => (
                    <tr key={x.id}>
                      <td className={TD}>{new Date(x.created_at).toLocaleString("es-AR")}</td>
                      <td className={TD}>{x.receipt_no ?? ""}</td>
                      <td className={TD}>
                        <Link href={`/clientes/${x.customer_id}`} className="hover:underline">
                          {x.customer_name ?? "Cliente"}
                        </Link>
                      </td>
                      <td className={TD}>{method(x.method)}</td>
                      <td className={TD}>{x.user_name ?? ""}</td>
                      <td className={cn(TD, NUM)}>{formatCurrency(x.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.count === 0 && <p className="text-sm text-muted-foreground">No hubo cobros de cuenta corriente en el período.</p>}
        </>
      )}
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: { key: string; name: string; amount: number; count: number }[] }) {
  return (
    <div className="rounded-xl border border-border">
      <p className="border-b border-border px-3 py-2 text-sm font-semibold">{title}</p>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">Sin datos</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((x) => (
            <li key={x.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {x.name} <span className="text-xs text-muted-foreground">({x.count})</span>
              </span>
              <span className="tabular-nums">{formatCurrency(x.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Movimientos de stock ────────────────────────────────────────────────────

function StockTab({ storeId }: { storeId: string | null }) {
  const canCosts = useCan("reports.costs");
  const [range, setRange] = useState<DateRange | undefined>();
  useEffect(() => setRange(defaultRange(30)), []);
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [range, product, reason, storeId]);
  const inst = rangeToInstants(range?.from, range?.to);
  const q = useStockMovementsReport({
    from: inst?.from ?? null,
    to: inst?.to ?? null,
    storeId,
    productId: product?.id ?? null,
    reason,
    page,
  });
  const r = q.data;
  const pages = r ? Math.max(1, Math.ceil(r.total_count / 200)) : 1;
  const reasons = useMemo(() => Object.keys(STOCK_REASON_LABEL), []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <select
          aria-label="Motivo"
          className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
          value={reason ?? ""}
          onChange={(e) => setReason(e.target.value || null)}
        >
          <option value="">Todos los motivos</option>
          {reasons.map((k) => (
            <option key={k} value={k}>
              {stockReasonLabel(k)}
            </option>
          ))}
        </select>
        {product ? (
          <Badge tone="neutral" className="gap-1">
            Kardex: {product.name}
            <button aria-label="Quitar producto" onClick={() => setProduct(null)}>
              <X size={12} />
            </button>
          </Badge>
        ) : (
          <div className="w-full sm:w-72">
            <ProductSearchCombobox
              placeholder="Kardex de un producto"
              onPick={(p) => setProduct({ id: p.id, name: p.name })}
            />
          </div>
        )}
      </div>
      {q.isLoading && <SpinnerBlock label="Cargando" />}
      {q.error && <Callout tone="danger" title={errorText(q.error)} />}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Movimientos" value={r.total_count.toLocaleString("es-AR")} />
            <Kpi label="Entradas" value={formatQty(r.in)} />
            <Kpi label="Salidas" value={formatQty(r.out)} />
            {product && r.opening !== null && (
              <Kpi label="Saldo" value={formatQty(r.closing ?? 0)} hint={`Antes del período: ${formatQty(r.opening)}`} />
            )}
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className={TH}>Fecha</th>
                  {!product && <th className={TH}>Producto</th>}
                  <th className={TH}>Sucursal</th>
                  <th className={TH}>Motivo</th>
                  <th className={cn(TH, "text-right")}>Cantidad</th>
                  {product && <th className={cn(TH, "text-right")}>Saldo</th>}
                  {canCosts && <th className={cn(TH, "text-right")}>Costo unit.</th>}
                  <th className={TH}>Usuario</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.rows.map((x) => (
                  <tr key={x.id}>
                    <td className={TD}>{new Date(x.created_at).toLocaleString("es-AR")}</td>
                    {!product && (
                      <td className={TD}>
                        <button className="hover:underline" onClick={() => setProduct({ id: x.product_id, name: x.product_name ?? "Producto" })}>
                          {x.product_name ?? "Producto"}
                        </button>
                      </td>
                    )}
                    <td className={TD}>{x.store_name ?? ""}</td>
                    <td className={TD}>{stockReasonLabel(x.reason)}</td>
                    <td className={cn(TD, NUM, x.delta < 0 ? "text-danger" : "text-success")}>
                      {x.delta > 0 ? "+" : ""}
                      {formatQty(x.delta)}
                    </td>
                    {product && <td className={cn(TD, NUM)}>{x.balance === null ? "" : formatQty(x.balance)}</td>}
                    {canCosts && <td className={cn(TD, NUM)}>{x.unit_cost === null ? "" : formatCurrency(x.unit_cost)}</td>}
                    <td className={TD}>{x.user_name ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm">
              <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <span className="tabular-nums">
                {page + 1} de {pages}
              </span>
              <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Siguiente
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Mercadería parada ───────────────────────────────────────────────────────

function DeadTab({ storeId }: { storeId: string | null }) {
  const feature = useFeature("metricas_avanzadas");
  const canCosts = useCan("reports.costs");
  const [days, setDays] = useState(90);
  const q = useDeadStockReport(days, storeId, feature !== false);
  const r = q.data;
  return (
    <FeatureGate feature="metricas_avanzadas" featureLabel="Rentabilidad y mercadería parada">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            aria-label="Días sin venta"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: "30", label: "30 días" },
              { value: "60", label: "60 días" },
              { value: "90", label: "90 días" },
              { value: "180", label: "180 días" },
              { value: "365", label: "1 año" },
            ]}
          />
          <GatedButton
            feature="export_xlsx"
            featureLabel="Exportar a Excel"
            variant="secondary"
            size="sm"
            disabled={!r}
            onClick={() =>
              r &&
              void exportXlsx(`mercaderia-parada-${days}d`, [
                {
                  name: "Mercadería parada",
                  title: `Sin ventas hace ${days} días o más`,
                  columns: [
                    { header: "Producto", key: "name" },
                    { header: "SKU", key: "sku" },
                    { header: "Categoría", key: "category" },
                    { header: "Stock", key: "qty", type: "number" },
                    { header: "Última venta", key: "last", type: "date" },
                    { header: "Días sin venta", key: "days_label" },
                    { header: "Valor a precio", key: "value_price", type: "money" },
                    ...(canCosts ? [{ header: "Valor a costo", key: "value_cost", type: "money" as const }] : []),
                  ],
                  rows: r.rows.map((x) => ({
                    ...x,
                    last: x.last_sale_at ? new Date(x.last_sale_at) : null,
                    days_label: x.days === null ? "Nunca se vendió" : String(x.days),
                  })),
                  totals: { value_price: r.value_price, ...(canCosts && r.value_cost !== null ? { value_cost: r.value_cost } : {}) },
                },
              ])
            }
          >
            <Download size={15} /> XLSX
          </GatedButton>
        </div>
        {q.isLoading && <SpinnerBlock label="Buscando" />}
        {q.error && <Callout tone="danger" title={errorText(q.error)} />}
        {r && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Productos parados" value={r.count.toLocaleString("es-AR")} hint={`${r.never_sold} nunca se vendieron`} />
              <Kpi label="Valor a precio" value={formatCurrency(r.value_price)} />
              {r.value_cost !== null && <Kpi label="Valor a costo" value={formatCurrency(r.value_cost)} hint="Plata inmovilizada" />}
            </div>
            {r.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todo lo que tiene stock se vendió en los últimos {days} días.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className={TH}>Producto</th>
                      <th className={TH}>Categoría</th>
                      <th className={cn(TH, "text-right")}>Stock</th>
                      <th className={TH}>Última venta</th>
                      <th className={cn(TH, "text-right")}>Valor a precio</th>
                      {canCosts && <th className={cn(TH, "text-right")}>Valor a costo</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {r.rows.map((x) => (
                      <tr key={x.product_id}>
                        <td className={TD}>
                          {x.name}
                          {x.sku && <span className="ml-1 text-xs text-muted-foreground">{x.sku}</span>}
                        </td>
                        <td className={TD}>{x.category ?? ""}</td>
                        <td className={cn(TD, NUM)}>{formatQty(x.qty)}</td>
                        <td className={TD}>
                          {x.last_sale_at ? (
                            `${new Date(x.last_sale_at).toLocaleDateString("es-AR")} (${x.days} días)`
                          ) : (
                            <Badge tone="warning">Nunca se vendió</Badge>
                          )}
                        </td>
                        <td className={cn(TD, NUM)}>{formatCurrency(x.value_price)}</td>
                        {canCosts && <td className={cn(TD, NUM)}>{x.value_cost === null ? "" : formatCurrency(x.value_cost)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </FeatureGate>
  );
}
