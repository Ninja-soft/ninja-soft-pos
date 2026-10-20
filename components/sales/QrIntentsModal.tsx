"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import {
  DateRangePicker,
  type DateRange,
} from "@/components/ui/DateRangePicker";
import { useQrIntents } from "@/modules/pos/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber, type SaleNumberFormat } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { NoData } from "@/components/ui/NoData";
import { Spinner } from "@/components/ui/Spinner";
import { paymentIcon } from "@/lib/payments/logos";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { posApi } from "@/modules/pos/api";
import { latestRefundByIntent } from "@/lib/payments/ualabis";
import { UalaBisRefundAction } from "@/components/sales/UalaBisRefundAction";

const PROVIDER_LABELS: Record<string, string> = {
  mercadopago: "Mercado Pago",
  mobbex: "Mobbex",
  modo: "MODO",
  pagos360: "Pagos360",
  payway: "Payway",
  mercadopago_point: "Mercado Point",
  nave: "Nave",
  nave_point: "Nave Point",
  fiserv_point: "Clover Point",
  gocuotas: "GO Cuotas",
  directo: "Directo",
  ualabis: "Ualá Bis",
  viumi: "Viumi",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "approved"
      ? "border-transparent bg-emerald-500/10 text-success"
      : status === "rejected"
        ? "border-transparent bg-red-400/10 text-danger"
        : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex rounded-md border px-2.5 py-0.5 text-xs font-semibold ${cls}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function QrIntentsModal({
  open,
  onOpenChange,
  numFmt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  numFmt: SaleNumberFormat | null | undefined;
}) {
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");

  const { data: intents, isLoading } = useQrIntents(
    range?.from ? { from: range.from, to: range.to ?? range.from } : undefined,
    open,
  );

  const filtered = useMemo(
    () =>
      (intents ?? []).filter(
        (i) =>
          (!provider || i.provider_key === provider) &&
          (!status || i.status === status),
      ),
    [intents, provider, status],
  );

  // Ualá Bis (ADR-143): devoluciones de sus cobros aprobados.
  const qc = useQueryClient();
  const ualaIds = useMemo(
    () => filtered.filter((i) => i.provider_key === "ualabis" && i.status === "approved").map((i) => i.id),
    [filtered],
  );
  const { data: ualaRefunds } = useQuery({
    queryKey: ["ualabis-refunds", ualaIds],
    queryFn: () => posApi.listUalaBisRefunds(ualaIds),
    enabled: open && ualaIds.length > 0,
  });
  const refundByIntent = useMemo(() => latestRefundByIntent(ualaRefunds ?? []), [ualaRefunds]);

  const orphans = useMemo(
    () => filtered.filter((i) => i.status === "approved" && i.saleNumber === null),
    [filtered],
  );
  const approvedTotal = useMemo(
    () =>
      filtered
        .filter((i) => i.status === "approved")
        .reduce((a, i) => a + i.amount, 0),
    [filtered],
  );

  async function exportIntents() {
    await exportXlsx("cobros-qr", [
      {
        name: "Cobros QR",
        title: "Conciliación de cobros QR • NinjaPos",
        columns: [
          { header: "Fecha", key: "fecha", width: 22 },
          { header: "Proveedor", key: "proveedor", width: 16 },
          { header: "Monto", key: "monto", type: "money" },
          { header: "Estado", key: "estado", width: 12 },
          { header: "Venta", key: "venta", width: 14 },
          { header: "ID pago proveedor", key: "pago", width: 24 },
          { header: "Intent", key: "intent", width: 38 },
        ],
        rows: filtered.map((i) => ({
          fecha: new Date(i.created_at).toLocaleString("es-AR"),
          proveedor: PROVIDER_LABELS[i.provider_key] ?? i.provider_key,
          monto: i.amount,
          estado: STATUS_LABELS[i.status] ?? i.status,
          venta:
            i.saleNumber !== null
              ? formatSaleNumber(i.saleNumber, numFmt)
              : i.status === "approved"
                ? "SIN VENTA"
                : "",
          pago: i.mp_payment_id ?? "",
          intent: i.id,
        })),
        totals: { monto: approvedTotal },
      },
    ]);
  }

  const selectCls =
    "h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cobros QR"
      description="Intents de Mercado Pago y Mobbex cruzados con sus ventas."
      className="max-w-3xl"
    >
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} className="h-10" />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className={selectCls}
        >
          <option value="">Todos los medios</option>
          <option value="mercadopago">Mercado Pago</option>
          <option value="mobbex">Mobbex</option>
          <option value="ualabis">Ualá Bis</option>
          <option value="viumi">Viumi</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={selectCls}
        >
          <option value="">Todos los estados</option>
          <option value="approved">Aprobados</option>
          <option value="pending">Pendientes</option>
          <option value="rejected">Rechazados</option>
        </select>
        <Button
          variant="secondary"
          className="ml-auto h-10"
          onClick={exportIntents}
          disabled={filtered.length === 0}
        >
          <Download size={15} /> XLSX
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <span className="rounded-lg border border-border bg-muted/40 px-3 py-1.5">
          Aprobado: <strong>{formatCurrency(approvedTotal)}</strong>
        </span>
        {orphans.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-400/10 px-3 py-1.5 font-medium text-danger">
            <AlertTriangle size={14} /> {orphans.length} aprobado
            {orphans.length > 1 ? "s" : ""} sin venta • revisar
          </span>
        )}
      </div>

      <div className="mt-3 max-h-[50dvh] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-sm">
          {/* Cabecera fija opaca: --muted es translúcido en los temas oscuros y
              las filas se veían por debajo al scrollear. */}
          <thead className="sticky top-0 z-10 bg-popover text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr className="bg-muted">
              <th className="px-3 py-2.5">Fecha</th>
              <th className="px-3 py-2.5">Medio</th>
              <th className="px-3 py-2.5 text-right">Monto</th>
              <th className="px-3 py-2.5">Estado</th>
              <th className="px-3 py-2.5">Venta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  <Spinner />
                </td>
              </tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  Sin cobros QR para los filtros elegidos.
                </td>
              </tr>
            )}
            {filtered.map((i) => {
              const orphan = i.status === "approved" && i.saleNumber === null;
              return (
                <tr
                  key={i.id}
                  className={orphan ? "bg-red-400/10" : "transition hover:bg-muted/40"}
                >
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                    {new Date(i.created_at).toLocaleString("es-AR", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      {paymentIcon(i.provider_key) && (
                        <ThemedLogo src={paymentIcon(i.provider_key)!} alt="" className="h-[18px] w-[18px]" />
                      )}
                      {PROVIDER_LABELS[i.provider_key] ?? i.provider_key}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">{formatCurrency(i.amount)}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    {i.saleNumber !== null ? (
                      <span className="font-mono text-xs">
                        {formatSaleNumber(i.saleNumber, numFmt)}
                        {i.saleStatus === "voided" && (
                          <span className="ml-1 text-danger">(anulada)</span>
                        )}
                      </span>
                    ) : i.status === "approved" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-danger">
                        <AlertTriangle size={12} /> Sin venta
                      </span>
                    ) : (
                      <NoData />
                    )}
                    {i.provider_key === "ualabis" && (
                      <div className="mt-1">
                        <UalaBisRefundAction
                          intent={i}
                          refund={refundByIntent.get(i.id)}
                          onRefund={posApi.refundUalaBisIntent}
                          onDone={() => void qc.invalidateQueries({ queryKey: ["ualabis-refunds"] })}
                        />
                      </div>
                    )}
                    {i.provider_key === "viumi" && i.status === "approved" && (i.saleNumber === null || i.saleStatus === "voided") && (
                      // Viumi (ADR-173): la API no tiene devoluciones.
                      <p className="mt-1 text-xs text-muted-foreground">Para devolverlo, usá la app o el panel de Viumi.</p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        &quot;Aprobado sin venta&quot; = el cliente pagó pero la venta no quedó
        registrada en el POS (se cerró el modal antes de confirmar, se cayó la
        conexión, etc.). Cobrá esa operación manualmente o verificala en el
        panel del proveedor con el ID de pago del export.
      </p>
    </Modal>
  );
}
