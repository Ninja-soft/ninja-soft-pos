"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { Isotype } from "@/components/brand/Logo";
import { useSalesReport } from "@/modules/reports/hooks";
import { formatCurrency, formatQty } from "@/lib/utils/format";

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
};

function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default function ReportesPage() {
  const [from, setFrom] = useState(isoDay(-6));
  const [to, setTo] = useState(isoDay(0));

  const { fromISO, toISO } = useMemo(() => {
    const f = new Date(`${from}T00:00:00`);
    const t = new Date(`${to}T00:00:00`);
    t.setDate(t.getDate() + 1); // inclusivo del día "hasta"
    return { fromISO: f.toISOString(), toISO: t.toISOString() };
  }, [from, to]);

  const { data, isLoading } = useSalesReport(fromISO, toISO);

  function exportCsv() {
    if (!data) return;
    const lines: string[] = [];
    lines.push(`Reporte de ventas,${from},${to}`);
    lines.push(`Total,${data.total}`);
    lines.push(`Cantidad,${data.count}`);
    lines.push("");
    lines.push("Por día,Total,Ventas");
    data.by_day.forEach((r) => lines.push(`${r.day},${r.total},${r.count}`));
    lines.push("");
    lines.push("Por medio de pago,Total");
    data.by_method.forEach((r) =>
      lines.push(`${METHOD_LABELS[r.method] ?? r.method},${r.total}`),
    );
    lines.push("");
    lines.push("Por categoría,Total,Cantidad");
    data.by_category.forEach((r) =>
      lines.push(`${r.category},${r.total},${r.qty}`),
    );
    lines.push("");
    lines.push("Por cajero,Total,Ventas");
    data.by_user.forEach((r) => lines.push(`${r.cashier},${r.total},${r.count}`));

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reporte-ventas-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls =
    "h-11 rounded-ninjaLg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

  return (
    <div className="ninja-dark-bg min-h-screen text-ninja-softWhite">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-3">
            <Isotype className="h-7 w-auto" />
            <span className="flex items-center gap-1 text-sm text-ninja-lavender">
              <ArrowLeft size={15} /> Panel
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <Eyebrow>Información</Eyebrow>
        <Display className="mt-3 text-3xl md:text-4xl">Reportes</Display>

        <div className="mt-6 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ninja-lavender">Desde</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ninja-lavender">Hasta</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </div>
          <Button variant="secondary" onClick={exportCsv} disabled={!data}>
            <Download size={16} /> Exportar CSV
          </Button>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-ninja-lavender">Total vendido</p>
              <p className="mt-2 font-display text-3xl font-black text-ninja-gold">
                {formatCurrency(data?.total ?? 0)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-ninja-lavender">Cantidad de ventas</p>
              <p className="mt-2 font-display text-3xl font-black">
                {data?.count ?? 0}
              </p>
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <p className="mt-8 text-center text-sm text-ninja-lavender">Cargando…</p>
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
      </main>
    </div>
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
    <div className="overflow-hidden rounded-ninjaLg border border-white/10 bg-white/[0.04]">
      <div className="border-b border-white/10 px-4 py-3 font-display font-bold">
        {title}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.14em] text-white/45">
          <tr>
            {cols.map((c, i) => (
              <th key={c} className={i === 0 ? "px-4 py-2" : "px-4 py-2 text-right"}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10 text-white/80">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} className="px-4 py-6 text-center text-white/40">
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
