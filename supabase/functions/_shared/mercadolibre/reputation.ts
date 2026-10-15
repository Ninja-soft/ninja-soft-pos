// =============================================================================
// _shared/mercadolibre/reputation.ts (H141 · ADR-132, parte B). PURO.
//
// Reputación del vendedor desde GET /users/{id} (seller_reputation): los
// endpoints /reputation* dan 404 (ANDESMAR lo probó el 24/09/2026). Criterios
// de ANDESMAR (`posventaReglas.js`: termometroDe, nivelMetrica, margen):
//   • umbrales verdes por defecto: reclamos 1 %, cancelaciones 0,5 %,
//     despachos con demora 8 %; ámbar desde el 80 % del umbral;
//   • margen: permitidos = floor(l/100 · ventas), margen = permitidos − valor;
//     si se pasó, faltan = ceil(valor / (l/100)) − ventas sin reclamo.
// Lo usan la Edge (foto diaria y avisos) y la UI.
// =============================================================================

export type MetricKey = "claims" | "cancellations" | "delayed";
export type MetricLevel = "ok" | "ambar" | "rojo";

export interface Thresholds {
  claims: number;
  cancellations: number;
  delayed: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { claims: 1, cancellations: 0.5, delayed: 8 };

export interface MlSellerReputation {
  level_id?: string | null;
  power_seller_status?: string | null;
  transactions?: {
    canceled?: number;
    completed?: number;
    total?: number;
    period?: string;
    ratings?: { negative?: number; neutral?: number; positive?: number };
  };
  metrics?: {
    sales?: { period?: string; completed?: number };
    claims?: MlMetric;
    delayed_handling_time?: MlMetric;
    cancellations?: MlMetric;
  };
}

export interface MlMetric {
  period?: string;
  rate?: number;
  value?: number;
  excluded?: { real_value?: number; real_rate?: number } | null;
}

export interface MetricSnap {
  rate: number;
  value: number;
  period: string | null;
  real_value: number | null;
  real_rate: number | null;
}

export interface ReputationSnap {
  level_id: string | null;
  power_seller_status: string | null;
  sales_completed: number;
  sales_period: string | null;
  claims: MetricSnap;
  cancellations: MetricSnap;
  delayed: MetricSnap;
  ratings: { positive: number; neutral: number; negative: number };
  transactions: { total: number; completed: number; canceled: number; period: string | null };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function metric(m: MlMetric | undefined): MetricSnap {
  return {
    rate: num(m?.rate),
    value: Math.max(0, Math.floor(num(m?.value))),
    period: m?.period ?? null,
    real_value: m?.excluded?.real_value != null ? num(m.excluded.real_value) : null,
    real_rate: m?.excluded?.real_rate != null ? num(m.excluded.real_rate) : null,
  };
}

export function snapshotFromReputation(r: MlSellerReputation | null | undefined): ReputationSnap {
  const t = r?.transactions ?? {};
  return {
    level_id: r?.level_id ?? null,
    power_seller_status: r?.power_seller_status ?? null,
    sales_completed: Math.max(0, Math.floor(num(r?.metrics?.sales?.completed))),
    sales_period: r?.metrics?.sales?.period ?? null,
    claims: metric(r?.metrics?.claims),
    cancellations: metric(r?.metrics?.cancellations),
    delayed: metric(r?.metrics?.delayed_handling_time),
    ratings: { positive: num(t.ratings?.positive), neutral: num(t.ratings?.neutral), negative: num(t.ratings?.negative) },
    transactions: { total: num(t.total), completed: num(t.completed), canceled: num(t.canceled), period: t.period ?? null },
  };
}

/** Escala de ML, de peor a mejor. Los colores son los de Mercado Libre (dato, no tema). */
export const LEVELS = [
  { id: "1_red", label: "Rojo", color: "#ba2d38" },
  { id: "2_orange", label: "Naranja", color: "#c25218" },
  { id: "3_yellow", label: "Amarillo", color: "#ad6800" },
  { id: "4_light_green", label: "Verde claro", color: "#4c8e35" },
  { id: "5_green", label: "Verde", color: "#12805c" },
] as const;

export function levelIndex(levelId: string | null | undefined): number {
  return LEVELS.findIndex((l) => l.id === levelId);
}

export function levelLabel(levelId: string | null | undefined): string {
  return LEVELS.find((l) => l.id === levelId)?.label ?? "Sin nivel todavía";
}

export const POWER_SELLER: Record<string, string> = {
  silver: "MercadoLíder",
  gold: "MercadoLíder Gold",
  platinum: "MercadoLíder Platinum",
};

/** "60 days" -> "60 días", "historic" -> "histórico". */
export function periodLabel(p: string | null | undefined): string {
  if (!p) return "";
  if (p === "historic") return "histórico";
  const m = /^(\d+)\s*(day|days|month|months)$/.exec(p.trim());
  if (!m) return p;
  return `${m[1]} ${m[2]!.startsWith("month") ? (m[1] === "1" ? "mes" : "meses") : m[1] === "1" ? "día" : "días"}`;
}

/** Nivel de una métrica contra su umbral verde (rate es fracción: 0,012 = 1,2 %). */
export function metricLevel(rate: number, thresholdPct: number): MetricLevel {
  const pct = rate * 100;
  if (pct >= thresholdPct) return "rojo";
  if (pct >= 0.8 * thresholdPct) return "ambar";
  return "ok";
}

/** Relleno de la barra (0 a 100) contra el umbral. */
export function barFill(rate: number, thresholdPct: number): number {
  if (!(thresholdPct > 0)) return 0;
  return Math.max(0, Math.min(100, ((rate * 100) / thresholdPct) * 100));
}

export interface Margin {
  /** Casos permitidos en el período sin pasar el umbral. */
  allowed: number;
  /** >= 0: cuántos casos más entran; < 0: se pasó. */
  margin: number;
  /** Si se pasó: ventas sin casos que hacen falta para volver al umbral. */
  salesNeeded: number | null;
}

export function margin(sales: number, value: number, thresholdPct: number): Margin {
  const l = thresholdPct / 100;
  const allowed = Math.floor(l * sales + 1e-9);
  const m = allowed - value;
  if (m >= 0) return { allowed, margin: m, salesNeeded: null };
  const needed = l > 0 ? Math.ceil(value / l - 1e-9) - sales : null;
  return { allowed, margin: m, salesNeeded: needed !== null ? Math.max(needed, 0) : null };
}

const NOUN: Record<MetricKey, [string, string, string]> = {
  claims: ["reclamo", "reclamos", "un reclamo"],
  cancellations: ["cancelación", "cancelaciones", "una cancelación"],
  delayed: ["despacho con demora", "despachos con demora", "un despacho con demora"],
};

export function marginText(key: MetricKey, m: Margin, thresholdPct: number): string {
  const [one, many, withArticle] = NOUN[key];
  const pct = `${thresholdPct.toLocaleString("es-AR")} %`;
  if (m.margin > 0) return `Te quedan ${m.margin} ${m.margin === 1 ? one : many} de margen antes de pasar el ${pct} (tope: ${m.allowed}).`;
  if (m.margin === 0) return `Estás justo en el límite del ${pct}: ${withArticle} más te saca del verde.`;
  return `Te pasaste del ${pct}. Te faltan ${m.salesNeeded ?? "?"} ventas sin ${many} para volver.`;
}

export const METRIC_LABEL: Record<MetricKey, string> = {
  claims: "Reclamos",
  cancellations: "Cancelaciones",
  delayed: "Despachos con demora",
};

export interface Crossing {
  key: MetricKey;
  from: MetricLevel;
  to: MetricLevel;
}

const ORDER: Record<MetricLevel, number> = { ok: 0, ambar: 1, rojo: 2 };

/** Métricas que empeoraron de nivel respecto de la foto anterior (para avisar). */
export function crossings(prev: ReputationSnap | null, curr: ReputationSnap, th: Thresholds): Crossing[] {
  if (!prev) return [];
  const out: Crossing[] = [];
  for (const key of ["claims", "cancellations", "delayed"] as MetricKey[]) {
    const from = metricLevel(prev[key].rate, th[key]);
    const to = metricLevel(curr[key].rate, th[key]);
    if (ORDER[to] > ORDER[from]) out.push({ key, from, to });
  }
  return out;
}

/** Umbrales válidos (los mismos rangos que ANDESMAR). */
export function cleanThresholds(t: Partial<Thresholds> | null | undefined): Thresholds {
  const clamp = (v: unknown, min: number, max: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : d;
  };
  return {
    claims: clamp(t?.claims, 0.1, 20, DEFAULT_THRESHOLDS.claims),
    cancellations: clamp(t?.cancellations, 0.1, 20, DEFAULT_THRESHOLDS.cancellations),
    delayed: clamp(t?.delayed, 0.1, 50, DEFAULT_THRESHOLDS.delayed),
  };
}

/** Fecha del día en Argentina (UTC-3, sin horario de verano) para la foto diaria. */
export function arDate(ms = Date.now()): string {
  return new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
}
