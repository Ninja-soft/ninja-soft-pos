// =============================================================================
// Score de activación y cuentas trabadas (F15 · H71 · ADR-089). Puro.
//
// Fuentes (sin duplicar):
//  * internal_activation_overview(): señales de puesta en marcha por negocio
//    (onboarding_tenant_signals, la misma definición que usan
//    onboarding_status y onboarding_activation_status de ADR-086).
//  * internal_tenant_health (ADR-084): usuarios activos, último ingreso,
//    última venta y ventas de 7 días.
// La salud comercial (pago pendiente, errores de cobro) sigue en
// lib/internal/tenantHealth.ts; acá se mide si el negocio aprendió a usar el
// sistema.
// =============================================================================

export interface ActivationSignals {
  fiscal: boolean;
  mp: boolean;
  producto: boolean;
  ticket: boolean;
  venta: boolean;
  caja: boolean;
  equipo: boolean;
  medios: boolean;
  escuela: boolean;
  first_sale_at: string | null;
  products_count: number;
  shifts_7d: number;
}

export interface ActivationRow {
  tenant_id: string;
  name: string;
  industry: string;
  status: string;
  plan_family: string | null;
  created_at: string;
  trial_ends_at: string | null;
  signals: ActivationSignals;
  tours_started: number;
  tours_completed: number;
  nudges_clicked: number;
  open_assignments: number;
}

export interface ActivationHealth {
  active_users: number;
  last_login_at: string | null;
  sales_7d_count: number;
}

export type ActivationLevel = "activado" | "en_camino" | "trabado";

export interface ScorePart {
  key: string;
  label: string;
  points: number;
  max: number;
}

export interface StuckReason {
  key: "sin_primera_venta" | "sin_productos" | "sin_caja" | "sin_ingresos" | "trial_sin_uso";
  label: string;
  /** Correctivo sugerido (clave de recorrido o sugerencia sembrada). */
  suggest: { kind: "tour" | "nudge"; key: string };
}

const DAY = 86_400_000;

function days(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / DAY) : null;
}

const bool = (v: unknown) => v === true;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function parseSignals(raw: unknown): ActivationSignals {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    fiscal: bool(r.fiscal),
    mp: bool(r.mp),
    producto: bool(r.producto),
    ticket: bool(r.ticket),
    venta: bool(r.venta),
    caja: bool(r.caja),
    equipo: bool(r.equipo),
    medios: bool(r.medios) || bool(r.mp),
    escuela: bool(r.escuela),
    first_sale_at: typeof r.first_sale_at === "string" ? r.first_sale_at : null,
    products_count: num(r.products_count),
    shifts_7d: num(r.shifts_7d),
  };
}

export function parseActivationRows(raw: unknown): ActivationRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const r = x as Record<string, unknown>;
    return {
      tenant_id: String(r.tenant_id),
      name: String(r.name ?? ""),
      industry: String(r.industry ?? "otro"),
      status: String(r.status ?? "trial"),
      plan_family: typeof r.plan_family === "string" ? r.plan_family : null,
      created_at: String(r.created_at),
      trial_ends_at: typeof r.trial_ends_at === "string" ? r.trial_ends_at : null,
      signals: parseSignals(r.signals),
      tours_started: num(r.tours_started),
      tours_completed: num(r.tours_completed),
      nudges_clicked: num(r.nudges_clicked),
      open_assignments: num(r.open_assignments),
    };
  });
}

/**
 * Puntaje 0 a 100: puesta en marcha 40 (productos 15, medios 10, datos
 * fiscales 5, ticket 5, caja abierta alguna vez 5), primera venta 25, uso de
 * caja en 7 días 10, usuarios 10 (alguien activo 5, equipo 5) y actividad
 * reciente 15 (ingreso en 7 días 5, ventas en 7 días 10).
 */
export function activationScore(
  row: ActivationRow,
  health: ActivationHealth | null,
  now: Date = new Date(),
): { score: number; level: ActivationLevel; parts: ScorePart[] } {
  const s = row.signals;
  const login = days(health?.last_login_at ?? null, now);
  const parts: ScorePart[] = [
    { key: "producto", label: "Productos cargados", points: s.producto ? 15 : 0, max: 15 },
    { key: "medios", label: "Medios de pago", points: s.medios ? 10 : 0, max: 10 },
    { key: "fiscal", label: "Datos fiscales", points: s.fiscal ? 5 : 0, max: 5 },
    { key: "ticket", label: "Ticket configurado", points: s.ticket ? 5 : 0, max: 5 },
    { key: "caja", label: "Abrió la caja", points: s.caja ? 5 : 0, max: 5 },
    { key: "venta", label: "Primera venta", points: s.first_sale_at || s.venta ? 25 : 0, max: 25 },
    { key: "caja_7d", label: "Usó la caja esta semana", points: s.shifts_7d > 0 ? 10 : 0, max: 10 },
    {
      key: "usuarios",
      label: "Usuarios activos",
      points: ((health?.active_users ?? 0) > 0 ? 5 : 0) + (s.equipo ? 5 : 0),
      max: 10,
    },
    {
      key: "actividad",
      label: "Actividad reciente",
      points: (login !== null && login < 7 ? 5 : 0) + ((health?.sales_7d_count ?? 0) > 0 ? 10 : 0),
      max: 15,
    },
  ];
  const score = Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.points, 0)));
  const level: ActivationLevel = score >= 70 ? "activado" : score >= 40 ? "en_camino" : "trabado";
  return { score, level, parts };
}

/**
 * Motivos por los que una cuenta está trabada. `noSaleDays` = días desde el
 * alta sin primera venta para marcarla (el staff lo ajusta en la pantalla).
 * Suspendidos y cancelados no cuentan (ya los gestiona cobranzas).
 */
export function stuckReasons(
  row: ActivationRow,
  health: ActivationHealth | null,
  opts: { noSaleDays?: number; now?: Date } = {},
): StuckReason[] {
  const now = opts.now ?? new Date();
  const noSaleDays = opts.noSaleDays ?? 3;
  if (row.status === "suspended" || row.status === "cancelled") return [];
  const age = days(row.created_at, now) ?? 0;
  const s = row.signals;
  const sold = Boolean(s.first_sale_at) || s.venta;
  const out: StuckReason[] = [];

  if (!sold && age >= noSaleDays) {
    out.push({
      key: "sin_primera_venta",
      label: `Sin primera venta a ${age} días del alta`,
      suggest: { kind: "tour", key: "primer-cobro" },
    });
  }
  if (!s.producto && age >= 2) {
    out.push({ key: "sin_productos", label: "Sin productos cargados", suggest: { kind: "nudge", key: "sin-productos" } });
  }
  if (!s.caja && age >= 2) {
    out.push({ key: "sin_caja", label: "Nunca abrió la caja", suggest: { kind: "tour", key: "primer-cobro" } });
  }
  const login = days(health?.last_login_at ?? null, now);
  if ((login === null && age >= 2) || (login !== null && login >= 7)) {
    out.push({
      key: "sin_ingresos",
      label: login === null ? "Nadie ingresó todavía" : `Sin ingresos hace ${login} días`,
      suggest: { kind: "nudge", key: "sin-primera-venta" },
    });
  }
  if (row.status === "trial" && row.trial_ends_at && !sold) {
    const left = Math.ceil((new Date(row.trial_ends_at).getTime() - now.getTime()) / DAY);
    if (Number.isFinite(left) && left <= 3) {
      out.push({
        key: "trial_sin_uso",
        label: left <= 0 ? "Prueba vencida sin ventas" : `Prueba vence en ${left} días sin ventas`,
        suggest: { kind: "nudge", key: "trial-por-vencer" },
      });
    }
  }
  return out;
}

export interface StuckAccount {
  row: ActivationRow;
  score: number;
  level: ActivationLevel;
  reasons: StuckReason[];
}

/** Cuentas trabadas: más motivos primero, después el menor puntaje y la más vieja. */
export function stuckAccounts(
  rows: ActivationRow[],
  healthBy: Map<string, ActivationHealth>,
  opts: { noSaleDays?: number; now?: Date } = {},
): StuckAccount[] {
  const now = opts.now ?? new Date();
  return rows
    .map((row) => {
      const health = healthBy.get(row.tenant_id) ?? null;
      const { score, level } = activationScore(row, health, now);
      return { row, score, level, reasons: stuckReasons(row, health, { ...opts, now }) };
    })
    .filter((a) => a.reasons.length > 0)
    .sort(
      (a, b) =>
        b.reasons.length - a.reasons.length ||
        a.score - b.score ||
        a.row.created_at.localeCompare(b.row.created_at),
    );
}

export const ACTIVATION_LEVEL_LABELS: Record<ActivationLevel, string> = {
  activado: "Activado",
  en_camino: "En camino",
  trabado: "Trabado",
};
