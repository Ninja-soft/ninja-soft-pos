// =============================================================================
// _shared/geo/core.ts (ADR-157 · F22 · H144)
//
// Lógica pura de la Edge `geo`: armar los pedidos a Photon (autocompletar),
// Georef AR (normalizar con datos oficiales) y Nominatim (sólo geocodificación
// inversa) y pasar sus respuestas a una dirección argentina estructurada.
// Sin Deno.* ni fetch: la usan la Edge, el POS (tipos y letras de provincia)
// y los tests de Vitest.
// =============================================================================

export type GeoSource = "photon" | "georef" | "nominatim" | "pin" | "manual";
export type GeoQuality = "exacta" | "calle" | "localidad" | "sin_geo";

/** Dirección estructurada (la misma forma que customer_addresses y dispatches.ship_to). */
export interface GeoAddress {
  street: string;
  number?: string | null;
  floor?: string | null;
  apartment?: string | null;
  locality?: string | null;
  partido?: string | null;
  province?: string | null;
  /** Letra de la provincia (la que usan ARBA y ARCA: B, C, X...). */
  province_code?: string | null;
  postal_code?: string | null;
  between_streets?: string | null;
  reference?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  delivery_notes?: string | null;
  label?: string | null;
  lat?: number | null;
  lng?: number | null;
  geo_source: GeoSource;
  geo_quality: GeoQuality;
  /** Ids oficiales de Georef (calle, localidad, departamento, provincia). */
  normalized?: Record<string, string> | null;
}

export interface GeoSuggestion {
  id: string;
  /** Línea principal: "Av. San Martín 1234" o el nombre del lugar. */
  title: string;
  /** Línea secundaria en gris: "Pilar, Buenos Aires". */
  detail: string;
  address: GeoAddress;
}

/** Cupos por negocio (sólo cuentan los pedidos que llegan al proveedor). */
export const GEO_LIMITS = {
  suggest: { perMinute: 60, perDay: 3000 },
  normalize: { perMinute: 30, perDay: 1000 },
  reverse: { perMinute: 10, perDay: 300 },
} as const;

/** La caché vence a los 180 días. */
export const GEO_CACHE_DAYS = 180;

/** Argentina (oeste, sur, este, norte) para filtrar Photon. */
export const AR_BBOX = [-73.6, -55.2, -53.6, -21.7] as const;

export const GEO_ATTRIBUTION = "© OpenStreetMap contributors · Georef AR (datos.gob.ar)";

export const PHOTON_URL = "https://photon.komoot.io/api/";
export const GEOREF_URL = "https://apis.datos.gob.ar/georef/api/direcciones";
export const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// ── Texto ─────────────────────────────────────────────────────────────────────

/** Minúsculas, sin acentos y con un solo espacio (para comparar y para la caché). */
export function normText(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lo que tipeó el usuario, listo para mandar (null si es muy corto o largo de más). */
export function cleanQuery(q: unknown): string | null {
  const s = String(q ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 3) return null;
  return s.slice(0, 120);
}

/** Altura que tipeó el usuario ("San Martín 1234 Pilar" → "1234"). */
export function typedHouseNumber(q: string): string | null {
  const m = q.match(/(?:^|\s)(\d{1,5})(?=\s|,|$)/);
  return m ? m[1]! : null;
}

/** "AV SAN MARTIN" → "Av San Martin" (Georef devuelve las calles en mayúsculas). */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s(-])([a-záéíóúñü])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/\b(De|Del|La|Las|Los|Y|E)\b/g, (w, _a, i: number) => (i === 0 ? w : w.toLowerCase()));
}

// ── Provincias ────────────────────────────────────────────────────────────────

/** Letra de cada provincia (ARBA, ARCA) por nombre normalizado. */
const PROVINCE_CODES: Record<string, string> = {
  "ciudad autonoma de buenos aires": "C",
  "capital federal": "C",
  caba: "C",
  "buenos aires": "B",
  catamarca: "K",
  chaco: "H",
  chubut: "U",
  cordoba: "X",
  corrientes: "W",
  "entre rios": "E",
  formosa: "P",
  jujuy: "Y",
  "la pampa": "L",
  "la rioja": "F",
  mendoza: "M",
  misiones: "N",
  neuquen: "Q",
  "rio negro": "R",
  salta: "A",
  "san juan": "J",
  "san luis": "D",
  "santa cruz": "Z",
  "santa fe": "S",
  "santiago del estero": "G",
  "tierra del fuego": "V",
  "tierra del fuego antartida e islas del atlantico sur": "V",
  tucuman: "T",
};

/** Ids de provincia de Georef (INDEC) a su letra. */
const GEOREF_PROVINCE_IDS: Record<string, string> = {
  "02": "C", "06": "B", "10": "K", "14": "X", "18": "W", "22": "H", "26": "U", "30": "E",
  "34": "P", "38": "Y", "42": "L", "46": "F", "50": "M", "54": "N", "58": "Q", "62": "R",
  "66": "A", "70": "J", "74": "D", "78": "Z", "82": "S", "86": "G", "90": "T", "94": "V",
};

export function provinceCode(name: string | null | undefined, georefId?: string | null): string | null {
  if (georefId && GEOREF_PROVINCE_IDS[georefId]) return GEOREF_PROVINCE_IDS[georefId]!;
  const n = normText(name).replace(/^provincia de /, "");
  if (!n) return null;
  return PROVINCE_CODES[n] ?? null;
}

/** "Ciudad Autónoma de Buenos Aires" se muestra como CABA. */
function provinceLabel(name: string | null | undefined): string | null {
  const n = normText(name);
  if (!n) return null;
  if (PROVINCE_CODES[n] === "C") return "CABA";
  return String(name).trim();
}

// ── Caché ─────────────────────────────────────────────────────────────────────

/** Texto canónico del pedido (la Edge lo pasa por SHA-256 para la clave). */
export function cacheInput(
  action: "suggest" | "normalize" | "reverse",
  payload: { q?: string; near?: { lat: number; lng: number } | null; address?: Partial<GeoAddress>; lat?: number; lng?: number },
): string {
  if (action === "suggest") {
    const near = payload.near ? `${payload.near.lat.toFixed(1)},${payload.near.lng.toFixed(1)}` : "";
    return `suggest|${normText(payload.q)}|${near}`;
  }
  if (action === "normalize") {
    const a = payload.address ?? {};
    return `normalize|${normText(a.street)}|${normText(a.number)}|${normText(a.locality)}|${normText(a.province)}`;
  }
  return `reverse|${Number(payload.lat).toFixed(5)},${Number(payload.lng).toFixed(5)}`;
}

export function isFreshCache(createdAt: string, now: Date, days = GEO_CACHE_DAYS): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now.getTime() - t < days * 86_400_000;
}

export function validLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null;
  return { lat: a, lng: b };
}

// ── Photon (autocompletar) ────────────────────────────────────────────────────

export function photonUrl(q: string, near?: { lat: number; lng: number } | null, limit = 6): string {
  const p = new URLSearchParams({ q, limit: String(limit), bbox: AR_BBOX.join(",") });
  if (near) {
    p.set("lat", near.lat.toFixed(4));
    p.set("lon", near.lng.toFixed(4));
  }
  return `${PHOTON_URL}?${p.toString()}`;
}

type PhotonProps = Record<string, unknown>;
const str = (v: unknown): string | null => {
  const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
  return s ? s : null;
};

/** Respuesta de Photon → hasta 5 sugerencias argentinas sin repetidas. */
export function parsePhoton(json: unknown, typed: string | null = null, max = 5): GeoSuggestion[] {
  const features = (json as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: GeoSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const props = ((f as { properties?: PhotonProps }).properties ?? {}) as PhotonProps;
    const coords = (f as { geometry?: { coordinates?: unknown[] } }).geometry?.coordinates;
    const cc = str(props.countrycode);
    if (cc && cc.toUpperCase() !== "AR") continue;
    const type = str(props.type) ?? "";
    const name = str(props.name);
    const street = str(props.street) ?? (type === "street" ? name : null);
    const locality =
      str(props.city) ?? str(props.town) ?? str(props.village) ?? str(props.locality) ?? str(props.district) ??
      (["city", "town", "village", "locality", "district"].includes(type) ? name : null);
    if (!street && !locality) continue;
    let number = str(props.housenumber);
    let quality: GeoQuality = number ? "exacta" : street ? "calle" : "localidad";
    // La altura tipeada vale aunque OSM no tenga esa casa (Georef interpola).
    if (!number && street && typed) {
      number = typed;
      quality = "calle";
    }
    const ll = Array.isArray(coords) ? validLatLng(coords[1], coords[0]) : null;
    const province = provinceLabel(str(props.state));
    const address: GeoAddress = {
      street: street ?? (name as string) ?? "",
      number,
      locality,
      partido: str(props.county),
      province,
      province_code: provinceCode(str(props.state)),
      postal_code: str(props.postcode),
      lat: ll?.lat ?? null,
      lng: ll?.lng ?? null,
      geo_source: "photon",
      geo_quality: ll ? quality : "sin_geo",
    };
    if (!street && locality) {
      // Sólo la localidad: el usuario completa calle y altura.
      address.street = "";
      address.geo_quality = ll ? "localidad" : "sin_geo";
    }
    const isPlace = Boolean(name && street && name !== street && type !== "street");
    const title = isPlace
      ? name!
      : street
        ? `${street}${number ? ` ${number}` : ""}`
        : locality!;
    const detail = [isPlace ? `${street}${number ? ` ${number}` : ""}` : null, street ? locality : null, province]
      .filter(Boolean)
      .join(", ");
    const key = normText(`${title}|${detail}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const osm = `${str(props.osm_type) ?? ""}${str(props.osm_id) ?? out.length}`;
    out.push({ id: `${osm}-${out.length}`, title, detail, address });
    if (out.length >= max) break;
  }
  return out;
}

// ── Georef (normalizar) ───────────────────────────────────────────────────────

/**
 * Pedido a Georef. Primero con la localidad elegida (`withLocality`); si no
 * encuentra nada, la Edge repite sin ella y elige por cercanía.
 */
export function georefUrl(
  a: Pick<GeoAddress, "street" | "number" | "province" | "province_code" | "locality">,
  withLocality = true,
  max = 5,
): string | null {
  if (!a.street || !a.number) return null;
  const p = new URLSearchParams({ direccion: `${a.street} ${a.number}`, max: String(max) });
  if (withLocality && a.locality && a.province_code !== "C") p.set("localidad", a.locality);
  const byCode = a.province_code
    ? Object.entries(GEOREF_PROVINCE_IDS).find(([, letter]) => letter === a.province_code)?.[0]
    : undefined;
  const prov = byCode ?? (a.province ? a.province : null);
  if (prov) p.set("provincia", prov);
  return `${GEOREF_URL}?${p.toString()}`;
}

interface GeorefItem {
  calle?: { id?: string | null; nombre?: string | null } | null;
  altura?: { valor?: number | string | null } | null;
  localidad_censal?: { id?: string | null; nombre?: string | null } | null;
  departamento?: { id?: string | null; nombre?: string | null } | null;
  provincia?: { id?: string | null; nombre?: string | null } | null;
  ubicacion?: { lat?: number | null; lon?: number | null } | null;
}

function distance2(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dx = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180);
  const dy = a.lat - b.lat;
  return dx * dx + dy * dy;
}

/**
 * Respuesta de Georef + lo que eligió el usuario → dirección normalizada. De
 * varios resultados toma el de la localidad elegida o el más cercano al punto
 * de Photon. null si Georef no la encontró (queda la de Photon).
 */
export function mergeGeoref(json: unknown, base: GeoAddress): GeoAddress | null {
  const list = (json as { direcciones?: GeorefItem[] } | null)?.direcciones;
  if (!Array.isArray(list) || list.length === 0) return null;
  const near = validLatLng(base.lat, base.lng);
  const wantLoc = normText(base.locality);
  const ranked = [...list].sort((x, y) => {
    const lx = wantLoc && normText(x.localidad_censal?.nombre) === wantLoc ? 0 : 1;
    const ly = wantLoc && normText(y.localidad_censal?.nombre) === wantLoc ? 0 : 1;
    if (lx !== ly) return lx - ly;
    if (!near) return 0;
    const px = validLatLng(x.ubicacion?.lat, x.ubicacion?.lon);
    const py = validLatLng(y.ubicacion?.lat, y.ubicacion?.lon);
    if (!px || !py) return px ? -1 : py ? 1 : 0;
    return distance2(px, near) - distance2(py, near);
  });
  const g = ranked[0]!;
  const ll = validLatLng(g.ubicacion?.lat, g.ubicacion?.lon);
  // Otra localidad a más de ~5 km del punto elegido: no es esa dirección.
  const sameLoc = Boolean(wantLoc) && normText(g.localidad_censal?.nombre) === wantLoc;
  if (near && ll && !sameLoc && distance2(ll, near) > 0.0025) return null;
  const provName = str(g.provincia?.nombre);
  const normalized: Record<string, string> = {};
  for (const [k, v] of [
    ["calle_id", g.calle?.id],
    ["localidad_id", g.localidad_censal?.id],
    ["departamento_id", g.departamento?.id],
    ["provincia_id", g.provincia?.id],
  ] as const) {
    if (v) normalized[k] = String(v);
  }
  const altura = str(g.altura?.valor);
  return {
    ...base,
    street: base.street || (g.calle?.nombre ? titleCase(g.calle.nombre) : ""),
    number: base.number || altura,
    locality: str(g.localidad_censal?.nombre) ?? base.locality ?? null,
    partido: str(g.departamento?.nombre) ?? base.partido ?? null,
    province: provinceLabel(provName) ?? base.province ?? null,
    province_code: provinceCode(provName, str(g.provincia?.id)) ?? base.province_code ?? null,
    lat: ll?.lat ?? base.lat ?? null,
    lng: ll?.lng ?? base.lng ?? null,
    geo_source: ll ? "georef" : base.geo_source,
    geo_quality: ll && altura ? "exacta" : ll ? "calle" : base.geo_quality,
    normalized: Object.keys(normalized).length > 0 ? normalized : base.normalized ?? null,
  };
}

// ── Nominatim (inversa) ───────────────────────────────────────────────────────

export function nominatimReverseUrl(lat: number, lng: number): string {
  const p = new URLSearchParams({
    format: "jsonv2",
    lat: lat.toFixed(6),
    lon: lng.toFixed(6),
    addressdetails: "1",
    zoom: "18",
    "accept-language": "es",
  });
  return `${NOMINATIM_REVERSE_URL}?${p.toString()}`;
}

/** Pin marcado en el mapa → dirección (las coordenadas son las del pin). */
export function parseNominatimReverse(json: unknown, pin: { lat: number; lng: number }): GeoAddress | null {
  const a = (json as { address?: Record<string, unknown> } | null)?.address;
  if (!a) return null;
  const cc = str(a.country_code);
  if (cc && cc.toLowerCase() !== "ar") return null;
  const street = str(a.road) ?? str(a.pedestrian) ?? str(a.footway) ?? "";
  const number = str(a.house_number);
  const locality = str(a.city) ?? str(a.town) ?? str(a.village) ?? str(a.suburb) ?? str(a.municipality) ?? null;
  const state = str(a.state);
  return {
    street,
    number,
    locality,
    partido: str(a.county) ?? str(a.state_district),
    province: provinceLabel(state),
    province_code: provinceCode(state),
    postal_code: str(a.postcode),
    lat: pin.lat,
    lng: pin.lng,
    geo_source: "pin",
    geo_quality: "exacta",
  };
}
