// =============================================================================
// Tipos de comprobante que ARCA acepta para un emisor y un receptor (ADR-133).
// PURO. Espejo de cbte_letter_check (SQL, 20261128100100).
//
// Matriz de WSFEv1 (FEParamGetCondicionIvaReceptor, RG 5616):
//   · clase A y M: sólo a responsables inscriptos, monotributistas y
//     monotributistas sociales, y con el CUIT del cliente;
//   · clase B: al resto (consumidor final, exento, no alcanzado, exterior...);
//   · clase C: a cualquiera.
// El emisor responsable inscripto emite A, B o M (M sólo si ARCA se lo pidió,
// y entonces no A); el monotributista o exento sólo C. La E (exportación) va
// por WSFEX y NinjaSoft todavía no la emite.
//
// La letra sugerida sigue saliendo de inferLetter (ADR-068): acá sólo se
// valida lo que el usuario elige a mano y se explica por qué no se puede.
// =============================================================================
import { inferLetter, type CbteLetter } from "@/lib/tax/comprobante";
import { emitterDiscriminatesIva, FISCAL_CONDITION_LABEL, type FiscalCondition } from "@/lib/tax/catalog";

export type LetterCheckError =
  | "emisor_sin_configurar"
  | "letra_invalida"
  | "exportacion_no_soportada"
  | "letra_no_habilitada_emisor"
  | "condicion_receptor_no_valida"
  | "receptor_sin_cuit"
  | "emisor_emite_m"
  | "m_no_habilitada";

/** Condiciones del receptor que admiten A y M (clase A de ARCA). */
export const CLASS_A_RECEPTORS: readonly string[] = ["responsable_inscripto", "monotributo", "monotributo_social"];

const LETTERS: readonly CbteLetter[] = ["A", "B", "C", "M", "E"];

export interface LetterContext {
  /** El cliente tiene CUIT válida cargada como tipo de documento CUIT. */
  hasCuit: boolean;
  /** ARCA le pidió al emisor facturar M en lugar de A. */
  issuesM?: boolean;
}

/** null = ARCA lo acepta; si no, el motivo (mismo código que el servidor). */
export function checkLetter(
  emitter: string | null | undefined,
  receptor: string | null | undefined,
  ctx: LetterContext,
  letter: string | null | undefined,
): LetterCheckError | null {
  if (!emitter) return "emisor_sin_configurar";
  if (!letter || !LETTERS.includes(letter as CbteLetter)) return "letra_invalida";
  if (letter === "E") return "exportacion_no_soportada";
  const ri = emitterDiscriminatesIva(emitter);
  if (!ri && letter !== "C") return "letra_no_habilitada_emisor";
  if (ri && letter === "C") return "letra_no_habilitada_emisor";
  const rec = receptor || "consumidor_final";
  const classA = CLASS_A_RECEPTORS.includes(rec);
  if ((letter === "A" || letter === "M") && !classA) return "condicion_receptor_no_valida";
  if (letter === "B" && classA) return "condicion_receptor_no_valida";
  if ((letter === "A" || letter === "M") && !ctx.hasCuit) return "receptor_sin_cuit";
  if (letter === "A" && ctx.issuesM) return "emisor_emite_m";
  if (letter === "M" && !ctx.issuesM) return "m_no_habilitada";
  return null;
}

/** Letras que puede emitir este emisor (para listar en "Cambiar tipo"). */
export function emitterLetters(emitter: string | null | undefined, opts: { issuesM?: boolean } = {}): CbteLetter[] {
  if (!emitter) return [];
  if (!emitterDiscriminatesIva(emitter)) return ["C", "E"];
  return opts.issuesM ? ["M", "B", "E"] : ["A", "B", "E"];
}

export interface LetterOption {
  letter: CbteLetter;
  /** ARCA lo acepta para este cliente. */
  allowed: boolean;
  /** Es la que corresponde según las condiciones (inferLetter). */
  suggested: boolean;
  code: LetterCheckError | null;
  /** Por qué no se puede, en criollo (null si se puede). */
  reason: string | null;
}

/** Opciones de "Cambiar tipo": todas las del emisor, con las que ARCA no acepta deshabilitadas. */
export function letterOptions(
  emitter: string | null | undefined,
  receptor: string | null | undefined,
  ctx: LetterContext,
): LetterOption[] {
  const suggested = inferLetter(emitter ?? null, receptor ?? null, { issuesM: ctx.issuesM });
  return emitterLetters(emitter, { issuesM: ctx.issuesM }).map((letter) => {
    const code = checkLetter(emitter, receptor, ctx, letter);
    return {
      letter,
      allowed: code === null,
      suggested: letter === suggested,
      code,
      reason: code ? letterCheckMessage(code, { letter, receptor, emitter }) : null,
    };
  });
}

function condLabel(c: string | null | undefined): string {
  const k = (c || "consumidor_final") as FiscalCondition;
  return (FISCAL_CONDITION_LABEL[k] ?? String(c)).toLowerCase();
}

/** Explicación sin jerga de por qué ARCA no acepta ese tipo. */
export function letterCheckMessage(
  code: LetterCheckError | string,
  ctx: { letter?: string | null; receptor?: string | null; emitter?: string | null } = {},
): string {
  switch (code) {
    case "emisor_sin_configurar":
      return "Primero cargá la condición frente al IVA de tu negocio en Configuración › Impuestos.";
    case "letra_invalida":
      return "Ese tipo de comprobante no existe.";
    case "exportacion_no_soportada":
      return "La factura E es de exportación y NinjaSoft todavía no la emite.";
    case "letra_no_habilitada_emisor":
      return ctx.letter === "C"
        ? "Como responsable inscripto no podés hacer factura C."
        : "Como monotributista o exento sólo podés hacer factura C.";
    case "condicion_receptor_no_valida":
      return ctx.letter === "B"
        ? `ARCA no acepta factura B a un cliente ${condLabel(ctx.receptor)}: le corresponde A. Si compra para uso personal, cobrale como consumidor final sin elegir cliente.`
        : `ARCA sólo acepta factura ${ctx.letter ?? "A"} a responsables inscriptos y monotributistas, y este cliente figura como ${condLabel(ctx.receptor)}.`;
    case "receptor_sin_cuit":
      return "Para hacer factura A o M necesitás el CUIT del cliente cargado, con tipo de documento CUIT.";
    case "emisor_emite_m":
      return "ARCA te pidió emitir M en lugar de A (está marcado en Configuración › Impuestos).";
    case "m_no_habilitada":
      return "La factura M es sólo para quienes ARCA se lo pidió. Si es tu caso, marcalo en Configuración › Impuestos.";
    default:
      return "ARCA no acepta ese tipo de comprobante para esta venta.";
  }
}

/** Qué implica forzar un tipo distinto del sugerido (para la confirmación). */
export function overrideRiskText(suggested: string | null | undefined, forced: string): string {
  const base = suggested
    ? `Vas a hacer factura ${forced} en lugar de la ${suggested} que corresponde según la condición frente al IVA de tu negocio y del cliente.`
    : `Vas a hacer factura ${forced}.`;
  return (
    base +
    " ARCA la acepta, pero si no es la que corresponde el cliente puede no poder usarla (por ejemplo, para descontar el IVA) y vas a tener que anularla con una nota de crédito y hacer otra. Queda registrado quién la cambió."
  );
}
