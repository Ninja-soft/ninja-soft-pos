// ADR-157 · F22 · H144 (L1): direcciones con Photon, Georef y Nominatim
// (lógica pura de la Edge geo), formato de la dirección, zonas por localidad,
// plan del envío con la dirección estructurada y la migración.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  cacheInput,
  cleanQuery,
  georefUrl,
  isFreshCache,
  mergeGeoref,
  nominatimReverseUrl,
  parseNominatimReverse,
  parsePhoton,
  photonUrl,
  provinceCode,
  titleCase,
  typedHouseNumber,
  validLatLng,
  type GeoAddress,
} from "@/supabase/functions/_shared/geo/core";
import {
  addressProblem,
  addressServerError,
  addressWarning,
  formatShipTo,
  parseLocalities,
  zoneFee,
  zoneForLocality,
} from "@/lib/geo/address";
import { buildPlan, envioAllocations, envioGroupKey, fulfillmentErrorMessage, planRpc } from "@/lib/stock/fulfillment";

const PHOTON = {
  type: "FeatureCollection",
  features: [
    {
      properties: {
        osm_type: "W", osm_id: 1, type: "house", housenumber: "1234", street: "San Martín", city: "Pilar",
        county: "Partido del Pilar", state: "Buenos Aires", postcode: "B1629", countrycode: "AR",
      },
      geometry: { type: "Point", coordinates: [-58.91, -34.45] },
    },
    {
      // Repetida: no se muestra dos veces.
      properties: { osm_type: "W", osm_id: 2, type: "house", housenumber: "1234", street: "San Martín", city: "Pilar", state: "Buenos Aires", countrycode: "AR" },
      geometry: { type: "Point", coordinates: [-58.9101, -34.4501] },
    },
    {
      properties: { osm_type: "W", osm_id: 3, type: "street", name: "San Martín", city: "Rosario", state: "Santa Fe", countrycode: "AR" },
      geometry: { type: "Point", coordinates: [-60.64, -32.95] },
    },
    {
      // Fuera de Argentina: afuera.
      properties: { type: "street", name: "San Martín", city: "Montevideo", countrycode: "UY" },
      geometry: { type: "Point", coordinates: [-56.1, -34.9] },
    },
    {
      properties: { type: "city", name: "Córdoba", state: "Córdoba", countrycode: "AR" },
      geometry: { type: "Point", coordinates: [-64.18, -31.41] },
    },
    {
      properties: { type: "house", name: "Ferretería Sur", street: "Belgrano", housenumber: "50", city: "Tigre", state: "Buenos Aires", countrycode: "AR", osm_key: "shop" },
      geometry: { type: "Point", coordinates: [-58.58, -34.42] },
    },
  ],
};

describe("Edge geo: Photon (autocompletar)", () => {
  it("arma la URL con Argentina y el sesgo de la sucursal", () => {
    const u = new URL(photonUrl("San Martín 1234", { lat: -34.45, lng: -58.91 }));
    expect(u.origin + u.pathname).toBe("https://photon.komoot.io/api/");
    expect(u.searchParams.get("bbox")).toBe("-73.6,-55.2,-53.6,-21.7");
    expect(u.searchParams.get("lat")).toBe("-34.4500");
    expect(u.searchParams.get("limit")).toBe("6");
  });

  it("sugerencias argentinas, sin repetidas, con localidad en gris y la altura tipeada", () => {
    const s = parsePhoton(PHOTON, typedHouseNumber("San Martín 1234"));
    expect(s.map((x) => x.title)).toEqual(["San Martín 1234", "San Martín 1234", "Córdoba", "Ferretería Sur"]);
    expect(s[0]!.detail).toBe("Pilar, Buenos Aires");
    expect(s[0]!.address).toMatchObject({
      street: "San Martín", number: "1234", locality: "Pilar", province: "Buenos Aires", province_code: "B",
      lat: -34.45, lng: -58.91, geo_source: "photon", geo_quality: "exacta",
    });
    // Rosario: la calle sin esa casa en OSM queda con la altura tipeada y calidad "calle".
    expect(s[1]!).toMatchObject({ detail: "Rosario, Santa Fe", address: { number: "1234", geo_quality: "calle", province_code: "S" } });
    // Sólo la localidad: el usuario completa la calle.
    expect(s[2]!.address).toMatchObject({ street: "", locality: "Córdoba", geo_quality: "localidad", province_code: "X" });
    // Un comercio: su nombre arriba y la dirección en gris.
    expect(s[3]!.detail).toBe("Belgrano 50, Tigre, Buenos Aires");
  });

  it("respuestas raras no rompen", () => {
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({ features: "x" })).toEqual([]);
    expect(parsePhoton({ features: [{ properties: { countrycode: "AR" } }] })).toEqual([]);
  });

  it("texto tipeado y altura", () => {
    expect(cleanQuery("  ab ")).toBeNull();
    expect(cleanQuery("  San   Martín  ")).toBe("San Martín");
    expect(cleanQuery("x".repeat(300))!.length).toBe(120);
    expect(typedHouseNumber("San Martín 1234 Pilar")).toBe("1234");
    expect(typedHouseNumber("Ruta 8 km 50")).toBe("8");
    expect(typedHouseNumber("Belgrano")).toBeNull();
  });
});

describe("Edge geo: Georef (normalizar)", () => {
  const base: GeoAddress = {
    street: "San Martín", number: "1234", locality: "Pilar", province: "Buenos Aires", province_code: "B",
    lat: -34.45, lng: -58.91, geo_source: "photon", geo_quality: "calle",
  };
  const item = (loc: string, lat: number, lon: number) => ({
    calle: { id: "0663804011710", nombre: "SAN MARTIN" },
    altura: { valor: 1234 },
    localidad_censal: { id: "06638040", nombre: loc },
    departamento: { id: "06638", nombre: "Pilar" },
    provincia: { id: "06", nombre: "Buenos Aires" },
    ubicacion: { lat, lon },
  });

  it("URL con la provincia por su id oficial y la localidad", () => {
    const u = new URL(georefUrl(base)!);
    expect(u.searchParams.get("direccion")).toBe("San Martín 1234");
    expect(u.searchParams.get("provincia")).toBe("06");
    expect(u.searchParams.get("localidad")).toBe("Pilar");
    expect(new URL(georefUrl(base, false)!).searchParams.get("localidad")).toBeNull();
    expect(new URL(georefUrl({ ...base, province_code: "C", province: "CABA" })!).searchParams.get("provincia")).toBe("02");
    expect(georefUrl({ ...base, number: null })).toBeNull();
  });

  it("toma la de la localidad elegida, con ids oficiales y coordenada exacta; conserva el nombre lindo de la calle", () => {
    const r = mergeGeoref({ direcciones: [item("Escobar", -34.41, -58.75), item("Pilar", -34.42, -58.87)] }, base)!;
    expect(r).toMatchObject({
      street: "San Martín", number: "1234", locality: "Pilar", partido: "Pilar", province_code: "B",
      lat: -34.42, lng: -58.87, geo_source: "georef", geo_quality: "exacta",
      normalized: { calle_id: "0663804011710", localidad_id: "06638040", departamento_id: "06638", provincia_id: "06" },
    });
  });

  it("descarta otra localidad lejos del punto elegido y acepta vacío", () => {
    expect(mergeGeoref({ direcciones: [item("Escobar", -34.2, -58.6)] }, base)).toBeNull();
    expect(mergeGeoref({ direcciones: [] }, base)).toBeNull();
    expect(mergeGeoref(null, base)).toBeNull();
    // Sin punto previo (carga a mano) acepta la de Georef y pone la calle en criollo.
    const manual = mergeGeoref({ direcciones: [item("Escobar", -34.41, -58.75)] }, { ...base, street: "", lat: null, lng: null, locality: null })!;
    expect(manual).toMatchObject({ street: "San Martin", locality: "Escobar", geo_quality: "exacta" });
  });

  it("provincias con su letra (ARBA, ARCA)", () => {
    expect(provinceCode("Buenos Aires")).toBe("B");
    expect(provinceCode("Ciudad Autónoma de Buenos Aires")).toBe("C");
    expect(provinceCode("Provincia de Córdoba")).toBe("X");
    expect(provinceCode("Tierra del Fuego, Antártida e Islas del Atlántico Sur")).toBe("V");
    expect(provinceCode(null, "82")).toBe("S");
    expect(provinceCode("Narnia")).toBeNull();
    expect(titleCase("AV DE LOS INCAS")).toBe("Av de los Incas");
  });
});

describe("Edge geo: Nominatim (sólo inversa) y caché", () => {
  it("pin en el mapa → dirección con las coordenadas del pin", () => {
    const u = new URL(nominatimReverseUrl(-34.4588, -58.9142));
    expect(u.pathname).toBe("/reverse");
    expect(u.searchParams.get("format")).toBe("jsonv2");
    const a = parseNominatimReverse(
      {
        address: {
          road: "San Martín", house_number: "540", town: "Pilar", state_district: "Partido del Pilar",
          state: "Buenos Aires", postcode: "1629", country_code: "ar",
        },
      },
      { lat: -34.4588, lng: -58.9142 },
    );
    expect(a).toMatchObject({
      street: "San Martín", number: "540", locality: "Pilar", partido: "Partido del Pilar", province_code: "B",
      lat: -34.4588, lng: -58.9142, geo_source: "pin", geo_quality: "exacta",
    });
    expect(parseNominatimReverse({ address: { road: "X", country_code: "uy" } }, { lat: 1, lng: 1 })).toBeNull();
    expect(parseNominatimReverse({}, { lat: 1, lng: 1 })).toBeNull();
  });

  it("clave de caché estable (sin acentos ni mayúsculas) y vencimiento", () => {
    expect(cacheInput("suggest", { q: "San MARTÍN  1234" })).toBe(cacheInput("suggest", { q: "san martin 1234" }));
    expect(cacheInput("suggest", { q: "a", near: { lat: -34.456, lng: -58.91 } })).toBe("suggest|a|-34.5,-58.9");
    expect(cacheInput("reverse", { lat: -34.4588123, lng: -58.91 })).toBe("reverse|-34.45881,-58.91000");
    expect(cacheInput("normalize", { address: { street: "Belgrano", number: "50", locality: "Tigre" } })).toBe(
      "normalize|belgrano|50|tigre|",
    );
    const now = new Date("2026-10-15T12:00:00Z");
    expect(isFreshCache("2026-06-01T00:00:00Z", now)).toBe(true);
    expect(isFreshCache("2026-01-01T00:00:00Z", now)).toBe(false);
    expect(isFreshCache("basura", now)).toBe(false);
    expect(validLatLng("0", "0")).toBeNull();
    expect(validLatLng(-91, 0)).toBeNull();
    expect(validLatLng("-34.5", "-58.4")).toEqual({ lat: -34.5, lng: -58.4 });
  });
});

describe("Dirección de la entrega y zonas", () => {
  const a = { street: "Av. San Martín", number: "1234", floor: "3", apartment: "B", locality: "Pilar", province: "Buenos Aires" };

  it("texto de la entrega igual que el servidor (_ship_to_text)", () => {
    expect(formatShipTo(a)).toBe("Av. San Martín 1234, Piso 3 Dto. B, Pilar, Buenos Aires");
    expect(formatShipTo({ street: "Belgrano", locality: "Tigre" })).toBe("Belgrano, Tigre");
    expect(formatShipTo(null)).toBe("");
  });

  it("qué falta y qué conviene avisar", () => {
    expect(addressProblem(null)).toBe("Cargá la calle de la entrega.");
    expect(addressProblem({ street: "Belgrano" })).toBe("Falta la localidad de la entrega.");
    expect(addressProblem(a)).toBeNull();
    expect(addressWarning({ street: "Belgrano", locality: "Tigre", geo_quality: "calle" })).toMatch(/Sin altura/);
    expect(addressWarning({ ...a, geo_quality: "sin_geo" })).toMatch(/Sin ubicación/);
    expect(addressWarning({ ...a, geo_quality: "exacta" })).toBeNull();
  });

  it("zona por localidad (sin acentos ni mayúsculas) y envío sin cargo desde un monto", () => {
    const zones = [
      { id: "1", name: "Apagada", fee: 1, is_active: false, localities: ["Pilar"] },
      { id: "2", name: "Norte", fee: 3500, is_active: true, localities: ["PILAR", "Del Viso"], free_from: 50000 },
    ];
    expect(zoneForLocality(zones, "pilar")?.name).toBe("Norte");
    expect(zoneForLocality(zones, "Tigre")).toBeNull();
    expect(zoneForLocality(zones, null)).toBeNull();
    expect(zoneFee(zones[1]!, 10000)).toBe(3500);
    expect(zoneFee(zones[1]!, 50000)).toBe(0);
    expect(zoneFee(null, 1)).toBe(0);
    expect(parseLocalities("Pilar, del viso;Del Viso\n  Villa   Rosa ,,")).toEqual(["Pilar", "del viso", "Villa Rosa"]);
  });

  it("el plan del envío lleva la dirección guardada o la nueva, y va por pos_sale_create_delivery", () => {
    const lines = [{ key: "p1|", productId: "p1", variantId: null, name: "Mesa", quantity: 1, localOnly: false }];
    const alloc = envioAllocations(lines, "S");
    const k = envioGroupKey("S");
    const shipTo: GeoAddress = { street: "Belgrano", number: "50", locality: "Tigre", geo_source: "georef", geo_quality: "exacta", lat: -34.4, lng: -58.5 };
    const saved = buildPlan(lines, alloc, "S", { [k]: { shipAddress: "Belgrano 50, Tigre", addressId: "dir-1", shipTo } });
    expect(saved.deliveries[0]).toMatchObject({ address_id: "dir-1", ship_to: null, save_to_customer: false });
    const fresh = buildPlan(lines, alloc, "S", { [k]: { shipAddress: "Belgrano 50, Tigre", shipTo, saveToCustomer: true } });
    expect(fresh.deliveries[0]).toMatchObject({ address_id: null, ship_to: shipTo, save_to_customer: true });
    const text = buildPlan(lines, alloc, "S", { [k]: { shipAddress: "Belgrano 50, Tigre" } });
    expect(text.deliveries[0]).not.toHaveProperty("ship_to");
    expect(planRpc(text)).toBe("pos_sale_create_delivery");
    expect(planRpc({ deliveries: [{ ...text.deliveries[0]!, mode: "retiro" }] })).toBe("pos_sale_create_fulfilled");
  });

  it("errores del servidor en criollo", () => {
    expect(fulfillmentErrorMessage(new Error("customer_required_for_shipping"))).toBe("Para enviar elegí o cargá un cliente.");
    expect(fulfillmentErrorMessage(new Error("address_not_found"))).toMatch(/ya no existe/);
    expect(addressServerError("feature_not_in_plan: direcciones_geo")).toMatch(/direcciones con mapa/);
    expect(addressServerError("otra cosa")).toBeNull();
  });
});

describe("Migración 20261226100000_logistica_l1_direcciones", () => {
  const DIR = join(process.cwd(), "supabase", "migrations");
  const sql = readFileSync(join(DIR, "20261226100000_logistica_l1_direcciones.sql"), "utf8");

  it("feature BASE en todos los planes", () => {
    expect(sql).toMatch(/\('direcciones_geo', 'Direcciones con mapa',[\s\S]*?'envios', true, 299\)/);
    expect(sql).toContain("jsonb_build_object('direcciones_geo', true)");
  });

  it("customer_addresses con tenant, RLS con initplan y escrituras sólo por RPC", () => {
    expect(sql).toMatch(/create table if not exists customer_addresses \(\s*id\s+uuid primary key default gen_random_uuid\(\),\s*tenant_id/);
    expect(sql).toContain("alter table customer_addresses enable row level security;");
    expect(sql).toContain("revoke all on customer_addresses from anon, authenticated;");
    expect(sql).toContain("for select using (tenant_id = (select current_tenant_id()));");
    expect(sql).not.toMatch(/is_internal\(\)/);
    expect(sql).toContain("deleted_at       timestamptz");
  });

  it("cliente obligatorio para enviar en el servidor, sin recrear create_sale ni pos_sale_create_fulfilled", () => {
    expect(sql).toContain("raise exception 'customer_required_for_shipping'");
    expect(sql).toMatch(/create trigger dispatches_customer_required\s+before insert or update of delivery_type on dispatches/);
    expect(sql).not.toMatch(/create or replace function (public\.)?create_sale\(/);
    expect(sql).not.toMatch(/create or replace function (public\.)?pos_sale_create_fulfilled\(/);
    expect(sql).toContain("v_res := pos_sale_create_fulfilled(p_sale, v_plan);");
    expect(sql).toMatch(/grant execute on function public\.pos_sale_create_delivery\(jsonb, jsonb\) to authenticated/);
  });

  it("caché, proveedores y cupo sólo para service_role; auditoría de las direcciones", () => {
    for (const t of ["geocode_cache", "geo_providers", "geo_usage"]) {
      expect(sql).toContain(`revoke all on ${t} from anon, authenticated;`);
    }
    for (const f of ["geo_guard(uuid, uuid)", "geo_rate_take(uuid, text, integer, integer)", "geo_provider_take(text)"]) {
      expect(sql).toContain(`grant execute on function ${f} to service_role;`);
    }
    expect(sql).toContain("('nominatim', true, 1100)");
    for (const a of ["customer_address_created", "customer_address_updated", "customer_address_deleted", "dispatch_address_set"]) {
      expect(sql).toContain(`'${a}'`);
    }
  });
});
