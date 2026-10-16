// Direcciones de entrega (ADR-157 · F22 · H144). PURO: sin React ni Supabase.
//
// La forma de la dirección es la de customer_addresses y dispatches.ship_to
// (la misma que arma la Edge geo en supabase/functions/_shared/geo/core.ts).
import { normText, type GeoAddress, type GeoQuality } from "@/supabase/functions/_shared/geo/core";

export type { GeoAddress, GeoQuality, GeoSource, GeoSuggestion } from "@/supabase/functions/_shared/geo/core";
export { provinceCode, normText } from "@/supabase/functions/_shared/geo/core";

/** Dirección guardada del cliente (fila de customer_addresses). */
export interface CustomerAddress extends GeoAddress {
  id: string;
  customer_id: string;
  is_default: boolean;
  created_at: string;
}

/**
 * "Av. San Martín 1234, Piso 3 Dto. B, Pilar, Buenos Aires". Espejo de
 * _ship_to_text en la migración 20261226100000 (el texto de la entrega).
 */
export function formatShipTo(a: Partial<GeoAddress> | null | undefined): string {
  if (!a) return "";
  const line1 = [a.street, a.number].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
  const unit = [a.floor ? `Piso ${a.floor}` : "", a.apartment ? `Dto. ${a.apartment}` : ""].filter(Boolean).join(" ");
  return [line1, unit, a.locality ?? "", a.province ?? ""]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ")
    .slice(0, 300);
}

/** "Av. San Martín 1234" (línea corta para chips). */
export function shortShipTo(a: Partial<GeoAddress> | null | undefined): string {
  if (!a) return "";
  return [a.street, a.number].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
}

export const GEO_QUALITY_LABEL: Record<GeoQuality, string> = {
  exacta: "Ubicación exacta",
  calle: "Ubicación aproximada",
  localidad: "Sólo la localidad",
  sin_geo: "Sin ubicación en el mapa",
};

/** ¿Alcanza para mandar el envío? Calle y localidad (la altura se avisa aparte). */
export function addressProblem(a: Partial<GeoAddress> | null | undefined): string | null {
  if (!a || (a.street ?? "").trim().length < 2) return "Cargá la calle de la entrega.";
  if (!(a.locality ?? "").trim()) return "Falta la localidad de la entrega.";
  return null;
}

/** Aviso que no frena el cobro: sin altura el repartidor no encuentra la casa. */
export function addressWarning(a: Partial<GeoAddress> | null | undefined): string | null {
  if (!a || addressProblem(a)) return null;
  if (!(a.number ?? "").trim()) return "Sin altura: sumala o marcá el pin en el mapa.";
  if (a.geo_quality === "sin_geo") return "Sin ubicación en el mapa: el repartidor sólo tiene el texto.";
  return null;
}

// ── Zonas por localidad ───────────────────────────────────────────────────────

export interface ZoneLike {
  id: string;
  name: string;
  fee: number;
  is_active: boolean;
  localities?: string[] | null;
  free_from?: number | null;
  eta_minutes?: number | null;
}

/** Zona activa que cubre la localidad (la primera, en el orden de la lista). */
export function zoneForLocality<Z extends ZoneLike>(zones: Z[], locality: string | null | undefined): Z | null {
  const loc = normText(locality);
  if (!loc) return null;
  return (
    zones.find((z) => z.is_active && (z.localities ?? []).some((l) => normText(l) === loc)) ?? null
  );
}

/** Costo sugerido de la zona: 0 si la venta supera "sin cargo desde". */
export function zoneFee(zone: ZoneLike | null, saleTotal: number): number {
  if (!zone) return 0;
  if (zone.free_from != null && zone.free_from > 0 && saleTotal >= zone.free_from) return 0;
  return Math.max(Number(zone.fee) || 0, 0);
}

/** "Pilar, Del Viso, Tortuguitas" → lista sin repetidas (Configuración de zonas). */
export function parseLocalities(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]+/)) {
    const t = part.replace(/\s+/g, " ").trim().slice(0, 120);
    const k = normText(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 200) break;
  }
  return out;
}

// ── Errores ───────────────────────────────────────────────────────────────────

const GEO_ERRORS: Record<string, string> = {
  rate_limited: "Muchas búsquedas seguidas. Esperá unos segundos.",
  busy: "El mapa está ocupado. Probá de nuevo en un segundo.",
  disabled: "La búsqueda de direcciones está apagada por ahora. Cargala a mano.",
  provider_error: "No pudimos buscar la dirección. Cargala a mano.",
  feature_not_in_plan: "Tu plan no incluye las direcciones con mapa.",
  forbidden: "No tenés permiso para buscar direcciones.",
};

export function geoErrorMessage(code: string | null | undefined): string {
  return GEO_ERRORS[code ?? ""] ?? "No pudimos buscar la dirección. Cargala a mano.";
}

/** Mensaje de un error del servidor de direcciones o del envío (null si no es de acá). */
export function addressServerError(msg: string): string | null {
  if (/customer_required_for_shipping/.test(msg)) return "Para enviar elegí o cargá un cliente.";
  if (/address_not_found/.test(msg)) return "Esa dirección ya no existe en el cliente. Elegí otra.";
  if (/ship_to_invalid/.test(msg)) return "Revisá la dirección: falta la calle.";
  if (/too_many_addresses/.test(msg)) return "El cliente ya tiene 20 direcciones. Borrá alguna para sumar otra.";
  if (/feature_not_in_plan: direcciones_geo/.test(msg)) return "Tu plan no incluye las direcciones con mapa.";
  if (/customer_not_found/.test(msg)) return "No encontramos el cliente.";
  return null;
}
