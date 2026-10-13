"use client";

import { useMemo } from "react";
import { EChart } from "@/components/charts/EChart";
import { doughnutOption, rankingBarOption, timeSeriesOption } from "@/components/charts/builders";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { methodLabel } from "@/lib/sales/paymentDetail";
import type { C360Summary } from "@/lib/customers/c360";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${String(y).slice(2)}`;
};

// Gráficos de la ficha 360: compras por mes, medios de pago y productos más
// comprados (ECharts perezoso del proyecto).
export function C360Charts({ summary }: { summary: C360Summary }) {
  const monthly = useMemo(
    () =>
      timeSeriesOption({
        labels: summary.monthly.map((m) => monthLabel(m.month)),
        values: summary.monthly.map((m) => m.total),
        name: "Comprado",
        format: "currency",
        kind: "bar",
        showAverage: true,
      }),
    [summary.monthly],
  );
  const methods = useMemo(
    () =>
      doughnutOption({
        items: summary.payment_methods.map((m) => ({
          label: methodLabel(m.method),
          value: m.total,
          note: `${m.count} cobros`,
        })),
        name: "Cobrado",
        format: "currency",
      }),
    [summary.payment_methods],
  );
  const products = useMemo(
    () =>
      rankingBarOption({
        items: summary.top_products.map((p) => ({
          label: p.name,
          value: p.total,
          note: `${formatQty(p.qty)} u. en ${p.purchases} compras`,
        })),
        name: "Comprado",
        format: "currency",
      }),
    [summary.top_products],
  );
  const noSales = summary.monthly.every((m) => m.total === 0);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Compras por mes</h2>
        <p className="text-xs text-muted-foreground">Últimos 12 meses, con el promedio.</p>
        <EChart
          className="mt-3"
          option={monthly}
          height={240}
          ariaLabel="Compras del cliente por mes"
          empty={noSales}
          emptyTitle="Sin compras en los últimos 12 meses"
          emptyHint="Cuando compre, vas a ver acá cómo evoluciona."
          summary={{
            columns: ["Mes", "Comprado"],
            rows: summary.monthly.map((m) => [monthLabel(m.month), formatCurrency(m.total)]),
          }}
        />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Medios de pago que usa</h2>
          <EChart
            className="mt-3"
            option={methods}
            height={240}
            ariaLabel="Medios de pago del cliente"
            empty={summary.payment_methods.length === 0}
            emptyTitle="Sin cobros"
            emptyHint="Todavía no hay cobros de este cliente."
            summary={{
              columns: ["Medio", "Cobrado"],
              rows: summary.payment_methods.map((m) => [methodLabel(m.method), formatCurrency(m.total)]),
            }}
          />
        </section>
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Productos que más compra</h2>
          <EChart
            className="mt-3"
            option={products}
            height={Math.max(160, summary.top_products.length * 28)}
            ariaLabel="Productos más comprados por el cliente"
            empty={summary.top_products.length === 0}
            emptyTitle="Sin productos"
            emptyHint="Todavía no compró productos."
            summary={{
              columns: ["Producto", "Comprado", "Unidades"],
              rows: summary.top_products.map((p) => [p.name, formatCurrency(p.total), formatQty(p.qty)]),
            }}
          />
        </section>
      </div>
    </div>
  );
}
