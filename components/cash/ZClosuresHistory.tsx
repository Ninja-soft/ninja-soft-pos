"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useZClosures } from "@/modules/cash/hooks";
import type { ZClosure } from "@/modules/cash/api";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { format } from "date-fns";
import { useBranchContext } from "@/modules/branches/hooks";
import { Select } from "@/components/ui/Select";
import { showRegisterFilter, zFileName, zSeriesLabel } from "@/lib/cash/zNumbers";
import { parseZItems, zItemsTotals } from "@/lib/cash/zItems";
import { formatQty } from "@/lib/utils/format";

function fdate(s: string | null): string {
  if (!s) return "Sin datos";
  return new Date(s).toLocaleString("es-AR");
}

function breakdown(z: ZClosure): [string, number][] {
  const b = (z.payment_breakdown ?? {}) as Record<string, number>;
  return Object.entries(b);
}

// Ítems vendidos resumidos (F11 · H30b): null en los Z anteriores al resumen.
function itemsOf(z: ZClosure) {
  return parseZItems((z as ZClosure & { items_summary?: unknown }).items_summary);
}

// Cobros de cuenta corriente del turno por medio (Cuenta corriente v2).
function accountCollected(z: ZClosure): [string, number][] {
  const b = (z.account_collected ?? {}) as Record<string, number>;
  return Object.entries(b);
}

export function ZClosuresHistory() {
  const [range, setRange] = useState<DateRange | undefined>();
  // F17 · H90: filtro global de sucursal; con "todas" se ve la columna.
  const branch = useBranchContext();
  const showBranchCol = branch.isMulti && !branch.filterStoreId;
  // F17 · H97: filtro por caja dentro de la sucursal elegida.
  const registers = useMemo(() => branch.all.flatMap((b) => b.registers ?? []), [branch.all]);
  const registerName = (id: string | null | undefined) =>
    id ? (registers.find((r) => r.id === id)?.name ?? null) : null;
  const [registerId, setRegisterId] = useState<string | null>(null);
  useEffect(() => setRegisterId(null), [branch.filterStoreId]);
  const registerFilterOn = showRegisterFilter(branch.filterStoreId, registers);
  const { data: closures, isLoading } = useZClosures(
    range,
    branch.filterStoreId,
    registerFilterOn ? registerId : null,
  );
  const [sel, setSel] = useState<ZClosure | null>(null);
  // Series propias de la sucursal (sólo con varias) y de la caja.
  const seriesOf = (z: ZClosure) =>
    zSeriesLabel(z, {
      branch: branch.isMulti ? branch.branchName(z.store_id) : null,
      register: registerName(z.cash_register_id),
    });

  async function exportZ(z: ZClosure) {
    const names = {
      branch: branch.isMulti ? branch.branchName(z.store_id) : null,
      register: registerName(z.cash_register_id),
    };
    await exportXlsx(zFileName(z, names), [
      {
        name: `Z ${z.z_number}`,
        title: `Cierre Z #${z.z_number} · ${fdate(z.closed_at)}`,
        columns: [
          { header: "Concepto", key: "k", width: 24 },
          { header: "Valor", key: "v", width: 20 },
        ],
        rows: [
          { k: "Z número", v: z.z_number },
          ...(branch.isMulti ? [{ k: "Sucursal", v: branch.branchName(z.store_id) ?? "" }] : []),
          ...(branch.isMulti && z.store_z_number ? [{ k: "Z de la sucursal", v: z.store_z_number }] : []),
          ...(names.register ? [{ k: "Caja", v: names.register }] : []),
          ...(z.register_z_number ? [{ k: "Z de la caja", v: z.register_z_number }] : []),
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
      {
        name: "Cobros cuenta corriente",
        columns: [
          { header: "Medio", key: "m", width: 18 },
          { header: "Monto", key: "a", type: "money" },
        ],
        rows: accountCollected(z).map(([k, v]) => ({
          m: METHOD_LABELS[k] ?? k,
          a: v,
        })),
      },
      {
        name: "Items vendidos",
        columns: [
          { header: "Producto", key: "n", width: 32 },
          { header: "Cantidad", key: "q", type: "number" },
          { header: "Total", key: "t", type: "money" },
        ],
        rows: (itemsOf(z) ?? []).map((l) => ({ n: l.name, q: l.qty, t: l.total })),
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} className="h-10" />
        {registerFilterOn && (
          <Select<string>
            aria-label="Caja"
            className="h-10 w-48"
            value={registerId ?? "all"}
            onChange={(v) => setRegisterId(v === "all" ? null : v)}
            options={[
              { value: "all", label: "Todas las cajas" },
              ...registers
                .filter((r) => r.store_id === branch.filterStoreId)
                .map((r) => ({ value: r.id, label: r.deleted_at ? `${r.name} (archivada)` : r.name })),
            ]}
          />
        )}
        {range?.from && (
          <button
            onClick={() => setRange(undefined)}
            className="h-10 rounded-lg border border-border px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            Limpiar
          </button>
        )}
      </div>

      <Card className="mt-3">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="whitespace-nowrap px-4 py-3">Z</th>
                <th className="whitespace-nowrap px-4 py-3">Cierre</th>
                {showBranchCol && <th className="whitespace-nowrap px-4 py-3">Sucursal</th>}
                <th className="whitespace-nowrap px-4 py-3 text-right">Ventas</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Total</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Diferencia</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {closures?.map((z) => (
                <tr key={z.id}>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="font-semibold">#{z.z_number}</div>
                    {seriesOf(z) && (
                      <div className="text-xs text-muted-foreground">{seriesOf(z)}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {fdate(z.closed_at)}
                  </td>
                  {showBranchCol && (
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {branch.branchName(z.store_id) ?? "-"}
                    </td>
                  )}
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
                          ? "text-success"
                          : "text-danger")
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
                    colSpan={showBranchCol ? 7 : 6}
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
              {seriesOf(sel) && <Row k="Serie" v={seriesOf(sel)!} />}
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

              {accountCollected(sel).length > 0 && (
                <>
                  <hr className="border-border" />
                  <div className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Cobros de cuenta corriente
                  </div>
                  {accountCollected(sel).map(([k, v]) => (
                    <Row key={`cc-${k}`} k={METHOD_LABELS[k] ?? k} v={formatCurrency(v)} />
                  ))}
                </>
              )}
              <ZItemsBlock z={sel} />
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

function ZItemsBlock({ z }: { z: ZClosure }) {
  const items = itemsOf(z);
  if (items === null) {
    return (
      <>
        <hr className="border-border" />
        <p className="text-xs text-muted-foreground">Este Z es anterior al detalle de ítems vendidos.</p>
      </>
    );
  }
  if (items.length === 0) return null;
  const totals = zItemsTotals(items);
  return (
    <>
      <hr className="border-border" />
      <div className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Ítems vendidos ({formatQty(totals.units)} u.)
      </div>
      {items.map((l, i) => (
        <Row key={`it-${i}`} k={`${formatQty(l.qty)} x ${l.name}`} v={formatCurrency(l.total)} />
      ))}
    </>
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
