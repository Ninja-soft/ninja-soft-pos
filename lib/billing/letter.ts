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

// ---------------------------------------------------------------------------
// Guía de letras para el dueño (ADR-125). PURO.
//
// Qué facturas emite el negocio según SU condición frente al IVA. Todo sale de
// inferLetter (la misma regla que usa la venta y el worker de ARCA): acá no se
// decide ninguna letra, sólo se explica.
// ---------------------------------------------------------------------------

/** Tipos de cliente que muestra la guía, cada uno con un receptor representativo. */
export const LETTER_GUIDE_BUYERS = [
  { key: "ri", receptor: "responsable_inscripto", who: "Responsable inscripto", example: "Una empresa o comercio que discrimina IVA" },
  { key: "mono", receptor: "monotributo", who: "Monotributista", example: "Un comercio chico o un profesional" },
  { key: "cf", receptor: "consumidor_final", who: "Consumidor final", example: "Una persona que compra para ella" },
  { key: "exento", receptor: "exento", who: "Exento o no alcanzado", example: "Una asociación civil o una cooperadora" },
  { key: "exterior", receptor: "exterior", who: "Cliente del exterior", example: "Una exportación" },
] as const;

export type LetterGuideBuyer = (typeof LETTER_GUIDE_BUYERS)[number]["key"];

export interface LetterGuideRow {
  key: LetterGuideBuyer;
  who: string;
  example: string;
  letter: CbteLetter | null;
}

/** Matriz "a quién le vendés → letra" para la condición del negocio (null = sin configurar). */
export function letterGuide(
  issuerCondition: string | null | undefined,
  opts: { issuesM?: boolean } = {},
): LetterGuideRow[] {
  return LETTER_GUIDE_BUYERS.map((b) => ({
    key: b.key,
    who: b.who,
    example: b.example,
    letter: issuerCondition ? inferLetter(issuerCondition, b.receptor, opts) : null,
  }));
}

const AS_ISSUER: Record<string, string> = {
  responsable_inscripto: "responsable inscripto",
  monotributo: "monotributista",
  monotributo_social: "monotributista social",
  exento: "exento de IVA",
  no_alcanzado: "no alcanzado por el IVA",
};

/** Una frase que resume qué factura el negocio. */
export function letterGuideSummary(issuerCondition: string | null | undefined, opts: { issuesM?: boolean } = {}): string {
  if (!issuerCondition) return "Elegí tu condición frente al IVA y te mostramos qué facturas vas a emitir.";
  const as = AS_ISSUER[issuerCondition] ?? conditionLabel(issuerCondition).toLowerCase();
  const toRi = inferLetter(issuerCondition, "responsable_inscripto", opts);
  const toCf = inferLetter(issuerCondition, "consumidor_final", opts);
  if (toRi === toCf) {
    return `Como ${as}, todas tus facturas son ${toCf}, le vendas a quien le vendas (salvo exportaciones, que son E).`;
  }
  return `Como ${as}, la letra depende de a quién le vendés: ${toRi} a responsables inscriptos y monotributistas, ${toCf} al resto.`;
}

/** Notas de crédito y débito de ARCA: llevan la letra de la factura que corrigen. */
const NOTE_TIPOS = new Set([2, 3, 7, 8, 12, 13, 20, 21, 52, 53]);

export function isCreditOrDebitNote(cbteTipo: number | null | undefined): boolean {
  return cbteTipo != null && NOTE_TIPOS.has(cbteTipo);
}

/** "¿Por qué C?": una frase sin jerga para un comprobante emitido. */
export function letterReason(letter: string | null | undefined, opts: { cbteTipo?: number | null } = {}): string | null {
  if (!letter) return null;
  if (isCreditOrDebitNote(opts.cbteTipo)) {
    return `Las notas de crédito y débito llevan la misma letra que la factura que corrigen: por eso es ${letter}.`;
  }
  switch (letter) {
    case "A":
      return "Sale A porque tu negocio es responsable inscripto y el cliente también es responsable inscripto o monotributista.";
    case "M":
      return "Sale M porque ARCA te pidió emitir M en lugar de A (está marcado en Configuración > Impuestos).";
    case "B":
      return "Sale B porque tu negocio es responsable inscripto y el cliente es consumidor final o exento.";
    case "C":
      return "Sale C porque tu negocio es monotributista o exento frente al IVA: a todos sus clientes les hace factura C.";
    case "E":
      return "Sale E porque es una venta a alguien del exterior (exportación).";
    default:
      return null;
  }
}

/** Resultado de comparar la condición cargada en NinjaSoft con la del padrón de ARCA. */
export type ConditionCheck =
  | { status: "match" }
  | { status: "mismatch"; arca: string }
  | { status: "not_registered" };

/**
 * ¿La condición cargada coincide con la de ARCA? Monotributo y monotributo
 * social cuentan como iguales (el padrón no los distingue y la letra es la
 * misma). Si ARCA no lo tiene inscripto en IVA ni en monotributo
 * (consumidor_final en el padrón), no puede facturar.
 */
export function compareConditionWithPadron(
  local: string | null | undefined,
  padron: string | null | undefined,
): ConditionCheck {
  if (!padron || padron === "consumidor_final") return { status: "not_registered" };
  const norm = (c: string | null | undefined) => (c === "monotributo_social" ? "monotributo" : (c ?? null));
  return norm(local) === norm(padron) ? { status: "match" } : { status: "mismatch", arca: padron };
}
