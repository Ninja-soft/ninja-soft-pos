"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, SlidersHorizontal } from "lucide-react";
import { format, startOfDay, subDays } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { Switch } from "@/components/ui/Switch";
import {
  Dropdown,
  DropdownContent,
  DropdownLabel,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { useSalesReport } from "@/modules/reports/hooks";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { loadReportPrefs, saveReportPrefs } from "@/lib/theme/preferences";

const REPORTS = [
  { key: "by_day", label: "Por día" },
  { key: "by_method", label: "Por medio de pago" },
  { key: "by_category", label: "Por categoría" },
  { key: "by_user", label: "Por cajero" },
  { key: "by_product", label: "Top productos" },
  { key: "by_customer", label: "Top clientes" },
  { key: "low_stock", label: "Stock bajo" },
] as const;
type ReportKey = (typeof REPORTS)[number]["key"];
const DEFAULT_VIS: Record<ReportKey, boolean> = {
  by_day: true,
  by_method: true,
  by_category: true,
  by_user: true,
  by_product: true,
  by_customer: true,
  low_stock: true,
};

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
};

export default function ReportesPage() {
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

  const { data, isLoading } = useSalesReport(fromISO, toISO);

  async function exportReporte() {
    if (!data) return;
    const tag = `${format(range?.from ?? new Date(), "yyyy-MM-dd")}_${format(
      range?.to ?? range?.from ?? new Date(),
      "yyyy-MM-dd",
    )}`;
    await exportXlsx(`reporte-ventas-${tag}`, [
      {
        name: "Resumen",
        title: `Reporte de ventas · ${tag}`,
        columns: [
          { header: "Métrica", key: "k", width: 22 },
          { header: "Valor", key: "v", type: "money", width: 18 },
        ],
        rows: [
          { k: "Total vendido", v: data.total },
          { k: "Cantidad de ventas", v: data.count },
        ],
      },
      {
        name: "Por día",
        columns: [
          { header: "Día", key: "day", width: 14 },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: data.by_day,
        totals: {
          total: data.by_day.reduce((a, r) => a + r.total, 0),
          count: data.by_day.reduce((a, r) => a + r.count, 0),
        },
      },
      {
        name: "Medios de pago",
        columns: [
          { header: "Medio", key: "method", width: 18 },
          { header: "Total", key: "total", type: "money" },
        ],
        rows: data.by_method.map((r) => ({
          method: METHOD_LABELS[r.method] ?? r.method,
          total: r.total,
        })),
        totals: { total: data.by_method.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Categorías",
        columns: [
          { header: "Categoría", key: "category", width: 24 },
          { header: "Total", key: "total", type: "money" },
          { header: "Cantidad", key: "qty", type: "number" },
        ],
        rows: data.by_category,
        totals: { total: data.by_category.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Cajeros",
        columns: [
          { header: "Cajero", key: "cashier", width: 24 },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: data.by_user,
        totals: { total: data.by_user.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Top productos",
        columns: [
          { header: "Producto", key: "product", width: 28 },
          { header: "Total", key: "total", type: "money" },
          { header: "Cantidad", key: "qty", type: "number" },
        ],
        rows: data.by_product,
        totals: { total: data.by_product.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Top clientes",
        columns: [
          { header: "Cliente", key: "customer", width: 28 },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: data.by_customer,
        totals: { total: data.by_customer.reduce((a, r) => a + r.total, 0) },
      },
    ]);
  }

  const [vis, setVis] = useState<Record<ReportKey, boolean>>(DEFAULT_VIS);
  useEffect(() => {
    loadReportPrefs().then((p) => {
      if (p) setVis((v) => ({ ...v, ...p }));
    });
  }, []);
  function toggle(k: ReportKey) {
    setVis((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      void saveReportPrefs(next);
      return next;
    });
  }

  // Stock bajo (no depende del rango: es stock actual).
  const { data: lowStock = [] } = useQuery({
    queryKey: ["report-low-stock"],
    queryFn: async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("products")
        .select("name, stock, stock_min, unit")
        .is("deleted_at", null)
        .eq("is_active", true)
        .gt("stock_min", 0)
        .order("stock", { ascending: true });
      return (data ?? []).filter((p) => p.stock <= (p.stock_min ?? 0));
    },
  });

  return (
    <>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Eyebrow>Información</Eyebrow>
        <Display className="mt-3 text-3xl md:text-4xl">Reportes</Display>

        <div className="-mx-6 mt-6 flex items-end gap-3 overflow-x-auto px-6 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 flex-col gap-1">
            <label className="text-xs text-muted-foreground">Período</label>
            <DateRangePicker value={range} onChange={setRange} />
          </div>
          <Button variant="secondary" className="shrink-0" onClick={exportReporte} disabled={!data}>
            <Download size={16} /> Exportar XLSX
          </Button>
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="secondary" className="shrink-0">
                <SlidersHorizontal size={16} /> Personalizar
              </Button>
            </DropdownTrigger>
            <DropdownContent align="end" className="w-60">
              <DropdownLabel>Reportes a mostrar</DropdownLabel>
              {REPORTS.map((r) => (
                <div
                  key={r.key}
                  className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm"
                >
                  {r.label}
                  <Switch
                    checked={vis[r.key]}
                    onCheckedChange={() => toggle(r.key)}
                    label={r.label}
                  />
                </div>
              ))}
            </DropdownContent>
          </Dropdown>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Total vendido</p>
              <p className="mt-2 price-hl font-price tabular-nums text-3xl font-black">
                {formatCurrency(data?.total ?? 0)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Cantidad de ventas</p>
              <p className="mt-2 font-display text-3xl font-black">
                {data?.count ?? 0}
              </p>
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {vis.by_day && (
              <ReportTable
                title="Por día"
                cols={["Día", "Total", "Ventas"]}
                rows={(data?.by_day ?? []).map((r) => [
                  r.day,
                  formatCurrency(r.total),
                  String(r.count),
                ])}
              />
            )}
            {vis.by_method && (
              <ReportTable
                title="Por medio de pago"
                cols={["Medio", "Total"]}
                rows={(data?.by_method ?? []).map((r) => [
                  METHOD_LABELS[r.method] ?? r.method,
                  formatCurrency(r.total),
                ])}
              />
            )}
            {vis.by_category && (
              <ReportTable
                title="Por categoría"
                cols={["Categoría", "Total", "Cant."]}
                rows={(data?.by_category ?? []).map((r) => [
                  r.category,
                  formatCurrency(r.total),
                  formatQty(r.qty),
                ])}
              />
            )}
            {vis.by_user && (
              <ReportTable
                title="Por cajero"
                cols={["Cajero", "Total", "Ventas"]}
                rows={(data?.by_user ?? []).map((r) => [
                  r.cashier,
                  formatCurrency(r.total),
                  String(r.count),
                ])}
              />
            )}
            {vis.by_product && (
              <ReportTable
                title="Top productos"
                cols={["Producto", "Total", "Cant."]}
                rows={(data?.by_product ?? []).map((r) => [
                  r.product,
                  formatCurrency(r.total),
                  formatQty(r.qty),
                ])}
              />
            )}
            {vis.by_customer && (
              <ReportTable
                title="Top clientes"
                cols={["Cliente", "Total", "Ventas"]}
                rows={(data?.by_customer ?? []).map((r) => [
                  r.customer,
                  formatCurrency(r.total),
                  String(r.count),
                ])}
              />
            )}
            {vis.low_stock && (
              <ReportTable
                title="Stock bajo"
                cols={["Producto", "Stock", "Mínimo"]}
                rows={lowStock.map((p) => [
                  p.name,
                  `${formatQty(p.stock)} ${p.unit}`,
                  formatQty(p.stock_min ?? 0),
                ])}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ReportTable({
  title,
  cols,
  rows,
}: {
  title: string;
  cols: string[];
  rows: string[][];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3 font-display font-bold">
        {title}
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[320px] text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <tr>
            {cols.map((c, i) => (
              <th key={c} className={i === 0 ? "px-4 py-2" : "px-4 py-2 text-right"}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border text-foreground">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} className="px-4 py-6 text-center text-muted-foreground">
                Sin datos.
              </td>
            </tr>
          ) : (
            rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={ci === 0 ? "px-4 py-2" : "px-4 py-2 text-right"}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
