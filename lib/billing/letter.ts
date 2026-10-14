// Letra de la factura de NinjaSoft a un negocio (F20-3 · ADR-110 · spec
// docs/40-cobranza-saas.md §7.2). PURO. Espejo de platform_cbte_letter (SQL).
//
// La letra no la elige el cliente: sale de la condición frente al IVA del
// emisor (NinjaSoft) y del receptor (a nombre de quién se factura).
//   · Emisor sin condición cargada (hoy: NinjaSoft sin CUIT, §22 #1) → pendiente.
//   · Receptor sin condición → pendiente (RG 5616 la exige).
//   · Si no, la regla de inferLetter (ADR-068): RI → RI o monotributo = A,
//     RI → resto = B, monotributo o exento → C, exterior = E.
import { inferLetter, type CbteLetter } from "@/lib/tax/comprobante";
import { FISCAL_CONDITION_LABEL, type FiscalCondition } from "@/lib/tax/catalog";

export type PlatformLetterStatus = "ok" | "pending_issuer" | "pending_receptor";

export type PlatformLetter =
  | { status: "ok"; letter: CbteLetter }
  | { status: "pending_issuer" | "pending_receptor"; letter: null };

export function platformLetter(
  issuerCondition: string | null | undefined,
  receptorCondition: string | null | undefined,
): PlatformLetter {
  if (!issuerCondition) return { status: "pending_issuer", letter: null };
  if (!receptorCondition) return { status: "pending_receptor", letter: null };
  const letter = inferLetter(issuerCondition, receptorCondition);
  return letter ? { status: "ok", letter } : { status: "pending_issuer", letter: null };
}

/** "Factura A" o el motivo por el que todavía no se sabe. */
export function letterTitle(r: { status: PlatformLetterStatus; letter: string | null }): string {
  if (r.status === "ok" && r.letter) return `Factura ${r.letter}`;
  return "Comprobante pendiente";
}

export function letterExplanation(r: { status: PlatformLetterStatus; letter: string | null }): string {
  switch (r.status) {
    case "pending_issuer":
      return "NinjaSoft está terminando su alta en ARCA. La letra (A, B o C) se define con tu condición frente al IVA apenas esté lista.";
    case "pending_receptor":
      return "Falta la condición frente al IVA del titular: sin ella ARCA no deja emitir la factura.";
    default:
      return r.letter === "A"
        ? "Discrimina el IVA: podés computarlo como crédito fiscal."
        : r.letter === "C"
          ? "NinjaSoft factura como monotributista o exento: todos sus comprobantes son C."
          : "Factura con el IVA incluido en el precio.";
  }
}

/** Condiciones que puede elegir un titular (las del receptor de ARCA, sin exterior). */
export const RECEPTOR_CONDITIONS: FiscalCondition[] = [
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "exento",
  "consumidor_final",
  "no_alcanzado",
  "no_categorizado",
  "iva_liberado",
];

/** Condiciones del emisor configurables en internal (null = sin definir). */
export const ISSUER_CONDITIONS = ["responsable_inscripto", "monotributo", "monotributo_social", "exento", "no_alcanzado"] as const;
export type IssuerCondition = (typeof ISSUER_CONDITIONS)[number];

export function conditionLabel(c: string | null | undefined): string {
  if (!c) return "Sin definir";
  return FISCAL_CONDITION_LABEL[c as FiscalCondition] ?? c;
}
