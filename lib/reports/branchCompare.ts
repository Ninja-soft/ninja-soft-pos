// lib/reports/branchCompare.ts
//
// Comparación entre sucursales (F17 · H97 · ADR-057). PURO: normaliza la
// respuesta de branch_compare_report, calcula diferencias contra el promedio,
// mejor y peor sucursal por métrica, ranking y arma las hojas del XLSX (una
// por sucursal más el consolidado). Sin React ni Supabase.

export interface CompareMethodRow {
  method: string;
  total: number;
  count: number;
}
export interface CompareDayRow {
  day: string;
  total: number;
  count: number;
}

export interface CompareStore {
  store_id: string;
  name: string;
  short_name: string | null;
  color: string | null;
  archived: boolean;
  total: number;
  count: number;
  avg_ticket: number;
  items_qty: number;
  voids_count: number;
  voids_total: number;
  returns_count: number;
  returns_total: number;
  net_total: number;
  margin: number;
  margin_pct: number | null;
  cost_coverage_pct: number;
  z_count: number;
  cash_diff: number;
  cash_diff_abs: number;
  z_with_diff: number;
  buyers: number;
  returning_buyers: number;
  new_customers: number;
  by_method: CompareMethodRow[];
  by_day: CompareDayRow[];
}

export interface CompareTotals {
  total: number;
  count: number;
  avg_ticket: number;
  items_qty: number;
  returns_total: number;
  voids_total: number;
  margin: number;
  margin_pct: number | null;
  cost_coverage_pct: number;
  cash_diff: number;
  new_customers: number;
}

export interface BranchCompareReport {
  stores: CompareStore[];
  totals: CompareTotals;
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const nOrNull = (v: unknown): number | null =>
  v == null || v === "" ? null : n(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

/** Normaliza el JSON del RPC (numeric llega como number o string). */
export function normalizeCompareReport(raw: unknown): BranchCompareReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  const stores = Array.isArray(r.stores)
    ? (r.stores as Record<string, unknown>[])
    : [];
  const t = (r.totals ?? {}) as Record<string, unknown>;
  return {
    stores: stores.map((s) => ({
      store_id: String(s.store_id ?? ""),
      name: str(s.name) ?? "Sucursal",
      short_name: str(s.short_name),
      color: str(s.color),
      archived: s.archived === true,
      total: n(s.total),
      count: n(s.count),
      avg_ticket: n(s.avg_ticket),
      items_qty: n(s.items_qty),
      voids_count: n(s.voids_count),
      voids_total: n(s.voids_total),
      returns_count: n(s.returns_count),
      returns_total: n(s.returns_total),
      net_total: n(s.net_total),
      margin: n(s.margin),
      margin_pct: nOrNull(s.margin_pct),
      cost_coverage_pct: n(s.cost_coverage_pct),
      z_count: n(s.z_count),
      cash_diff: n(s.cash_diff),
      cash_diff_abs: n(s.cash_diff_abs),
      z_with_diff: n(s.z_with_diff),
      buyers: n(s.buyers),
      returning_buyers: n(s.returning_buyers),
      new_customers: n(s.new_customers),
      by_method: (Array.isArray(s.by_method)
        ? (s.by_method as Record<string, unknown>[])
        : []
      ).map((m) => ({
        method: String(m.method ?? ""),
        total: n(m.total),
        count: n(m.count),
      })),
      by_day: (Array.isArray(s.by_day)
        ? (s.by_day as Record<string, unknown>[])
        : []
      ).map((d) => ({
        day: String(d.day ?? ""),
        total: n(d.total),
        count: n(d.count),
      })),
    })),
    totals: {
      total: n(t.total),
      count: n(t.count),
      avg_ticket: n(t.avg_ticket),
      items_qty: n(t.items_qty),
      returns_total: n(t.returns_total),
      voids_total: n(t.voids_total),
      margin: n(t.margin),
      margin_pct: nOrNull(t.margin_pct),
      cost_coverage_pct: n(t.cost_coverage_pct),
      cash_diff: n(t.cash_diff),
      new_customers: n(t.new_customers),
    },
  };
}

/** Nombre corto para tablas y gráficos. */
export function storeLabel(
  s: Pick<CompareStore, "name" | "short_name">,
): string {
  return s.short_name?.trim() || s.name;
}

// ── Métricas comparables ─────────────────────────────────────────────────────

export type MetricFormat = "currency" | "number" | "percent";

export interface CompareMetric {
  key: string;
  label: string;
  format: MetricFormat;
  /** "high": más es mejor; "low": menos es mejor; null: sin mejor/peor. */
  better: "high" | "low" | null;
  value: (s: CompareStore) => number | null;
  /** Aclaración corta bajo el valor (p. ej. cobertura de costo). */
  note?: (s: CompareStore) => string | null;
}

export const COMPARE_METRICS: CompareMetric[] = [
  {
    key: "total",
    label: "Ventas",
    format: "currency",
    better: "high",
    value: (s) => s.total,
  },
  {
    key: "count",
    label: "Tickets",
    format: "number",
    better: "high",
    value: (s) => s.count,
  },
  {
    key: "avg_ticket",
    label: "Ticket promedio",
    format: "currency",
    better: "high",
    value: (s) => s.avg_ticket,
  },
  {
    key: "items_qty",
    label: "Unidades",
    format: "number",
    better: "high",
    value: (s) => s.items_qty,
  },
  {
    key: "returns_total",
    label: "Devoluciones",
    format: "currency",
    better: "low",
    value: (s) => s.returns_total,
    note: (s) => (s.returns_count ? `${s.returns_count} devoluciones` : null),
  },
  {
    key: "voids_total",
    label: "Anulaciones",
    format: "currency",
    better: "low",
    value: (s) => s.voids_total,
    note: (s) => (s.voids_count ? `${s.voids_count} anuladas` : null),
  },
  {
    key: "margin",
    label: "Margen bruto",
    format: "currency",
    better: "high",
    value: (s) => s.margin,
    note: (s) =>
      s.total > 0
        ? `costo cargado en ${formatPct(s.cost_coverage_pct)} de lo vendido`
        : null,
  },
  {
    key: "margin_pct",
    label: "Margen %",
    format: "percent",
    better: "high",
    value: (s) => s.margin_pct,
  },
  {
    key: "cash_diff_abs",
    label: "Diferencias de caja",
    format: "currency",
    better: "low",
    value: (s) => s.cash_diff_abs,
    note: (s) =>
      s.z_count
        ? `${s.z_with_diff} de ${s.z_count} cierres con diferencia`
        : "sin cierres",
  },
  {
    key: "new_customers",
    label: "Clientes nuevos",
    format: "number",
    better: "high",
    value: (s) => s.new_customers,
  },
  {
    key: "buyers",
    label: "Compradores",
    format: "number",
    better: "high",
    value: (s) => s.buyers,
  },
  {
    key: "returning_buyers",
    label: "Recurrentes",
    format: "number",
    better: "high",
    value: (s) => s.returning_buyers,
    note: (s) =>
      s.buyers
        ? `${formatPct((s.returning_buyers / s.buyers) * 100)} de los compradores`
        : null,
  },
];

export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "s/d";
  return `${v.toLocaleString("es-AR", { maximumFractionDigits: 1 })} %`;
}

/** Promedio de la métrica entre las sucursales con dato. */
export function metricAverage(
  stores: CompareStore[],
  metric: CompareMetric,
): number | null {
  const vals = stores.map(metric.value).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, v) => a + v, 0) / vals.length;
}

/** Diferencia % contra el promedio (null si no hay base). */
export function deltaVsAverage(
  value: number | null,
  average: number | null,
): number | null {
  if (value == null || average == null || average === 0) return null;
  return ((value - average) / Math.abs(average)) * 100;
}

/**
 * Mejor y peor sucursal de una métrica. null cuando no aplica: menos de 2
 * sucursales con dato, métrica sin dirección o todas iguales.
 */
export function bestWorst(
  stores: CompareStore[],
  metric: CompareMetric,
): { best: string; worst: string } | null {
  if (!metric.better) return null;
  const vals = stores
    .map((s) => ({ id: s.store_id, v: metric.value(s) }))
    .filter((x): x is { id: string; v: number } => x.v != null);
  if (vals.length < 2) return null;
  const sorted = [...vals].sort((a, b) =>
    metric.better === "high" ? b.v - a.v : a.v - b.v,
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first.v === last.v) return null;
  return { best: first.id, worst: last.id };
}

/** Ranking por ventas (desc), desempata por nombre. */
export function rankByTotal(stores: CompareStore[]): CompareStore[] {
  return [...stores].sort(
    (a, b) =>
      b.total - a.total || storeLabel(a).localeCompare(storeLabel(b), "es"),
  );
}

/** Participación de cada sucursal en las ventas (0 a 100). */
export function shareOfTotal(stores: CompareStore[]): Record<string, number> {
  const sum = stores.reduce((a, s) => a + s.total, 0);
  return Object.fromEntries(
    stores.map((s) => [s.store_id, sum > 0 ? (s.total / sum) * 100 : 0]),
  );
}

/** Medios presentes (orden por total del período) para series apiladas. */
export function methodsUnion(stores: CompareStore[]): string[] {
  const acc = new Map<string, number>();
  for (const s of stores)
    for (const m of s.by_method)
      acc.set(m.method, (acc.get(m.method) ?? 0) + m.total);
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** Matriz medio × sucursal. `percent` = participación dentro de cada sucursal. */
export function methodMatrix(
  stores: CompareStore[],
  methods: string[],
  percent = false,
): { method: string; values: number[] }[] {
  return methods.map((method) => ({
    method,
    values: stores.map((s) => {
      const v = s.by_method.find((m) => m.method === method)?.total ?? 0;
      if (!percent) return v;
      const sum = s.by_method.reduce((a, m) => a + m.total, 0);
      return sum > 0 ? Math.round((v / sum) * 1000) / 10 : 0;
    }),
  }));
}

/** Días del período (yyyy-mm-dd, inclusivo) con el total de cada sucursal (0 si no vendió). */
export function dailySeries(
  stores: CompareStore[],
  days: string[],
): { store_id: string; values: number[] }[] {
  return stores.map((s) => {
    const byDay = new Map(s.by_day.map((d) => [d.day, d.total]));
    return { store_id: s.store_id, values: days.map((d) => byDay.get(d) ?? 0) };
  });
}

// ── XLSX: una hoja por sucursal + consolidado ────────────────────────────────

export interface SheetSpec {
  name: string;
  title?: string;
  columns: {
    header: string;
    key: string;
    type?: "text" | "money" | "number";
    width?: number;
  }[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
}

/** Nombre de hoja válido para Excel (31 caracteres, sin []:*?/\) y único. */
export function sheetName(raw: string, used: Set<string>): string {
  const base = (
    raw
      .replace(/[[\]:*?/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Hoja"
  ).slice(0, 31);
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${i++})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function kpiRows(s: CompareStore | (CompareTotals & { name?: string })) {
  const rows: { k: string; v: number | string }[] = [
    { k: "Ventas", v: s.total },
    { k: "Tickets", v: s.count },
    { k: "Ticket promedio", v: s.avg_ticket },
    { k: "Unidades", v: s.items_qty },
    { k: "Devoluciones", v: s.returns_total },
    { k: "Anulaciones", v: s.voids_total },
    { k: "Margen bruto estimado", v: s.margin },
    { k: "Margen %", v: s.margin_pct == null ? "s/d" : s.margin_pct },
    { k: "Cobertura de costo %", v: s.cost_coverage_pct },
    { k: "Diferencia de caja (neta)", v: s.cash_diff },
    { k: "Clientes nuevos", v: s.new_customers },
  ];
  if ("buyers" in s) {
    rows.push(
      { k: "Compradores", v: s.buyers },
      { k: "Compradores recurrentes", v: s.returning_buyers },
    );
  }
  return rows;
}

/**
 * Hojas del XLSX: "Consolidado" (KPIs del total y una fila por sucursal) y
 * una hoja por sucursal con sus KPIs, medios y ventas por día.
 */
export function compareSheets(
  report: BranchCompareReport,
  opts: { periodLabel: string; methodLabel?: (m: string) => string },
): SheetSpec[] {
  const ml = opts.methodLabel ?? ((m: string) => m);
  const used = new Set<string>();
  const sheets: SheetSpec[] = [];
  const consolidated = sheetName("Consolidado", used);
  sheets.push({
    name: consolidated,
    title: `Comparativo de sucursales · ${opts.periodLabel}`,
    columns: [
      { header: "Sucursal", key: "store", width: 22 },
      { header: "Ventas", key: "total", type: "money" },
      { header: "Tickets", key: "count", type: "number" },
      { header: "Ticket prom.", key: "avg_ticket", type: "money" },
      { header: "Unidades", key: "items_qty", type: "number" },
      { header: "Devoluciones", key: "returns_total", type: "money" },
      { header: "Anulaciones", key: "voids_total", type: "money" },
      { header: "Margen", key: "margin", type: "money" },
      { header: "Margen %", key: "margin_pct", type: "number" },
      { header: "Dif. caja", key: "cash_diff", type: "money" },
      { header: "Clientes nuevos", key: "new_customers", type: "number" },
      { header: "Compradores", key: "buyers", type: "number" },
    ],
    rows: report.stores.map((s) => ({
      store: s.archived ? `${s.name} (archivada)` : s.name,
      total: s.total,
      count: s.count,
      avg_ticket: s.avg_ticket,
      items_qty: s.items_qty,
      returns_total: s.returns_total,
      voids_total: s.voids_total,
      margin: s.margin,
      margin_pct: s.margin_pct ?? 0,
      cash_diff: s.cash_diff,
      new_customers: s.new_customers,
      buyers: s.buyers,
    })),
    totals: {
      total: report.totals.total,
      count: report.totals.count,
      items_qty: report.totals.items_qty,
      returns_total: report.totals.returns_total,
      voids_total: report.totals.voids_total,
      margin: report.totals.margin,
      cash_diff: report.totals.cash_diff,
      new_customers: report.totals.new_customers,
    },
  });

  for (const s of report.stores) {
    const methodsSum = s.by_method.reduce((a, m) => a + m.total, 0);
    sheets.push({
      name: sheetName(storeLabel(s), used),
      title: `${s.name} · ${opts.periodLabel}`,
      columns: [
        { header: "Métrica / Día / Medio", key: "k", width: 26 },
        { header: "Valor", key: "v", type: "money", width: 18 },
        { header: "Ventas", key: "c", type: "number" },
      ],
      rows: [
        ...kpiRows(s).map((r) => ({ k: r.k, v: r.v, c: "" })),
        { k: "", v: "", c: "" },
        { k: "Medios de pago", v: "", c: "" },
        ...s.by_method.map((m) => ({
          k: ml(m.method),
          v: m.total,
          c: m.count,
        })),
        { k: "Total medios", v: methodsSum, c: "" },
        { k: "", v: "", c: "" },
        { k: "Ventas por día", v: "", c: "" },
        ...s.by_day.map((d) => ({ k: d.day, v: d.total, c: d.count })),
      ],
    });
  }
  return sheets;
}
