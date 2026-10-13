"use client";

import { useState } from "react";
import { CircleAlert, Printer, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { shippingErrorMessage, type QuoteChoice } from "@/lib/shipping/form";
import { enqueueZplLabel, openPdfForPrint } from "@/lib/shipping/print";
import { canCancel, isFinal, needsLocalCancel, statusLabel, statusTone, type ShipmentStatus } from "@/lib/shipping/status";
import { shippingApi, type ShippingProvider } from "@/modules/shipping/api";
import { useShipment, useShipmentEvents, useShippingMutations } from "@/modules/shipping/hooks";

// Detalle de un envío (ADR-103): datos, etiqueta (PDF por el navegador o ZPL a
// la cola de impresión del equipo), línea de tiempo del seguimiento, pedir un
// seguimiento ya, reintentar y cancelar. Para un borrador: cotizar y crear.

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

export function ShipmentDetailModal({
  id,
  onClose,
  providers,
  canManage,
  canOperate,
}: {
  id: string | null;
  onClose: () => void;
  providers: ShippingProvider[];
  canManage: boolean;
  canOperate: boolean;
}) {
  const { toast } = useToast();
  const { data: s } = useShipment(id);
  const { data: events = [] } = useShipmentEvents(id);
  const m = useShippingMutations();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [quotes, setQuotes] = useState<QuoteChoice[] | null>(null);
  const [printing, setPrinting] = useState<"pdf" | "zpl" | null>(null);

  const provider = providers.find((p) => p.key === s?.provider_key) ?? null;
  const formats = provider?.label_formats ?? [];

  async function print(format: "pdf" | "zpl") {
    if (!s) return;
    setPrinting(format);
    try {
      const r = await shippingApi.label(s.id, format);
      if (r.format === "zpl" && r.zpl) {
        enqueueZplLabel(r.zpl, `Envío ${r.tracking_number ?? s.id.slice(0, 8)}`);
        toast({ title: "Etiqueta enviada a la cola de impresión de este equipo", variant: "success" });
      } else if (r.url) {
        if (!openPdfForPrint(r.url)) toast({ title: "El navegador bloqueó la pestaña de la etiqueta", variant: "error" });
      }
    } catch (e) {
      toast({ title: shippingErrorMessage(e), variant: "error" });
    } finally {
      setPrinting(null);
    }
  }

  async function quoteDraft() {
    if (!s) return;
    try {
      const r = await shippingApi.quote({
        store_id: s.store_id,
        destination: s.destination,
        packages: s.packages,
        declared_value: Number(s.declared_value) || 0,
        service_type: s.service_type,
      });
      setQuotes(r.quotes);
      if (r.quotes.length === 0) toast({ title: "Ninguna logística conectada pudo cotizar", variant: "error" });
    } catch (e) {
      toast({ title: shippingErrorMessage(e), variant: "error" });
    }
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ title: ok, variant: "success" });
    } catch (e) {
      toast({ title: shippingErrorMessage(e), variant: "error" });
    }
  };

  const dest = s?.destination;
  const status = (s?.status ?? "draft") as ShipmentStatus;

  return (
    <Modal
      open={id !== null}
      onOpenChange={(o) => !o && onClose()}
      title={s ? `Envío a ${s.recipient?.name ?? ""}` : "Envío"}
      description={s ? `${provider?.name ?? "Sin logística"}${s.tracking_number ? ` · Seguimiento ${s.tracking_number}` : ""}` : undefined}
      className="sm:max-w-2xl"
    >
      {!s ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
            {s.carrier_status && <span className="text-xs text-muted-foreground">{s.carrier_status}</span>}
            {s.cancel_requested_at && s.status !== "cancelled" && <Badge tone="warning">Cancelación pedida</Badge>}
          </div>
          {s.status_detail && (
            <Callout tone={s.status === "error" ? "danger" : "neutral"} icon={CircleAlert}>
              {s.status_detail}
            </Callout>
          )}

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Destino</dt>
              <dd>
                {s.service_type === "branch"
                  ? `Retira en ${s.pickup_point?.name ?? s.pickup_point?.id ?? "sucursal"}`
                  : [dest?.street, dest?.number, dest?.floor && `piso ${dest.floor}`, dest?.apartment && `dto. ${dest.apartment}`]
                      .filter(Boolean)
                      .join(" ")}
                <br />
                {[dest?.postal_code, dest?.city, dest?.province].filter(Boolean).join(", ")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Contacto</dt>
              <dd>{[s.recipient?.phone, s.recipient?.email].filter(Boolean).join(" · ") || "Sin datos"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Bultos</dt>
              <dd>
                {s.package_count} · {Number(s.total_weight_kg).toLocaleString("es-AR")} kg · declarado {formatCurrency(s.declared_value)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Costo cotizado</dt>
              <dd>{s.quoted_cost != null ? formatCurrency(s.quoted_cost) : "Sin cotizar"}</dd>
            </div>
            {(s.sale_id || s.order_ref) && (
              <div>
                <dt className="text-xs text-muted-foreground">Origen</dt>
                <dd>{s.order_ref ? `Pedido ${s.order_ref}` : "Venta del POS"}</dd>
              </div>
            )}
          </dl>

          <div className="flex flex-wrap gap-2">
            {s.label_path || (s.external_id && formats.length > 0) ? (
              <>
                {formats.includes("pdf") && (
                  <Button size="sm" onClick={() => print("pdf")} loading={printing === "pdf"} disabled={!s.label_path && !s.external_id}>
                    <Printer size={15} /> Imprimir etiqueta (PDF)
                  </Button>
                )}
                {formats.includes("zpl") && (
                  <Button size="sm" variant="secondary" onClick={() => print("zpl")} loading={printing === "zpl"}>
                    <Printer size={15} /> Mandar a térmica (ZPL)
                  </Button>
                )}
              </>
            ) : null}
            {s.external_id && !isFinal(status) && (
              <Button size="sm" variant="secondary" loading={m.track.isPending} onClick={() => run(() => m.track.mutateAsync(s.id), "Seguimiento actualizado")}>
                <RefreshCw size={15} /> Actualizar seguimiento
              </Button>
            )}
            {s.status === "pending" && canOperate && (
              <Button size="sm" variant="secondary" loading={m.process.isPending} onClick={() => run(() => m.process.mutateAsync(s.id), "Procesado")}>
                <RefreshCw size={15} /> Procesar ahora
              </Button>
            )}
            {(s.status === "error" || (s.external_id && !s.label_path && !isFinal(status))) && canManage && (
              <Button
                size="sm"
                variant="secondary"
                loading={m.retry.isPending}
                onClick={() =>
                  s.create_uncertain
                    ? setForceOpen(true)
                    : run(async () => {
                        await m.retry.mutateAsync({ id: s.id, force: false });
                        await m.process.mutateAsync(s.id);
                      }, "Reintento en marcha")
                }
              >
                <RotateCcw size={15} /> Reintentar
              </Button>
            )}
            {(s.status === "draft" || s.status === "quoted") && canOperate && (
              <Button size="sm" onClick={quoteDraft}>
                Cotizar y crear
              </Button>
            )}
            {canCancel(s) && canOperate && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelOpen(true)}>
                <XCircle size={15} /> Cancelar envío
              </Button>
            )}
          </div>

          {quotes && quotes.length > 0 && (
            <ul className="space-y-2">
              {quotes.map((q) => (
                <li key={`${q.provider_key}-${q.service_code}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-lg bg-muted/50 px-4 py-3 text-left hover:bg-muted"
                    onClick={() =>
                      run(async () => {
                        await m.submit.mutateAsync([s.id, q.provider_key, q]);
                        await m.process.mutateAsync(s.id);
                        setQuotes(null);
                      }, "Envío creado")
                    }
                  >
                    <span>
                      {providers.find((p) => p.key === q.provider_key)?.name ?? q.provider_key} · {q.service_name}
                    </span>
                    <span className="font-semibold tabular-nums">{formatCurrency(q.cost)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold">Seguimiento</h3>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no hay movimientos.</p>
            ) : (
              <ol className="relative space-y-3 pl-5">
                <span aria-hidden className="absolute bottom-1 left-[5px] top-1 w-px bg-border" />
                {[...events].reverse().map((e, i) => (
                  <li key={e.id} className="relative">
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -left-5 top-1.5 h-2.5 w-2.5 rounded-full",
                        i === 0 ? "bg-ninja-flameSoft" : "bg-muted-foreground/40",
                      )}
                    />
                    <p className="text-sm">
                      {e.status ? <span className="font-medium">{statusLabel(e.status)}</span> : null}
                      {e.status && e.description ? " · " : ""}
                      {e.description}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {when(e.occurred_at)}
                      {e.location ? ` · ${e.location}` : ""}
                      {e.source === "manual" ? " · registrado a mano" : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {s.last_tracked_at && <p className="mt-2 text-xs text-muted-foreground">Última consulta a la logística: {when(s.last_tracked_at)}</p>}
          </section>
        </div>
      )}

      {s && (
        <ConfirmDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title="Cancelar el envío"
          description={
            !s.external_id
              ? "Todavía no se creó en la logística: se cancela acá y no se cobra."
              : needsLocalCancel(s, provider?.capabilities)
                ? "Esta logística no cancela por API. Se marca cancelado en NinjaSoft y tenés que avisarle al carrier para que no lo retire ni lo cobre."
                : "Se le pide la cancelación a la logística."
          }
          confirmLabel="Cancelar envío"
          danger
          withReason
          reasonLabel="Motivo"
          reasonPlaceholder="El cliente se arrepintió, dirección mal cargada"
          loading={m.cancel.isPending}
          onConfirm={(reason) =>
            m.cancel.mutate(
              { id: s.id, reason, local: needsLocalCancel(s, provider?.capabilities) },
              {
                onSuccess: async (r) => {
                  setCancelOpen(false);
                  if (r.cancel_mode === "carrier") await m.process.mutateAsync(s.id).catch(() => undefined);
                  toast({ title: r.cancel_mode === "carrier" ? "Cancelación pedida" : "Envío cancelado", variant: "success" });
                },
                onError: (e) => toast({ title: shippingErrorMessage(e), variant: "error" }),
              },
            )
          }
        />
      )}
      {s && (
        <ConfirmDialog
          open={forceOpen}
          onOpenChange={setForceOpen}
          title="¿Revisaste el panel de la logística?"
          description="El alta anterior quedó sin respuesta. Si la logística lo creó igual y reintentás, vas a tener dos envíos y te los cobran. Reintentá sólo si confirmaste que no existe."
          confirmLabel="No existe, reintentar"
          danger
          loading={m.retry.isPending}
          onConfirm={() =>
            run(async () => {
              await m.retry.mutateAsync({ id: s.id, force: true });
              setForceOpen(false);
              await m.process.mutateAsync(s.id);
            }, "Reintento en marcha")
          }
        />
      )}
    </Modal>
  );
}
ShipmentDetailModal.displayName = "ShipmentDetailModal";

