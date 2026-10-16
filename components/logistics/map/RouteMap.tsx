"use client";

// Mapa de Logística (ADR-164): paradas numeradas por estado (entregada en
// verde, no entregada en rojo, pendientes con el color del camión), el
// recorrido planificado, el recorrido real y el camión con su última
// posición. Leaflet + tiles de OSM (components/geo/leaflet.ts), dibujado a
// mano sobre capas: el polling cambia los datos sin rearmar el mapa y el
// encuadre sólo se rehace cuando cambia `fitKey`.

import { useEffect, useRef, useState } from "react";
import { MapPinOff } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { MAP_ATTRIBUTION, MAP_TILES, loadLeaflet, type LGroup, type LL, type LMap, type LeafletNS } from "@/components/geo/leaflet";
import type { StopStatus } from "@/lib/logistics/logic";

export interface MapStop {
  id: string;
  seq: number;
  lat: number | null;
  lng: number | null;
  status: StopStatus;
  /** Color del camión (pendientes). */
  color: string;
  title?: string;
}

export interface MapTruck {
  lat: number;
  lng: number;
  label: string;
  /** Sin posición nueva hace rato: se dibuja apagado. */
  stale?: boolean;
  alert?: boolean;
}

export interface MapRoute {
  id: string;
  color: string;
  planned: LL[];
  actual?: LL[];
  truck?: MapTruck | null;
  /** Otra hoja elegida: ésta se ve tenue. */
  dim?: boolean;
  /** Recorrido planificado en el color del camión (planificador) o gris (en vivo). */
  plannedInColor?: boolean;
}

const STATUS_FILL: Partial<Record<StopStatus, string>> = {
  entregada: "#16a34a",
  parcial: "#d97706",
  no_entregada: "#dc2626",
  saltada: "#64748b",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function stopHtml(s: MapStop, selected: boolean): string {
  const fill = STATUS_FILL[s.status];
  const done = s.status === "entregada" || s.status === "parcial";
  const failed = s.status === "no_entregada";
  const size = selected ? 34 : 28;
  const bg = fill ?? "#ffffff";
  const fg = fill ? "#ffffff" : s.color;
  const ring = selected ? `outline:3px solid ${s.color};outline-offset:2px;` : "";
  const text = done ? "&#10003;" : failed ? "&#10005;" : String(s.seq);
  return `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${bg};color:${fg};border:3px solid ${fill ?? s.color};${ring}display:grid;place-items:center;font:700 ${selected ? 14 : 12}px/1 system-ui,sans-serif;">${text}</div>`;
}

function truckHtml(t: MapTruck, color: string): string {
  const bg = t.stale ? "#64748b" : color;
  const ring = t.alert ? "outline:3px solid #dc2626;outline-offset:2px;" : "";
  return `<div style="width:36px;height:36px;border-radius:10px;background:${bg};${ring}display:grid;place-items:center;border:2px solid #fff;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg></div>`;
}

const ORIGIN_HTML =
  '<div style="width:30px;height:30px;border-radius:8px;background:#0f172a;border:2px solid #fff;display:grid;place-items:center;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg></div>';

export function RouteMap({
  routes,
  stops,
  origin,
  selectedStopId,
  onStopClick,
  onTruckClick,
  fitKey,
  height = 420,
  className,
  label = "Mapa del reparto",
}: {
  routes: MapRoute[];
  stops: MapStop[];
  origin?: LL | null;
  selectedStopId?: string | null;
  onStopClick?: (id: string) => void;
  onTruckClick?: (routeId: string) => void;
  /** Cambia = se vuelve a encuadrar todo. */
  fitKey?: string;
  height?: number | string;
  className?: string;
  label?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const L = useRef<LeafletNS | null>(null);
  const layer = useRef<LGroup | null>(null);
  const fitted = useRef<string | null>(null);
  const handlers = useRef({ onStopClick, onTruckClick });
  handlers.current = { onStopClick, onTruckClick };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((ns) => {
        if (cancelled || !el.current || map.current) return;
        const m = ns.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: true });
        ns.tileLayer(MAP_TILES, { maxZoom: 19, attribution: MAP_ATTRIBUTION }).addTo(m);
        m.setView([-34.6, -58.45], 11);
        L.current = ns;
        map.current = m;
        layer.current = ns.layerGroup().addTo(m);
        setTimeout(() => m.invalidateSize(), 60);
        setReady(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
      layer.current = null;
    },
    [],
  );

  // Dibuja todo de nuevo con cada cambio de datos (son pocas capas).
  useEffect(() => {
    const ns = L.current;
    const m = map.current;
    const g = layer.current;
    if (!ready || !ns || !m || !g) return;
    g.clearLayers();
    const bounds: LL[] = [];
    for (const r of routes) {
      const opacity = r.dim ? 0.25 : 1;
      if (r.planned.length >= 2) {
        ns.polyline(r.planned, {
          color: r.plannedInColor ? r.color : "#64748b",
          weight: r.plannedInColor ? 5 : 4,
          opacity: (r.plannedInColor ? 0.85 : 0.6) * opacity,
          dashArray: r.plannedInColor ? undefined : "8 8",
        }).addTo(g);
        bounds.push(...r.planned);
      }
      if (r.actual && r.actual.length >= 2) {
        ns.polyline(r.actual, { color: r.color, weight: 5, opacity: 0.9 * opacity }).addTo(g);
        bounds.push(...r.actual);
      }
    }
    if (origin) {
      ns.marker(origin, { icon: ns.divIcon({ html: ORIGIN_HTML, className: "", iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false, title: "Origen" }).addTo(g);
      bounds.push(origin);
    }
    for (const s of stops) {
      if (s.lat === null || s.lng === null) continue;
      const selected = s.id === selectedStopId;
      const size = selected ? 34 : 28;
      const mk = ns.marker([s.lat, s.lng], {
        icon: ns.divIcon({ html: stopHtml(s, selected), className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        keyboard: true,
        title: s.title ? `${s.seq}. ${s.title}` : `Parada ${s.seq}`,
        zIndexOffset: selected ? 1000 : 0,
      });
      mk.on("click", () => handlers.current.onStopClick?.(s.id));
      mk.addTo(g);
      bounds.push([s.lat, s.lng]);
    }
    for (const r of routes) {
      if (!r.truck) continue;
      const t = r.truck;
      const mk = ns.marker([t.lat, t.lng], {
        icon: ns.divIcon({ html: truckHtml(t, r.color), className: "", iconSize: [36, 36], iconAnchor: [18, 18] }),
        keyboard: true,
        title: t.label,
        zIndexOffset: 2000,
      });
      mk.bindTooltip(esc(t.label), { direction: "top", offset: [0, -16] });
      mk.on("click", () => handlers.current.onTruckClick?.(r.id));
      mk.addTo(g);
      bounds.push([t.lat, t.lng]);
    }
    const key = fitKey ?? "auto";
    if (fitted.current !== key && bounds.length) {
      fitted.current = key;
      if (bounds.length === 1) m.setView(bounds[0]!, 15);
      else m.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
    }
  }, [ready, routes, stops, origin, selectedStopId, fitKey]);

  if (failed) {
    return (
      <div
        className={cn("flex flex-col items-center justify-center gap-2 rounded-lg bg-muted/40 p-6 text-center text-sm text-muted-foreground", className)}
        style={{ height }}
      >
        <MapPinOff size={20} aria-hidden />
        No se pudo cargar el mapa. La lista de abajo tiene lo mismo.
      </div>
    );
  }
  return (
    <div
      ref={el}
      role="region"
      aria-label={label}
      className={cn("isolate z-0 overflow-hidden rounded-lg bg-muted", className)}
      style={{ height }}
    />
  );
}
RouteMap.displayName = "RouteMap";
