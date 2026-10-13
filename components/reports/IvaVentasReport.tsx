"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Landmark, Lock } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PageHeader } from "@/components/ui/PageHeader";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { SettingsCard } from "@/components/settings/Settings";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { jurisdictionName } from "@/lib/tax/catalog";
import { taxErrorMessage, type IvaReport } from "@/modules/tax/api";
import { useIvaReport } from "@/modules/tax/hooks";

// Reporte de IVA ventas (F18 · H103-H105, ADR-068): por alícuota (AlicIva),
// exento, no gravado, internos, percepciones por jurisdicción, por tipo de
// comprobante y por sucursal. Base para el Libro IVA Digital (H108).

function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

function csv(r: IvaReport): string {
  const rows: (string | number)[][] = [["Concepto", "Base", "Importe"]];
  for (const g of r.by_rate) rows.push([`IVA ${g.label}`, g.base, g.amount]);
  rows.push(["Exento", r.net_exempt, 0], ["No gravado", r.net_untaxed, 0], ["Impuestos internos", "", r.internal_total]);
  for (const p of r.perceptions)
    rows.push([`Percepción ${p.tax.toUpperCase()} ${p.jurisdiction ? jurisdictionName(p.jurisdiction) : ""}`.trim(), p.base, p.amount]);
  rows.push(["Total vendido", "", r.total]);
  return rows.map((x) => x.map((v) => (typeof v === "number" ? String(v).replace(".", ",") : `"${v}"`)).join(";")).join("\n");
}

export function IvaVentasReport() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const { from, to } = monthRange(month);
  const q = useIvaReport(from, to, null);
  const r = q.data;

  const download = () => {
    if (!r) return;
    const blob = new Blob([`﻿${csv(r)}`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `iva-ventas-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pb-10 pt-6 sm:px-6 sm:pt-8">
      <PageHeader
        eyebrow="Reportes"
        title="IVA ventas"
        icon={Landmark}
        description="Lo que vendiste en el mes discriminado como lo pide el Libro IVA: base e IVA por alícuota, exento, no gravado, internos y percepciones."
      />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link href="/reportes" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          <ArrowLeft size={15} /> Reportes
        </Link>
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          aria-label="Mes"
        />
        <Button size="sm" variant="secondary" onClick={download} disabled={!r}>
          <Download size={15} /> Exportar CSV
        </Button>
      </div>

      <div className="mt-6 space-y-6">
        {q.isLoading ? (
          <SpinnerBlock className="py-16" />
        ) : q.error || !r ? (
          <Callout tone="warning" icon={Lock} title="No disponible">
            {taxErrorMessage(q.error)}
          </Callout>
        ) : (
          <>
            {r.sales_without_breakdown > 0 && (
              <Callout tone="info" title="Ventas sin desglose">
                {r.sales_without_breakdown} ventas del período son anteriores al motor de impuestos y no tienen IVA
                discriminado: no suman en las alícuotas.
              </Callout>
            )}
            <div className="grid gap-3 sm:grid-cols-4">
              <Kpi label="Ventas" value={String(r.sales)} />
              <Kpi label="Neto gravado" value={formatCurrency(r.net_taxed)} />
              <Kpi label="IVA débito fiscal" value={formatCurrency(r.iva_total)} />
              <Kpi label="Percepciones" value={formatCurrency(r.perception_total)} />
            </div>

            <SettingsCard title="Por alícuota" padded>
              <Table
                head={["Alícuota", "Neto", "IVA", "Ventas"]}
                rows={[
                  ...r.by_rate.map((g) => [g.label, formatCurrency(g.base), formatCurrency(g.amount), String(g.sales)]),
                  ["Exento", formatCurrency(r.net_exempt), "", ""],
                  ["No gravado", formatCurrency(r.net_untaxed), "", ""],
                  ["Impuestos internos", "", formatCurrency(r.internal_total), ""],
                ]}
              />
            </SettingsCard>

            {r.perceptions.length > 0 && (
              <SettingsCard title="Percepciones practicadas" padded>
                <Table
                  head={["Régimen", "Base", "Percibido", "Ventas"]}
                  rows={r.perceptions.map((p) => [
                    `${p.tax.toUpperCase()}${p.jurisdiction ? ` · ${jurisdictionName(p.jurisdiction)}` : ""}`,
                    formatCurrency(p.base),
                    formatCurrency(p.amount),
                    String(p.sales),
                  ])}
                />
              </SettingsCard>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              <SettingsCard title="Por comprobante" padded>
                <Table
                  head={["Tipo", "Ventas", "Total"]}
                  rows={r.by_letter.map((l) => [l.letter === "-" ? "Sin tipo" : l.letter, String(l.sales), formatCurrency(l.total)])}
                />
              </SettingsCard>
              <SettingsCard title="Por sucursal" padded>
                <Table
                  head={["Sucursal", "IVA", "Total"]}
                  rows={r.by_store.map((s) => [s.name ?? "Sin sucursal", formatCurrency(s.iva), formatCurrency(s.total)])}
                />
              </SettingsCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin datos en el período.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={cn("pb-2 font-medium", i > 0 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, k) => (
            <tr key={k}>
              {r.map((c, i) => (
                <td key={i} className={cn("py-2", i > 0 && "text-right font-mono tabular-nums")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
