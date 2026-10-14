// =============================================================================
// Fechas para la liquidación del staff (F21 · ADR-121). Todo en días
// calendario 'YYYY-MM-DD' (hora de Argentina ya resuelta por la base): sin
// zonas horarias ni Date locales, así el cálculo da igual en Deno, Node y el
// navegador. Un "período" es el primer día del mes ('2026-10-01').
// =============================================================================

const DAY_MS = 86_400_000;

function parts(day: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) throw new Error(`fecha inválida: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function makeDay(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Días del mes (m de 1 a 12). */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Primer día del mes de la fecha. */
export function periodOf(day: string): string {
  const [y, m] = parts(day);
  return makeDay(y, m, 1);
}

/** Último día del mes del período. */
export function periodEnd(period: string): string {
  const [y, m] = parts(period);
  return makeDay(y, m, daysInMonth(y, m));
}

/** Índice absoluto del mes (año × 12 + mes − 1): sirve para restar meses. */
export function monthIndex(day: string): number {
  const [y, m] = parts(day);
  return y * 12 + (m - 1);
}

export function periodFromIndex(idx: number): string {
  return makeDay(Math.floor(idx / 12), (idx % 12) + 1, 1);
}

/** Suma meses conservando el día; si el mes es más corto, el último día (31/01 + 1 = 28/02). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return makeDay(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return makeDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Lista de días del mes del período. */
export function daysOfPeriod(period: string): string[] {
  const [y, m] = parts(period);
  const n = daysInMonth(y, m);
  const out: string[] = [];
  for (let d = 1; d <= n; d++) out.push(makeDay(y, m, d));
  return out;
}

/** a ≤ day ≤ b (b null = abierto). */
export function inRange(day: string, from: string | null, to: string | null): boolean {
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** '2026-10-01' → 'octubre 2026'. */
export function periodLabel(period: string): string {
  const [y, m] = parts(period);
  return `${MONTHS[m - 1]} ${y}`;
}
