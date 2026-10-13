// Tipo de comprobante que corresponde a una venta (F18 · H104, ADR-068). PURO.
//
// Espejo de `cbte_letter_infer` (SQL). Todavía no se factura (F3): la letra
// queda guardada en la venta para emitirla después y para avisar antes de
// tiempo lo que va a faltar (por ejemplo identificar al consumidor final).
//
// Reglas (RG 1415 y modificatorias, orientativo; validar con el contador):
//   · Emisor monotributista, monotributo social, exento o no alcanzado → C.
//   · Receptor del exterior → E (exportación, WSFEX).
//   · Emisor responsable inscripto:
//       receptor responsable inscripto o monotributista → A (M si el emisor
//       quedó obligado a emitir M);
//       consumidor final, exento, no responsable, no categorizado, no
//       alcanzado, IVA liberado o sin dato → B.
//   · Emisor sin configurar → sin letra.

import { emitterDiscriminatesIva } from "./catalog";

export type CbteLetter = "A" | "B" | "C" | "M" | "E";

export function inferLetter(
  emitter: string | null | undefined,
  receptor: string | null | undefined,
  opts: { issuesM?: boolean } = {},
): CbteLetter | null {
  if (!emitter) return null;
  const rec = receptor || "consumidor_final";
  if (rec === "exterior") return "E";
  if (!emitterDiscriminatesIva(emitter)) return "C";
  if (rec === "responsable_inscripto" || rec === "monotributo" || rec === "monotributo_social") {
    return opts.issuesM ? "M" : "A";
  }
  return "B";
}

/**
 * La factura a consumidor final por encima del tope tiene que identificar al
 * comprador (tipo y número de documento). El tope es un parámetro con vigencia
 * (`tax_parameters`, clave cf_id_threshold).
 */
export function needsIdentification(
  letter: CbteLetter | null,
  receptor: string | null | undefined,
  docNumber: string | null | undefined,
  total: number,
  threshold: number | null | undefined,
): boolean {
  if (letter !== "B" && letter !== "C") return false;
  if ((receptor || "consumidor_final") !== "consumidor_final") return false;
  if (String(docNumber ?? "").replace(/\D/g, "").length > 0) return false;
  return threshold != null && threshold > 0 && total >= threshold;
}
