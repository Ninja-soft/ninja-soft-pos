// =============================================================================
// Escalera de mora, restricción blanda, promesas y feriados de la cobranza de
// la plataforma (F20-9 · H135, spec docs/40 §10.5, §11 y §22 #6 y #10;
// ADR-128).
//
// Funciones puras, espejo de la lógica SQL de la migración
// 20261124100000_cobranza_mora_punitorios:
//   · isBusinessDay / nextBusinessDay → platform_is_business_day /
//     platform_next_business_day (fines de semana y platform_holidays)
//   · stepDate / nextStep / dueSteps   → platform_mora_evaluate
//   · renderStepText                   → platform_dunning_render
//   · promiseWindow                    → owner_promise_create /
//                                        internal_promise_create
//   · restrictedAreaFor                → el overlay de la restricción blanda
// Tests en tests/unit/billingMora.test.ts.
// =============================================================================

// Sin imports: la prueba de PGlite lo carga directo con Node.
const DAY = 86_400_000;
const dayNum = (ymd: string) => Math.round(Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) / DAY);
const addDays = (ymd: string, n: number) => new Date((dayNum(ymd) + n) * DAY).toISOString().slice(0, 10);

// ── Días hábiles ────────────────────────────────────────────────────────────

/** Sábado, domingo o feriado cargado en platform_holidays = no hábil. */
export function isBusinessDay(ymd: string, holidays: ReadonlySet<string>): boolean {
  const d = ymd.slice(0, 10);
  const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(d);
}

/** El mismo día si es hábil; si no, el próximo hábil. */
export function nextBusinessDay(ymd: string, holidays: ReadonlySet<string>): string {
  let d = ymd.slice(0, 10);
  for (let i = 0; i < 60; i++) {
    if (isBusinessDay(d, holidays)) return d;
    d = addDays(d, 1);
  }
  return d;
}

// ── Escalera ────────────────────────────────────────────────────────────────

export type DunningAction = "notify" | "past_due" | "soft_restrict" | "suspend" | "mark_uncollectible";
export type DunningChannel = "email" | "in_app";

export interface DunningStep {
  id: string;
  position: number;
  offset_days: number;
  action: DunningAction;
  channels: DunningChannel[];
  requires_no_promise: boolean;
  min_debt_cents: number;
  title: string;
  body: string;
  is_active: boolean;
}

export const DUNNING_ACTION_LABELS: Record<DunningAction, string> = {
  notify: "Aviso",
  past_due: "Pago pendiente (banner)",
  soft_restrict: "Restricción parcial",
  suspend: "Suspensión",
  mark_uncollectible: "Marcar incobrable",
};

export const DUNNING_ACTION_HELP: Record<DunningAction, string> = {
  notify: "Manda el email y el aviso en la app. No cambia el acceso.",
  past_due: "La cuenta pasa a pago pendiente: banner en el POS. Sigue vendiendo.",
  soft_restrict: "El POS vende, pero reportes y configuración (lo que elijas) quedan con un aviso para regularizar.",
  suspend: "Suspende la cuenta (sólo lectura hasta que pague).",
  mark_uncollectible: "Marca la deuda como incobrable para el staff. No da de baja ni avisa al cliente.",
};

export const DUNNING_CHANNEL_LABELS: Record<DunningChannel, string> = {
  email: "Email",
  in_app: "Aviso en la app",
};

/**
 * Día en que se ejecuta un paso: vencimiento efectivo + offset. Si cae en un
 * día no hábil, se corre al próximo hábil (la escalera no avanza en feriado).
 */
export function stepDate(effectiveDue: string, offsetDays: number, holidays: ReadonlySet<string>): string {
  return nextBusinessDay(addDays(effectiveDue, offsetDays), holidays);
}

export interface LadderState {
  /** Vencimiento efectivo de la deuda más vieja (null = sin deuda vencida). */
  effectiveDue: string | null;
  /** Saldo de lo vencido hasta hoy (incluido). */
  dueCents: number;
  today: string;
  promiseOpen: boolean;
  /** Ids de pasos ya ejecutados para esta deuda. */
  executed: ReadonlySet<string>;
  holidays: ReadonlySet<string>;
}

export interface DueStepsResult {
  /** Pasos a ejecutar hoy, en orden (sólo el último avisa al cliente). */
  run: DunningStep[];
  /** Pasos vencidos frenados por una promesa vigente. */
  held: DunningStep[];
}

const activeSteps = (steps: DunningStep[]) =>
  steps.filter((s) => s.is_active).sort((a, b) => a.offset_days - b.offset_days || a.position - b.position);

/**
 * Pasos que corresponde ejecutar hoy. En un día no hábil no avanza nada. Un
 * paso con requires_no_promise queda frenado mientras haya una promesa
 * abierta; al romperse la promesa la escalera retoma desde donde estaba.
 */
export function dueSteps(steps: DunningStep[], st: LadderState): DueStepsResult {
  const out: DueStepsResult = { run: [], held: [] };
  if (!st.effectiveDue || !isBusinessDay(st.today, st.holidays)) return out;
  const days = dayNum(st.today) - dayNum(st.effectiveDue);
  for (const s of activeSteps(steps)) {
    if (st.executed.has(s.id)) continue;
    if (s.offset_days > days) continue;
    if (st.dueCents <= 0 || st.dueCents < s.min_debt_cents) continue;
    if (s.requires_no_promise && st.promiseOpen) {
      out.held.push(s);
      continue;
    }
    out.run.push(s);
  }
  return out;
}

/** Próximo paso pendiente y su fecha (para "Próx. paso" y el panel del dueño). */
export function nextStep(steps: DunningStep[], st: LadderState): { step: DunningStep; date: string } | null {
  if (!st.effectiveDue) return null;
  for (const s of activeSteps(steps)) {
    if (st.executed.has(s.id)) continue;
    if (s.requires_no_promise && st.promiseOpen) continue;
    const date = stepDate(st.effectiveDue, s.offset_days, st.holidays);
    return { step: s, date: date < st.today ? nextBusinessDay(st.today, st.holidays) : date };
  }
  return null;
}

/** Reemplaza {monto}, {dias}, {vence} y {negocio} (mismo orden que en SQL). */
export function renderStepText(
  text: string,
  vars: { monto: string; dias: number | string; vence: string; negocio: string },
): string {
  return String(text ?? "")
    .split("{monto}")
    .join(vars.monto)
    .split("{dias}")
    .join(String(vars.dias))
    .split("{vence}")
    .join(vars.vence)
    .split("{negocio}")
    .join(vars.negocio);
}

// ── Restricción blanda ──────────────────────────────────────────────────────

export type RestrictArea = "reportes" | "configuracion" | "importaciones" | "integraciones";

export const RESTRICT_AREAS: Record<RestrictArea, { label: string; help: string; paths: string[] }> = {
  reportes: { label: "Reportes", help: "Reportes y contabilidad", paths: ["/reportes", "/contabilidad"] },
  configuracion: { label: "Configuración", help: "Configuración e impuestos", paths: ["/configuracion", "/impuestos"] },
  importaciones: { label: "Importaciones", help: "Importar y exportar la base", paths: ["/importaciones"] },
  integraciones: { label: "Integraciones", help: "Mercado Libre y Tiendita", paths: ["/mercadolibre", "/tiendita"] },
};

export const RESTRICT_AREA_KEYS = Object.keys(RESTRICT_AREAS) as RestrictArea[];

/**
 * Pantallas que la restricción blanda nunca toca: vender, cobrar, caja,
 * devoluciones y el panel del dueño (desde ahí se paga).
 */
export const NEVER_RESTRICTED = ["/pos", "/caja", "/ventas", "/devoluciones", "/cobros-en-espera", "/dashboard", "/dashboard-team"];

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** Área restringida que corresponde a la ruta, o null si se usa normal. */
export function restrictedAreaFor(pathname: string, areas: readonly string[]): RestrictArea | null {
  const p = pathname.split("?")[0] ?? "";
  if (NEVER_RESTRICTED.some((b) => under(p, b))) return null;
  for (const key of RESTRICT_AREA_KEYS) {
    if (!areas.includes(key)) continue;
    if (RESTRICT_AREAS[key].paths.some((b) => under(p, b))) return key;
  }
  return null;
}

// ── Promesas ────────────────────────────────────────────────────────────────

export type PromiseStatus = "open" | "kept" | "broken" | "cancelled";

export const PROMISE_STATUS_LABELS: Record<PromiseStatus, string> = {
  open: "Vigente",
  kept: "Cumplida",
  broken: "Incumplida",
  cancelled: "Cancelada",
};

export const PROMISE_REJECT_MESSAGES: Record<string, string> = {
  promise_disabled: "Las promesas de pago no están habilitadas para tu cuenta.",
  promise_open_exists: "Ya hay una promesa de pago vigente.",
  promise_already_used: "Ya cargaste una promesa para esta deuda.",
  promise_blocked: "Incumpliste promesas recientes: hablá con nosotros para regularizar.",
  nothing_due: "No tenés deuda vencida.",
  invalid_promise_date: "Elegí una fecha dentro del plazo permitido.",
  invalid_amount: "Ingresá un importe mayor a cero y no mayor a tu saldo.",
};

/** Fechas posibles para una promesa: de mañana a hoy + maxDays. */
export function promiseWindow(today: string, maxDays: number): { min: string; max: string } {
  return { min: addDays(today, 1), max: addDays(today, Math.max(1, Math.trunc(maxDays))) };
}

/** Valida una promesa como lo hace el servidor. Devuelve la clave del error o null. */
export function validatePromise(input: {
  today: string;
  date: string;
  amountCents: number;
  balanceCents: number;
  maxDays: number;
}): string | null {
  const w = promiseWindow(input.today, input.maxDays);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < w.min || input.date > w.max) return "invalid_promise_date";
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0 || input.amountCents > Math.max(0, input.balanceCents)) {
    return "invalid_amount";
  }
  return null;
}

// ── Estado de cobranza ──────────────────────────────────────────────────────

export type CollectionState = "al_dia" | "vencida" | "en_promesa" | "incobrable";

export const COLLECTION_STATE_LABELS: Record<CollectionState, string> = {
  al_dia: "Al día",
  vencida: "Vencida",
  en_promesa: "En promesa",
  incobrable: "Incobrable",
};

export const COLLECTION_STATE_TONES: Record<CollectionState, "success" | "warning" | "info" | "danger"> = {
  al_dia: "success",
  vencida: "warning",
  en_promesa: "info",
  incobrable: "danger",
};

/** Mensajes de error de las RPC de mora y punitorios. */
export const MORA_ERROR_MESSAGES: Record<string, string> = {
  ...PROMISE_REJECT_MESSAGES,
  nothing_to_waive: "No hay punitorios pendientes para condonar.",
  waiver_not_pending: "Esa condonación ya fue resuelta.",
  policy_not_found: "No encontramos esa política.",
  ladder_not_found: "No encontramos esa escalera.",
  invalid_policy: "Revisá la política: tasa de 0 a 100 %, gracia de 0 a 90 días, tope y mínimo desde 0.",
  invalid_ladder: "Revisá la escalera: nombre y al menos un paso con días de 0 a 365.",
  invalid_step: "Cada paso necesita días de 0 a 365, una acción, un título y un texto.",
  invalid_holiday: "Elegí una fecha y escribí el nombre del feriado.",
  invalid_settings: "Revisá la configuración de mora.",
  promise_not_open: "La promesa ya no está vigente.",
  default_in_use: "Es la política o escalera por defecto: elegí otra antes de archivarla.",
};
