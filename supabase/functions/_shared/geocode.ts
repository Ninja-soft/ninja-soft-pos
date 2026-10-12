// =============================================================================
// Geocodificación de direcciones argentinas con OpenStreetMap Nominatim.
// Uso: alta del local en Mercado Pago ("QR en el mostrador", ADR-032), para no
// pedirle al dueño que pegue coordenadas.
//
// Política de uso de Nominatim: User-Agent identificable y como mucho 1
// pedido por segundo. El throttle es por instancia de la Edge; además el
// resultado se cachea en la config del medio (mp_qr_geo), así que en la
// práctica se consulta una vez por dirección.
// =============================================================================
import { type GeoPick, pickGeocodeResult } from "./mpOrders.ts";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "NinjaPOS/1.0 (soporte@soft.ninja)";
const MIN_INTERVAL_MS = 1100;

let lastCallAt = 0;

async function courtesyWait() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export type GeocodeOutcome =
  | { ok: true; place: GeoPick | null }
  | { ok: false; error: "geocode_unavailable" };

/** Busca `query` en Argentina. place=null si no hubo un resultado usable. */
export async function geocodeAr(query: string, expectedState?: string): Promise<GeocodeOutcome> {
  if (!query) return { ok: true, place: null };
  await courtesyWait();
  const url =
    `${NOMINATIM}?format=json&addressdetails=1&limit=5&countrycodes=ar&accept-language=es` +
    `&q=${encodeURIComponent(query)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, error: "geocode_unavailable" };
    return { ok: true, place: pickGeocodeResult(await r.json(), expectedState) };
  } catch {
    return { ok: false, error: "geocode_unavailable" };
  }
}
