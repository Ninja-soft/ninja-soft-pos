"use client";

import { useMemo, useState } from "react";
import { Printer, Truck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { enqueueOnDevice } from "@/lib/print/deviceQueue";
import { toBase64 } from "@/lib/print/queue";
import { formatCurrency } from "@/lib/utils/format";
import { LABEL_BLOCKER_LABELS, logisticLabel, mlErrorMessage, shipmentStatusLabel } from "@/lib/mercadolibre/labels";
import { useMlMutations, useMlShipments, type MlAccount, type MlShipment } from "@/modules/mercadolibre/hooks";

export const MAX_LABELS = 50;

/** Etiqueta ME2 imprimible (doc de ML): me2, listo para despachar, etiqueta lista o impresa, nunca Full. */
export function canPrintLabel(s: Pick<MlShipment, "mode" | "logistic_type" | "status" | "substatus">): boolean {
  return (
    s.mode === "me2" &&
    s.logistic_type !== "fulfillment" &&
    s.status === "ready_to_ship" &&
    (s.substatus === "ready_to_print" || s.substatus === "printed")
  );
}

function openPdf(base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const w = window.open(url, "_blank");
  if (!w) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "etiquetas-mercadolibre.pdf";
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function MlShipmentsTab({ account }: { account: MlAccount }) {
  const { toast } = useToast();
  const { data: shipments = [], isLoading } = useMlShipments(account.id);
  const { labels } = useMlMutations();
  const [filter, setFilter] = useState("to_print");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"pdf" | "zpl2">(account.label_format);

  const list = useMemo(() => {
    const base =
      filter === "to_print"
        ? shipments.filter(canPrintLabel)
        : filter
          ? shipments.filter((s) => s.status === filter)
          : shipments;
    return [...base].sort((a, b) => Number(canPrintLabel(b)) - Number(canPrintLabel(a)));
  }, [shipments, filter]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX_LABELS) n.add(id);
      return n;
    });

  const print = () => {
    const ids = shipments.filter((s) => selected.has(s.id)).map((s) => String(s.shipment_id));
    if (ids.length === 0) return;
    labels.mutate(
      { accountId: account.id, shipmentIds: ids, format },
      {
        onSuccess: (r) => {
          if (r.pdf_base64) openPdf(r.pdf_base64);
          if (r.zpl) {
            const ok = enqueueOnDevice({
              doc: "label",
              label: `Etiquetas ML (${ids.length})`,
              printerId: "label",
              payload: toBase64(new TextEncoder().encode(r.zpl)),
            });
            if (ok) toast({ title: "Etiquetas en la cola de impresión del equipo", description: "Las ves en Diagnóstico de hardware.", variant: "success" });
            downloadText(r.zpl, "etiquetas-mercadolibre.zpl");
          }
          for (const b of r.blocked ?? []) {
            toast({ title: `Envío ${b.shipment_id} sin etiqueta`, description: LABEL_BLOCKER_LABELS[b.reason] ?? b.reason, variant: "error" });
          }
          setSelected(new Set());
        },
        onError: (e) => toast({ title: "No se pudieron traer las etiquetas", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  if (isLoading) return <SpinnerBlock className="py-16" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${selectCls} sm:w-64`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar envíos">
          <option value="to_print">Para imprimir etiqueta</option>
          <option value="ready_to_ship">Listos para despachar</option>
          <option value="shipped">En camino</option>
          <option value="delivered">Entregados</option>
          <option value="">Todos</option>
        </select>
        <select className={`${selectCls} sm:w-48`} value={format} onChange={(e) => setFormat(e.target.value as "pdf" | "zpl2")} aria-label="Formato">
          <option value="pdf">PDF</option>
          <option value="zpl2">ZPL (Zebra)</option>
        </select>
        <Button onClick={print} disabled={selected.size === 0} loading={labels.isPending}>
          <Printer size={15} /> Imprimir etiquetas{selected.size > 0 ? ` (${selected.size})` : ""}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Hasta {MAX_LABELS} etiquetas por vez. La etiqueta de Mercado Libre no se modifica.</p>

      {list.length === 0 ? (
        <EmptyState icon={Truck} title="No hay envíos para mostrar" />
      ) : (
        <div className="divide-y divide-border rounded-xl bg-card">
          {list.map((s) => {
            const printable = canPrintLabel(s);
            return (
              <div key={s.id} className="flex gap-3 px-4 py-3">
                <Checkbox
                  checked={selected.has(s.id)}
                  disabled={!printable}
                  onCheckedChange={() => toggle(s.id)}
                  aria-label={`Elegir envío ${s.shipment_id}`}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">Envío {s.shipment_id}</span>
                    <Badge tone={printable ? "warning" : s.status === "delivered" ? "success" : "neutral"}>
                      {shipmentStatusLabel(s.status, s.substatus)}
                    </Badge>
                    <Badge tone="neutral">{logisticLabel(s.logistic_type, s.mode)}</Badge>
                    {s.label_print_count > 0 && <Badge tone="info">Impresa {s.label_print_count}x</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[s.city, s.state].filter(Boolean).join(", ")}
                    {s.pack_key ? ` · venta ${s.pack_key}` : ""}
                    {s.cost != null ? ` · costo ${formatCurrency(s.cost)}` : ""}
                  </p>
                  {s.tracking_number && <p className="font-mono text-xs">Seguimiento {s.tracking_number}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
