// Derivaciones client-side para los gráficos de Reportes. Puras y testeables:
// no consultan nada, sólo reacomodan lo que ya devolvieron las RPCs/consultas.
import { addDays, differenceInCalendarDays, format, startOfDay } from "date-fns";
import { es } from "date-fns/locale";

export interface DayPoint {
  key: string; // yyyy-MM-dd
  label: string; // dd/MM
  long: string; // "lun 06/10"
  total: number;
  count: number;
}

/** Cantidad de días (inclusiva) entre dos fechas. */
export function rangeDays(from: Date, to: Date): number {
  return Math.max(1, differenceInCalendarDays(startOfDay(to), startOfDay(from)) + 1);
}

/** Rango inmediatamente anterior con la misma cantidad de días. */
export function previousRange(from: Date, to: Date): { from: Date; to: Date } {
  const n = rangeDays(from, to);
  const f = addDays(startOfDay(from), -n);
  return { from: f, to: addDays(f, n - 1) };
}

/**
 * Serie diaria continua (rellena con 0 los días sin ventas, que la RPC omite)
 * para que el eje temporal no "salte" días.
 */
export function fillDays(
  from: Date,
  to: Date,
  rows: { day: string; total: number; count: number }[],
): DayPoint[] {
  const byKey = new Map(rows.map((r) => [r.day.slice(0, 10), r]));
  const n = rangeDays(from, to);
  const out: DayPoint[] = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(startOfDay(from), i);
    const key = format(d, "yyyy-MM-dd");
    const r = byKey.get(key);
    out.push({
      key,
      label: format(d, "dd/MM"),
      long: format(d, "EEE dd/MM", { locale: es }),
      total: r?.total ?? 0,
      count: r?.count ?? 0,
    });
  }
  return out;
}

/** Lunes = 0 … domingo = 6. */
export function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Matriz día de semana × hora (hora local del navegador). */
export function hourMatrix(sales: { created_at: string; total: number }[]): {
  totals: number[][];
  counts: number[][];
} {
  const totals = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const s of sales) {
    const d = new Date(s.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const w = weekdayIndex(d);
    const h = d.getHours();
    totals[w]![h]! += Number(s.total) || 0;
    counts[w]![h]! += 1;
  }
  return { totals, counts };
}

/** Totales por hora (sumando todos los días). */
export function byHour(totals: number[][]): number[] {
  const out = new Array<number>(24).fill(0);
  totals.forEach((day) => day.forEach((v, h) => (out[h]! += v)));
  return out;
}

export type CashMovementLite = { type: string; amount: number; created_at: string; payment_method?: string | null };

/**
 * Flujo de caja diario a partir de cash_movements:
 * ingresos = ventas + ingresos manuales; egresos = gastos + anulaciones.
 */
export function cashFlowByDay(
  from: Date,
  to: Date,
  movements: CashMovementLite[],
): { key: string; label: string; long: string; inflow: number; outflow: number }[] {
  const days = fillDays(from, to, []);
  const idx = new Map(days.map((d, i) => [d.key, i]));
  const inflow = new Array<number>(days.length).fill(0);
  const outflow = new Array<number>(days.length).fill(0);
  for (const m of movements) {
    const key = format(new Date(m.created_at), "yyyy-MM-dd");
    const i = idx.get(key);
    if (i == null) continue;
    const amt = Number(m.amount) || 0;
    // ADR-088: la parte de una venta pagada con la seña ya entró al cobrarla.
    if (m.type === "sale" && m.payment_method === "sena") continue;
    if (m.type === "sale" || m.type === "income") inflow[i]! += amt;
    else if (m.type === "expense" || m.type === "sale_void") outflow[i]! += amt;
  }
  return days.map((d, i) => ({
    key: d.key,
    label: d.label,
    long: d.long,
    inflow: inflow[i]!,
    outflow: outflow[i]!,
  }));
}

/** Hora pico (mayor monto) o null si no hay ventas. */
export function peakHour(totals: number[][]): { weekday: number; hour: number; total: number } | null {
  let best: { weekday: number; hour: number; total: number } | null = null;
  totals.forEach((day, w) =>
    day.forEach((v, h) => {
      if (v > 0 && (!best || v > best.total)) best = { weekday: w, hour: h, total: v };
    }),
  );
  return best;
}
