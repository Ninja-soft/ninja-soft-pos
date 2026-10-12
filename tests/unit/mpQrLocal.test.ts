import { describe, expect, it } from "vitest";
import {
  buildGeocodeQuery,
  mapMpQrError,
  mpCityName,
  mpStoreErrorField,
  normalizeArState,
  parseBusinessAddress,
  parseStoreAddress,
  parseStoreSetup,
  pickGeocodeResult,
  splitStreet,
} from "@/supabase/functions/_shared/mpOrders";

// "QR en el mostrador": alta del local en MP con los datos del negocio y
// coordenadas geocodificadas (Nominatim), sin pedirle nada técnico al dueño.

describe("normalizeArState", () => {
  it.each([
    ["Capital Federal", "Capital Federal"],
    ["CABA", "Capital Federal"],
    ["C.A.B.A.", "Capital Federal"],
    ["Ciudad Autónoma de Buenos Aires", "Capital Federal"],
    ["ciudad de buenos aires", "Capital Federal"],
    ["Buenos Aires", "Buenos Aires"],
    ["Provincia de Buenos Aires", "Buenos Aires"],
    ["Bs. As.", "Buenos Aires"],
    ["PBA", "Buenos Aires"],
    ["cordoba", "Córdoba"],
    ["NEUQUEN", "Neuquén"],
    ["Provincia de Tucumán", "Tucumán"],
    ["Tierra del Fuego, Antártida e Islas del Atlántico Sur", "Tierra del Fuego"],
  ])("%s → %s", (input, out) => {
    expect(normalizeArState(input)).toBe(out);
  });
  it("devuelve null si no es una provincia", () => {
    expect(normalizeArState("Narnia")).toBeNull();
    expect(normalizeArState("")).toBeNull();
  });
});

describe("splitStreet", () => {
  it.each([
    ["Av. Corrientes 1234", "Av. Corrientes", "1234"],
    ["Corrientes 1234 piso 3 dto B", "Corrientes", "1234"],
    ["Calle 50 N° 123", "Calle 50", "123"],
    ["Calle 50 nro. 123", "Calle 50", "123"],
    ["San Martín 45bis", "San Martín", "45bis"],
    ["9 de Julio 800", "9 de Julio", "800"],
    ["  Belgrano   350 ", "Belgrano", "350"],
  ])("%s", (input, street, number) => {
    expect(splitStreet(input)).toEqual({ street_name: street, street_number: number });
  });
  it("sin altura deja el número vacío", () => {
    expect(splitStreet("Ruta Provincial")).toEqual({ street_name: "Ruta Provincial", street_number: "" });
  });
});

describe("parseBusinessAddress", () => {
  it("dirección completa con localidad y provincia", () => {
    expect(parseBusinessAddress("Av. Colón 1500, Córdoba, Córdoba")).toEqual({
      street_name: "Av. Colón",
      street_number: "1500",
      city_name: "Córdoba",
      state_name: "Córdoba",
    });
  });
  it("CABA va a Capital Federal y deja la localidad para el mapa", () => {
    expect(parseBusinessAddress("Av. Corrientes 1234, CABA")).toEqual({
      street_name: "Av. Corrientes",
      street_number: "1234",
      city_name: "",
      state_name: "Capital Federal",
    });
  });
  it("ignora código postal y país", () => {
    expect(parseBusinessAddress("Mitre 220, B1642 San Isidro, Buenos Aires, Argentina")).toEqual({
      street_name: "Mitre",
      street_number: "220",
      city_name: "San Isidro",
      state_name: "Buenos Aires",
    });
  });
  it("solo calle y altura", () => {
    expect(parseBusinessAddress("Rivadavia 300")).toEqual({
      street_name: "Rivadavia",
      street_number: "300",
      city_name: "",
      state_name: "",
    });
  });
  it("vacío o nulo", () => {
    const empty = { street_name: "", street_number: "", city_name: "", state_name: "" };
    expect(parseBusinessAddress("")).toEqual(empty);
    expect(parseBusinessAddress(null)).toEqual(empty);
  });
});

describe("buildGeocodeQuery", () => {
  it("arma la búsqueda con el nombre de provincia que entiende el mapa", () => {
    expect(
      buildGeocodeQuery({
        street_name: "Av. Corrientes",
        street_number: "1234",
        city_name: "",
        state_name: "Capital Federal",
      }),
    ).toBe("Av. Corrientes 1234, Ciudad Autónoma de Buenos Aires, Argentina");
  });
  it("incluye la localidad", () => {
    expect(
      buildGeocodeQuery({
        street_name: "Mitre",
        street_number: "220",
        city_name: "San Isidro",
        state_name: "Buenos Aires",
      }),
    ).toBe("Mitre 220, San Isidro, Buenos Aires, Argentina");
  });
  it("sin calle no hay búsqueda", () => {
    expect(buildGeocodeQuery({ street_name: "", street_number: "", city_name: "X", state_name: "" })).toBe("");
  });
});

const caba = {
  lat: "-34.6037",
  lon: "-58.3816",
  class: "place",
  type: "house",
  display_name: "1234, Avenida Corrientes, San Nicolás, Buenos Aires, Comuna 1, Ciudad Autónoma de Buenos Aires, Argentina",
  address: {
    house_number: "1234",
    road: "Avenida Corrientes",
    suburb: "San Nicolás",
    city: "Buenos Aires",
    state: "Ciudad Autónoma de Buenos Aires",
    country_code: "ar",
  },
};
const roadOnly = {
  lat: "-34.60",
  lon: "-58.40",
  class: "highway",
  type: "primary",
  display_name: "Avenida Corrientes, Balvanera, Buenos Aires, Argentina",
  address: { road: "Avenida Corrientes", suburb: "Balvanera", city: "Buenos Aires", state: "Ciudad Autónoma de Buenos Aires" },
};
const cordoba = {
  lat: "-31.4135",
  lon: "-64.1811",
  class: "place",
  type: "house",
  display_name: "1500, Avenida Colón, Alberdi, Córdoba, Municipio de Córdoba, Córdoba, Argentina",
  address: {
    house_number: "1500",
    road: "Avenida Colón",
    suburb: "Alberdi",
    city: "Córdoba",
    county: "Municipio de Córdoba",
    state: "Córdoba",
  },
};

describe("pickGeocodeResult", () => {
  it("prefiere el resultado con altura exacta", () => {
    expect(pickGeocodeResult([roadOnly, caba], "Capital Federal")).toEqual({
      lat: -34.6037,
      lon: -58.3816,
      precise: true,
      label: "Avenida Corrientes 1234, San Nicolás",
      city_name: "San Nicolás",
      state_name: "Capital Federal",
    });
  });
  it("en provincias usa la ciudad, no el barrio", () => {
    const r = pickGeocodeResult([cordoba], "Córdoba");
    expect(r?.city_name).toBe("Córdoba");
    expect(r?.label).toBe("Avenida Colón 1500, Córdoba");
  });
  it("descarta resultados de otra provincia", () => {
    expect(pickGeocodeResult([cordoba], "Mendoza")).toBeNull();
  });
  it("sin altura igual sirve, marcado como aproximado", () => {
    const r = pickGeocodeResult([roadOnly]);
    expect(r?.precise).toBe(false);
    expect(r?.city_name).toBe("Balvanera");
  });
  it("descarta coordenadas fuera de Argentina o inválidas", () => {
    expect(pickGeocodeResult([{ ...caba, lat: "40.4", lon: "-3.7" }])).toBeNull();
    expect(pickGeocodeResult([{ ...caba, lat: "x" }])).toBeNull();
  });
  it("tolera respuestas que no son lista", () => {
    expect(pickGeocodeResult(null)).toBeNull();
    expect(pickGeocodeResult({ error: "x" })).toBeNull();
  });
  it("limpia prefijos de partido o municipio", () => {
    const r = pickGeocodeResult([
      {
        lat: "-34.47",
        lon: "-58.51",
        class: "place",
        type: "house",
        address: { house_number: "220", road: "Mitre", county: "Partido de San Isidro", state: "Buenos Aires" },
      },
    ]);
    expect(r?.city_name).toBe("San Isidro");
  });
});

describe("mpCityName", () => {
  it("respeta la localidad que cargó el dueño", () => {
    expect(mpCityName("Olivos", "Buenos Aires", "Vicente López")).toBe("Olivos");
  });
  it("en Capital usa el barrio del mapa si el dueño puso CABA", () => {
    expect(mpCityName("CABA", "Capital Federal", "Palermo")).toBe("Palermo");
    expect(mpCityName("", "Capital Federal", "Palermo")).toBe("Palermo");
  });
  it("sin localidad usa la del mapa", () => {
    expect(mpCityName("", "Córdoba", "Córdoba")).toBe("Córdoba");
    expect(mpCityName("", "Córdoba", "")).toBe("");
  });
});

describe("parseStoreAddress / parseStoreSetup con coordenadas numéricas", () => {
  const base = {
    name: "Kiosco",
    street_name: "Mitre",
    street_number: "220",
    city_name: "San Isidro",
    state_name: "Buenos Aires",
  };
  it("valida la dirección sin coordenadas", () => {
    expect(parseStoreAddress(base)).toEqual({ ok: true, value: { ...base, reference: "" } });
  });
  it("en Capital la localidad puede venir vacía (la completa el mapa)", () => {
    const r = parseStoreAddress({ ...base, city_name: "", state_name: "CABA" });
    expect(r.ok && r.value.state_name).toBe("Capital Federal");
  });
  it("fuera de Capital la localidad es obligatoria", () => {
    const r = parseStoreAddress({ ...base, city_name: "" });
    expect(!r.ok && r.field).toBe("city_name");
  });
  it("acepta latitude/longitude numéricos", () => {
    const r = parseStoreSetup({ ...base, latitude: -34.47, longitude: -58.51 });
    expect(r.ok && r.value.location.latitude).toBe(-34.47);
  });
});

describe("mpStoreErrorField", () => {
  it.each([
    ['{"message":"invalid city_name"}', "city_name"],
    ['{"message":"The city name Palermo Soho is not valid"}', "city_name"],
    ['{"message":"state_name is invalid"}', "state_name"],
    ['{"message":"invalid latitude"}', "address"],
    ['{"message":"street_number required"}', "address"],
    ['{"message":"internal"}', null],
  ])("%s", (detail, field) => {
    expect(mpStoreErrorField(detail)).toBe(field);
  });
});

describe("mapMpQrError", () => {
  it("dirección no encontrada → corregir dirección", () => {
    const e = mapMpQrError("geocode_not_found");
    expect(e.fix).toBe("address");
    expect(e.title).not.toMatch(/—/);
  });
  it("localidad rechazada por MP → corregir con campo", () => {
    expect(mapMpQrError("mp_store_error", "city_name")).toMatchObject({ fix: "address", field: "city_name" });
  });
  it("campos inválidos van al campo", () => {
    expect(mapMpQrError("invalid_store", "street_number")).toMatchObject({ fix: "address", field: "street_number" });
    expect(mapMpQrError("invalid_store", "name")).toMatchObject({ fix: "address", field: "name" });
  });
  it("sin plan, sin conexión y genérico", () => {
    expect(mapMpQrError("payment_method_not_allowed").fix).toBe("plan");
    expect(mapMpQrError("not_connected").fix).toBe("reconnect");
    expect(mapMpQrError("mp_error").fix).toBe("retry");
    expect(mapMpQrError("lo_que_sea").fix).toBe("retry");
  });
  it("ningún mensaje usa jerga ni raya larga", () => {
    for (const c of [
      "geocode_not_found",
      "geocode_unavailable",
      "invalid_store",
      "mp_store_error",
      "mp_pos_error",
      "mp_error",
      "not_connected",
      "payment_method_not_allowed",
      "forbidden",
    ]) {
      const e = mapMpQrError(c);
      const text = `${e.title} ${e.message}`;
      expect(text).not.toMatch(/—|sucursal|external|pos_id|caja/i);
    }
  });
});
