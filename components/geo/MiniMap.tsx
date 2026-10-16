"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { MAP_ATTRIBUTION as ATTRIBUTION, MAP_TILES as TILES, loadLeaflet, type LMap, type LMarker } from "@/components/geo/leaflet";

// Mini mapa con el pin de la dirección (ADR-157). Leaflet + tiles de
// OpenStreetMap (cargador compartido en components/geo/leaflet.ts); si no
// carga, la dirección se guarda igual sin mapa. El pin se arrastra o se toca
// el mapa para corregirlo.

const PIN_HTML =
  '<svg width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"><path d="M14 0C6.3 0 0 6.1 0 13.7 0 24 14 36 14 36s14-12 14-22.3C28 6.1 21.7 0 14 0z" fill="#ef4444"/><circle cx="14" cy="13.5" r="5" fill="#fff"/></svg>';

export function MiniMap({
  lat,
  lng,
  onMove,
  className,
  height = 168,
}: {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /** Pin arrastrado o toque en el mapa. Sin esto el mapa es sólo de lectura. */
  onMove?: (lat: number, lng: number) => void;
  className?: string;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const marker = useRef<LMarker | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const [failed, setFailed] = useState(false);
  const has = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);

  useEffect(() => {
    if (!has) {
      // El contenedor se desmonta: el mapa se arma de nuevo con el próximo punto.
      map.current?.remove();
      map.current = null;
      marker.current = null;
      return;
    }
    if (!el.current) return;
    let cancelled = false;
    const ll: [number, number] = [lat as number, lng as number];
    if (map.current && marker.current) {
      marker.current.setLatLng(ll);
      map.current.setView(ll, Math.max(map.current.getZoom(), 16), { animate: true });
      return;
    }
    loadLeaflet()
      .then((L) => {
        if (cancelled || !el.current || map.current) return;
        const m = L.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
        L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
        m.setView(ll, 17);
        const icon = L.divIcon({ html: PIN_HTML, className: "", iconSize: [28, 36], iconAnchor: [14, 36] });
        const mk = L.marker(ll, { draggable: Boolean(moveRef.current), icon, keyboard: false });
        mk.addTo(m);
        mk.on("dragend", () => {
          const p = mk.getLatLng();
          moveRef.current?.(p.lat, p.lng);
        });
        m.on("click", (e) => {
          if (!moveRef.current) return;
          mk.setLatLng([e.latlng.lat, e.latlng.lng]);
          moveRef.current(e.latlng.lat, e.latlng.lng);
        });
        map.current = m;
        marker.current = mk;
        // El contenedor puede haber cambiado de tamaño (pestaña recién abierta).
        setTimeout(() => m.invalidateSize(), 60);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [has, lat, lng]);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
      marker.current = null;
    },
    [],
  );

  if (!has) {
    return (
      <div
        className={cn("flex items-center justify-center gap-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground", className)}
        style={{ height: Math.round(height * 0.5) }}
      >
        <MapPin size={14} aria-hidden /> Elegí una dirección para verla en el mapa
      </div>
    );
  }
  if (failed) {
    return (
      <a
        href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("flex items-center justify-center gap-2 rounded-lg border border-border text-xs font-medium underline-offset-2 hover:underline", className)}
        style={{ height: Math.round(height * 0.5) }}
      >
        <MapPin size={14} aria-hidden /> Ver en el mapa
      </a>
    );
  }
  return (
    <div
      ref={el}
      role="img"
      aria-label={onMove ? "Mapa con la ubicación. Arrastrá el pin o tocá el mapa para corregirla." : "Mapa con la ubicación"}
      className={cn("isolate z-0 overflow-hidden rounded-lg border border-border bg-muted", className)}
      style={{ height }}
    />
  );
}
MiniMap.displayName = "MiniMap";
