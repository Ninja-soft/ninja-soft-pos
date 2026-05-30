"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { format, startOfDay, subDays } from "date-fns";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useSalesReport } from "@/modules/reports/hooks";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";

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
    ]);
  }

  return (
    <>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Eyebrow>Información</Eyebrow>
        <Display className="mt-3 text-3xl md:text-4xl">Reportes</Display>

        <div className="mt-6 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Período</label>
            <DateRangePicker value={range} onChange={setRange} />
          </div>
          <Button variant="secondary" onClick={exportReporte} disabled={!data}>
            <Download size={16} /> Exportar XLSX
          </Button>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Total vendido</p>
              <p className="mt-2 font-price tabular-nums text-3xl font-black text-foreground">
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
            <ReportTable
              title="Por día"
              cols={["Día", "Total", "Ventas"]}
              rows={(data?.by_day ?? []).map((r) => [
                r.day,
                formatCurrency(r.total),
                String(r.count),
              ])}
            />
            <ReportTable
              title="Por medio de pago"
              cols={["Medio", "Total"]}
              rows={(data?.by_method ?? []).map((r) => [
                METHOD_LABELS[r.method] ?? r.method,
                formatCurrency(r.total),
              ])}
            />
            <ReportTable
              title="Por categoría"
              cols={["Categoría", "Total", "Cant."]}
              rows={(data?.by_category ?? []).map((r) => [
                r.category,
                formatCurrency(r.total),
                formatQty(r.qty),
              ])}
            />
            <ReportTable
              title="Por cajero"
              cols={["Cajero", "Total", "Ventas"]}
              rows={(data?.by_user ?? []).map((r) => [
                r.cashier,
                formatCurrency(r.total),
                String(r.count),
              ])}
            />
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
      <table className="w-full text-sm">
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
  );
}
