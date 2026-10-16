"use client";

// App del repartidor (ADR-161, R10, R11): mobile-first, sin el menú del panel.
// Mis hojas -> la hoja (Salir, paradas en orden) -> la parada (Llamar,
// WhatsApp, Cómo llegar, productos y remito; Llegué, Entregado, No se pudo
// entregar) -> Cerrar la hoja. Funciona sin señal: lo que se marca queda en
// la cola del teléfono y se manda solo cuando vuelve la conexión.

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CloudOff,
  FileText,
  LogOut,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
  RefreshCw,
  Truck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { DeliverSheet, type DeliverResult } from "@/components/reparto/DeliverSheet";
import { TrackingBanner } from "@/components/reparto/TrackingBanner";
import { FailSheet, type FailResult } from "@/components/reparto/FailSheet";
import { cn } from "@/lib/utils/cn";
import { remitoNumberLabel } from "@/lib/remitos/logic";
import {
  ROUTE_STATUS_LABEL,
  ROUTE_STATUS_TONE,
  STOP_STATUS_LABEL,
  STOP_STATUS_TONE,
  VEHICLE_KIND_LABEL,
  logisticsErrorMessage,
  navigationLinks,
  phoneLinks,
  stopIsFinal,
} from "@/lib/logistics/logic";
import { applyPending, pendingLabel, routeMediaPath, type QueuedAction, type QueuedMedia } from "@/lib/logistics/offline";
import { currentPosition, currentTenantId, deviceId, newId, useActionQueue, useDriverRoute, useMyRoutes } from "@/modules/logistics/reparto";
import { useRouteTracking } from "@/modules/logistics/tracking";
import type { RouteDetail, RouteStop } from "@/modules/logistics/api";
import { createClient } from "@/lib/supabase/client";

function dateAr(d: string): string {
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
}

function StatusBar({ q }: { q: ReturnType<typeof useActionQueue> }) {
  const label = !q.online ? "Sin señal" : q.syncing ? "Enviando…" : pendingLabel(q.pending);
  return (
    <div className={cn("flex items-center justify-between gap-2 px-4 py-2 text-xs", !q.online || q.pending ? "bg-warning/15 text-warning" : "bg-muted/40 text-muted-foreground")}>
      <span className="flex items-center gap-1.5 font-medium">
        {!q.online && <CloudOff size={14} aria-hidden />}
        {label}
        {!q.online && q.pending > 0 ? ` · ${pendingLabel(q.pending).toLowerCase()}` : ""}
      </span>
      {q.online && q.pending > 0 && (
        <button type="button" onClick={() => void q.sync()} className="inline-flex items-center gap-1 font-semibold">
          <RefreshCw size={13} aria-hidden /> Enviar ahora
        </button>
      )}
    </div>
  );
}

function FailedActions({ q }: { q: ReturnType<typeof useActionQueue> }) {
  if (!q.failed.length) return null;
  return (
    <div className="space-y-2 px-4 pt-3">
      {q.failed.map((a) => (
        <div key={a.id} className="rounded-lg bg-danger/10 p-3 text-sm">
          <p className="font-semibold text-danger">No se pudo guardar una acción</p>
          <p className="text-muted-foreground">{logisticsErrorMessage(new Error(a.lastError ?? ""))}</p>
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => void q.discard(a.id)}>
            Descartar y volver a marcar
          </Button>
        </div>
      ))}
    </div>
  );
}

function MyRoutesScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading, error, refetch, isFetching } = useMyRoutes();
  const routes = data?.data ?? [];
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Mis hojas</h1>
        <Button size="sm" variant="ghost" onClick={() => void refetch()} loading={isFetching} aria-label="Actualizar">
          <RefreshCw size={16} />
        </Button>
      </div>
      {data?.cached && <p className="text-xs text-warning">Sin señal: ves lo último que se cargó.</p>}
      {isLoading ? (
        [0, 1].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)
      ) : error ? (
        <EmptyState compact icon={CloudOff} title="No se pudieron cargar tus hojas" description={logisticsErrorMessage(error)} />
      ) : routes.length === 0 ? (
        <EmptyState icon={Truck} title="No tenés hojas de ruta" description="Cuando te asignen una, aparece acá con sus paradas." />
      ) : (
        routes.map((r) => (
          <button key={r.id} type="button" onClick={() => onOpen(r.id)} className="w-full rounded-lg bg-card p-4 text-left ring-1 ring-border active:bg-muted/50">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-semibold">Hoja N° {r.number}</span>
              <Badge tone={ROUTE_STATUS_TONE[r.status]}>{ROUTE_STATUS_LABEL[r.status]}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {dateAr(r.service_date)} · {r.store_name}
              {r.is_helper ? " · como acompañante" : ""}
            </p>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5">
                <Truck size={15} aria-hidden />
                {r.vehicle ? `${r.vehicle.name}${r.vehicle.plate ? ` · ${r.vehicle.plate}` : ""}` : "Sin vehículo"}
              </span>
              <span className="flex items-center gap-1 font-semibold tabular-nums">
                {r.done}/{r.stops} <ChevronRight size={16} aria-hidden />
              </span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}

function StopCard({ s, onOpen }: { s: RouteStop; onOpen: () => void }) {
  const final = stopIsFinal(s.status);
  return (
    <button type="button" onClick={onOpen} className={cn("flex w-full items-start gap-3 rounded-lg p-4 text-left ring-1 ring-border", final ? "bg-muted/30" : "bg-card active:bg-muted/50")}>
      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg text-lg font-bold tabular-nums", final ? "bg-muted text-muted-foreground" : "bg-ninja-flame/15 text-ninja-flameSoft")}>{s.seq}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn("font-semibold", final && "text-muted-foreground")}>{s.contact_name ?? "Sin nombre"}</span>
          <Badge tone={STOP_STATUS_TONE[s.status]}>{STOP_STATUS_LABEL[s.status]}</Badge>
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{s.address_text ?? "Sin dirección"}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {s.dispatches.length === 1 ? "1 entrega" : `${s.dispatches.length} entregas`} ·{" "}
          {s.dispatches.reduce((a, d) => a + d.items.length, 0)} productos
        </span>
      </span>
      <ChevronRight size={18} className="mt-2 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

function StopScreen({
  detail,
  stop,
  onBack,
  onArrive,
  onDeliver,
  onFail,
}: {
  detail: RouteDetail;
  stop: RouteStop;
  onBack: () => void;
  onArrive: () => void;
  onDeliver: () => void;
  onFail: () => void;
}) {
  const nav = navigationLinks({ lat: stop.lat, lng: stop.lng, address: stop.address_text });
  const phone = phoneLinks(stop.contact_phone);
  const final = stopIsFinal(stop.status);
  const live = detail.route.status === "en_curso";
  return (
    <div className="space-y-4 p-4 pb-40">
      <button type="button" onClick={onBack} className="inline-flex h-10 items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <ArrowLeft size={16} aria-hidden /> Paradas
      </button>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-ninja-flame/15 font-bold text-ninja-flameSoft">{stop.seq}</span>
          <h1 className="text-xl font-semibold">{stop.contact_name ?? "Sin nombre"}</h1>
          <Badge tone={STOP_STATUS_TONE[stop.status]}>{STOP_STATUS_LABEL[stop.status]}</Badge>
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-base">
          <MapPin size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          {stop.address_text ?? "Sin dirección"}
        </p>
        {(stop.ship_to?.between_streets || stop.ship_to?.reference) && (
          <p className="ml-6 text-sm text-muted-foreground">{[stop.ship_to?.between_streets, stop.ship_to?.reference].filter(Boolean).join(" · ")}</p>
        )}
        {stop.notes && <p className="ml-6 mt-1 rounded-md bg-warning/10 px-2 py-1 text-sm">{stop.notes}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <a href={phone?.tel ?? undefined} aria-disabled={!phone} className={cn("flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg bg-muted/60 text-xs font-semibold", !phone && "pointer-events-none opacity-40")}>
          <Phone size={18} aria-hidden /> Llamar
        </a>
        <a href={phone?.whatsapp ?? undefined} target="_blank" rel="noreferrer" aria-disabled={!phone} className={cn("flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg bg-muted/60 text-xs font-semibold", !phone && "pointer-events-none opacity-40")}>
          <MessageCircle size={18} aria-hidden /> WhatsApp
        </a>
        <a href={nav.google} target="_blank" rel="noreferrer" className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg bg-muted/60 text-xs font-semibold">
          <Navigation size={18} aria-hidden /> Cómo llegar
        </a>
      </div>
      {nav.waze && (
        <a href={nav.waze} target="_blank" rel="noreferrer" className="block text-center text-sm font-medium text-ninja-flameSoft">
          Abrir en Waze
        </a>
      )}

      <div className="space-y-3">
        {stop.dispatches.map((d) => (
          <div key={d.id} className="rounded-lg bg-card p-3 ring-1 ring-border">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                Entrega {d.number}
                {d.sale_number ? ` · venta ${d.sale_number}` : ""}
              </span>
              {d.remito && (
                <Badge tone="info">
                  <FileText size={12} aria-hidden /> Remito {remitoNumberLabel(d.remito.pto_vta, d.remito.number)}
                </Badge>
              )}
            </div>
            {d.remito?.cot_number && <p className="mt-1 text-xs text-muted-foreground">COT {d.remito.cot_number}</p>}
            <ul className="mt-2 space-y-1">
              {d.items.map((i, k) => (
                <li key={k} className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0">{i.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {Number(i.qty).toLocaleString("es-AR", { maximumFractionDigits: 3 })} {i.unit ?? ""}
                  </span>
                </li>
              ))}
            </ul>
            {d.notes && <p className="mt-2 text-xs text-muted-foreground">{d.notes}</p>}
          </div>
        ))}
      </div>

      {stop.last_event && (
        <p className={cn("rounded-lg p-3 text-sm", stop.last_event.type === "entregado" ? "bg-success/10" : "bg-danger/10")}>
          {stop.last_event.type === "entregado"
            ? `Entregado a ${stop.last_event.received_by_name ?? "quien recibió"}`
            : `No se entregó: ${stop.last_event.reason_label ?? ""}`}
        </p>
      )}

      {live && !final && (
        <div className="fixed inset-x-0 bottom-0 space-y-2 bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] ring-1 ring-border">
          {stop.status !== "en_el_lugar" && (
            <Button variant="secondary" className="h-12 w-full text-base" onClick={onArrive}>
              <MapPin size={18} /> Llegué
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button className="h-14 text-base" onClick={onDeliver}>
              <CheckCircle2 size={20} /> Entregado
            </Button>
            <Button variant="secondary" className="h-14 text-base text-danger" onClick={onFail}>
              <XCircle size={20} /> No se pudo
            </Button>
          </div>
        </div>
      )}
      {!live && !final && <p className="text-center text-sm text-muted-foreground">Tocá Salir en la hoja para empezar a entregar.</p>}
    </div>
  );
}

function RouteScreen({ routeId, onBack, q }: { routeId: string; onBack: () => void; q: ReturnType<typeof useActionQueue> }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useDriverRoute(routeId);
  const [stopId, setStopId] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [failing, setFailing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [starting, setStarting] = useState(false);

  const detail = useMemo(() => (data ? applyPending(data.data, q.items) : null), [data, q.items]);
  if (isLoading) return <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>;
  if (error || !detail) {
    return (
      <div className="p-4">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={16} /> Mis hojas
        </Button>
        <EmptyState compact icon={CloudOff} title="No se pudo abrir la hoja" description={logisticsErrorMessage(error)} />
      </div>
    );
  }
  const r = detail.route;
  const stop = detail.stops.find((s) => s.id === stopId) ?? null;
  const open = detail.stops.filter((s) => !stopIsFinal(s.status));
  const point = stop && stop.lat != null && stop.lng != null ? { lat: stop.lat, lng: stop.lng } : null;

  async function base(kind: QueuedAction["kind"], extra: Partial<QueuedAction>, payload: Record<string, unknown>, media: QueuedMedia[] = []) {
    const id = (payload.id as string) ?? newId();
    const a: QueuedAction = {
      id,
      kind,
      routeId,
      stopId: null,
      payload: { ...payload, id, route_id: routeId, occurred_at: new Date().toISOString(), device_id: deviceId() },
      media,
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      failed: false,
      ...extra,
    };
    // Si el servidor la rechaza (dato que falta), queda arriba con el motivo.
    return q.enqueue(a);
  }

  async function start() {
    setStarting(true);
    const pos = await currentPosition(6000);
    // Con señal se manda directo para mostrar el motivo si no puede salir.
    if (q.online) {
      const id = newId();
      const { error: err } = await createClient().rpc("route_start" as never, {
        p_route: routeId,
        p_event: { id, lat: pos?.lat, lng: pos?.lng, accuracy_m: pos?.accuracy, device_id: deviceId(), occurred_at: new Date().toISOString() },
      } as never);
      setStarting(false);
      if (err && !/Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
        toast({ title: "No podés salir todavía", description: logisticsErrorMessage(err), variant: "error" });
        return;
      }
      if (!err) {
        toast({ title: "¡Buen viaje!", description: "Las entregas quedan en camino.", variant: "success" });
        void q.sync();
        return;
      }
    }
    await base("start", {}, { lat: pos?.lat, lng: pos?.lng, accuracy_m: pos?.accuracy });
    setStarting(false);
    toast({ title: "Salida guardada", description: "Se manda cuando vuelva la señal.", variant: "success" });
  }

  async function arrive() {
    if (!stop) return;
    const pos = await currentPosition(5000);
    await base("event", { stopId: stop.id, eventType: "llegada" }, { type: "llegada", stop_id: stop.id, lat: pos?.lat, lng: pos?.lng, accuracy_m: pos?.accuracy });
  }

  async function deliver(res: DeliverResult) {
    if (!stop) return;
    const tenant = await currentTenantId();
    if (!tenant) {
      toast({ title: "Volvé a iniciar sesión", variant: "error" });
      return;
    }
    const id = newId();
    const media: QueuedMedia[] = [];
    let signaturePath: string | null = null;
    if (res.signature) {
      signaturePath = routeMediaPath(tenant, routeId, id, "firma", "png");
      media.push({ path: signaturePath, blob: res.signature, contentType: "image/png", uploaded: false });
    }
    const photoPaths = res.photos.map((p, i) => {
      const path = routeMediaPath(tenant, routeId, id, `foto${i + 1}`, p.type === "image/webp" ? "webp" : "jpg");
      media.push({ path, blob: p.blob, contentType: p.type, uploaded: false });
      return path;
    });
    let remitoPath: string | null = null;
    if (res.remitoPhoto) {
      remitoPath = routeMediaPath(tenant, routeId, id, "remito", res.remitoPhoto.type === "image/webp" ? "webp" : "jpg");
      media.push({ path: remitoPath, blob: res.remitoPhoto.blob, contentType: res.remitoPhoto.type, uploaded: false });
    }
    await base(
      "event",
      { stopId: stop.id, eventType: "entregado" },
      {
        id,
        type: "entregado",
        stop_id: stop.id,
        lat: res.position?.lat,
        lng: res.position?.lng,
        accuracy_m: res.position?.accuracy,
        far_confirmed: res.farConfirmed,
        received_by_name: res.receivedByName,
        received_by_doc: res.receivedByDoc,
        signature_path: signaturePath,
        photo_paths: photoPaths,
        remito_photo_path: remitoPath,
        note: res.note,
      },
      media,
    );
    setDelivering(false);
    toast({ title: "Entrega guardada", variant: "success" });
    const next = open.find((s) => s.id !== stop.id);
    setStopId(next?.id ?? null);
  }

  async function fail(res: FailResult) {
    if (!stop) return;
    const tenant = await currentTenantId();
    if (!tenant) {
      toast({ title: "Volvé a iniciar sesión", variant: "error" });
      return;
    }
    const id = newId();
    const media: QueuedMedia[] = [];
    const photoPaths = res.photos.map((p, i) => {
      const path = routeMediaPath(tenant, routeId, id, `foto${i + 1}`, p.type === "image/webp" ? "webp" : "jpg");
      media.push({ path, blob: p.blob, contentType: p.type, uploaded: false });
      return path;
    });
    await base(
      "event",
      { stopId: stop.id, eventType: "no_entregado" },
      {
        id,
        type: "no_entregado",
        stop_id: stop.id,
        reason_key: res.reason.key,
        note: res.note,
        lat: res.position?.lat,
        lng: res.position?.lng,
        accuracy_m: res.position?.accuracy,
        far_confirmed: res.farConfirmed,
        photo_paths: photoPaths,
      },
      media,
    );
    setFailing(false);
    toast({ title: "Guardado: vuelve a Expedición", description: res.reason.label, variant: "success" });
    const next = open.find((s) => s.id !== stop.id);
    setStopId(next?.id ?? null);
  }

  async function close() {
    const pos = await currentPosition(5000);
    await base("close", {}, { lat: pos?.lat, lng: pos?.lng, accuracy_m: pos?.accuracy });
    setClosing(false);
    toast({ title: "Hoja cerrada", description: "Lo que no se entregó vuelve a Expedición.", variant: "success" });
    onBack();
  }

  if (stop) {
    return (
      <>
        <StopScreen detail={detail} stop={stop} onBack={() => setStopId(null)} onArrive={() => void arrive()} onDeliver={() => setDelivering(true)} onFail={() => setFailing(true)} />
        <DeliverSheet
          open={delivering}
          title={`${stop.contact_name ?? ""} · ${stop.address_text ?? ""}`}
          defaultName={stop.contact_name ?? ""}
          stopPoint={point}
          settings={detail.settings}
          hasRemito={stop.dispatches.some((d) => d.remito)}
          onClose={() => setDelivering(false)}
          onConfirm={deliver}
        />
        <FailSheet open={failing} title={`${stop.contact_name ?? ""} · ${stop.address_text ?? ""}`} settings={detail.settings} stopPoint={point} onClose={() => setFailing(false)} onConfirm={fail} />
      </>
    );
  }

  const canStart = r.status === "planificada" || r.status === "cargando";
  return (
    <div className="space-y-4 p-4 pb-32">
      <button type="button" onClick={onBack} className="inline-flex h-10 items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <ArrowLeft size={16} aria-hidden /> Mis hojas
      </button>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">Hoja N° {r.number}</h1>
          <Badge tone={ROUTE_STATUS_TONE[r.status]}>{ROUTE_STATUS_LABEL[r.status]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {dateAr(r.service_date)}
          {detail.vehicle ? ` · ${detail.vehicle.name}${detail.vehicle.plate ? ` (${detail.vehicle.plate})` : ""} · ${VEHICLE_KIND_LABEL[detail.vehicle.kind]}` : ""}
        </p>
        {detail.origin && <p className="text-sm text-muted-foreground">Sale de {detail.origin.name}</p>}
        {r.notes && <p className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-sm">{r.notes}</p>}
        {data?.cached && <p className="mt-2 text-xs text-warning">Sin señal: ves lo último que se cargó.</p>}
      </div>

      <div className="space-y-2">
        {detail.stops.map((s) => (
          <StopCard key={s.id} s={s} onOpen={() => setStopId(s.id)} />
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] ring-1 ring-border">
        {canStart ? (
          <Button className="h-14 w-full text-base" onClick={() => void start()} loading={starting}>
            <Truck size={20} /> Salir
          </Button>
        ) : r.status === "en_curso" ? (
          open.length > 0 ? (
            <Button className="h-14 w-full text-base" onClick={() => setStopId(open[0]!.id)}>
              Próxima parada: {open[0]!.seq}. {open[0]!.contact_name ?? ""}
            </Button>
          ) : (
            <Button className="h-14 w-full text-base" onClick={() => setClosing(true)}>
              <LogOut size={20} /> Cerrar la hoja
            </Button>
          )
        ) : (
          <p className="text-center text-sm text-muted-foreground">Hoja {ROUTE_STATUS_LABEL[r.status].toLowerCase()}.</p>
        )}
        {r.status === "en_curso" && open.length > 0 && (
          <button type="button" onClick={() => setClosing(true)} className="mt-2 w-full text-center text-sm font-medium text-muted-foreground">
            Cerrar la hoja con {open.length === 1 ? "1 parada sin visitar" : `${open.length} paradas sin visitar`}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title="Cerrar la hoja"
        description={open.length ? "Las paradas que quedan vuelven a Expedición como no visitadas." : "Terminaste el reparto. Lo no entregado vuelve a Expedición con su motivo."}
        confirmLabel="Cerrar la hoja"
        onConfirm={() => void close()}
      />
    </div>
  );
}

export function RepartoApp({ name }: { name: string | null }) {
  const q = useActionQueue();
  const [routeId, setRouteId] = useState<string | null>(null);
  // ADR-164: seguimiento de la hoja en curso (también si salió sin señal).
  const mine = useMyRoutes();
  const activeId =
    mine.data?.data.find((r) => r.status === "en_curso")?.id ?? q.items.find((a) => a.kind === "start" && !a.failed)?.routeId ?? null;
  const closing = q.items.some((a) => a.kind === "close" && a.routeId === activeId && !a.failed);
  const tracking = useRouteTracking(activeId, Boolean(activeId) && !closing);
  return (
    <div className="mx-auto min-h-dvh w-full max-w-xl bg-background">
      <header className="sticky top-0 z-10 bg-background">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <span className="flex items-center gap-2 font-semibold">
            <Truck size={20} className="text-ninja-flameSoft" aria-hidden /> Reparto
          </span>
          <span className="truncate text-sm text-muted-foreground">{name}</span>
        </div>
        <StatusBar q={q} />
        <TrackingBanner t={tracking} />
      </header>
      <FailedActions q={q} />
      {routeId ? <RouteScreen routeId={routeId} q={q} onBack={() => setRouteId(null)} /> : <MyRoutesScreen onOpen={setRouteId} />}
    </div>
  );
}
RepartoApp.displayName = "RepartoApp";
