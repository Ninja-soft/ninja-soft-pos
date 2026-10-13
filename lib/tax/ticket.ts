// Impuestos en el ticket (ADR-068). PURO.
//
//   · Percepciones: una línea por régimen antes del total ("Perc. IIBB Buenos
//     Aires 1,5 %"), como exige el comprobante.
//   · Transparencia Fiscal al Consumidor (Ley 27.743): en el comprobante B
//     (responsable inscripto a consumidor final) se informa el IVA contenido y
//     los otros impuestos nacionales indirectos (internos). Orientativo:
//     validar el texto exacto con la reglamentación vigente.

import { jurisdictionName } from "./catalog";

interface SaleTaxFields {
  cbte_letter?: string | null;
  iva_total?: number | string | null;
  internal_tax_total?: number | string | null;
}

interface TaxLineLike {
  kind: string;
  tax: string;
  jurisdiction: string | null;
  rate: number | null;
  amount: number;
}

const fmtRate = (r: number | null) => (r == null ? "" : ` ${String(Number(r)).replace(".", ",")} %`);

export function perceptionLabel(l: Pick<TaxLineLike, "tax" | "jurisdiction" | "rate">): string {
  const where = l.tax === "iibb" && l.jurisdiction ? ` ${jurisdictionName(l.jurisdiction)}` : "";
  return `Perc. ${l.tax === "iva" ? "IVA" : "IIBB"}${where}${fmtRate(l.rate)}`;
}

export function saleTaxTicket(sale: unknown, lines: TaxLineLike[]) {
  const s = (sale ?? {}) as SaleTaxFields;
  const perceptions = lines
    .filter((l) => l.kind === "perception" && Number(l.amount) > 0)
    .map((l) => ({ name: perceptionLabel(l), amount: Number(l.amount) }));
  const iva = Number(s.iva_total ?? 0) || 0;
  const others = Number(s.internal_tax_total ?? 0) || 0;
  return {
    perceptions,
    transparency: s.cbte_letter === "B" && iva + others > 0 ? { iva, others } : null,
  };
}
