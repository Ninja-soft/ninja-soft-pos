"use client";

import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useZClosures } from "@/modules/cash/hooks";
import type { ZClosure } from "@/modules/cash/api";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { format } from "date-fns";

function fdate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("es-AR");
}

function breakdown(z: ZClosure): [string, number][] {
  const b = (z.payment_breakdown ?? {}) as Record<string, number>;
  return Object.entries(b);
}

export function ZClosuresHistory() {
  const { data: closures, isLoading } = useZClosures();
  const [sel, setSel] = useState<ZClosure | null>(null);

  async function exportZ(z: ZClosure) {
    await exportXlsx(`cierre-z-${z.z_number}`, [
      {
        name: `Z ${z.z_number}`,
        title: `Cierre Z #${z.z_number} · ${fdate(z.closed_at)}`,
        columns: [
          { header: "Concepto", key: "k", width: 24 },
          { header: "Valor", key: "v", width: 20 },
        ],
        rows: [
          { k: "Z número", v: z.z_number },
          { k: "Apertura", v: formatCurrency(z.opening_amount) },
          { k: "Ventas (cantidad)", v: z.sales_count },
          { k: "Ventas (total)", v: formatCurrency(z.sales_total) },
          { k: "Descuentos", v: formatCurrency(z.discounts_total) },
          { k: "Anulaciones (cantidad)", v: z.voids_count },
          { k: "Anulaciones (total)", v: formatCurrency(z.voids_total) },
          { k: "Ingresos de caja", v: formatCurrency(z.cash_in) },
          { k: "Egresos de caja", v: formatCurrency(z.cash_out) },
          { k: "Efectivo esperado", v: formatCurrency(z.expected_amount) },
          { k: "Efectivo contado", v: formatCurrency(z.closing_amount) },
          { k: "Diferencia", v: formatCurrency(z.difference) },
        ],
      },
      {
        name: "Por medio de pago",
        columns: [
          { header: "Medio", key: "m", width: 18 },
          { header: "Monto", key: "a", type: "money" },
        ],
        rows: breakdown(z).map(([k, v]) => ({
          m: METHOD_LABELS[k] ?? k,
          a: v,
        })),
      },
    ]);
  }

  return (
    <section>
      <div className="flex items-center gap-2">
        <h2 className="font-display text-lg font-bold">Cierres Z</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          inmutable
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Historial contable de cada cierre de caja con su consolidado del turno. No
        se puede editar ni borrar.
      </p>

      <Card className="mt-3">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="whitespace-nowrap px-4 py-3">Z</th>
                <th className="whitespace-nowrap px-4 py-3">Cierre</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Ventas</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Total</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Diferencia</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {closures?.map((z) => (
                <tr key={z.id}>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold">
                    #{z.z_number}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {fdate(z.closed_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {z.sales_count}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                    {formatCurrency(z.sales_total)}
                  </td>
                  <td
                    className={
                      "whitespace-nowrap px-4 py-3 text-right " +
                      (z.difference === 0
                        ? "text-muted-foreground"
                        : z.difference > 0
                          ? "text-emerald-400"
                          : "text-red-300")
                    }
                  >
                    {formatCurrency(z.difference)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <button
                      onClick={() => setSel(z)}
                      className="text-ninja-flameSoft hover:underline"
                    >
                      Ver
                    </button>
                  </td>
                </tr>
              ))}
              {!isLoading && (closures?.length ?? 0) === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    Todavía no hay cierres Z. Cuando cierres una caja, el Z aparece acá.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Modal
        open={sel !== null}
        onOpenChange={(o) => !o && setSel(null)}
        title={sel ? `Cierre Z #${sel.z_number}` : "Cierre Z"}
        className="max-w-lg"
      >
        {sel && (
          <div className="space-y-4">
            <div className="ticket-print space-y-1.5 text-sm">
              <Row k="Cierre" v={fdate(sel.closed_at)} />
              <Row k="Apertura del turno" v={fdate(sel.opened_at)} />
              <hr className="border-border" />
              <Row k="Apertura" v={formatCurrency(sel.opening_amount)} />
              <Row k="Ventas" v={`${sel.sales_count} · ${formatCurrency(sel.sales_total)}`} />
              <Row k="Descuentos" v={formatCurrency(sel.discounts_total)} />
              {sel.voids_count > 0 && (
                <Row
                  k="Anulaciones"
                  v={`${sel.voids_count} · ${formatCurrency(sel.voids_total)}`}
                />
              )}
              <Row k="Ingresos de caja" v={formatCurrency(sel.cash_in)} />
              <Row k="Egresos de caja" v={formatCurrency(sel.cash_out)} />
              <hr className="border-border" />
              <Row k="Efectivo esperado" v={formatCurrency(sel.expected_amount)} />
              <Row k="Efectivo contado" v={formatCurrency(sel.closing_amount)} />
              <Row
                k="Diferencia"
                v={formatCurrency(sel.difference)}
                strong
              />

              {breakdown(sel).length > 0 && (
                <>
                  <hr className="border-border" />
                  <div className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Por medio de pago
                  </div>
                  {breakdown(sel).map(([k, v]) => (
                    <Row key={k} k={METHOD_LABELS[k] ?? k} v={formatCurrency(v)} />
                  ))}
                </>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => window.print()}>
                <FileText size={15} /> Imprimir
              </Button>
              <Button variant="secondary" onClick={() => exportZ(sel)}>
                <Download size={15} /> Exportar XLSX
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={strong ? "font-bold text-foreground" : "text-foreground"}>
        {v}
      </span>
    </div>
  );
}
