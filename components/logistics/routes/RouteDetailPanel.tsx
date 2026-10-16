"use client";

// Detalle de una hoja de ruta en el panel (ADR-161): camión, repartidor,
// paradas en orden con sus entregas, productos, remito y lo que pasó en la
// calle (quién recibió, firma, fotos, ubicación y distancia a la dirección).
// Antes de salir: sumar entregas, ordenar por cercanía o a mano, planificar,
// controlar la carga, emitir los remitos que falten e imprimir la hoja.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route as NextRoute } from "next";
import { useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FileText,
  MapPin,
  Map as MapIcon,
  Navigation,
  Pencil,
  Plus,
  Printer,
  Sparkles,
  Trash2,
  Truck,
  UserRound,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { SignedImage } from "@/components/logistics/SignedImage";
import { AddDispatchesModal } from "@/components/logistics/routes/AddDispatchesModal";
import { RouteFormModal } from "@/components/logistics/routes/RouteFormModal";
import { RouteSheetPrint } from "@/components/logistics/routes/RouteSheetPrint";
import { RouteMap } from "@/components/logistics/map/RouteMap";
import { routePath } from "@/lib/logistics/tracking";
import { formatDuration } from "@/lib/logistics/planning";
import { RemitoDetailModal } from "@/components/remitos/RemitoDetailModal";
import { printTicketIsolated } from "@/lib/print/webPrint";
import { cn } from "@/lib/utils/cn";
import { remitoNumberLabel } from "@/lib/remitos/logic";
import {
  ROUTE_STATUS_LABEL,
  ROUTE_STATUS_TONE,
  STOP_STATUS_LABEL,
  STOP_STATUS_TONE,
  formatDistance,
  logisticsErrorMessage,
  orderByProximity,
  routeEditable,
  routeMissing,
  type RouteStatus,
} from "@/lib/logistics/logic";
import { useLogisticsMutations, useRouteDetail, type RouteDetail, type RouteStop } from "@/modules/logistics/api";
import { remitosApi } from "@/modules/remitos/api";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";

function time(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });
}

function StopEvent({ stop }: { stop: RouteStop }) {
  const e = stop.last_event;
  if (!e) return null;
  const ok = e.type === "entregado";
  return (
    <div className={cn("mt-3 rounded-lg p-3 text-sm", ok ? "bg-success/10" : "bg-danger/10")}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
        {ok ? <CheckCircle2 size={15} className="text-success" aria-hidden /> : <XCircle size={15} className="text-danger" aria-hidden />}
        {ok ? `Entregado a ${e.received_by_name ?? "quien recibió"}` : `No se entregó: ${e.reason_label ?? "sin motivo"}`}
        <span className="font-normal text-muted-foreground">{time(e.occurred_at)}</span>
        {e.received_by_doc && <span className="font-normal text-muted-foreground">DNI {e.received_by_doc}</span>}
        {e.distance_to_stop_m != null && (
          <Badge tone={e.distance_to_stop_m > 300 ? "warning" : "neutral"}>a {formatDistance(e.distance_to_stop_m)} de la dirección</Badge>
        )}
      </p>
      {e.note && <p className="mt-1 text-muted-foreground">{e.note}</p>}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        {e.signature_path && (
          <figure className="space-y-1">
            <SignedImage path={e.signature_path} alt="Firma" contain className="h-16 w-32 rounded-md bg-white" />
            <figcaption className="text-[11px] text-muted-foreground">Firma</figcaption>
          </figure>
        )}
        {e.photo_paths.map((p) => (
          <figure key={p} className="space-y-1">
            <SignedImage path={p} alt="Foto de la entrega" className="h-16 w-16 rounded-md" />
            <figcaption className="text-[11px] text-muted-foreground">Foto</figcaption>
          </figure>
        ))}
        {e.remito_photo_path && (
          <figure className="space-y-1">
            <SignedImage path={e.remito_photo_path} alt="Remito firmado" className="h-16 w-16 rounded-md" />
            <figcaption className="text-[11px] text-muted-foreground">Remito firmado</figcaption>
          </figure>
        )}
        {e.lat != null && e.lng != null && (
          <a
            href={`https://www.google.com/maps?q=${e.lat},${e.lng}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ninja-flameSoft hover:bg-muted"
          >
            <MapPin size={15} aria-hidden /> Dónde se marcó
          </a>
        )}
      </div>
    </div>
  );
}

export function RouteDetailPanel({ routeId, onClosed }: { routeId: string; onClosed?: () => void }) {
  const { toast } = useToast();
  const { data: d, isLoading, error } = useRouteDetail(routeId);
  const m = useLogisticsMutations();
  const qc = useQueryClient();
  const remitosOn = useFeature("entregas_remitos") === true;
  const { data: me } = useMyTenant();
  const printRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [remitoId, setRemitoId] = useState<string | null>(null);
  // ADR-164: la hoja en el mapa (paradas por estado y recorrido planificado).
  const map = useMemo(() => {
    if (!d || !d.stops.some((s) => s.lat != null)) return null;
    const o = d.origin?.lat != null && d.origin.lng != null ? { lat: d.origin.lat, lng: d.origin.lng } : null;
    return {
      origin: o ? ([o.lat, o.lng] as [number, number]) : null,
      routes: [{ id: d.route.id, color: "#f97316", planned: routePath(d.route.planned_path ?? null, o, d.stops, d.route.return_to_origin), plannedInColor: true }],
      stops: d.stops.map((s) => ({ id: s.id, seq: s.seq, lat: s.lat, lng: s.lng, status: s.status, color: "#f97316", title: s.contact_name ?? undefined })),
    };
  }, [d]);

  if (isLoading) return <Skeleton className="h-96 w-full rounded-lg" />;
  if (error || !d) {
    return <EmptyState compact icon={Truck} title="No se pudo abrir la hoja" description={logisticsErrorMessage(error)} />;
  }
  const detail: RouteDetail = d;
  const r = detail.route;
  const editable = routeEditable(r.status);
  const missing = routeMissing({ vehicle: Boolean(detail.vehicle), driver: Boolean(detail.driver), stops: detail.stops.length });
  const withoutRemito = detail.stops.flatMap((s) => s.dispatches.filter((x) => x.outcome === "pendiente" && !x.remito));
  const done = detail.stops.filter((s) => ["entregada", "parcial", "no_entregada", "saltada"].includes(s.status)).length;

  async function setStatus(to: RouteStatus) {
    try {
      await m.setStatus.mutateAsync({ routeId, to });
      toast({ title: `Hoja ${ROUTE_STATUS_LABEL[to].toLowerCase()}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo cambiar el estado", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  async function move(idx: number, dir: -1 | 1) {
    const ids = detail.stops.map((s) => s.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    try {
      await m.reorder.mutateAsync({ routeId, ids, mode: "manual", distanceM: null });
    } catch (e) {
      toast({ title: "No se pudo ordenar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  async function optimize() {
    const origin = detail.origin?.lat != null && detail.origin.lng != null ? { lat: detail.origin.lat, lng: detail.origin.lng } : null;
    const res = orderByProximity(
      origin,
      detail.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, locality: s.ship_to?.locality ?? null })),
      r.return_to_origin,
    );
    try {
      await m.reorder.mutateAsync({ routeId, ids: res.ids, mode: "heuristica", distanceM: res.distanceM || null });
      const noGeo = detail.stops.filter((s) => s.lat == null).length;
      toast({
        title: "Paradas ordenadas por cercanía",
        description: [res.distanceM ? `Unos ${formatDistance(res.distanceM)} en línea recta.` : null, noGeo ? `${noGeo} sin ubicación quedaron al final.` : null]
          .filter(Boolean)
          .join(" "),
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo ordenar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  async function removeStop(id: string) {
    try {
      await m.removeStop.mutateAsync(id);
    } catch (e) {
      toast({ title: "No se pudo quitar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  async function issueRemitos() {
    setIssuing(true);
    let ok = 0;
    try {
      for (const x of withoutRemito) {
        await remitosApi.issue(crypto.randomUUID(), { dispatch_id: x.id });
        ok++;
      }
      toast({ title: ok === 1 ? "1 remito emitido" : `${ok} remitos emitidos`, variant: "success" });
    } catch (e) {
      toast({ title: ok ? `Se emitieron ${ok}, uno falló` : "No se pudo emitir", description: logisticsErrorMessage(e), variant: "error" });
    } finally {
      setIssuing(false);
      void qc.invalidateQueries({ queryKey: ["logistics"] });
      void qc.invalidateQueries({ queryKey: ["remitos"] });
    }
  }

  const offscreen =
    typeof document !== "undefined"
      ? createPortal(
          <div ref={printRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
            <div className="ticket-print">
              <RouteSheetPrint detail={detail} businessName={me?.name ?? null} />
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="space-y-5">
      {offscreen}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">Hoja N° {r.number}</h2>
            <Badge tone={ROUTE_STATUS_TONE[r.status]}>{ROUTE_STATUS_LABEL[r.status]}</Badge>
            {r.optimize_mode === "heuristica" && <Badge tone="info">Ordenada por cercanía</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.stops.length === 1 ? "1 parada" : `${detail.stops.length} paradas`}
            {r.status === "en_curso" || r.status === "cerrada" ? ` · ${done} resueltas` : ""}
            {r.planned_distance_m ? ` · ${formatDistance(r.planned_distance_m)}` : ""}
            {detail.origin ? ` · sale de ${detail.origin.name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => printTicketIsolated(printRef.current) || toast({ title: "No se pudo imprimir", variant: "error" })}>
            <Printer size={15} /> Imprimir hoja
          </Button>
          {editable && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              <Pencil size={15} /> Editar
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <SignedImage path={detail.vehicle?.cover_photo_path} alt="Vehículo" className="h-12 w-16 shrink-0 rounded-md" fallback={<Truck size={18} aria-hidden />} />
          <div className="min-w-0 text-sm">
            <p className="truncate font-semibold">{detail.vehicle?.name ?? "Sin vehículo"}</p>
            <p className="truncate text-muted-foreground">{detail.vehicle?.plate ?? "Elegí uno en Editar"}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <UserRound size={18} aria-hidden />
          </span>
          <div className="min-w-0 text-sm">
            <p className="truncate font-semibold">{detail.driver?.name ?? "Sin repartidor"}</p>
            <p className="truncate text-muted-foreground">{detail.helper ? `Con ${detail.helper.name}` : r.started_at ? `Salió ${time(r.started_at)}` : "Repartidor"}</p>
          </div>
        </div>
      </div>

      {map && (
        <div className="space-y-2">
          <RouteMap routes={map.routes} stops={map.stops} origin={map.origin} fitKey={`${r.id}:${detail.stops.length}`} height={260} label={`Mapa de la hoja N° ${r.number}`} />
          <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {r.planned_duration_s ? `Unas ${formatDuration(r.planned_duration_s)} de recorrido` : "Paradas en orden"}
              {detail.stops.some((s) => s.lat == null) ? " · las que no tienen ubicación no se ven en el mapa" : ""}
            </span>
            {(r.status === "en_curso" || r.status === "cerrada") && (
              <Link
                href={`/logistica/mapa?dia=${r.service_date}&hoja=${r.id}` as NextRoute}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ninja-flameSoft hover:bg-muted"
              >
                <MapIcon size={15} aria-hidden /> {r.status === "en_curso" ? "Seguir en vivo" : "Ver el recorrido"}
              </Link>
            )}
          </p>
        </div>
      )}

      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={15} /> Sumar entregas
          </Button>
          {detail.stops.length > 1 && (
            <Button size="sm" variant="secondary" onClick={optimize} loading={m.reorder.isPending}>
              <Sparkles size={15} /> Ordenar por cercanía
            </Button>
          )}
          {remitosOn && detail.settings.remito_policy !== "nunca" && withoutRemito.length > 0 && (
            <Button size="sm" variant="secondary" onClick={issueRemitos} loading={issuing}>
              <FileText size={15} /> Emitir {withoutRemito.length === 1 ? "el remito que falta" : `los ${withoutRemito.length} remitos que faltan`}
            </Button>
          )}
          {r.status === "borrador" && (
            <Button size="sm" variant="secondary" onClick={() => setStatus("planificada")} disabled={missing.length > 0}>
              Planificar
            </Button>
          )}
          {r.status === "planificada" && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setStatus("cargando")}>
                Controlar la carga
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStatus("borrador")}>
                Volver a borrador
              </Button>
            </>
          )}
          {r.status === "cargando" && (
            <Button size="sm" variant="ghost" onClick={() => setStatus("planificada")}>
              Volver a planificada
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelling(true)}>
            Cancelar hoja
          </Button>
        </div>
      )}
      {editable && missing.length > 0 && <p className="text-sm text-warning">{missing.join(" ")}</p>}
      {editable && r.status !== "borrador" && (
        <p className="text-sm text-muted-foreground">
          El repartidor la ve en su celular y sale desde la app.
          {(detail.settings.remito_policy === "siempre_reparto" || detail.settings.remito_policy === "siempre_envio") && withoutRemito.length > 0
            ? " Tu configuración pide remito en cada entrega: emitilos antes de salir."
            : ""}
        </p>
      )}

      {detail.stops.length === 0 ? (
        <EmptyState compact icon={MapPin} title="La hoja no tiene paradas" description="Sumá los envíos que salen en este vehículo." />
      ) : (
        <ol className="space-y-3">
          {detail.stops.map((s, idx) => (
            <li key={s.id} className="rounded-lg bg-card p-4 ring-1 ring-border">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-base font-bold tabular-nums">{s.seq}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{s.contact_name ?? "Sin nombre"}</p>
                    <Badge tone={STOP_STATUS_TONE[s.status]}>{STOP_STATUS_LABEL[s.status]}</Badge>
                    {s.lat == null && <Badge tone="warning">Sin ubicación</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {s.address_text ?? "Sin dirección"}
                    {s.contact_phone ? ` · ${s.contact_phone}` : ""}
                  </p>
                  {s.notes && <p className="mt-1 text-sm text-muted-foreground">{s.notes}</p>}
                  <ul className="mt-2 space-y-1">
                    {s.dispatches.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium">Entrega {x.number}</span>
                        <span className="text-muted-foreground">
                          {x.items.map((i) => `${Number(i.qty).toLocaleString("es-AR", { maximumFractionDigits: 3 })} ${i.name}`).join(", ")}
                        </span>
                        {x.remito ? (
                          <button type="button" onClick={() => setRemitoId(x.remito!.id)} className="rounded-md text-xs font-semibold text-ninja-flameSoft hover:underline">
                            Remito {remitoNumberLabel(x.remito.pto_vta, x.remito.number)}
                          </button>
                        ) : remitosOn && detail.settings.remito_policy !== "nunca" ? (
                          <Badge tone="neutral">Sin remito</Badge>
                        ) : null}
                        {x.outcome === "no_entregado" && <Badge tone="danger">Volvió a Expedición</Badge>}
                      </li>
                    ))}
                  </ul>
                  <StopEvent stop={s} />
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {editable && (
                    <>
                      <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Subir" disabled={idx === 0} onClick={() => move(idx, -1)}>
                        <ArrowUp size={16} />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Bajar" disabled={idx === detail.stops.length - 1} onClick={() => move(idx, 1)}>
                        <ArrowDown size={16} />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-9 w-9 text-danger" aria-label="Quitar la parada" onClick={() => removeStop(s.id)}>
                        <Trash2 size={16} />
                      </Button>
                    </>
                  )}
                  {!editable && s.lat != null && (
                    <a
                      href={`https://www.google.com/maps?q=${s.lat},${s.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Ver la dirección en el mapa"
                      className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
                    >
                      <Navigation size={16} />
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {r.status === "cerrada" && r.summary && (
        <p className="rounded-lg bg-muted/40 p-3 text-sm">
          Cerrada {time(r.closed_at)}: {r.summary.delivered} entregadas, {r.summary.failed} no entregadas
          {r.summary.skipped ? `, ${r.summary.skipped} sin visitar` : ""}. Lo que no se entregó volvió a Expedición con su motivo.
        </p>
      )}

      <AddDispatchesModal open={adding} routeId={routeId} storeId={r.store_id} onClose={() => setAdding(false)} />
      <RouteFormModal open={editing} route={r} defaultStoreId={r.store_id} defaultDate={r.service_date} onClose={() => setEditing(false)} />
      <RemitoDetailModal id={remitoId} canManage={me?.canManage ?? false} onClose={() => setRemitoId(null)} />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={`Cancelar la hoja N° ${r.number}`}
        description="Las entregas vuelven a Expedición para sumarlas a otra hoja."
        confirmLabel="Cancelar hoja"
        danger
        withReason
        loading={m.cancel.isPending}
        onConfirm={async (reason) => {
          try {
            await m.cancel.mutateAsync({ routeId, reason });
            toast({ title: `Hoja N° ${r.number} cancelada`, variant: "success" });
            setCancelling(false);
            onClosed?.();
          } catch (e) {
            toast({ title: "No se pudo cancelar", description: logisticsErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}
RouteDetailPanel.displayName = "RouteDetailPanel";
