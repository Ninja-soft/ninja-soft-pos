"use client";

import { Download } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useAccountsReceivable } from "@/modules/customers/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";

// Cuentas por cobrar (H31): deuda global por cliente con buckets de antigüedad.
export function AccountsReceivableModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data, isLoading } = useAccountsReceivable(open);

  async function exportAr() {
    if (!data) return;
    await exportXlsx("cuentas-por-cobrar", [
      {
        name: "Cuentas por cobrar",
        title: "Cuentas por cobrar — NinjaPos",
        columns: [
          { header: "Cliente", key: "name" },
          { header: "Vencido", key: "overdue" },
          { header: "0-30 días", key: "b0_30" },
          { header: "31-60 días", key: "b31_60" },
          { header: "61-90 días", key: "b61_90" },
          { header: "+90 días", key: "b90plus" },
          { header: "Total", key: "total" },
        ],
        rows: data.rows.map((r) => ({
          name: r.name,
          overdue: r.overdue,
          b0_30: r.b0_30,
          b31_60: r.b31_60,
          b61_90: r.b61_90,
          b90plus: r.b90plus,
          total: r.total,
        })),
      },
    ]);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cuentas por cobrar"
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-md text-sm text-muted-foreground">
            Deuda de cuenta corriente por cliente. Los pagos cancelan primero los
            cargos más viejos (FIFO); cada tramo muestra la antigüedad de lo que
            sigue impago.
          </p>
          <Button
            variant="secondary"
            onClick={exportAr}
            disabled={!data || data.rows.length === 0}
          >
            <Download size={15} /> Exportar XLSX
          </Button>
        </div>

        {!isLoading && data && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { k: "b0_30", label: "0-30 días" },
              { k: "b31_60", label: "31-60 días" },
              { k: "b61_90", label: "61-90 días" },
              { k: "b90plus", label: "+90 días" },
            ].map((b) => (
              <div
                key={b.k}
                className="rounded-lg border border-border bg-muted/30 px-3 py-2"
              >
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {b.label}
                </div>
                <div
                  className={
                    b.k === "b90plus" && data.totals.b90plus > 0
                      ? "font-price text-base font-black tabular-nums text-red-400"
                      : "font-price text-base font-black tabular-nums text-foreground"
                  }
                >
                  {formatCurrency(data.totals[b.k as keyof typeof data.totals])}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Cliente</th>
                <th className="px-3 py-2 text-right font-medium">Vencido</th>
                <th className="px-3 py-2 text-right font-medium">0-30</th>
                <th className="px-3 py-2 text-right font-medium">31-60</th>
                <th className="px-3 py-2 text-right font-medium">61-90</th>
                <th className="px-3 py-2 text-right font-medium">+90</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Cargando…
                  </td>
                </tr>
              )}
              {!isLoading && data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Nadie debe. Cuentas al día.
                  </td>
                </tr>
              )}
              {data?.rows.map((r) => (
                <tr key={r.customer_id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{r.name}</td>
                  <td
                    className={
                      r.overdue > 0
                        ? "px-3 py-2 text-right font-semibold tabular-nums text-red-400"
                        : "px-3 py-2 text-right tabular-nums text-muted-foreground"
                    }
                  >
                    {r.overdue > 0 ? formatCurrency(r.overdue) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.b0_30 ? formatCurrency(r.b0_30) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.b31_60 ? formatCurrency(r.b31_60) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.b61_90 ? formatCurrency(r.b61_90) : "—"}
                  </td>
                  <td
                    className={
                      r.b90plus
                        ? "px-3 py-2 text-right tabular-nums text-red-400"
                        : "px-3 py-2 text-right tabular-nums text-muted-foreground"
                    }
                  >
                    {r.b90plus ? formatCurrency(r.b90plus) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatCurrency(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            {data && data.rows.length > 0 && (
              <tfoot className="border-t-2 border-border bg-muted/40">
                <tr>
                  <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Total
                  </td>
                  <td
                    className={
                      data.totals.overdue > 0
                        ? "px-3 py-2 text-right font-semibold tabular-nums text-red-400"
                        : "px-3 py-2 text-right tabular-nums"
                    }
                  >
                    {formatCurrency(data.totals.overdue)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.b0_30)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.b31_60)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.b61_90)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.b90plus)}</td>
                  <td className="px-3 py-2 text-right font-black tabular-nums">{formatCurrency(data.totals.total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </Modal>
  );
}
