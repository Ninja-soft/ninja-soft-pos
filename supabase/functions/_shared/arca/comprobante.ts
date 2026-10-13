// =============================================================================
// Tipo de comprobante, concepto, fecha e importes del WSFEv1 (ADR-072). PURO.
//
//   · cbteTipoFor(letra, clase): espejo de arca_cbte_tipo (SQL). Códigos de
//     FEParamGetTiposCbte: 1/2/3 A, 6/7/8 B, 11/12/13 C, 51/52/53 M, 19/20/21 E.
//   · inferLetter: espejo de cbte_letter_infer (SQL) y de lib/tax/comprobante
//     (RG 1415, orientativo).
//   · breakdownFromSnapshot: importes de la venta (ImpNeto, ImpIVA, ImpOpEx,
//     ImpTotConc, ImpTrib, AlicIva y Tributos) desde el desglose del motor de
//     impuestos (sale_tax_lines, ADR-068). Notas de crédito: proporcional al
//     total acreditado, en centavos por resto mayor (siempre cierra).
// =============================================================================

export type Letter = "A" | "B" | "C" | "M" | "E";
export type CbteKind = "factura" | "nd" | "nc";

const TIPOS: Record<Letter, Record<CbteKind, number>> = {
  A: { factura: 1, nd: 2, nc: 3 },
  B: { factura: 6, nd: 7, nc: 8 },
  C: { factura: 11, nd: 12, nc: 13 },
  M: { factura: 51, nd: 52, nc: 53 },
  E: { factura: 19, nd: 20, nc: 21 },
};

export function cbteTipoFor(letter: string | null | undefined, kind: CbteKind): number | null {
  if (!letter || !(letter in TIPOS)) return null;
  return TIPOS[letter as Letter][kind];
}

export const CBTE_LABEL: Record<number, string> = {
  1: "Factura A", 2: "Nota de débito A", 3: "Nota de crédito A",
  6: "Factura B", 7: "Nota de débito B", 8: "Nota de crédito B",
  11: "Factura C", 12: "Nota de débito C", 13: "Nota de crédito C",
  51: "Factura M", 52: "Nota de débito M", 53: "Nota de crédito M",
  19: "Factura E", 20: "Nota de débito E", 21: "Nota de crédito E",
};

export function letterOfTipo(tipo: number): Letter | null {
  for (const [l, m] of Object.entries(TIPOS)) if (Object.values(m).includes(tipo)) return l as Letter;
  return null;
}

/** El emisor discrimina IVA (responsable inscripto o sin configurar). */
function discriminates(cond: string | null | undefined): boolean {
  return !cond || cond === "responsable_inscripto";
}

export function inferLetter(
  emitter: string | null | undefined,
  receptor: string | null | undefined,
  issuesM = false,
): Letter | null {
  if (!emitter) return null;
  const rec = receptor || "consumidor_final";
  if (rec === "exterior") return "E";
  if (!discriminates(emitter)) return "C";
  if (rec === "responsable_inscripto" || rec === "monotributo" || rec === "monotributo_social") {
    return issuesM ? "M" : "A";
  }
  return "B";
}

/** Concepto: 1 productos, 2 servicios, 3 productos y servicios. */
export function conceptoFor(hasGoods: boolean, hasServices: boolean): 1 | 2 | 3 {
  if (hasServices && hasGoods) return 3;
  if (hasServices) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Fechas (AAAAMMDD, en hora de Argentina)
// ---------------------------------------------------------------------------
export function arDate(d: Date | string): string {
  const t = new Date(new Date(d).getTime() - 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
}

export function ymdToIso(ymd: string | null | undefined): string | null {
  if (!ymd || !/^\d{8}$/.test(ymd)) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function isoToYmd(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * Fecha del comprobante: la de la venta, salvo que quede fuera de la ventana
 * que acepta ARCA (hasta 5 días antes para productos y 10 para servicios) o
 * sea anterior al último autorizado de la serie (la numeración tiene que ir
 * con fechas no decrecientes). Nunca en el futuro.
 */
export function pickCbteDate(
  saleDate: string,
  today: string,
  lastAuthorized: string | null,
  concepto: number,
): string {
  const floor = addDaysYmd(today, concepto === 1 ? -5 : -10);
  let d = saleDate;
  if (d > today) d = today;
  if (d < floor) d = floor;
  if (lastAuthorized && d < lastAuthorized) d = lastAuthorized > today ? today : lastAuthorized;
  return d;
}

// ---------------------------------------------------------------------------
// Importes
// ---------------------------------------------------------------------------
export interface TaxLine {
  kind: string; // iva | internos | perception
  tax: string;
  rate_code: string | null;
  rate: number | string | null;
  base: number | string;
  amount: number | string;
  arca_id: number | null;
  jurisdiction?: string | null;
  name?: string | null;
}

export interface AlicIva {
  Id: number;
  BaseImp: number;
  Importe: number;
}

export interface Tributo {
  Id: number;
  Desc: string;
  BaseImp: number;
  Alic: number;
  Importe: number;
}

export interface Breakdown {
  ImpTotal: number;
  ImpTotConc: number;
  ImpNeto: number;
  ImpOpEx: number;
  ImpTrib: number;
  ImpIVA: number;
  Iva: AlicIva[];
  Tributos: Tributo[];
}

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const pesos = (c: number) => Math.round(c) / 100;

/** Tributo de ARCA para una percepción sin id (FEParamGetTiposTributos). */
export function tributoIdFor(l: Pick<TaxLine, "kind" | "tax" | "arca_id">): number {
  if (l.arca_id && l.arca_id > 0) return l.arca_id;
  if (l.kind === "internos") return 4;
  if (l.tax === "iva") return 6;
  if (l.tax === "iibb") return 7;
  return 99;
}

export interface SaleAmounts {
  total: number | string;
  net_taxed?: number | string | null;
  iva_total?: number | string | null;
}

/**
 * Importes de la factura. Sin desglose (ventas anteriores al motor de
 * impuestos): con letra A, B o M se toma todo como gravado al 21 %; con C,
 * todo neto.
 */
export function breakdownFromSale(letter: Letter, sale: SaleAmounts, lines: TaxLine[]): Breakdown {
  const totalC = cents(sale.total);
  const tributos: Tributo[] = lines
    .filter((l) => (l.kind === "perception" || l.kind === "internos") && cents(l.amount) > 0)
    .map((l) => ({
      Id: tributoIdFor(l),
      Desc: (l.name || (l.kind === "internos" ? "Impuestos internos" : `Percepción ${l.tax.toUpperCase()}`)).slice(0, 80),
      BaseImp: pesos(cents(l.base)),
      Alic: Number(l.rate ?? 0) || 0,
      Importe: pesos(cents(l.amount)),
    }));
  const tribC = tributos.reduce((a, t) => a + cents(t.Importe), 0);

  if (letter === "C") {
    return {
      ImpTotal: pesos(totalC),
      ImpTotConc: 0,
      ImpNeto: pesos(totalC - tribC),
      ImpOpEx: 0,
      ImpTrib: pesos(tribC),
      ImpIVA: 0,
      Iva: [],
      Tributos: tributos,
    };
  }

  const ivaLines = lines.filter((l) => l.kind === "iva");
  if (ivaLines.length === 0) {
    const neto = Math.round((totalC - tribC) / 1.21);
    return {
      ImpTotal: pesos(totalC),
      ImpTotConc: 0,
      ImpNeto: pesos(neto),
      ImpOpEx: 0,
      ImpTrib: pesos(tribC),
      ImpIVA: pesos(totalC - tribC - neto),
      Iva: [{ Id: 5, BaseImp: pesos(neto), Importe: pesos(totalC - tribC - neto) }],
      Tributos: tributos,
    };
  }

  let neto = 0;
  let iva = 0;
  let exento = 0;
  let noGravado = 0;
  const byId = new Map<number, { base: number; imp: number }>();
  for (const l of ivaLines) {
    const id = Number(l.arca_id ?? 5);
    if (id === 2) {
      exento += cents(l.base);
    } else if (id === 1) {
      noGravado += cents(l.base);
    } else {
      neto += cents(l.base);
      iva += cents(l.amount);
      const g = byId.get(id) ?? { base: 0, imp: 0 };
      g.base += cents(l.base);
      g.imp += cents(l.amount);
      byId.set(id, g);
    }
  }
  return {
    ImpTotal: pesos(totalC),
    ImpTotConc: pesos(noGravado),
    ImpNeto: pesos(neto),
    ImpOpEx: pesos(exento),
    ImpTrib: pesos(tribC),
    ImpIVA: pesos(iva),
    Iva: [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([Id, g]) => ({ Id, BaseImp: pesos(g.base), Importe: pesos(g.imp) })),
    Tributos: tributos,
  };
}

/** ¿Los importes cierran como exige ARCA? (ImpTotal = suma de las partes). */
export function breakdownCloses(b: Breakdown): boolean {
  const parts = cents(b.ImpTotConc) + cents(b.ImpNeto) + cents(b.ImpOpEx) + cents(b.ImpTrib) + cents(b.ImpIVA);
  if (parts !== cents(b.ImpTotal)) return false;
  if (b.Iva.reduce((a, x) => a + cents(x.Importe), 0) !== cents(b.ImpIVA)) return false;
  if (b.Iva.length > 0 && b.Iva.reduce((a, x) => a + cents(x.BaseImp), 0) !== cents(b.ImpNeto)) return false;
  if (b.Tributos.reduce((a, x) => a + cents(x.Importe), 0) !== cents(b.ImpTrib)) return false;
  return true;
}

/** Reparte target (centavos) según pesos (centavos) por resto mayor. */
export function allocate(target: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + Math.max(w, 0), 0);
  if (sum <= 0 || target <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (target * Math.max(w, 0)) / sum);
  const out = raw.map((x) => Math.floor(x));
  let left = target - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    out[o.i] = (out[o.i] as number) + 1;
    left--;
  }
  return out;
}

/**
 * Nota de crédito por una parte de la factura: escala cada componente al
 * total acreditado. Cada base y su IVA se reparten juntos, así cada alícuota
 * mantiene su proporción y la suma da exacto el total.
 */
export function scaleBreakdown(full: Breakdown, targetTotal: number): Breakdown {
  const tC = cents(targetTotal);
  if (tC >= cents(full.ImpTotal)) return { ...full, Iva: full.Iva.map((x) => ({ ...x })), Tributos: full.Tributos.map((x) => ({ ...x })) };
  const comps: number[] = [
    cents(full.ImpTotConc),
    cents(full.ImpOpEx),
    ...full.Iva.flatMap((x) => [cents(x.BaseImp), cents(x.Importe)]),
    ...full.Tributos.map((x) => cents(x.Importe)),
  ];
  // Alícuotas sin IVA (0 %) o C sin desglose: el neto va como componente propio.
  const ivaBase = full.Iva.reduce((a, x) => a + cents(x.BaseImp), 0);
  const netoSuelto = cents(full.ImpNeto) - ivaBase;
  comps.push(netoSuelto);
  const parts = allocate(tC, comps);
  let k = 0;
  const totConc = parts[k++] as number;
  const opEx = parts[k++] as number;
  const iva: AlicIva[] = full.Iva.map((x) => {
    const base = parts[k++] as number;
    const imp = parts[k++] as number;
    return { Id: x.Id, BaseImp: pesos(base), Importe: pesos(imp) };
  });
  const tributos: Tributo[] = full.Tributos.map((x) => {
    const imp = parts[k++] as number;
    const ratio = cents(x.Importe) > 0 ? imp / cents(x.Importe) : 0;
    return { ...x, BaseImp: pesos(Math.round(cents(x.BaseImp) * ratio)), Importe: pesos(imp) };
  });
  const suelto = parts[k++] as number;
  const neto = iva.reduce((a, x) => a + cents(x.BaseImp), 0) + suelto;
  return {
    ImpTotal: pesos(tC),
    ImpTotConc: pesos(totConc),
    ImpNeto: pesos(neto),
    ImpOpEx: pesos(opEx),
    ImpTrib: pesos(tributos.reduce((a, x) => a + cents(x.Importe), 0)),
    ImpIVA: pesos(iva.reduce((a, x) => a + cents(x.Importe), 0)),
    Iva: iva,
    Tributos: tributos,
  };
}
