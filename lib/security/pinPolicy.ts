// Política de PIN de supervisor por acción (F17 · H116, ADR-051). PURO.
//
// ESPEJO del SQL: security_default_policy(), pin_action_required() e
// is_supervisor() en supabase/migrations/20261017110000_pin_supervisor_politicas.sql.
// El servidor decide (triggers + token en el header); esto sirve para pedir el
// PIN ANTES de intentar y para la pantalla de Seguridad.

export type PinAction =
  | "discount_over"
  | "sale_void"
  | "sale_return"
  | "cash_out"
  | "cash_in"
  | "shift_force_close";

export interface PinRule {
  enabled: boolean;
  threshold: number;
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
}

export const PIN_ACTIONS: PinAction[] = [
  "discount_over",
  "sale_void",
  "sale_return",
  "cash_out",
  "cash_in",
  "shift_force_close",
];

export const DEFAULT_POLICY: PinPolicy = {
  discount_over: { enabled: false, threshold: 20 },
  sale_void: { enabled: false, threshold: 0 },
  sale_return: { enabled: false, threshold: 0 },
  cash_out: { enabled: false, threshold: 0 },
  cash_in: { enabled: false, threshold: 0 },
  shift_force_close: { enabled: true, threshold: 0 },
};

export const DEFAULT_SECURITY: SecuritySettings = {
  pin_policy: DEFAULT_POLICY,
  supervisor_roles: ["owner", "manager"],
  supervisor_user_ids: [],
  pin_max_attempts: 5,
  pin_lock_minutes: 15,
  pin_rotation_days: null,
  shared_shift: false,
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
};

/** Política completa (acciones nuevas con su default). */
export function normalizeSettings(raw: Partial<SecuritySettings> | null | undefined): SecuritySettings {
  const policy = { ...DEFAULT_POLICY } as PinPolicy;
  const src = (raw?.pin_policy ?? {}) as Partial<Record<string, Partial<PinRule>>>;
  for (const a of PIN_ACTIONS) {
    const r = src[a];
    if (r) {
      policy[a] = {
        enabled: a === "shift_force_close" ? true : Boolean(r.enabled),
        threshold: Math.max(0, Number(r.threshold ?? DEFAULT_POLICY[a].threshold) || 0),
      };
    }
  }
  return {
    ...DEFAULT_SECURITY,
    ...(raw ?? {}),
    pin_policy: policy,
    supervisor_roles: raw?.supervisor_roles?.length ? raw.supervisor_roles : DEFAULT_SECURITY.supervisor_roles,
    supervisor_user_ids: raw?.supervisor_user_ids ?? [],
  };
}

/** ¿La acción pide PIN para ese monto? (porcentaje para discount_over) */
export function pinRequired(policy: PinPolicy, action: PinAction, amount: number | null): boolean {
  if (action === "shift_force_close") return true;
  const r = policy[action];
  if (!r?.enabled) return false;
  const v = amount ?? 0;
  if (action === "discount_over") return v > r.threshold + 0.001;
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
    default:
      return "No se pudo autorizar.";
  }
}
