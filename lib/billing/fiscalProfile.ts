// Perfil de facturación de un negocio frente a NinjaSoft (F20-3 · ADR-110 ·
// spec docs/40-cobranza-saas.md §6.2 y §8.1). PURO.
//
// resolveBillingProfile es el espejo de _tenant_billing_profile_eff (SQL):
//   1. "Otro titular" guardado → sus datos.
//   2. Datos de la empresa con CUIT → los de la empresa; si la fila vigente
//      guarda una verificación de ESE CUIT, la copia verificada.
//   3. Empresa sin CUIT → consumidor final (doc 99) y aviso para completar.
// La base es la que decide; esto sirve para la vista previa y los tests.
import { isValidCuit, normalizeDigits } from "@/lib/tax/catalog";
import { platformLetter, type PlatformLetterStatus } from "./letter";

export type Verification = "padron" | "staff" | "manual" | "none";
export type HolderType = "empresa" | "persona";
export type BillingSource = "company" | "other" | "consumidor_final";

export interface CompanyFiscal {
  razon_social: string | null;
  cuit: string | null;
  iva_condition: string | null;
  domicilio: string | null;
}

export interface BillingProfileRow {
  use_company_data: boolean;
  holder_type: HolderType | null;
  doc_tipo: number | null;
  doc_nro: string | null;
  razon_social: string | null;
  iva_condition: string | null;
  domicilio: string | null;
  email_facturacion: string | null;
  verification: Verification;
}

export interface EffectiveBillingProfile {
  source: BillingSource;
  holder_type: HolderType | null;
  doc_tipo: number;
  doc_nro: string | null;
  razon_social: string | null;
  iva_condition: string | null;
  domicilio: string | null;
  email: string | null;
  email_is_default: boolean;
  verification: Verification;
  verified: boolean;
  letter: string | null;
  letter_status: PlatformLetterStatus;
  blocked_a_unverified: boolean;
}

export const isVerified = (v: string | null | undefined) => v === "padron" || v === "staff";

export function resolveBillingProfile(
  row: BillingProfileRow | null,
  company: CompanyFiscal,
  ownerEmail: string | null,
  issuerCondition: string | null,
): EffectiveBillingProfile {
  const companyCuit = company.cuit && isValidCuit(company.cuit) ? normalizeDigits(company.cuit) : null;
  let base: Omit<EffectiveBillingProfile, "email" | "email_is_default" | "verified" | "letter" | "letter_status" | "blocked_a_unverified">;

  if (row && !row.use_company_data) {
    base = {
      source: "other",
      holder_type: row.holder_type,
      doc_tipo: row.doc_tipo ?? 80,
      doc_nro: row.doc_nro,
      razon_social: row.razon_social,
      iva_condition: row.iva_condition,
      domicilio: row.domicilio,
      verification: row.verification,
    };
  } else if (companyCuit) {
    const verifiedCopy = row && row.doc_nro === companyCuit && isVerified(row.verification);
    base = {
      source: "company",
      holder_type: "empresa",
      doc_tipo: 80,
      doc_nro: companyCuit,
      razon_social: (verifiedCopy && row?.razon_social) || company.razon_social,
      iva_condition: (verifiedCopy && row?.iva_condition) || company.iva_condition,
      domicilio: (verifiedCopy && row?.domicilio) || company.domicilio,
      verification: verifiedCopy ? (row as BillingProfileRow).verification : "none",
    };
  } else {
    base = {
      source: "consumidor_final",
      holder_type: null,
      doc_tipo: 99,
      doc_nro: null,
      razon_social: company.razon_social,
      iva_condition: "consumidor_final",
      domicilio: company.domicilio,
      verification: "none",
    };
  }

  const l = platformLetter(issuerCondition, base.iva_condition);
  const verified = isVerified(base.verification);
  return {
    ...base,
    email: row?.email_facturacion || ownerEmail,
    email_is_default: !row?.email_facturacion,
    verified,
    letter: l.letter,
    letter_status: l.status,
    blocked_a_unverified: l.letter === "A" && !verified,
  };
}

/** CUIT 20123456786 → 20-12345678-6. */
export function formatCuit(v: string | null | undefined): string {
  const d = normalizeDigits(v);
  if (d.length !== 11) return d;
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

export type CuitCheck = "empty" | "incomplete" | "invalid" | "ok";

/** Estado del CUIT mientras se escribe (dígito verificador siempre). */
export function checkCuit(v: string | null | undefined): CuitCheck {
  const d = normalizeDigits(v);
  if (d.length === 0) return "empty";
  if (d.length < 11) return "incomplete";
  if (d.length > 11) return "invalid";
  return isValidCuit(d) ? "ok" : "invalid";
}

export const VERIFICATION_LABEL: Record<Verification, string> = {
  padron: "Verificado en ARCA",
  staff: "Verificado por NinjaSoft",
  manual: "Sin verificar",
  none: "Sin verificar",
};

export const DOC_TIPO_LABEL: Record<number, string> = { 80: "CUIT", 86: "CUIL", 96: "DNI", 99: "Sin identificar" };

/** Errores de las RPC y de la Edge → texto para el usuario. */
export function billingProfileError(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { message?: string })?.message ?? "");
  const map: Record<string, string> = {
    forbidden: "Sólo el dueño o el encargado pueden ver y cambiar los datos de facturación.",
    invalid_cuit: "El CUIT no es válido: revisá el dígito verificador.",
    invalid_dni: "El DNI tiene que tener 7 u 8 números.",
    invalid_email: "El email no es válido.",
    razon_social_required: "Completá la razón social o el nombre.",
    invalid_iva_condition: "Elegí la condición frente al IVA.",
    invalid_holder_type: "Elegí si el titular es una empresa o una persona.",
    doc_required: "Completá el documento del titular.",
    padron_lookup_missing: "Volvé a buscar el CUIT en ARCA antes de guardar.",
    padron_needs_cuit: "La verificación en ARCA necesita un CUIT o CUIL.",
    reason_required: "Escribí el motivo del cambio.",
    verify_needs_doc: "No hay CUIT para verificar: el negocio no tiene CUIT cargado.",
    platform_not_configured: "La verificación automática con ARCA todavía no está disponible.",
    rate_limited: "Hiciste muchas consultas seguidas. Probá de nuevo en un rato.",
  };
  for (const [k, v] of Object.entries(map)) if (m.includes(k)) return v;
  return "No se pudo completar la operación. Probá de nuevo.";
}
