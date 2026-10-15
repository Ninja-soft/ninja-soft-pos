// =============================================================================
// Padrón de ARCA: ws_sr_constancia_inscripcion ("padrón A5", getPersona_v2).
// F20-3 · ADR-110 / ADR-117 · spec docs/40-cobranza-saas.md §8.2. PURO.
//
// Lo usa la Edge platform_billing (acción padron_lookup) para traer la razón
// social, la condición frente al IVA y el domicilio fiscal de un CUIT. La
// autenticación es el WSAA de siempre (wsaa.ts) con el certificado de la
// plataforma (arca_platform) y service = ws_sr_constancia_inscripcion.
//
// Mapeo a la condición frente al IVA (vocabulario de lib/tax/catalog.ts):
//   monotributo (datosMonotributo con impuesto 20)  → monotributo
//   IVA (impuesto 30 en datosRegimenGeneral)        → responsable_inscripto
//   IVA exento (impuesto 32)                        → exento
//   sin IVA ni monotributo                          → consumidor_final (aviso)
// Orientativo: validar con el contador (spec §16).
// =============================================================================
import { allowedEndpoint, type ArcaEnv } from "./config.ts";
import { escapeXml, num, parseFault, raw, rawAll, soapEnvelope, text } from "./xml.ts";

export const PADRON_SERVICE = "ws_sr_constancia_inscripcion";
export const PADRON_NS = "http://a5.soap.ws.server.puc.sr/";

export const PADRON_ENDPOINTS: Record<ArcaEnv, string> = {
  homologacion: "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5",
  produccion: "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
};

/** Endpoint del ambiente; se puede pisar con ARCA_PADRON_URL_HOMO / _PROD (sólo ARCA o localhost). */
export function padronEndpointFor(env: ArcaEnv, vars: Record<string, string | undefined> = {}): string {
  const v = vars[env === "produccion" ? "ARCA_PADRON_URL_PROD" : "ARCA_PADRON_URL_HOMO"];
  return allowedEndpoint(v) ? (v as string) : PADRON_ENDPOINTS[env];
}

/** Cache de una consulta (spec §8.2): 30 días. */
export const PADRON_CACHE_DAYS = 30;
/** Rate limit (spec §8.2): por negocio y en toda la plataforma, por hora. */
export const PADRON_RATE = { tenantPerHour: 10, globalPerHour: 300 } as const;

export function rateLimited(counts: { tenantHour: number; globalHour: number }): "tenant" | "global" | null {
  if (counts.globalHour >= PADRON_RATE.globalPerHour) return "global";
  if (counts.tenantHour >= PADRON_RATE.tenantPerHour) return "tenant";
  return null;
}

/**
 * Cupo de la consulta para los negocios (ADR-133): configurable en internal
 * (arca_padron_config). Cuenta sólo las consultas que llegan a ARCA (la cache
 * no consume cupo). null = hay cupo; si no, cuál se agotó.
 */
export interface PadronQuota {
  tenant_per_hour: number;
  tenant_per_day: number;
  global_per_hour: number;
}
export interface PadronUsage {
  tenant_hour: number;
  tenant_day: number;
  global_hour: number;
}
export function quotaExceeded(u: PadronUsage, q: PadronQuota): "global" | "tenant_hour" | "tenant_day" | null {
  if (u.global_hour >= q.global_per_hour) return "global";
  if (u.tenant_hour >= q.tenant_per_hour) return "tenant_hour";
  if (u.tenant_day >= q.tenant_per_day) return "tenant_day";
  return null;
}

export function isFresh(fetchedAt: string | Date | null | undefined, now: Date = new Date(), days = PADRON_CACHE_DAYS): boolean {
  if (!fetchedAt) return false;
  const t = new Date(fetchedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t < days * 86_400_000;
}

/** Dígito verificador de CUIT/CUIL (módulo 11). Espejo de isValidCuit (lib/tax/catalog.ts). */
export function cuitIsValid(value: string | null | undefined): boolean {
  const d = String(value ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (w[i] as number);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9;
  return check === Number(d[10]);
}

export interface PadronAuth {
  token: string;
  sign: string;
  /** CUIT de la plataforma (la del certificado). */
  cuitRepresentada: string;
}

export function buildGetPersonaV2(a: PadronAuth, idPersona: string): string {
  return soapEnvelope(
    `<a5:getPersona_v2>` +
      `<token>${escapeXml(a.token)}</token>` +
      `<sign>${escapeXml(a.sign)}</sign>` +
      `<cuitRepresentada>${escapeXml(a.cuitRepresentada.replace(/\D/g, ""))}</cuitRepresentada>` +
      `<idPersona>${escapeXml(idPersona.replace(/\D/g, ""))}</idPersona>` +
      `</a5:getPersona_v2>`,
    { a5: PADRON_NS },
  );
}

/** Request sin Token ni Sign (para logs). */
export function redactPadronXml(xml: string): string {
  return xml.replace(/<token>[\s\S]*?<\/token>/g, "<token>***</token>").replace(/<sign>[\s\S]*?<\/sign>/g, "<sign>***</sign>");
}

export type PadronIvaCondition = "responsable_inscripto" | "monotributo" | "exento" | "consumidor_final";

export interface PadronPersona {
  cuit: string;
  tipo_persona: "FISICA" | "JURIDICA" | null;
  razon_social: string;
  estado_clave: string | null;
  activa: boolean;
  domicilio: string | null;
  provincia: string | null;
  iva_condition: PadronIvaCondition;
  /** De dónde salió la condición. */
  iva_source: "monotributo" | "regimen_general" | "sin_iva";
  impuestos: number[];
  monotributo_categoria: string | null;
  /** Errores informativos de la constancia (p. ej. sin impuestos activos). */
  avisos: string[];
  /** Actividades declaradas (régimen general o monotributo), en orden. ADR-133. */
  actividades?: PadronActividad[];
  /** Domicilio fiscal en partes (para autocompletar el cliente). ADR-133. */
  domicilio_partes?: PadronDomicilio | null;
  /**
   * Inicio de actividades APROXIMADO (AAAA-MM-01): ARCA no lo informa en la
   * constancia; sale del período de alta más viejo de los impuestos activos
   * (IVA, monotributo, ganancias). Se muestra como sugerencia a confirmar.
   */
  inicio_actividades?: string | null;
  /** Fecha del contrato social (sólo personas jurídicas, si viene). */
  fecha_contrato_social?: string | null;
}

export interface PadronActividad {
  id: string | null;
  descripcion: string;
  orden: number | null;
}

export interface PadronDomicilio {
  direccion: string | null;
  localidad: string | null;
  provincia: string | null;
  cod_postal: string | null;
  /** Código de provincia de ARCA (0 = CABA, 1 = Buenos Aires, ...). */
  id_provincia: number | null;
}

export type PadronResult =
  | { status: "ok"; persona: PadronPersona }
  | { status: "no_encontrado"; message: string }
  | { status: "error"; code: string; message: string };

const IMP_IVA = 30;
const IMP_IVA_EXENTO = 32;
const IMP_MONOTRIBUTO = 20;

/** Condición frente al IVA a partir de los impuestos activos. */
export function condicionFromImpuestos(regimenGeneral: number[], monotributo: number[]): {
  iva_condition: PadronIvaCondition;
  iva_source: PadronPersona["iva_source"];
} {
  if (monotributo.length > 0 && (monotributo.includes(IMP_MONOTRIBUTO) || !regimenGeneral.includes(IMP_IVA))) {
    return { iva_condition: "monotributo", iva_source: "monotributo" };
  }
  if (regimenGeneral.includes(IMP_IVA)) return { iva_condition: "responsable_inscripto", iva_source: "regimen_general" };
  if (regimenGeneral.includes(IMP_IVA_EXENTO)) return { iva_condition: "exento", iva_source: "regimen_general" };
  return { iva_condition: "consumidor_final", iva_source: "sin_iva" };
}

function impuestosDe(block: string | null): number[] {
  if (!block) return [];
  return rawAll(block, "impuesto")
    .map((imp) => num(imp, "idImpuesto"))
    .filter((n): n is number => n != null);
}

function actividadesDe(rg: string | null, mt: string | null): PadronActividad[] {
  const out: PadronActividad[] = [];
  const add = (block: string) => {
    const descripcion = text(block, "descripcionActividad") ?? "";
    if (!descripcion) return;
    out.push({ id: text(block, "idActividad"), descripcion, orden: num(block, "orden") });
  };
  if (rg) for (const a of rawAll(rg, "actividad")) add(a);
  if (mt) for (const a of rawAll(mt, "actividadMonotributista")) add(a);
  return out
    .filter((a, i, all) => all.findIndex((b) => b.id === a.id && b.descripcion === a.descripcion) === i)
    .sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99));
}

/** Período AAAAMM más viejo de los impuestos → "AAAA-MM-01". */
export function inicioDesdePeriodos(blocks: (string | null)[]): string | null {
  let min: number | null = null;
  for (const b of blocks) {
    if (!b) continue;
    for (const imp of [...rawAll(b, "impuesto"), ...rawAll(b, "categoriaMonotributo")]) {
      const per = num(imp, "periodo");
      if (per == null || per < 190001 || per > 299912) continue;
      if (min == null || per < min) min = per;
    }
  }
  if (min == null) return null;
  const y = Math.floor(min / 100);
  const m = min % 100;
  if (m < 1 || m > 12) return null;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function joinParts(parts: (string | null | undefined)[]): string | null {
  const s = parts.map((p) => (p ?? "").trim()).filter(Boolean).join(", ");
  return s || null;
}

/** Respuesta de getPersona_v2 → resultado normalizado. */
export function parsePersonaV2(xml: string, cuitConsultado?: string): PadronResult {
  const fault = parseFault(xml);
  if (fault) {
    const m = fault.message || fault.code;
    if (/no existe persona/i.test(m)) return { status: "no_encontrado", message: m };
    if (/no autorizad|not authorized|sin permiso|no tiene permiso/i.test(m)) {
      return { status: "error", code: "padron_no_autorizado", message: m };
    }
    return { status: "error", code: fault.code || "padron_fault", message: m };
  }
  const ret = raw(xml, "personaReturn");
  if (ret == null) return { status: "error", code: "padron_respuesta_invalida", message: "ARCA no devolvió personaReturn" };

  const errConst = raw(ret, "errorConstancia");
  const avisos = errConst ? rawAll(errConst, "error").map((e) => text(`<x>${e}</x>`, "x") ?? "").filter(Boolean) : [];
  const gen = raw(ret, "datosGenerales");
  if (!gen) {
    const msg = avisos.join(" · ") || "La CUIT no figura en el padrón";
    return { status: "no_encontrado", message: msg };
  }

  const tipo = (text(gen, "tipoPersona") ?? "").toUpperCase();
  const razon =
    text(gen, "razonSocial") ?? joinParts([text(gen, "apellido"), text(gen, "nombre")])?.replace(", ", " ") ?? "";
  const estado = text(gen, "estadoClave");
  const dom = raw(gen, "domicilioFiscal");
  const provincia = dom ? text(dom, "descripcionProvincia") : null;
  const domicilio = dom
    ? joinParts([text(dom, "direccion"), text(dom, "localidad"), provincia, text(dom, "codPostal") ? `CP ${text(dom, "codPostal")}` : null])
    : null;

  const rgBlock = raw(ret, "datosRegimenGeneral");
  const rg = impuestosDe(rgBlock);
  const mtBlock = raw(ret, "datosMonotributo");
  const mt = impuestosDe(mtBlock);
  const cat = mtBlock ? raw(mtBlock, "categoriaMonotributo") : null;
  const cond = condicionFromImpuestos(rg, mt);

  return {
    status: "ok",
    persona: {
      cuit: (text(gen, "idPersona") ?? cuitConsultado ?? "").replace(/\D/g, ""),
      tipo_persona: tipo === "FISICA" || tipo === "JURIDICA" ? tipo : null,
      razon_social: razon.trim(),
      estado_clave: estado,
      activa: (estado ?? "").toUpperCase() === "ACTIVO",
      domicilio,
      provincia,
      iva_condition: cond.iva_condition,
      iva_source: cond.iva_source,
      impuestos: [...rg, ...mt],
      monotributo_categoria: cat ? text(cat, "descripcionCategoria") : null,
      avisos,
      actividades: actividadesDe(rgBlock, mtBlock),
      inicio_actividades: inicioDesdePeriodos([rgBlock, mtBlock]),
      fecha_contrato_social: (text(gen, "fechaContratoSocial") ?? "").slice(0, 10) || null,
      domicilio_partes: dom
        ? {
            direccion: text(dom, "direccion"),
            localidad: text(dom, "localidad"),
            provincia,
            cod_postal: text(dom, "codPostal"),
            id_provincia: num(dom, "idProvincia"),
          }
        : null,
    },
  };
}
