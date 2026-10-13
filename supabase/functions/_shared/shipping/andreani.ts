// =============================================================================
// _shared/shipping/andreani.ts  (ADR-103)
//
// Adaptador REAL de Andreani (API REST v1/v2 de apis.andreani.com).
//
// Fuentes y verificación (2026-10-13, ver docs/37-envios.md):
//   • Portal oficial developers-sandbox.andreani.com: documenta en OpenAPI el
//     alta de orden (POST /beta/transporte-distribucion/ordenes-de-envio, mismo
//     cuerpo y respuesta que /v2/ordenes-de-envio) con servidor sandbox
//     apissandbox.andreani.com. Del resto de los recursos no hay OpenAPI
//     público; las rutas salen del cliente comunitario node-andreani-api
//     (lpetrora, MIT) y se VERIFICARON contra el QA público
//     (apisqa.andreani.com) con las credenciales de prueba publicadas:
//       - GET  /login (Basic) → header x-authorization-token      VERIFICADO
//       - GET  /v2/sucursales?codigoPostal=                       VERIFICADO (público)
//       - POST /v2/ordenes-de-envio (202, domicilio y sucursal)   VERIFICADO
//       - GET  /v2/ordenes-de-envio/{agrupador}                   VERIFICADO
//       - GET  /v2/ordenes-de-envio/{agrupador}/etiquetas (PDF)   VERIFICADO
//       - GET  /v2/envios/{numero}/trazas                         VERIFICADO
//       - GET  /v1/tarifas                                        PARCIAL: responde,
//         pero el contrato de prueba devuelve "No se pudo obtener la tarifa";
//         la forma de la respuesta sale del cliente comunitario (A CONFIRMAR
//         con un contrato real).
//   • Sin endpoint de cancelación por API (DELETE responde 403 del gateway):
//     capability cancel = false. Etiqueta sólo PDF (ZPL no documentado).
//     Webhooks no documentados: seguimiento por polling.
//   • Mapeo de estados: "Ingreso al circuito operativo" (5) y "Entregado" (18)
//     verificados en QA; el resto por texto, A CONFIRMAR con envíos reales.
//
// Credenciales (por negocio o sucursal): usuario y contraseña de la API
// (secrets), número de cliente y un contrato por servicio (domicilio,
// sucursal) en config. PURO salvo el caché de token en memoria del isolate.
// =============================================================================
import { argentinaIso } from "./status.ts";
import { errorFromResponse, httpCall, toBase64 } from "./http.ts";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierContext,
  type CreateShipmentRequest,
  type PickupPoint,
  type Quote,
  type ShipmentStatus,
  type TrackingEvent,
} from "./types.ts";

export const ANDREANI_HOSTS = {
  sandbox: "https://apisqa.andreani.com",
  production: "https://apis.andreani.com",
} as const;

export function andreaniBase(ctx: Pick<CarrierContext, "sandbox">): string {
  return ctx.sandbox ? ANDREANI_HOSTS.sandbox : ANDREANI_HOSTS.production;
}

export interface AndreaniConfig {
  client_number: string;
  contract_door?: string;
  contract_branch?: string;
  /** Sucursal de origen para cotizar (código, p. ej. "BAR"). */
  origin_branch?: string;
}

export function andreaniConfig(ctx: CarrierContext): AndreaniConfig {
  const c = ctx.config;
  const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
  return {
    client_number: s("client_number"),
    contract_door: s("contract_door") || undefined,
    contract_branch: s("contract_branch") || undefined,
    origin_branch: s("origin_branch") || undefined,
  };
}

function contractFor(cfg: AndreaniConfig, type: "door" | "branch"): string {
  const c = type === "branch" ? cfg.contract_branch : cfg.contract_door;
  if (!c) {
    throw new CarrierError(
      "missing_config",
      type === "branch" ? "Falta el número de contrato de envío a sucursal de Andreani." : "Falta el número de contrato de envío a domicilio de Andreani.",
    );
  }
  return c;
}

// ---------------------------------------------------------------------------
// Token (x-authorization-token, ~24 h): caché por host y usuario en el isolate.
// ---------------------------------------------------------------------------
const tokenCache = new Map<string, { token: string; exp: number }>();

export function clearAndreaniTokens(): void {
  tokenCache.clear();
}

/** exp (ms) del JWT; si no se puede leer, 12 h desde ahora. */
export function jwtExpMs(token: string, nowMs: number): number {
  try {
    const part = token.split(".")[1] ?? "";
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {
    /* token opaco */
  }
  return nowMs + 12 * 3600_000;
}

async function login(ctx: CarrierContext, force = false): Promise<string> {
  const user = (ctx.secrets.username ?? "").trim();
  const pass = ctx.secrets.password ?? "";
  if (!user || !pass) throw new CarrierError("missing_config", "Faltan el usuario y la contraseña de la API de Andreani.");
  const base = andreaniBase(ctx);
  const key = `${base}|${user}`;
  const now = ctx.now().getTime();
  const hit = tokenCache.get(key);
  if (!force && hit && hit.exp - 5 * 60_000 > now) return hit.token;
  const res = await httpCall(ctx.fetch, {
    method: "GET",
    url: `${base}/login`,
    headers: { Authorization: `Basic ${toBase64(`${user}:${pass}`)}` },
  });
  if (res.status === 401 || res.status === 403 || res.status === 422) {
    throw new CarrierError("invalid_credentials", "Andreani rechazó el usuario o la contraseña.", { httpStatus: res.status });
  }
  if (!res.ok) throw await errorFromResponse(res, "GET", "Login de Andreani");
  const token = res.headers.get("x-authorization-token");
  if (!token) throw new CarrierError("invalid_credentials", "Andreani no devolvió el token de acceso.");
  tokenCache.set(key, { token, exp: jwtExpMs(token, now) });
  return token;
}

/** GET/POST autenticado; ante un 401 renueva el token una vez. */
async function authed(
  ctx: CarrierContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  what = "Andreani",
): Promise<Response> {
  const base = andreaniBase(ctx);
  for (let i = 0; i < 2; i++) {
    const token = await login(ctx, i > 0);
    const res = await httpCall(ctx.fetch, {
      method,
      url: `${base}${path}`,
      headers: {
        "x-authorization-token": token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // El alta y la etiqueta tardan en QA (la etiqueta recién creada superó
      // 15 s en la prueba del 2026-10-13).
      timeoutMs: method === "POST" || path.includes("/etiquetas") ? 30_000 : 15_000,
    });
    if (res.status === 401 && i === 0) continue;
    if (!res.ok && res.status !== 204) throw await errorFromResponse(res, method, what);
    return res;
  }
  throw new CarrierError("invalid_credentials", "Andreani rechazó el token de acceso.");
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------
const ESTADO_ID: Record<number, ShipmentStatus> = {
  // Verificados en QA (2026-10-13).
  5: "picked_up",
  18: "delivered",
};

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Estado de Andreani (texto y, si viene, EstadoId) → estado normalizado. */
export function mapAndreaniStatus(estado: string, estadoId?: string | number | null): ShipmentStatus | null {
  const id = estadoId === null || estadoId === undefined || estadoId === "" ? NaN : Number(estadoId);
  if (Number.isFinite(id) && ESTADO_ID[id]) return ESTADO_ID[id]!;
  const s = norm(estado ?? "");
  if (!s) return null;
  if (/anulad|cancelad/.test(s)) return "cancelled";
  if (/no entregad|visita|ausente|domicilio cerrado|sin exito|rechazad/.test(s)) return "failed_attempt";
  if (/devuelto|entregado al remitente|devolucion entregada|rendido al cliente/.test(s)) return "returned";
  if (/entregad/.test(s)) return "delivered";
  if (/disponible para retir|en espera en sucursal|listo para retir|para retirar/.test(s)) return "ready_for_pickup";
  if (/en distribucion|salida a distribucion|en camino al domicilio|en reparto/.test(s)) return "out_for_delivery";
  if (/ingreso al circuito|retirad|colectad|admitid/.test(s)) return "picked_up";
  if (/pendiente|solicitad|alta|generad|creada/.test(s)) return "created";
  if (/transito|en viaje|despachad|arribo|ingresado en sucursal|en sucursal|devolucion|en proceso/.test(s)) return "in_transit";
  return null;
}

// ---------------------------------------------------------------------------
// Payloads (exportados para los tests con fixtures)
// ---------------------------------------------------------------------------
export function quoteQuery(cfg: AndreaniConfig, contract: string, req: {
  destination: { postal_code: string };
  packages: { weight_kg: number; length_cm: number; width_cm: number; height_cm: number }[];
  declared_value: number;
}): string {
  const p = new URLSearchParams();
  p.set("cpDestino", req.destination.postal_code.replace(/\D/g, "").slice(0, 4));
  p.set("contrato", contract);
  p.set("cliente", cfg.client_number);
  if (cfg.origin_branch) p.set("sucursalOrigen", cfg.origin_branch);
  const n = req.packages.length || 1;
  req.packages.forEach((b, i) => {
    p.set(`bultos[${i}][valorDeclarado]`, String(Math.round((req.declared_value / n) * 100) / 100));
    p.set(`bultos[${i}][volumen]`, String(Math.round(b.length_cm * b.width_cm * b.height_cm)));
    p.set(`bultos[${i}][kilos]`, String(b.weight_kg));
  });
  return p.toString();
}

function money(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}

export function parseQuote(body: unknown, type: "door" | "branch", contract: string): Quote {
  const b = (body ?? {}) as Record<string, unknown>;
  const conIva = (b.tarifaConIva ?? {}) as Record<string, unknown>;
  const sinIva = (b.tarifaSinIva ?? {}) as Record<string, unknown>;
  const cost = money(conIva.total);
  if (cost === undefined) throw new CarrierError("validation", "Andreani no devolvió una tarifa.");
  return {
    provider_key: "andreani",
    service_type: type,
    service_code: contract,
    service_name: type === "branch" ? "Andreani a sucursal" : "Andreani a domicilio",
    cost,
    cost_without_tax: money(sinIva.total),
    currency: "ARS",
    billable_weight_kg: money(b.pesoAforado),
  };
}

export function buildOrderBody(cfg: AndreaniConfig, req: CreateShipmentRequest): Record<string, unknown> {
  const contrato = contractFor(cfg, req.service_type);
  const postal = (a: CreateShipmentRequest["origin"]) => ({
    codigoPostal: a.postal_code,
    calle: a.street ?? "",
    numero: a.number ?? "",
    ...(a.floor ? { piso: a.floor } : {}),
    ...(a.apartment ? { departamento: a.apartment } : {}),
    localidad: a.city ?? "",
    region: a.province ?? "",
    pais: "Argentina",
    ...(a.reference ? { componentesDeDireccion: [{ meta: "observaciones", contenido: a.reference.slice(0, 100) }] } : {}),
  });
  const phones = (p?: string) => (p ? [{ tipo: 1, numero: p }] : []);
  const doc = (d?: string) => {
    const digits = (d ?? "").replace(/\D/g, "");
    if (!digits) return {};
    return { documentoTipo: digits.length === 11 ? "CUIT" : "DNI", documentoNumero: digits };
  };
  const n = req.packages.length || 1;
  const perPackage = Math.round((req.declared_value / n) * 100) / 100;
  if (req.service_type === "branch" && !req.pickup_point_id) {
    throw new CarrierError("validation", "Elegí la sucursal de Andreani donde retira el destinatario.");
  }
  return {
    contrato,
    origen: { postal: postal(req.origin) },
    destino: req.service_type === "branch" ? { sucursal: { id: req.pickup_point_id } } : { postal: postal(req.destination) },
    remitente: {
      nombreCompleto: req.sender.name,
      ...(req.sender.email ? { email: req.sender.email } : {}),
      ...doc(req.sender.document),
      telefonos: phones(req.sender.phone),
    },
    destinatario: [
      {
        nombreCompleto: req.recipient.name,
        ...(req.recipient.email ? { email: req.recipient.email } : {}),
        ...doc(req.recipient.document),
        telefonos: phones(req.recipient.phone),
      },
    ],
    productoAEntregar: (req.description ?? "Mercadería").slice(0, 100),
    bultos: req.packages.map((b) => ({
      kilos: b.weight_kg,
      largoCm: b.length_cm,
      altoCm: b.height_cm,
      anchoCm: b.width_cm,
      volumenCm: Math.round(b.length_cm * b.width_cm * b.height_cm),
      // El valor declarado se informa con impuestos; el neto se estima con
      // IVA 21 % (A CONFIRMAR con Andreani si el contrato lo exige exacto).
      valorDeclaradoConImpuestos: perPackage,
      valorDeclaradoSinImpuestos: Math.round((perPackage / 1.21) * 100) / 100,
      ...(b.description ? { descripcion: b.description.slice(0, 100) } : {}),
      referencias: [{ meta: "idCliente", contenido: req.reference }],
    })),
  };
}

export function parseOrderResponse(body: unknown): { external_id: string; tracking_number: string; carrier_status: string; package_tracking: string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const bultos = Array.isArray(b.bultos) ? (b.bultos as Record<string, unknown>[]) : [];
  const numbers = bultos.map((x) => String(x.numeroDeEnvio ?? "")).filter(Boolean);
  const agrupador = String(b.agrupadorDeBultos ?? "");
  if (!agrupador && numbers.length === 0) {
    throw new CarrierError("validation", "Andreani no devolvió el número de la orden.");
  }
  return {
    external_id: agrupador || numbers[0]!,
    tracking_number: numbers[0] ?? agrupador,
    carrier_status: String(b.estado ?? "Pendiente"),
    package_tracking: numbers,
  };
}

export function parseTrazas(body: unknown): TrackingEvent[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const eventos = Array.isArray(b.eventos) ? (b.eventos as Record<string, unknown>[]) : [];
  const out: TrackingEvent[] = [];
  for (const e of eventos) {
    const estado = String(e.Estado ?? e.estado ?? "");
    const fecha = argentinaIso(String(e.Fecha ?? e.fecha ?? ""));
    if (!fecha) continue;
    const id = e.EstadoId ?? e.estadoId ?? null;
    const motivo = [e.Motivo, e.Submotivo].filter((x) => typeof x === "string" && x).join(" · ");
    out.push({
      status: mapAndreaniStatus(estado, id as number | string | null),
      carrier_status: estado.slice(0, 200),
      description: (String(e.Traduccion ?? "") || motivo || estado).slice(0, 500),
      location: typeof e.Sucursal === "string" ? e.Sucursal : undefined,
      occurred_at: fecha,
      external_event_id: `${id ?? ""}|${String(e.Evento ?? "")}|${String(e.Fecha ?? "")}`,
    });
  }
  return out;
}

export function parseSucursales(body: unknown): PickupPoint[] {
  const list = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  const out: PickupPoint[] = [];
  for (const s of list) {
    const extra = (s.datosAdicionales ?? {}) as Record<string, unknown>;
    if (extra.entregaEnvios === false) continue;
    const desc = String(s.descripcion ?? "");
    if (/no usar/i.test(desc)) continue;
    const dir = (s.direccion ?? {}) as Record<string, unknown>;
    const coords = (s.coordenadas ?? {}) as Record<string, unknown>;
    const lat = Number(coords.latitud);
    const lng = Number(coords.longitud);
    out.push({
      // El alta de orden a sucursal usa el número de sucursal (verificado: "15").
      id: String(s.numero ?? s.id ?? ""),
      name: desc || String(s.codigo ?? ""),
      address: [dir.calle, dir.numero].filter(Boolean).join(" ").trim(),
      city: typeof dir.localidad === "string" ? dir.localidad : undefined,
      province: typeof dir.provincia === "string" ? dir.provincia : undefined,
      postal_code: typeof dir.codigoPostal === "string" ? dir.codigoPostal : undefined,
      hours: typeof s.horarioDeAtencion === "string" ? s.horarioDeAtencion : undefined,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
      kind: "branch",
    });
  }
  return out.filter((p) => p.id);
}

// ---------------------------------------------------------------------------
// Adaptador
// ---------------------------------------------------------------------------
export const andreaniAdapter: CarrierAdapter = {
  key: "andreani",
  name: "Andreani",
  capabilities: { quote: true, label: true, points: true, track: true, cancel: false, webhooks: false, pickup: false },
  labelFormats: ["pdf"],

  mapStatus(carrierStatus, code) {
    return mapAndreaniStatus(carrierStatus, code ?? null);
  },

  async testConnection(ctx) {
    const cfg = andreaniConfig(ctx);
    if (!cfg.client_number) throw new CarrierError("missing_config", "Falta el número de cliente de Andreani.");
    if (!cfg.contract_door && !cfg.contract_branch) {
      throw new CarrierError("missing_config", "Cargá al menos un contrato (a domicilio o a sucursal).");
    }
    await login(ctx, true);
    return { ok: true, detail: `Usuario válido en ${ctx.sandbox ? "prueba (QA)" : "producción"}.` };
  },

  async quote(ctx, req) {
    const cfg = andreaniConfig(ctx);
    if (!cfg.client_number) throw new CarrierError("missing_config", "Falta el número de cliente de Andreani.");
    const types: ("door" | "branch")[] = req.service_type
      ? [req.service_type]
      : (["door", "branch"] as const).filter((t) => (t === "door" ? cfg.contract_door : cfg.contract_branch));
    if (types.length === 0) throw new CarrierError("missing_config", "No hay contratos cargados para cotizar.");
    const out: Quote[] = [];
    for (const t of types) {
      const contract = contractFor(cfg, t);
      const res = await authed(ctx, "GET", `/v1/tarifas?${quoteQuery(cfg, contract, req)}`, undefined, "Tarifa de Andreani");
      out.push(parseQuote(await res.json(), t, contract));
    }
    return out;
  },

  async listPoints(ctx, q) {
    const cp = q.postal_code.replace(/\D/g, "").slice(0, 4);
    const res = await httpCall(ctx.fetch, {
      method: "GET",
      url: `${andreaniBase(ctx)}/v2/sucursales?codigoPostal=${encodeURIComponent(cp)}`,
    });
    if (!res.ok) throw await errorFromResponse(res, "GET", "Sucursales de Andreani");
    return parseSucursales(await res.json());
  },

  async create(ctx, req) {
    const cfg = andreaniConfig(ctx);
    const body = buildOrderBody(cfg, req);
    const res = await authed(ctx, "POST", "/v2/ordenes-de-envio", body, "Alta de orden en Andreani");
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // 2xx sin cuerpo legible: la orden pudo haberse creado.
      throw new CarrierError("unknown", "Andreani respondió sin datos de la orden.", { uncertain: true });
    }
    const r = parseOrderResponse(json);
    return {
      external_id: r.external_id,
      tracking_number: r.tracking_number,
      status: "created",
      carrier_status: r.carrier_status,
      package_tracking: r.package_tracking,
    };
  },

  async label(ctx, ref) {
    const res = await authed(ctx, "GET", `/v2/ordenes-de-envio/${encodeURIComponent(ref.external_id)}/etiquetas`, undefined, "Etiqueta de Andreani");
    if (res.status === 204) throw new CarrierError("not_ready", "La etiqueta todavía no está lista.", { retryable: true });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    if (head !== "%PDF-") throw new CarrierError("not_ready", "Andreani no devolvió un PDF de etiqueta.", { retryable: true });
    return { format: "pdf", size: "10x15", mime: "application/pdf", bytes };
  },

  async track(ctx, ref) {
    try {
      const res = await authed(ctx, "GET", `/v2/envios/${encodeURIComponent(ref.tracking_number)}/trazas`, undefined, "Seguimiento de Andreani");
      if (res.status === 204) return [];
      return parseTrazas(await res.json());
    } catch (e) {
      // Recién creado: Andreani todavía no lo tiene en seguimiento.
      if (e instanceof CarrierError && e.code === "not_found") return [];
      throw e;
    }
  },

  async cancel() {
    throw new CarrierError("not_supported", "Andreani no permite cancelar por API: pedilo a tu ejecutivo de cuentas.");
  },
};
