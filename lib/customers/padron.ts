// =============================================================================
// Padrón de ARCA para los clientes del negocio (ADR-133). PURO.
//
// La respuesta la arma la Edge arca_padron con el parser compartido
// (supabase/functions/_shared/arca/padron.ts). Acá: llevarla a los campos del
// cliente, nombrar los errores y las etiquetas de verificación.
// =============================================================================
import type { PadronPersona } from "@/supabase/functions/_shared/arca/padron";
import { JURISDICTIONS, isValidCuit } from "@/lib/tax/catalog";

export type { PadronPersona };

/** Código de provincia de ARCA → jurisdicción de IIBB (901 a 924). */
const PROVINCE_TO_JURISDICTION: Record<number, string> = {
  0: "901",
  1: "902",
  2: "903",
  3: "904",
  4: "905",
  5: "908",
  6: "910",
  7: "913",
  8: "912",
  9: "917",
  10: "918",
  11: "919",
  12: "921",
  13: "922",
  14: "924",
  16: "906",
  17: "907",
  18: "909",
  19: "914",
  20: "915",
  21: "911",
  22: "916",
  23: "920",
  24: "923",
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Jurisdicción de IIBB a partir de la provincia del domicilio fiscal. */
export function jurisdictionFromProvince(idProvincia: number | null | undefined, nombre?: string | null): string | null {
  if (idProvincia != null && PROVINCE_TO_JURISDICTION[idProvincia]) return PROVINCE_TO_JURISDICTION[idProvincia] ?? null;
  if (!nombre) return null;
  const n = norm(nombre);
  if (n.includes("CIUDAD") || n === "CABA" || n.includes("CAPITAL FEDERAL")) return "901";
  const hit = JURISDICTIONS.find((j) => norm(j.name) === n);
  return hit?.code ?? null;
}

/** Domicilio corto para el cliente: calle, localidad (sin provincia ni CP). */
export function padronAddress(p: Pick<PadronPersona, "domicilio" | "domicilio_partes">): string | null {
  const d = p.domicilio_partes;
  if (d && (d.direccion || d.localidad)) {
    return [d.direccion, d.localidad].map((x) => (x ?? "").trim()).filter(Boolean).join(", ") || null;
  }
  return p.domicilio ?? null;
}

export interface CustomerFromPadron {
  name: string;
  iva_condition: PadronPersona["iva_condition"];
  address: string | null;
  iibb_jurisdiction: string | null;
}

/** Campos del cliente que completa la verificación. */
export function padronToCustomer(p: PadronPersona): CustomerFromPadron {
  return {
    name: p.razon_social,
    iva_condition: p.iva_condition,
    address: padronAddress(p),
    iibb_jurisdiction: jurisdictionFromProvince(p.domicilio_partes?.id_provincia ?? null, p.provincia),
  };
}

export function personTypeLabel(t: PadronPersona["tipo_persona"]): string {
  if (t === "FISICA") return "Persona humana";
  if (t === "JURIDICA") return "Persona jurídica (empresa o entidad)";
  return "Sin dato";
}

/** Condición frente al IVA según ARCA, en palabras simples. */
export function padronConditionLabel(p: Pick<PadronPersona, "iva_condition" | "monotributo_categoria">): string {
  switch (p.iva_condition) {
    case "responsable_inscripto":
      return "Responsable inscripto en IVA";
    case "monotributo":
      return p.monotributo_categoria ? `Monotributista (categoría ${p.monotributo_categoria})` : "Monotributista";
    case "exento":
      return "Exento de IVA";
    default:
      return "No inscripto en IVA ni en monotributo (se le factura como consumidor final)";
  }
}

/** ¿Se puede consultar este documento en el padrón? */
export function canVerifyDocument(type: string | null | undefined, number: string | null | undefined): boolean {
  return (type === "cuit" || type === "cuil") && isValidCuit(number);
}

/** Mensaje para cada error de la Edge arca_padron. */
export function padronErrorMessage(code: string | null | undefined, extra: { scope?: string | null; reason?: string | null } = {}): string {
  switch (code) {
    case "invalid_cuit":
      return "El CUIT o CUIL no es válido: revisá los 11 números (el último es un dígito de control).";
    case "no_encontrado":
      return "ARCA no tiene registrada esa CUIT. Revisá el número con el cliente.";
    case "not_configured":
      return extra.reason === "disabled"
        ? "La verificación en ARCA todavía no está activa. Cargá los datos a mano."
        : "La verificación en ARCA no está disponible en este momento (falta el certificado de NinjaSoft). Cargá los datos a mano.";
    case "feature_not_in_plan":
      return "Tu plan no incluye verificar clientes en ARCA.";
    case "rate_limited":
      return extra.scope === "global"
        ? "ARCA está recibiendo muchas consultas. Probá de nuevo en unos minutos o cargá los datos a mano."
        : extra.scope === "tenant_day"
          ? "Llegaste al máximo de consultas a ARCA de hoy. Cargá los datos a mano o probá mañana."
          : "Hiciste muchas consultas seguidas. Esperá unos minutos o cargá los datos a mano.";
    case "arca_auth_failed":
      return "ARCA no aceptó la conexión de NinjaSoft. Cargá los datos a mano; ya lo estamos revisando.";
    case "padron_error":
      return "ARCA no respondió bien. Probá de nuevo en un rato o cargá los datos a mano.";
    case "forbidden":
      return "No tenés permiso para consultar ARCA en este negocio.";
    case "padron_verification_missing":
      return "Para marcarlo como verificado, primero tocá Verificar en ARCA con ese CUIT.";
    default:
      return "No se pudo consultar ARCA. Cargá los datos a mano.";
  }
}

export type FiscalVerification = "padron" | "manual" | null;

/** "Verificado en ARCA el 12/10/2026" o "Cargado a mano". Fecha en hora de Argentina. */
export function verificationLabel(v: FiscalVerification | undefined, verifiedAt: string | null | undefined): string | null {
  if (v === "padron") {
    if (!verifiedAt) return "Verificado en ARCA";
    const d = new Date(verifiedAt);
    if (Number.isNaN(d.getTime())) return "Verificado en ARCA";
    const f = new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);
    return `Verificado en ARCA el ${f}`;
  }
  if (v === "manual") return "Cargado a mano";
  return null;
}
