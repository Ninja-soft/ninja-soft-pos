"use client";

import { useState } from "react";
import { startOfDay, subDays } from "date-fns";
import { BarChart3, Download } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";
import { promotionsApi, type PromotionPerfReport } from "@/modules/promotions/api";
import { exportXlsx } from "@/lib/utils/xlsx";
import { formatCurrency } from "@/lib/utils/format";

// F9 · H56 — Reporte de performance de promociones. Para el período elegido,
// muestra cuánto descuento otorgó cada promo, en cuántas ventas se usó y la
// facturación de esas ventas. Read-only; export XLSX. (Las promos de regalo no
// descuentan ni setean promo_id, así que no figuran acá.)
export function PromotionPerfModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: startOfDay(new Date()),
  }));
  const [report, setReport] = useState<PromotionPerfReport | null>(null);
  const [loading, setLoading] = useState(false);

  function rangeIso() {
    const from = startOfDay(range?.from ?? new Date());
    const to = startOfDay(range?.to ?? range?.from ?? new Date());
    to.setDate(to.getDate() + 1); // inclusivo del día "hasta"
    return { fromISO: from.toISOString(), toISO: to.toISOString() };
  }

  async function run() {
    setLoading(true);
    setReport(null);
    try {
      const { fromISO, toISO } = rangeIso();
      setReport(await promotionsApi.performance(fromISO, toISO));
    } catch (e) {
      toast({
        title: "No se pudo cargar el reporte",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function downloadXlsx() {
    if (!report) return;
    try {
      await exportXlsx("rendimiento-promociones", [
        {
          name: "Promociones",
          title: "Rendimiento de promociones",
          columns: [
            { header: "Promoción", key: "promo", type: "text", width: 32 },
            { header: "Ventas", key: "count", type: "number" },
            { header: "Descuento otorgado", key: "discount", type: "money", width: 18 },
            { header: "Facturación", key: "sold", type: "money", width: 16 },
            { header: "% sobre vendido", key: "pct", type: "number" },
          ],
          rows: report.rows.map((r) => ({
            promo: r.promo_name,
            count: r.count,
            discount: r.total_discount,
            sold: r.total_sold,
            pct: r.total_sold > 0 ? Math.round((r.total_discount / r.total_sold) * 1000) / 10 : 0,
          })),
          totals: {
            count: report.count,
            discount: report.total_discount,
            sold: report.total_sold,
          },
        },
      ]);
    } catch (e) {
      toast({
        title: "No se pudo exportar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  const totalPct =
    report && report.total_sold > 0
      ? (report.total_discount / report.total_sold) * 100
      : null;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Rendimiento de promociones"
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Cuánto descuento otorgó cada promoción en el período y en cuántas ventas
          se aplicó. (Las promos de <strong>regalo</strong> no descuentan, así que
          no figuran acá.)
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <Button onClick={run} loading={loading}>
            <BarChart3 size={16} /> Ver
          </Button>
          {report && report.rows.length > 0 && (
            <Button variant="secondary" onClick={downloadXlsx}>
              <Download size={16} /> Exportar XLSX
            </Button>
          )}
        </div>

        {report && (
          <>
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/20 p-4">
              <Metric label="Ventas con promo" value={String(report.count)} />
              <Metric
                label="Descuento total"
                value={formatCurrency(report.total_discount)}
                accent
              />
              <Metric
                label="Sobre lo vendido"
                value={totalPct != null ? `${totalPct.toFixed(1)}%` : "—"}
              />
            </div>

            {report.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No se aplicaron promociones de descuento en el período elegido.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Promoción</th>
                      <th className="px-3 py-2 text-right font-medium">Ventas</th>
                      <th className="px-3 py-2 text-right font-medium">Descuento</th>
                      <th className="px-3 py-2 text-right font-medium">Facturación</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.promo_id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-medium text-foreground">{r.promo_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ninja-flameSoft">
                          {formatCurrency(r.total_discount)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(r.total_sold)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-price text-lg font-bold tabular-nums ${accent ? "text-ninja-flameSoft" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}
