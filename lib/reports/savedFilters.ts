// Filtros guardables, presets por usuario y orden de Reportes (TX-5 · ADR-100).
// PURO: sin DOM ni Supabase. Se persiste en public.users.settings
// (lib/theme/preferences.ts), igual que la visibilidad de reportes: viaja con
// el usuario entre dispositivos y no pisa otras claves (apariencia, POS).

import {
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
  endOfMonth,
} from "date-fns";

/** Rango guardado: relativo (se recalcula cada día) o fijo. */
export type RangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "month"
  | "prev_month"
  | "custom";

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: "Hoy",
  yesterday: "Ayer",
  "7d": "Últimos 7 días",
  "30d": "Últimos 30 días",
  month: "Este mes",
  prev_month: "Mes pasado",
  custom: "Rango fijo",
};

export interface ReportFilters {
  range: RangePreset;
  /** Sólo con range = "custom": fechas yyyy-MM-dd (día local). */
  from: string | null;
  to: string | null;
  /** null = todas las sucursales que el usuario ve (consolidado). */
  storeId: string | null;
  /** payments.method; null = todos los medios. */
  method: string | null;
  /** categories.id (incluye subcategorías); null = todas. */
  categoryId: string | null;
}

export const DEFAULT_FILTERS: ReportFilters = {
  range: "7d",
  from: null,
  to: null,
  storeId: null,
  method: null,
  categoryId: null,
};

export interface ReportPreset {
  id: string;
  name: string;
  filters: ReportFilters;
}

export interface ReportPresetState {
  presets: ReportPreset[];
  /** Preset que se aplica al abrir Reportes (null = el rango de siempre). */
  defaultId: string | null;
}

export const EMPTY_PRESETS: ReportPresetState = {
  presets: [],
  defaultId: null,
};
export const MAX_PRESETS = 12;
export const MAX_PRESET_NAME = 40;

const RANGES = Object.keys(RANGE_PRESET_LABELS) as RangePreset[];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHOD = /^[a-z_]{1,32}$/;

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Sanea filtros que vienen de users.settings (jsonb editable por el usuario). */
export function sanitizeFilters(raw: unknown): ReportFilters {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const range = RANGES.includes(o.range as RangePreset)
    ? (o.range as RangePreset)
    : DEFAULT_FILTERS.range;
  const from = str(o.from);
  const to = str(o.to);
  const custom =
    range === "custom" && from && ISO_DAY.test(from) ? true : false;
  const storeId = str(o.storeId);
  const method = str(o.method);
  const categoryId = str(o.categoryId);
  return {
    range: range === "custom" && !custom ? DEFAULT_FILTERS.range : range,
    from: custom ? from : null,
    to: custom ? (to && ISO_DAY.test(to) && to >= from! ? to : from) : null,
    storeId: storeId && UUID.test(storeId) ? storeId : null,
    method: method && METHOD.test(method) ? method : null,
    categoryId: categoryId && UUID.test(categoryId) ? categoryId : null,
  };
}

export function sanitizePresets(raw: unknown): ReportPresetState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(o.presets) ? o.presets : [];
  const seen = new Set<string>();
  const presets: ReportPreset[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name)?.trim().slice(0, MAX_PRESET_NAME);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    presets.push({ id, name, filters: sanitizeFilters(r.filters) });
    if (presets.length >= MAX_PRESETS) break;
  }
  const defaultId = str(o.defaultId);
  return {
    presets,
    defaultId: defaultId && seen.has(defaultId) ? defaultId : null,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Día local yyyy-MM-dd (no UTC: en Argentina a la noche ya sería mañana). */
export function toLocalDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fromLocalDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/** Rango concreto (días locales, ambos inclusive) para hoy. */
export function resolveRange(
  f: Pick<ReportFilters, "range" | "from" | "to">,
  now: Date = new Date(),
): {
  from: Date;
  to: Date;
} {
  const today = startOfDay(now);
  switch (f.range) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = subDays(today, 1);
      return { from: y, to: y };
    }
    case "30d":
      return { from: subDays(today, 29), to: today };
    case "month":
      return { from: startOfMonth(today), to: today };
    case "prev_month": {
      const p = subMonths(today, 1);
      return { from: startOfMonth(p), to: startOfDay(endOfMonth(p)) };
    }
    case "custom":
      if (f.from) {
        const from = fromLocalDay(f.from);
        const to = f.to ? fromLocalDay(f.to) : from;
        return to < from ? { from: to, to: from } : { from, to };
      }
      return { from: subDays(today, 6), to: today };
    case "7d":
    default:
      return { from: subDays(today, 6), to: today };
  }
}

/** Reconoce un rango elegido a mano como preset relativo (si coincide). */
export function detectRange(
  from: Date,
  to: Date,
  now: Date = new Date(),
): Pick<ReportFilters, "range" | "from" | "to"> {
  const a = toLocalDay(from);
  const b = toLocalDay(to);
  for (const r of [
    "today",
    "yesterday",
    "7d",
    "30d",
    "month",
    "prev_month",
  ] as const) {
    const x = resolveRange({ range: r, from: null, to: null }, now);
    if (toLocalDay(x.from) === a && toLocalDay(x.to) === b)
      return { range: r, from: null, to: null };
  }
  return { range: "custom", from: a, to: b };
}

export function newPresetId(): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `p_${Date.now().toString(36)}${rnd}`;
}

/** Agrega o reemplaza (mismo nombre, sin distinguir mayúsculas) un preset. */
export function upsertPreset(
  state: ReportPresetState,
  name: string,
  filters: ReportFilters,
  id: string = newPresetId(),
):
  | { state: ReportPresetState; id: string }
  | { error: "empty_name" | "too_many" } {
  const clean = name.trim().slice(0, MAX_PRESET_NAME);
  if (!clean) return { error: "empty_name" };
  const existing = state.presets.find(
    (p) => p.name.toLowerCase() === clean.toLowerCase(),
  );
  if (existing) {
    return {
      id: existing.id,
      state: {
        ...state,
        presets: state.presets.map((p) =>
          p.id === existing.id ? { ...p, name: clean, filters } : p,
        ),
      },
    };
  }
  if (state.presets.length >= MAX_PRESETS) return { error: "too_many" };
  return {
    id,
    state: {
      ...state,
      presets: [...state.presets, { id, name: clean, filters }],
    },
  };
}

export function removePreset(
  state: ReportPresetState,
  id: string,
): ReportPresetState {
  return {
    presets: state.presets.filter((p) => p.id !== id),
    defaultId: state.defaultId === id ? null : state.defaultId,
  };
}

export function setDefaultPreset(
  state: ReportPresetState,
  id: string | null,
): ReportPresetState {
  if (id && !state.presets.some((p) => p.id === id)) return state;
  return { ...state, defaultId: id };
}

/** Cantidad de filtros además del rango (para el contador del botón). */
export function activeFilterCount(f: ReportFilters): number {
  return (f.storeId ? 1 : 0) + (f.method ? 1 : 0) + (f.categoryId ? 1 : 0);
}

// ── Orden de reportes ────────────────────────────────────────────────────────

/**
 * Orden efectivo: el guardado (sin claves desconocidas ni repetidas) y al
 * final las claves nuevas en su orden de catálogo. Así un reporte agregado en
 * una versión futura aparece aunque el usuario ya haya ordenado los suyos.
 */
export function resolveOrder<K extends string>(
  saved: unknown,
  catalog: readonly K[],
): K[] {
  const known = new Set<string>(catalog);
  const out: K[] = [];
  if (Array.isArray(saved)) {
    for (const k of saved) {
      if (typeof k === "string" && known.has(k) && !out.includes(k as K))
        out.push(k as K);
    }
  }
  for (const k of catalog) if (!out.includes(k)) out.push(k);
  return out;
}

/** Mueve una clave un lugar arriba (-1) o abajo (+1) dentro de `within`. */
export function moveInOrder<K extends string>(
  order: K[],
  key: K,
  dir: -1 | 1,
  within?: readonly K[],
): K[] {
  const visible = within ? order.filter((k) => within.includes(k)) : order;
  const i = visible.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return order;
  const other = visible[j]!;
  const a = order.indexOf(key);
  const b = order.indexOf(other);
  const next = [...order];
  next[a] = other;
  next[b] = key;
  return next;
}
