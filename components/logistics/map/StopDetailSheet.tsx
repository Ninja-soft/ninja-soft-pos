"use client";

// Detalle de una entrega tocada en el mapa (ADR-164, R13): qué se llevó y su
// remito, lo que pasó en la calle (quién recibió, DNI, firma, fotos, foto del
// remito firmado, dónde se marcó y a qué distancia de la dirección), y el
// camión y el repartidor. Los datos vienen de route_detail (la misma RPC que
// usa la hoja) y del mapa en vivo.

import { useState } from "react";
import { CheckCircle2, Clock, FileText, MapPin, Phone, Truck, UserRound, XCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { SignedImage } from "@/components/logistics/SignedImage";
import { RemitoDetailModal } from "@/components/remitos/RemitoDetailModal";
import { remitoNumberLabel } from "@/lib/remitos/logic";
import { STOP_STATUS_LABEL, STOP_STATUS_TONE, VEHICLE_KIND_LABEL, formatDistance, phoneLinks } from "@/lib/logistics/logic";
import { clock } from "@/lib/logistics/tracking";
import { useRouteDetail, type RouteStop } from "@/modules/logistics/api";
import type { LiveRoute } from "@/modules/logistics/map";
import { useMyTenant } from "@/modules/tenants/hooks";

function Evidence({ stop, maxDistance }: { stop: RouteStop; maxDistance: number }) {
  const e = stop.last_event;
  if (!e) {
    return <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">Todavía no se marcó nada en esta parada.</p>;
  }
  const ok = e.type === "entregado";
  return (
    <section aria-label="Lo que pasó en la entrega" className={ok ? "space-y-3 rounded-lg bg-success/10 p-3" : "space-y-3 rounded-lg bg-danger/10 p-3"}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
        {ok ? <CheckCircle2 size={16} className="text-success" aria-hidden /> : <XCircle size={16} className="text-danger" aria-hidden />}
        {ok ? `Entregado a ${e.received_by_name ?? "quien recibió"}` : `No se entregó: ${e.reason_label ?? "sin motivo"}`}
        <span className="font-normal text-muted-foreground">{clock(e.occurred_at)}</span>
      </p>
      {(e.received_by_doc || e.note) && (
        <p className="text-sm text-muted-foreground">
          {e.received_by_doc ? `DNI ${e.received_by_doc}` : ""}
          {e.received_by_doc && e.note ? " · " : ""}
          {e.note ?? ""}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {e.signature_path && (
          <figure className="space-y-1">
            <SignedImage path={e.signature_path} alt="Firma de quien recibió" contain className="h-20 w-36 rounded-md bg-white" />
            <figcaption className="text-xs text-muted-foreground">Firma</figcaption>
          </figure>
        )}
        {e.photo_paths.map((p, i) => (
          <figure key={p} className="space-y-1">
            <SignedImage path={p} alt={`Foto ${i + 1} de la entrega`} className="h-20 w-20 rounded-md" />
            <figcaption className="text-xs text-muted-foreground">Foto {i + 1}</figcaption>
          </figure>
        ))}
        {e.remito_photo_path && (
          <figure className="space-y-1">
            <SignedImage path={e.remito_photo_path} alt="Remito firmado" className="h-20 w-20 rounded-md" />
            <figcaption className="text-xs text-muted-foreground">Remito firmado</figcaption>
          </figure>
        )}
      </div>
      {e.lat != null && e.lng != null && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <MapPin size={15} className="text-muted-foreground" aria-hidden />
          <a href={`https://www.google.com/maps?q=${e.lat},${e.lng}`} target="_blank" rel="noreferrer" className="font-medium text-ninja-flameSoft hover:underline">
            Dónde se marcó
          </a>
          {e.distance_to_stop_m != null && (
            <Badge tone={e.distance_to_stop_m > maxDistance ? "warning" : "neutral"}>a {formatDistance(e.distance_to_stop_m)} de la dirección</Badge>
          )}
        </p>
      )}
    </section>
  );
}

export function StopDetailSheet({
  route,
  stopId,
  eta,
  onClose,
}: {
  route: LiveRoute | null;
  stopId: string | null;
  /** Hora estimada de llegada (ms) si todavía falta. */
  eta?: number | null;
  onClose: () => void;
}) {
  const open = Boolean(route && stopId);
  const { data: detail, isLoading } = useRouteDetail(open ? route!.id : null);
  const { data: me } = useMyTenant();
  const [remitoId, setRemitoId] = useState<string | null>(null);
  const stop = detail?.stops.find((s) => s.id === stopId) ?? null;
  const phone = phoneLinks(route?.driver?.phone ?? null);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(v) => !v && onClose()}
        title={stop ? `${stop.seq}. ${stop.contact_name ?? "Parada"}` : "Parada"}
        description={stop?.address_text ?? undefined}
      >
        {isLoading || !stop || !route ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STOP_STATUS_TONE[stop.status]}>{STOP_STATUS_LABEL[stop.status]}</Badge>
              {eta ? (
                <Badge tone="info">
                  <Clock size={12} aria-hidden /> Llega a las {clock(eta)} aprox.
                </Badge>
              ) : null}
              {stop.lat == null && <Badge tone="warning">Sin ubicación</Badge>}
              {stop.contact_phone && <span className="text-sm text-muted-foreground">{stop.contact_phone}</span>}
            </div>

            <Evidence stop={stop} maxDistance={detail?.settings.max_distance_m ?? 300} />

            <section aria-label="Documentación" className="space-y-2">
              <h3 className="text-sm font-semibold">Qué lleva</h3>
              {stop.dispatches.map((x) => (
                <div key={x.id} className="rounded-lg bg-muted/40 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      Entrega {x.number}
                      {x.sale_number ? ` · venta ${x.sale_number}` : ""}
                    </span>
                    {x.remito ? (
                      <button
                        type="button"
                        onClick={() => setRemitoId(x.remito!.id)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-ninja-flameSoft hover:bg-muted"
                      >
                        <FileText size={15} aria-hidden /> Remito {remitoNumberLabel(x.remito.pto_vta, x.remito.number)}
                      </button>
                    ) : (
                      <Badge tone="neutral">Sin remito</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {x.items.map((i) => `${Number(i.qty).toLocaleString("es-AR", { maximumFractionDigits: 3 })} ${i.name}`).join(", ") || "Sin detalle"}
                  </p>
                  {x.remito?.cot_number && <p className="mt-1 text-xs text-muted-foreground">COT {x.remito.cot_number}</p>}
                  {x.remito?.signed_copy_path && (
                    <SignedImage path={x.remito.signed_copy_path} alt="Copia firmada del remito" className="mt-2 h-20 w-20 rounded-md" />
                  )}
                </div>
              ))}
            </section>

            <section aria-label="Camión y repartidor" className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                <SignedImage path={route.vehicle?.cover_photo_path} alt="Vehículo" className="h-12 w-16 shrink-0 rounded-md" fallback={<Truck size={18} aria-hidden />} />
                <div className="min-w-0 text-sm">
                  <p className="truncate font-semibold">{route.vehicle?.name ?? "Sin vehículo"}</p>
                  <p className="truncate text-muted-foreground">
                    {[route.vehicle?.plate, route.vehicle ? VEHICLE_KIND_LABEL[route.vehicle.kind] : null, [route.vehicle?.brand, route.vehicle?.model].filter(Boolean).join(" ")]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  <UserRound size={18} aria-hidden />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate font-semibold">{route.driver?.name ?? "Sin repartidor"}</p>
                  <p className="truncate text-muted-foreground">Hoja N° {route.number}</p>
                </div>
                {phone && (
                  <a href={phone.tel} aria-label="Llamar al repartidor" className="grid h-10 w-10 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
                    <Phone size={17} />
                  </a>
                )}
              </div>
            </section>
          </div>
        )}
      </Modal>
      <RemitoDetailModal id={remitoId} canManage={me?.canManage ?? false} onClose={() => setRemitoId(null)} />
    </>
  );
}
StopDetailSheet.displayName = "StopDetailSheet";
