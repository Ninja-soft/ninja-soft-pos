// =============================================================================
// Cotización del dólar (ADR-135). Lógica pura, sin red ni base: la usan la Edge
// platform_fx_sync (parseo de ArgentinaDatos), el motor de liquidación del staff
// (F21, cotización de un día) y el panel interno (gráfico y tarjeta).
//
// Fuente: https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial
//   · histórico: GET .../oficial            → [{ casa, compra, venta, fecha }]
//   · un día:    GET .../oficial/YYYY/MM/DD → { casa, compra, venta, fecha }
// Se usa la VENTA del oficial. Fechas 'YYYY-MM-DD' (día de Argentina).
//
// Reglas:
//   · manual > API: si el staff cargó la cotización de un día, esa manda.
//   · "del día o la última anterior": para una fecha se toma la cotización de
//     ese día y, si no hay (fin de semana, feriado, la API no corrió), la
//     última disponible antes.
// =============================================================================

export type FxSource = "api" | "manual";

export interface FxApiRow {
  date: string;
  casa: string;
  compra: number | null;
  venta: number;
}

/** Una fila de platform_fx_rates (o de platform_fx_daily_rates) ya normalizada. */
export interface DailyFxRate {
  date: string;
  /** Pesos por 1 USD (venta). */
  rate: number;
  source: FxSource;
  /** Nota de la carga manual o de la fuente ("ArgentinaDatos", "BNA venta"). */
  note?: string | null;
}

export const FX_API_BASE = "https://api.argentinadatos.com/v1/cotizaciones/dolares";
export const FX_CASA = "oficial";
export const FX_SOURCE_LABEL: Record<FxSource, string> = { api: "ArgentinaDatos", manual: "Carga manual" };
/** Más de estos días entre la fecha pedida y la cotización usada: se avisa. */
export const FX_STALE_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Una cotización de ArgentinaDatos; null si no sirve (sin fecha válida o venta ≤ 0). */
export function parseFxRow(raw: unknown, casa = FX_CASA): FxApiRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = String(r.fecha ?? "").slice(0, 10);
  if (!DAY_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  const rowCasa = String(r.casa ?? casa).trim().toLowerCase();
  if (rowCasa !== casa) return null;
  const venta = toNumber(r.venta);
  if (venta === null || venta <= 0 || venta > 1_000_000) return null;
  const compra = toNumber(r.compra);
  return { date, casa: rowCasa, compra: compra !== null && compra > 0 ? compra : null, venta: Math.round(venta * 10_000) / 10_000 };
}

/**
 * Respuesta de la API (un objeto o una lista) a filas válidas, una por día
 * (si un día viene repetido, gana la última), ordenadas por fecha.
 */
export function parseFxResponse(body: unknown, casa = FX_CASA): FxApiRow[] {
  const list = Array.isArray(body) ? body : body ? [body] : [];
  const byDay = new Map<string, FxApiRow>();
  for (const raw of list) {
    const row = parseFxRow(raw, casa);
    if (row) byDay.set(row.date, row);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Suma días a una fecha 'YYYY-MM-DD' (sin zonas horarias). */
export function addDaysISO(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Filas de la API desde `from` inclusive (ventana del cron o del backfill). */
export function rowsSince(rows: FxApiRow[], from: string): FxApiRow[] {
  return rows.filter((r) => r.date >= from);
}

/** Una cotización por día: la manual gana sobre la de la API. Ordenadas por fecha. */
export function effectiveDaily(rows: DailyFxRate[]): DailyFxRate[] {
  const byDay = new Map<string, DailyFxRate>();
  for (const r of rows) {
    if (!(r.rate > 0) || !DAY_RE.test(r.date)) continue;
    const prev = byDay.get(r.date);
    if (!prev || (prev.source === "api" && r.source === "manual")) byDay.set(r.date, r);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface FxPick extends DailyFxRate {
  /** Días entre la cotización usada y la fecha pedida (0 = la del día). */
  lagDays: number;
}

/** Cotización del día `day` o, si no hay, la última anterior (manual > API). null si no hay ninguna. */
export function rateOn(rows: DailyFxRate[], day: string): FxPick | null {
  const eff = effectiveDaily(rows);
  let pick: DailyFxRate | null = null;
  for (const r of eff) {
    if (r.date > day) break;
    pick = r;
  }
  return pick ? { ...pick, lagDays: daysBetween(pick.date, day) } : null;
}

export type FxRange = "1M" | "3M" | "6M" | "1A" | "2A";
export const FX_RANGES: { value: FxRange; label: string; months: number }[] = [
  { value: "1M", label: "1M", months: 1 },
  { value: "3M", label: "3M", months: 3 },
  { value: "6M", label: "6M", months: 6 },
  { value: "1A", label: "1A", months: 12 },
  { value: "2A", label: "2A", months: 24 },
];

/** Primer día del rango que termina en `today` ('YYYY-MM-DD'). */
export function rangeStart(today: string, range: FxRange): string {
  const months = FX_RANGES.find((r) => r.value === range)?.months ?? 1;
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) - months;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${String(ty).padStart(4, "0")}-${String(tm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
