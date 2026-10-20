"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useConfirmZ, useReviewZ, useZClosures } from "@/modules/cash/hooks";
import { countDetailBills, countDetailRows } from "@/lib/cash/arqueo";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { useMyTenant } from "@/modules/tenants/hooks";
import { MIN_REASON, Z_REVIEW_KINDS, validReason, zNeedsReview, zReviewLabel, type ZReviewKind } from "@/lib/cash/closeControls";
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

// Conciliación del Z (H156, ADR-158): columnas nuevas, ausentes sin la migración.
type ZReviewCols = { review_kind?: string | null; review_reason?: string | null; reviewed_at?: string | null };
function reviewOf(z: ZClosure): ZReviewCols {
  return z as ZClosure & ZReviewCols;
}

// Arqueo detallado y confirmación (H159, ADR-172): columnas nuevas.
type ZCountCols = { count_detail?: unknown; confirmed_at?: string | null; confirmed_by?: string | null };
function countOf(z: ZClosure): ZCountCols {
  return z as ZClosure & ZCountCols;
}

function confirmErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? "");
  if (m.includes("z_self_confirm")) return "Otra persona tiene que confirmar tu cierre (el encargado o el dueño).";
  if (m.includes("z_already_confirmed")) return "Ese cierre ya estaba confirmado.";
  if (m.includes("forbidden")) return "Sólo el dueño o un encargado confirman cierres.";
  return "No se pudo confirmar el cierre.";
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
  const [reviewing, setReviewing] = useState<ZClosure | null>(null);
  const { data: me } = useMyTenant();
  const canReview = Boolean(me?.canManage);
  const confirmZ = useConfirmZ();
  const { toast } = useToast();
  async function confirm(z: ZClosure) {
    try {
      await confirmZ.mutateAsync(z.id);
      toast({ title: `Cierre Z #${z.z_number} confirmado`, variant: "success" });
    } catch (e) {
      toast({ title: confirmErrorText(e), variant: "error" });
    }
  }
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
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
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
                    <div>{formatCurrency(z.difference)}</div>
                    {zNeedsReview({ difference: z.difference, reviewed_at: reviewOf(z).reviewed_at }) ? (
                      <Badge tone="warning" className="mt-1">Diferencia sin revisar</Badge>
                    ) : reviewOf(z).reviewed_at ? (
                      <Badge tone="neutral" className="mt-1">{zReviewLabel(reviewOf(z).review_kind)}</Badge>
                    ) : null}
                    {"confirmed_at" in z && !countOf(z).confirmed_at && (
                      <Badge tone="neutral" className="mt-1">Sin confirmar</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="flex justify-end gap-3">
                      {canReview && zNeedsReview({ difference: z.difference, reviewed_at: reviewOf(z).reviewed_at }) && (
                        <button onClick={() => setReviewing(z)} className="text-warning hover:underline">
                          Revisar
                        </button>
                      )}
                      {canReview && "confirmed_at" in z && !countOf(z).confirmed_at && (
                        <button
                          onClick={() => void confirm(z)}
                          disabled={confirmZ.isPending}
                          className="text-success hover:underline disabled:opacity-50"
                        >
                          Confirmar
                        </button>
                      )}
                      <button
                        onClick={() => setSel(z)}
                        className="text-ninja-flameSoft hover:underline"
                      >
                        Ver
                      </button>
                    </div>
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
              {reviewOf(sel).reviewed_at && (
                <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{zReviewLabel(reviewOf(sel).review_kind)}:</span>{" "}
                  {reviewOf(sel).review_reason}
                </p>
              )}

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
              <ZCountBlock z={sel} />
              {countOf(sel).confirmed_at && (
                <p className="pt-1 text-xs text-muted-foreground">Confirmado el {fdate(countOf(sel).confirmed_at ?? null)}.</p>
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
      <ZReviewModal z={reviewing} onClose={() => setReviewing(null)} />
    </section>
  );
}

// Conciliación del Z (H156): el encargado deja por qué hubo diferencia.
function ZReviewModal({ z, onClose }: { z: ZClosure | null; onClose: () => void }) {
  const { toast } = useToast();
  const review = useReviewZ();
  const [kind, setKind] = useState<ZReviewKind>("conteo");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (z) {
      setKind(z.difference < 0 ? "faltante_real" : "sobrante_real");
      setReason("");
    }
  }, [z]);

  async function save() {
    if (!z || !validReason(reason)) return;
    try {
      await review.mutateAsync({ id: z.id, kind, reason: reason.trim() });
      toast({ title: "Diferencia revisada", variant: "success" });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? "");
      toast({
        title: "No se pudo guardar la revisión",
        description: /forbidden/.test(msg)
          ? "Sólo el dueño o un encargado revisan los cierres."
          : /Could not find the function|PGRST202/.test(msg)
            ? "Falta actualizar la base para usar esta función."
            : msg || undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={z !== null}
      onOpenChange={(o) => !o && onClose()}
      title={z ? `Revisar la diferencia del Z #${z.z_number}` : "Revisar diferencia"}
      description={z ? `Diferencia de ${formatCurrency(z.difference)}. Queda registrado quién lo revisó y por qué.` : undefined}
      className="max-w-md"
    >
      <div className="space-y-3">
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-medium">¿Qué pasó?</legend>
          {Z_REVIEW_KINDS.map((k) => (
            <label key={k.value} className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-muted">
              <input
                type="radio"
                name="z-review-kind"
                className="mt-1"
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
              />
              <span className="text-sm">
                <span className="font-medium">{k.label}</span>
                <span className="block text-xs text-muted-foreground">{k.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Motivo</span>
          <textarea
            className="min-h-[72px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Mínimo ${MIN_REASON} letras`}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={review.isPending} disabled={!validReason(reason)} onClick={() => void save()}>
            Guardar revisión
          </Button>
        </div>
      </div>
    </Modal>
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

// Arqueo por medio y por billete (H159): esperado, contado y diferencia.
function ZCountBlock({ z }: { z: ZClosure }) {
  const detail = countOf(z).count_detail;
  const rows = countDetailRows(detail);
  const bills = countDetailBills(detail);
  const coins = Number((detail as { coins?: number } | null)?.coins ?? 0);
  if (rows.length <= 1 && bills.length === 0) return null;
  return (
    <>
      <hr className="border-border" />
      <div className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Arqueo por medio</div>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">Medio</span>
        <span className="text-right text-muted-foreground">Esperado</span>
        <span className="text-right text-muted-foreground">Contado</span>
        <span className="text-right text-muted-foreground">Dif.</span>
        {rows.map((r) => (
          <div key={r.method} className="contents">
            <span>{r.label}</span>
            <span className="text-right tabular-nums">{formatCurrency(r.expected)}</span>
            <span className="text-right tabular-nums">{r.counted === null ? "Sin contar" : formatCurrency(r.counted)}</span>
            <span className={`text-right tabular-nums ${r.diff ? (r.diff < 0 ? "text-danger" : "text-warning") : ""}`}>
              {r.diff === null ? "" : formatCurrency(r.diff)}
            </span>
          </div>
        ))}
      </div>
      {bills.length > 0 && (
        <>
          <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billetes contados</div>
          {bills.map((b) => (
            <Row key={b.denom} k={`${b.qty} × ${formatCurrency(b.denom)}`} v={formatCurrency(b.subtotal)} />
          ))}
          {coins > 0 && <Row k="Monedas" v={formatCurrency(coins)} />}
        </>
      )}
    </>
  );
}
