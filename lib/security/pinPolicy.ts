// Política de PIN de supervisor por acción (F17 · H116, ADR-051). PURO.
//
// ESPEJO del SQL: security_default_policy(), pin_action_required() e
// is_supervisor() en supabase/migrations/20261017110000_pin_supervisor_politicas.sql.
// El servidor decide (triggers + token en el header); esto sirve para pedir el
// PIN ANTES de intentar y para la pantalla de Seguridad.
// Modos del PIN (fijo, rotativo, de un uso, app): ADR-060, espejo de
// pin_action_modes() en 20261023100000_pin_autenticador.sql.

import { PIN_MODES, type PinMode } from "@/lib/security/otp";

export type PinAction =
  | "discount_over"
  | "cambio_precio"
  | "sale_void"
  | "sale_return"
  | "cash_out"
  | "cash_in"
  | "shift_force_close"
  | "abrir_cajon"
  | "reintegro_mp";

export interface PinRule {
  enabled: boolean;
  threshold: number;
  /** Modos que acepta la acción (ADR-060). Vacío o ausente: todos los del negocio. */
  modes?: PinMode[];
}

export type PinPolicy = Record<PinAction, PinRule>;

export interface SecuritySettings {
  pin_policy: PinPolicy;
  supervisor_roles: ("owner" | "manager" | "cashier")[];
  supervisor_user_ids: string[];
  pin_max_attempts: number;
  pin_lock_minutes: number;
  pin_rotation_days: number | null;
  shared_shift: boolean;
  /** Modos de PIN que acepta el negocio (ADR-060). */
  pin_modes: PinMode[];
  /** Modo que se sugiere primero en Mis PINes. */
  pin_default_mode: PinMode;
  /** Cada cuántas horas cambia el PIN rotativo (1 a 168). */
  pin_rotation_hours: number;
  /** Duración máxima de un PIN de un uso, en minutos (1 a 30). */
  pin_one_time_max_minutes: number;
  /** El plan incluye la feature pin_autenticador (sin ella sólo vale el PIN fijo). */
  pin_autenticador: boolean;
}

export const PIN_ACTIONS: PinAction[] = [
  "discount_over",
  "cambio_precio",
  "sale_void",
  "sale_return",
  "cash_out",
  "cash_in",
  "shift_force_close",
  "abrir_cajon",
  "reintegro_mp",
];

/** Acciones que siempre piden PIN cuando se consultan (espejo de pin_action_required). */
export const ALWAYS_PIN: PinAction[] = ["shift_force_close", "abrir_cajon", "reintegro_mp"];

export const DEFAULT_POLICY: PinPolicy = {
  discount_over: { enabled: false, threshold: 20 },
  // ADR-056: encendida por defecto (cambio manual de precio en el POS).
  cambio_precio: { enabled: true, threshold: 0 },
  sale_void: { enabled: false, threshold: 0 },
  sale_return: { enabled: false, threshold: 0 },
  cash_out: { enabled: false, threshold: 0 },
  cash_in: { enabled: false, threshold: 0 },
  shift_force_close: { enabled: true, threshold: 0 },
  // ADR-063: siempre; la pide la política del cajón de la sucursal.
  abrir_cajon: { enabled: true, threshold: 0 },
  // ADR-067: siempre; la plata sale de la cuenta de Mercado Pago.
  reintegro_mp: { enabled: true, threshold: 0 },
};

export const DEFAULT_SECURITY: SecuritySettings = {
  pin_policy: DEFAULT_POLICY,
  supervisor_roles: ["owner", "manager"],
  supervisor_user_ids: [],
  pin_max_attempts: 5,
  pin_lock_minutes: 15,
  pin_rotation_days: null,
  shared_shift: false,
  pin_modes: [...PIN_MODES],
  pin_default_mode: "fixed",
  pin_rotation_hours: 24,
  pin_one_time_max_minutes: 5,
  pin_autenticador: false,
};

export const ACTION_INFO: Record<
  PinAction,
  { label: string; desc: string; unit: "pct" | "money" | "none"; reasonRequired: boolean }
> = {
  discount_over: {
    label: "Descuento sobre el tope",
    desc: "Descuento general manual (sin promociones ni cupones) mayor al porcentaje.",
    unit: "pct",
    reasonRequired: false,
  },
  cambio_precio: {
    label: "Cambio de precio en el POS",
    desc: "Precio de una línea distinto al de lista, con más desvío que el porcentaje. El cajero siempre deja el motivo.",
    unit: "pct",
    reasonRequired: false,
  },
  sale_void: {
    label: "Anular una venta",
    desc: "Anulaciones desde el monto indicado.",
    unit: "money",
    reasonRequired: true,
  },
  sale_return: {
    label: "Devolución o cambio",
    desc: "Devoluciones desde el monto indicado.",
    unit: "money",
    reasonRequired: true,
  },
  cash_out: {
    label: "Retiro de caja",
    desc: "Retiros de efectivo desde el monto indicado.",
    unit: "money",
    reasonRequired: true,
  },
  cash_in: {
    label: "Ingreso de caja",
    desc: "Ingresos de efectivo desde el monto indicado.",
    unit: "money",
    reasonRequired: false,
  },
  shift_force_close: {
    label: "Cierre forzado de una caja ajena",
    desc: "Siempre pide supervisor: cierra el turno que otra persona dejó abierto.",
    unit: "none",
    reasonRequired: true,
  },
  abrir_cajon: {
    label: "Abrir el cajón sin venta",
    desc: "Se pide cuando la sucursal tiene el cajón sin venta \"Con PIN de supervisor\" (Configuración, Hardware). El cajero ya dejó el motivo.",
    unit: "none",
    reasonRequired: false,
  },
  reintegro_mp: {
    label: "Reintegrar por Mercado Pago",
    desc: "Siempre pide supervisor: devuelve la plata de una venta a la tarjeta o cuenta de Mercado Pago del cliente. El dueño y los supervisores lo hacen sin PIN.",
    unit: "money",
    reasonRequired: false,
  },
};

/** Política completa (acciones nuevas con su default). */
export function normalizeSettings(raw: Partial<SecuritySettings> | null | undefined): SecuritySettings {
  const policy = { ...DEFAULT_POLICY } as PinPolicy;
  const src = (raw?.pin_policy ?? {}) as Partial<Record<string, Partial<PinRule>>>;
  for (const a of PIN_ACTIONS) {
    const r = src[a];
    if (r) {
      const modes = cleanModes(r.modes);
      policy[a] = {
        enabled: ALWAYS_PIN.includes(a) ? true : Boolean(r.enabled),
        threshold: Math.max(0, Number(r.threshold ?? DEFAULT_POLICY[a].threshold) || 0),
        ...(modes.length ? { modes } : {}),
      };
    }
  }
  const pinModes = cleanModes(raw?.pin_modes);
  const modes = pinModes.length ? pinModes : DEFAULT_SECURITY.pin_modes;
  const def = raw?.pin_default_mode && modes.includes(raw.pin_default_mode) ? raw.pin_default_mode : modes[0]!;
  return {
    ...DEFAULT_SECURITY,
    ...(raw ?? {}),
    pin_policy: policy,
    supervisor_roles: raw?.supervisor_roles?.length ? raw.supervisor_roles : DEFAULT_SECURITY.supervisor_roles,
    supervisor_user_ids: raw?.supervisor_user_ids ?? [],
    pin_modes: modes,
    pin_default_mode: def,
    pin_rotation_hours: clampInt(raw?.pin_rotation_hours, 1, 168, DEFAULT_SECURITY.pin_rotation_hours),
    pin_one_time_max_minutes: clampInt(raw?.pin_one_time_max_minutes, 1, 30, DEFAULT_SECURITY.pin_one_time_max_minutes),
    pin_autenticador: Boolean(raw?.pin_autenticador),
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Modos válidos, sin repetir y en el orden de PIN_MODES. */
export function cleanModes(raw: unknown): PinMode[] {
  if (!Array.isArray(raw)) return [];
  return PIN_MODES.filter((m) => raw.includes(m));
}

/**
 * Modos que acepta una acción (espejo de pin_action_modes()): los del negocio,
 * recortados por los de la acción. Sin la feature pin_autenticador, sólo el fijo.
 */
export function actionModes(s: SecuritySettings, action: PinAction): PinMode[] {
  if (!s.pin_autenticador) return ["fixed"];
  const base = s.pin_modes.length ? s.pin_modes : PIN_MODES;
  const own = s.pin_policy[action]?.modes ?? [];
  if (!own.length) return [...base];
  const both = base.filter((m) => own.includes(m));
  return both.length ? both : [...base];
}

/** Error de validación de la configuración de modos, o null si está bien. */
export function modesProblem(s: SecuritySettings): string | null {
  if (!s.pin_modes.length) return "Tiene que quedar al menos un modo de PIN.";
  if (!s.pin_modes.includes(s.pin_default_mode)) return "El modo por defecto tiene que estar entre los permitidos.";
  for (const a of PIN_ACTIONS) {
    const own = s.pin_policy[a]?.modes ?? [];
    if (own.length && !own.some((m) => s.pin_modes.includes(m))) {
      return `${ACTION_INFO[a].label}: ninguno de sus modos está permitido en el negocio.`;
    }
  }
  return null;
}

/** ¿La acción pide PIN para ese monto? (porcentaje para discount_over) */
export function pinRequired(policy: PinPolicy, action: PinAction, amount: number | null): boolean {
  if (ALWAYS_PIN.includes(action)) return true;
  const r = policy[action];
  if (!r?.enabled) return false;
  const v = amount ?? 0;
  if (action === "discount_over" || action === "cambio_precio") return v > r.threshold + 0.001;
  return v >= r.threshold;
}

/** ¿El usuario es supervisor? (espejo de is_supervisor, sin el estado del personal) */
export function isSupervisor(
  s: Pick<SecuritySettings, "supervisor_roles" | "supervisor_user_ids">,
  role: string | null,
  userId: string | null,
): boolean {
  if (role === "owner") return true;
  if (!role) return false;
  return (s.supervisor_roles as string[]).includes(role) || (userId ? s.supervisor_user_ids.includes(userId) : false);
}

/** ¿Hay que pedir el PIN a este usuario para esta acción? */
export function needsPinFrom(
  s: SecuritySettings,
  action: PinAction,
  amount: number | null,
  role: string | null,
  userId: string | null,
): boolean {
  return pinRequired(s.pin_policy, action, amount) && !isSupervisor(s, role, userId);
}

/** Si el error del servidor pide supervisor, la acción; si no, null. */
export function supervisorRequiredAction(err: unknown): PinAction | null {
  const msg =
    err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? err ?? "");
  const m = /supervisor_required:([a-z_]+)/.exec(msg);
  if (!m) return null;
  return (PIN_ACTIONS as string[]).includes(m[1]!) ? (m[1] as PinAction) : null;
}

/** Fecha de vencimiento del PIN por rotación (null = no vence). */
export function pinExpiresAt(setAt: string | null, rotationDays: number | null): Date | null {
  if (!setAt || !rotationDays) return null;
  const d = new Date(setAt);
  d.setDate(d.getDate() + rotationDays);
  return d;
}

/** Mensaje del resultado de supervisor_authorize. */
export function authorizeErrorMessage(
  error: string,
  extra?: { attempts_left?: number; locked_until?: string },
  lockMinutes = 15,
): string {
  switch (error) {
    case "pin_invalid": {
      const n = extra?.attempts_left ?? 0;
      return `PIN incorrecto. ${n === 1 ? "Queda 1 intento" : `Quedan ${n} intentos`} antes de bloquearlo ${lockMinutes} minutos.`;
    }
    case "pin_locked": {
      const until = extra?.locked_until
        ? new Date(extra.locked_until).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
        : null;
      return until ? `PIN bloqueado por intentos fallidos hasta las ${until}.` : "PIN bloqueado por intentos fallidos.";
    }
    case "pin_not_set":
      return "Esa persona todavía no cargó su PIN de supervisor.";
    case "pin_expired":
      return "El PIN venció: el supervisor tiene que cargar uno nuevo en Configuración, Seguridad.";
    case "requester_locked": {
      const until = extra?.locked_until
        ? new Date(extra.locked_until).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
        : null;
      return until
        ? `Demasiados intentos fallidos desde tu usuario. Probá de nuevo a las ${until}.`
        : "Demasiados intentos fallidos desde tu usuario.";
    }
    case "rate_limited":
      return "Demasiados intentos seguidos. Esperá un minuto.";
    case "one_time_scope":
      return "Ese PIN de un uso es para otra acción o para un monto menor. Pedí uno nuevo.";
    default:
      return "No se pudo autorizar.";
  }
}
