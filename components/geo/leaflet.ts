"use client";

// Leaflet + tiles de OpenStreetMap (ADR-157, ADR-164): gratis y sin clave.
// Se carga del CDN sólo cuando se muestra un mapa (no suma al bundle) con
// SRI fijo. La URL de tiles se cambia sin código con NEXT_PUBLIC_MAP_TILE_URL
// (plan B: OpenFreeMap o Protomaps). Lo comparten el mini mapa de la
// dirección y los mapas de Logística.

export const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
export const LEAFLET_JS_SRI = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
export const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
export const LEAFLET_CSS_SRI = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";
export const MAP_TILES = process.env.NEXT_PUBLIC_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';

export type LL = [number, number];

/** Lo poco de Leaflet que usamos (sin @types/leaflet). */
export interface LLayer {
  addTo(m: LMap | LGroup): LLayer;
  remove(): void;
  on(ev: string, fn: (e: unknown) => void): LLayer;
}
export interface LMarker extends LLayer {
  setLatLng(ll: LL): void;
  getLatLng(): { lat: number; lng: number };
  setIcon(icon: unknown): void;
  setZIndexOffset(n: number): void;
  bindTooltip(text: string, opts?: Record<string, unknown>): LMarker;
}
export interface LPolyline extends LLayer {
  setLatLngs(lls: LL[]): void;
  setStyle(s: Record<string, unknown>): void;
}
export interface LGroup {
  addTo(m: LMap): LGroup;
  clearLayers(): void;
  remove(): void;
}
export interface LMap {
  setView(ll: LL, zoom: number, opts?: { animate?: boolean }): void;
  on(ev: string, fn: (e: { latlng: { lat: number; lng: number } }) => void): void;
  remove(): void;
  invalidateSize(): void;
  getZoom(): number;
  fitBounds(b: LL[], opts?: Record<string, unknown>): void;
  flyTo(ll: LL, zoom?: number, opts?: Record<string, unknown>): void;
}
export interface LeafletNS {
  map(el: HTMLElement, opts: Record<string, unknown>): LMap;
  tileLayer(url: string, opts: Record<string, unknown>): { addTo(m: LMap): void };
  marker(ll: LL, opts: Record<string, unknown>): LMarker;
  polyline(lls: LL[], opts: Record<string, unknown>): LPolyline;
  circleMarker(ll: LL, opts: Record<string, unknown>): LLayer;
  layerGroup(): LGroup;
  divIcon(opts: Record<string, unknown>): unknown;
}

let loading: Promise<LeafletNS> | null = null;

export function loadLeaflet(): Promise<LeafletNS> {
  const w = window as unknown as { L?: LeafletNS };
  if (w.L) return Promise.resolve(w.L);
  if (loading) return loading;
  loading = new Promise<LeafletNS>((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET_CSS;
      css.integrity = LEAFLET_CSS_SRI;
      css.crossOrigin = "";
      document.head.appendChild(css);
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.integrity = LEAFLET_JS_SRI;
    s.crossOrigin = "";
    s.async = true;
    s.onload = () => (w.L ? resolve(w.L) : reject(new Error("leaflet")));
    s.onerror = () => {
      loading = null;
      reject(new Error("leaflet"));
    };
    document.head.appendChild(s);
  });
  return loading;
}
