// Cuenta por comensal y partes iguales (F13 · H44, ADR-097). Helpers puros que
// arman las líneas que recibe split_table_order: cada cuenta separada es un
// pedido hijo que se cobra como una venta propia con sus ítems.

export interface SplitItemLike {
  id: string;
  qty: number;
  unit_price: number;
  diner: number | null;
}

export interface SplitLine {
  item_id: string;
  // null = la línea entera.
  qty: number | null;
}

export const MAX_DINERS = 20;

// Redondeo a 3 decimales, la escala de table_order_items.qty.
export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function dinerLabel(diner: number): string {
  return `Comensal ${diner}`;
}

export function partLabel(part: number, parts: number): string {
  return `Parte ${part} de ${parts}`;
}

// "Parte 2 de 3" → { part: 2, parts: 3 }. Cualquier otra etiqueta → null.
export function parsePartLabel(label: string | null | undefined): { part: number; parts: number } | null {
  const m = (label ?? "").match(/^Parte (\d+) de (\d+)$/);
  if (!m) return null;
  const part = Number(m[1]);
  const parts = Number(m[2]);
  if (!part || !parts || part > parts) return null;
  return { part, parts };
}

// Total y líneas de cada comensal; las sin comensal van a "compartido".
export function dinerSummary<T extends SplitItemLike>(
  items: T[],
): { diners: { diner: number; items: T[]; total: number }[]; shared: { items: T[]; total: number } } {
  const map = new Map<number, T[]>();
  const shared: T[] = [];
  for (const it of items) {
    if (it.diner == null) shared.push(it);
    else map.set(it.diner, [...(map.get(it.diner) ?? []), it]);
  }
  const total = (list: T[]) => roundMoney(list.reduce((a, i) => a + i.qty * i.unit_price, 0));
  return {
    diners: [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([diner, list]) => ({ diner, items: list, total: total(list) })),
    shared: { items: shared, total: total(shared) },
  };
}

// Líneas enteras de un comensal.
export function dinerLines(items: SplitItemLike[], diner: number): SplitLine[] {
  return items.filter((i) => i.diner === diner).map((i) => ({ item_id: i.id, qty: null }));
}

// Una parte igual de lo que queda: cada línea aporta qty / partes restantes
// (3 decimales). Con una sola parte restante se lleva todo (cuadra al centavo
// porque la última parte toma el resto de cada línea).
export function equalShareLines(items: SplitItemLike[], remainingParts: number): SplitLine[] {
  const parts = Math.max(1, Math.floor(remainingParts));
  if (parts === 1) return items.map((i) => ({ item_id: i.id, qty: null }));
  const out: SplitLine[] = [];
  for (const it of items) {
    const share = roundQty(it.qty / parts);
    if (share <= 0) continue;
    out.push({ item_id: it.id, qty: share >= it.qty ? null : share });
  }
  return out;
}

// Importe de un conjunto de líneas (lo que va a cobrar esa cuenta).
export function linesTotal(items: SplitItemLike[], lines: SplitLine[]): number {
  const byId = new Map(items.map((i) => [i.id, i]));
  let total = 0;
  for (const l of lines) {
    const it = byId.get(l.item_id);
    if (!it) continue;
    total += roundMoney((l.qty ?? it.qty) * it.unit_price);
  }
  return roundMoney(total);
}

// Próxima parte igual a partir de las cuentas separadas ya hechas: si hay un
// reparto "Parte k de N" en curso, sigue con k+1 de N; si no, arranca con la 1
// de `defaultParts`.
export function nextEqualPart(
  splits: { split_label: string | null; status: string }[],
  defaultParts: number,
): { part: number; parts: number; remaining: number } {
  const done = splits
    .filter((s) => s.status !== "cancelada")
    .map((s) => parsePartLabel(s.split_label))
    .filter((x): x is { part: number; parts: number } => x !== null);
  if (done.length === 0) {
    const parts = Math.max(2, Math.floor(defaultParts));
    return { part: 1, parts, remaining: parts };
  }
  const parts = Math.max(...done.map((d) => d.parts));
  const sameRun = done.filter((d) => d.parts === parts);
  const part = Math.min(parts, Math.max(...sameRun.map((d) => d.part)) + 1);
  return { part, parts, remaining: Math.max(1, parts - part + 1) };
}
