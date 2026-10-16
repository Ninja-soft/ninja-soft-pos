// lib/accounting/settlementSource.ts
//
// Fuente de los asientos de liquidación (F23 · H153, ADR-162). Lógica PURA:
// meses desde los que se puede cambiar la fuente (primer día de un mes
// abierto, hasta el mes que viene) y el texto del estado de conciliación que
// devuelve NubCeo.

/** Primeros días de mes desde `first` (mes abierto más viejo) hasta el mes siguiente a `today`. */
export function openMonthStarts(first: string, today: string): string[] {
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  let ly = Number(today.slice(0, 4));
  let lm = Number(today.slice(5, 7)) + 1;
  if (lm === 13) {
    lm = 1;
    ly++;
  }
  const out: string[] = [];
  while ((y < ly || (y === ly && m <= lm)) && out.length < 24) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
  return out;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function monthLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** Mes por defecto para el cambio: el actual si está abierto; si no, el último abierto posible. */
export function defaultFromMonth(months: string[], today: string): string {
  const current = `${today.slice(0, 7)}-01`;
  return months.find((x) => x >= current) ?? months[months.length - 1] ?? "";
}

export type NubceoReconStatus = "reconciled" | "pending" | "difference";

export const NUBCEO_RECON_LABEL: Record<NubceoReconStatus, { label: string; tone: "success" | "warning" | "danger" }> = {
  reconciled: { label: "NubCeo: conciliada", tone: "success" },
  pending: { label: "NubCeo: pendiente", tone: "warning" },
  difference: { label: "NubCeo: con diferencia", tone: "danger" },
};
