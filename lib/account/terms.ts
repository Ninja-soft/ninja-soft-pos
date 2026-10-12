// Plazos y cuotas de cuenta corriente (Cuenta corriente v2).
//
// ESPEJO del SQL: account_due_date() y payment_account_charge() en
// supabase/migrations/20261011180000_cuenta_corriente_v2.sql. Si cambia una
// regla acá, cambia allá (y viceversa); los casos de tests/unit/account-terms
// están documentados en los comentarios del SQL.
//
// Las fechas viajan como ISO "yyyy-mm-dd" (date de Postgres) y se operan en UTC
// para no depender de la zona horaria del navegador.

export type TermsMode = "days" | "monthly_cutoff";

export interface Terms {
  mode: TermsMode;
  days: number;
  cutoff_day: number;
  due_day: number;
}

export interface Installment {
  installment_no: number;
  amount: number;
  due_date: string;
}

const DAY_MS = 86_400_000;

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function toIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parseIso(iso);
  return toIso(utc(y, m, d) + days * DAY_MS);
}

// Suma meses y recorta el día al último del mes destino (31/01 + 1 → 28/02).
export function addMonthsClamped(iso: string, months: number, day?: number): string {
  const { y, m, d } = parseIso(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(day ?? d, lastDayOfMonth(ny, nm));
  return toIso(utc(ny, nm, nd));
}

// Diferencia en días entre dos fechas ISO (b − a).
export function diffDays(a: string, b: string): number {
  const pa = parseIso(a);
  const pb = parseIso(b);
  return Math.round((utc(pb.y, pb.m, pb.d) - utc(pa.y, pa.m, pa.d)) / DAY_MS);
}

/**
 * Vencimiento de una compra a cuenta.
 * - days: fecha + días.
 * - monthly_cutoff: compras hasta el día de corte (inclusive) vencen el
 *   `due_day` del mes siguiente; después del corte, el `due_day` del otro mes.
 *   El día de vencimiento se recorta al último día del mes.
 */
export function dueDateFor(saleDate: string, terms: Terms): string {
  if (terms.mode === "monthly_cutoff") {
    const { d } = parseIso(saleDate);
    const monthsAhead = d <= terms.cutoff_day ? 1 : 2;
    return addMonthsClamped(saleDate, monthsAhead, terms.due_day);
  }
  return addDays(saleDate, Math.max(0, Math.trunc(terms.days)));
}

/**
 * Cronograma de cuotas. El total se reparte en centavos; el resto de la
 * división va a la ÚLTIMA cuota. La cuota 1 vence en `firstDue`; las
 * siguientes cada `interval_days` (modo días) o el mismo día de los meses
 * siguientes (modo corte mensual).
 */
export function installmentSchedule(
  total: number,
  count: number,
  firstDue: string,
  opts: { mode: TermsMode; interval_days: number },
): Installment[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("invalid_installments");
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const out: Installment[] = [];
  for (let i = 0; i < count; i++) {
    const amountCents = i === count - 1 ? cents - base * (count - 1) : base;
    const due =
      opts.mode === "monthly_cutoff"
        ? addMonthsClamped(firstDue, i)
        : addDays(firstDue, i * Math.max(1, Math.trunc(opts.interval_days)));
    out.push({ installment_no: i + 1, amount: amountCents / 100, due_date: due });
  }
  return out;
}

// Hoy en ISO según la hora local del navegador (para la UI).
export function todayIso(): string {
  const d = new Date();
  return toIso(utc(d.getFullYear(), d.getMonth() + 1, d.getDate()));
}
