"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
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

const PROVIDER_LABELS: Record<string, string> = {
  mercadopago: "Mercado Pago",
  mobbex: "Mobbex",
};
const PROVIDER_LOGOS: Record<string, string> = {
  mercadopago: "/img/medios_de_pago/mercado_pago_cube.webp",
  mobbex: "/img/medios_de_pago/Mobbex_cube.webp",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "approved"
      ? "border-emerald-500/40 bg-emerald-500/10 text-success"
      : status === "rejected"
        ? "border-red-400/40 bg-red-400/10 text-danger"
        : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}
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
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-1.5 font-medium text-danger">
            <AlertTriangle size={14} /> {orphans.length} aprobado
            {orphans.length > 1 ? "s" : ""} sin venta • revisar
          </span>
        )}
      </div>

      <div className="mt-3 max-h-[50dvh] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="sticky top-0 bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
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
                  Cargando…
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
                  className={orphan ? "bg-red-400/5" : "transition hover:bg-muted/40"}
                >
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                    {new Date(i.created_at).toLocaleString("es-AR", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      {PROVIDER_LOGOS[i.provider_key] && (
                        <Image
                          src={PROVIDER_LOGOS[i.provider_key]!}
                          alt=""
                          width={18}
                          height={18}
                          className="h-[18px] w-[18px] rounded object-contain"
                        />
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
                      <span className="text-muted-foreground">—</span>
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
