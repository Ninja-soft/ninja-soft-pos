// @vitest-environment node
// Adaptador de Andreani (ADR-103) con fixtures de respuestas REALES del QA
// público (tests/fixtures/shipping/andreani.ts). Nunca llama a Andreani.
import { beforeEach, describe, expect, it } from "vitest";
import {
  andreaniAdapter,
  buildOrderBody,
  clearAndreaniTokens,
  jwtExpMs,
  mapAndreaniStatus,
  parseOrderResponse,
  parseSucursales,
  parseTrazas,
  quoteQuery,
} from "@/supabase/functions/_shared/shipping/andreani";
import type { CarrierContext, CreateShipmentRequest } from "@/supabase/functions/_shared/shipping/types";
import * as F from "../fixtures/shipping/andreani";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return routes({ url, init });
  };
  return { fn, calls };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const loginOk = () => new Response("{}", { status: 200, headers: { "x-authorization-token": F.LOGIN_TOKEN } });

const NOW = new Date("2026-10-13T12:00:00Z");

function ctx(fetchFn: CarrierContext["fetch"], over: Partial<CarrierContext> = {}): CarrierContext {
  return {
    sandbox: true,
    config: { client_number: "CL0003750", contract_door: "400006709", contract_branch: "400006711", origin_branch: "BAR" },
    secrets: { username: "usuario_test", password: "secreto" },
    fetch: fetchFn,
    now: () => NOW,
    ...over,
  };
}

const REQ: CreateShipmentRequest = {
  reference: "8f2a1c3e-0000-4000-8000-000000000001",
  service_type: "door",
  origin: { street: "Thames", number: "100", city: "CABA", province: "CABA", postal_code: "1414" },
  sender: { name: "Ninja Test", document: "20-11111111-2", email: "a@b.com", phone: "1144445555" },
  recipient: { name: "Cliente Prueba", document: "30111222", phone: "1155556666" },
  destination: { street: "Av Alberdi", number: "3000", city: "CABA", province: "CABA", postal_code: "1406" },
  packages: [{ weight_kg: 1.2, length_cm: 30, width_cm: 20, height_cm: 10 }],
  declared_value: 12100,
};

beforeEach(() => clearAndreaniTokens());

describe("Andreani · payloads", () => {
  it("arma el alta a domicilio como la orden aceptada en QA (202)", () => {
    const b = buildOrderBody({ client_number: "CL", contract_door: "400006709", contract_branch: "400006711" }, REQ) as Record<string, unknown>;
    expect(b.contrato).toBe("400006709");
    expect((b.destino as { postal: { codigoPostal: string } }).postal.codigoPostal).toBe("1406");
    const bultos = b.bultos as Record<string, unknown>[];
    expect(bultos[0]).toMatchObject({ kilos: 1.2, largoCm: 30, anchoCm: 20, altoCm: 10, volumenCm: 6000, valorDeclaradoConImpuestos: 12100 });
    expect(bultos[0]!.referencias).toEqual([{ meta: "idCliente", contenido: REQ.reference }]);
    expect(b.remitente).toMatchObject({ nombreCompleto: "Ninja Test", documentoTipo: "CUIT", documentoNumero: "20111111112" });
    expect((b.destinatario as Record<string, unknown>[])[0]).toMatchObject({ documentoTipo: "DNI", documentoNumero: "30111222" });
  });

  it("a sucursal usa el contrato de sucursal y destino.sucursal.id", () => {
    const b = buildOrderBody(
      { client_number: "CL", contract_door: "1", contract_branch: "400006711" },
      { ...REQ, service_type: "branch", pickup_point_id: "15" },
    ) as Record<string, unknown>;
    expect(b.contrato).toBe("400006711");
    expect(b.destino).toEqual({ sucursal: { id: "15" } });
  });

  it("sin contrato del servicio pide completar la conexión", () => {
    expect(() => buildOrderBody({ client_number: "CL", contract_door: "1" }, { ...REQ, service_type: "branch", pickup_point_id: "15" })).toThrow(
      /contrato de envío a sucursal/,
    );
  });

  it("lee la respuesta real del alta: agrupador, número de envío y estado", () => {
    expect(parseOrderResponse(F.ORDER_CREATED)).toEqual({
      external_id: "API0000000964698",
      tracking_number: "360000108921289",
      carrier_status: "Pendiente",
      package_tracking: ["360000108921289"],
    });
  });

  it("arma la consulta de tarifa con bultos en notación de corchetes", () => {
    const q = new URLSearchParams(
      quoteQuery({ client_number: "CL0003750", origin_branch: "BAR" }, "400006709", {
        destination: { postal_code: "1406" },
        packages: [{ weight_kg: 1.3, length_cm: 10, width_cm: 10, height_cm: 2 }],
        declared_value: 1200,
      }),
    );
    expect(q.get("cpDestino")).toBe("1406");
    expect(q.get("contrato")).toBe("400006709");
    expect(q.get("cliente")).toBe("CL0003750");
    expect(q.get("sucursalOrigen")).toBe("BAR");
    expect(q.get("bultos[0][volumen]")).toBe("200");
    expect(q.get("bultos[0][kilos]")).toBe("1.3");
    expect(q.get("bultos[0][valorDeclarado]")).toBe("1200");
  });

  it("trazas reales: fecha sin zona en hora de Argentina y estado normalizado", () => {
    const ev = parseTrazas(F.TRAZAS);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      status: "picked_up",
      carrier_status: "Ingreso al circuito operativo",
      description: "ENVIO INGRESADO AL SISTEMA",
      location: "Barracas",
      occurred_at: "2026-07-24T19:28:37.000Z",
    });
  });

  it("sucursales reales: deja afuera las que no entregan y usa el número como id", () => {
    const p = parseSucursales(F.SUCURSALES);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: "15", name: "FLORES (AV JUAN B ALBERDI)", postal_code: "1406", kind: "branch" });
    expect(p[0]!.lat).toBeCloseTo(-34.63434);
  });

  it("vencimiento del token desde el JWT", () => {
    expect(jwtExpMs(F.LOGIN_TOKEN, 0)).toBe(1791976590 * 1000);
    expect(jwtExpMs("opaco", 1000)).toBe(1000 + 12 * 3600_000);
  });
});

describe("Andreani · estados", () => {
  it.each([
    ["Ingreso al circuito operativo", 5, "picked_up"],
    ["Entregado", 18, "delivered"],
    ["Pendiente", null, "created"],
    ["Solicitada", null, "created"],
    ["En distribución", null, "out_for_delivery"],
    ["No entregado - Visita", null, "failed_attempt"],
    ["Visita sin éxito", null, "failed_attempt"],
    ["Disponible para retiro en sucursal", null, "ready_for_pickup"],
    ["Devuelto al remitente", null, "returned"],
    ["Anulado", null, "cancelled"],
    ["En viaje", null, "in_transit"],
    ["Algo nuevo que no conocemos", null, null],
  ])("%s → %s", (estado, id, want) => {
    expect(mapAndreaniStatus(estado, id)).toBe(want);
  });
});

describe("Andreani · adaptador con fetch falso", () => {
  it("login una vez y reutiliza el token", async () => {
    const f = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes(F.TRAZAS)));
    const c = ctx(f.fn);
    const ref = { reference: "r", external_id: "API1", tracking_number: "360000206923779", service_type: "door" as const, created_at: "" };
    await andreaniAdapter.track(c, ref);
    await andreaniAdapter.track(c, ref);
    expect(f.calls.filter((x) => x.url.endsWith("/login"))).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://apisqa.andreani.com/login");
    expect((f.calls[0]!.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect((f.calls[1]!.init?.headers as Record<string, string>)["x-authorization-token"]).toBe(F.LOGIN_TOKEN);
    expect(f.calls[1]!.url).toBe("https://apisqa.andreani.com/v2/envios/360000206923779/trazas");
  });

  it("producción usa apis.andreani.com", async () => {
    const f = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes([])));
    await andreaniAdapter.listPoints(ctx(f.fn, { sandbox: false }), { postal_code: "1406" });
    expect(f.calls[0]!.url).toBe("https://apis.andreani.com/v2/sucursales?codigoPostal=1406");
  });

  it("credenciales inválidas: error claro, sin reintento", async () => {
    const f = fakeFetch(() => new Response('{"message":"Unauthorized"}', { status: 401 }));
    await expect(andreaniAdapter.testConnection(ctx(f.fn))).rejects.toMatchObject({ code: "invalid_credentials", retryable: false });
  });

  it("testConnection exige número de cliente y algún contrato", async () => {
    const f = fakeFetch(() => loginOk());
    await expect(andreaniAdapter.testConnection(ctx(f.fn, { config: {} }))).rejects.toMatchObject({ code: "missing_config" });
    await expect(andreaniAdapter.testConnection(ctx(f.fn, { config: { client_number: "CL" } }))).rejects.toMatchObject({ code: "missing_config" });
    await expect(andreaniAdapter.testConnection(ctx(f.fn))).resolves.toMatchObject({ ok: true });
  });

  it("alta OK (202) devuelve agrupador y número de envío", async () => {
    const f = fakeFetch(({ url, init }) => {
      if (url.endsWith("/login")) return loginOk();
      expect(url).toBe("https://apisqa.andreani.com/v2/ordenes-de-envio");
      expect(init?.method).toBe("POST");
      return jsonRes(F.ORDER_CREATED, 202);
    });
    const r = await andreaniAdapter.create(ctx(f.fn), REQ);
    expect(r).toMatchObject({ external_id: "API0000000964698", tracking_number: "360000108921289", status: "created" });
  });

  it("alta rechazada (400 real): validación, no se reintenta ni queda en duda", async () => {
    const f = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes(F.ORDER_INVALID, 400)));
    await expect(andreaniAdapter.create(ctx(f.fn), REQ)).rejects.toMatchObject({
      code: "validation",
      retryable: false,
      uncertain: false,
      message: "Debe enviar bultos o articulos, pero no ambos.",
    });
  });

  it("alta con 5xx o sin respuesta: queda EN DUDA (no se reintenta solo)", async () => {
    const f5 = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : new Response("boom", { status: 502 })));
    await expect(andreaniAdapter.create(ctx(f5.fn), REQ)).rejects.toMatchObject({ uncertain: true, retryable: false });
    clearAndreaniTokens();
    const fNet = fakeFetch(({ url }) => {
      if (url.endsWith("/login")) return loginOk();
      throw new TypeError("network down");
    });
    await expect(andreaniAdapter.create(ctx(fNet.fn), REQ)).rejects.toMatchObject({ uncertain: true });
  });

  it("lectura con 5xx se puede reintentar", async () => {
    const f = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : new Response("x", { status: 503 })));
    await expect(
      andreaniAdapter.track(ctx(f.fn), { reference: "r", external_id: "A", tracking_number: "1", service_type: "door", created_at: "" }),
    ).rejects.toMatchObject({ retryable: true, uncertain: false });
  });

  it("401 en una llamada renueva el token una vez", async () => {
    let first = true;
    const f = fakeFetch(({ url }) => {
      if (url.endsWith("/login")) return loginOk();
      if (first) {
        first = false;
        return new Response('{"message":"Unauthorized"}', { status: 401 });
      }
      return jsonRes(F.TRAZAS);
    });
    const ev = await andreaniAdapter.track(ctx(f.fn), { reference: "r", external_id: "A", tracking_number: "1", service_type: "door", created_at: "" });
    expect(ev).toHaveLength(1);
    expect(f.calls.filter((x) => x.url.endsWith("/login"))).toHaveLength(2);
  });

  it("seguimiento de un envío recién creado (404 real) devuelve sin eventos", async () => {
    const f = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes(F.ENVIO_NOT_FOUND, 404)));
    await expect(
      andreaniAdapter.track(ctx(f.fn), { reference: "r", external_id: "A", tracking_number: "1", service_type: "door", created_at: "" }),
    ).resolves.toEqual([]);
  });

  it("etiqueta: PDF por agrupador; si no es PDF todavía, se reintenta", async () => {
    const pdf = new Response(new TextEncoder().encode(`${F.LABEL_PDF_HEAD}...`), { status: 200, headers: { "content-type": "application/pdf" } });
    const f = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : pdf));
    const ref = { reference: "r", external_id: "API0000000964698", tracking_number: "1", service_type: "door" as const, created_at: "" };
    const file = await andreaniAdapter.label(ctx(f.fn), ref);
    expect(file).toMatchObject({ format: "pdf", mime: "application/pdf", size: "10x15" });
    expect(f.calls[1]!.url).toBe("https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000964698/etiquetas");
    const g = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes({ nada: true })));
    await expect(andreaniAdapter.label(ctx(g.fn), ref)).rejects.toMatchObject({ code: "not_ready", retryable: true });
  });

  it("cotización: contrato de prueba rechazado (respuesta real) y forma de una tarifa OK", async () => {
    const bad = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes(F.QUOTE_REJECTED, 400)));
    const req = {
      origin: { postal_code: "1414" },
      destination: { postal_code: "1406" },
      packages: [{ weight_kg: 1, length_cm: 10, width_cm: 10, height_cm: 10 }],
      declared_value: 1000,
    };
    await expect(andreaniAdapter.quote(ctx(bad.fn), req)).rejects.toMatchObject({ code: "validation", message: "No se pudo obtener la tarifa" });
    clearAndreaniTokens();
    const ok = fakeFetch(({ url }) => (url.endsWith("/login") ? loginOk() : jsonRes(F.QUOTE_OK)));
    const q = await andreaniAdapter.quote(ctx(ok.fn), req);
    expect(q.map((x) => x.service_type)).toEqual(["door", "branch"]);
    expect(q[0]).toMatchObject({ provider_key: "andreani", cost: 5590.2, cost_without_tax: 4620, service_code: "400006709", billable_weight_kg: 1.5 });
  });

  it("no cancela por API", async () => {
    await expect(
      andreaniAdapter.cancel(ctx(fakeFetch(() => loginOk()).fn), { reference: "r", external_id: "A", tracking_number: "1", service_type: "door", created_at: "" }),
    ).rejects.toMatchObject({ code: "not_supported" });
    expect(andreaniAdapter.capabilities.cancel).toBe(false);
  });
});
