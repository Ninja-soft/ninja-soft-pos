// Configuración de cuenta corriente (Cuenta corriente v2).
//
// Vive en pos_settings.account_config (negocio), customer_groups.account_config
// (grupo) y customers.account_config (cliente). Grupo y cliente son overrides
// PARCIALES: null = hereda. La efectiva se arma con merge profundo
// negocio → grupo → cliente (los arrays se reemplazan, no se concatenan).
//
// ESPEJO del SQL: account_effective_config() y el CHECK account_config_valid()
// en supabase/migrations/20261011200000_cuenta_corriente_v2.sql.
import { z } from "zod";

const day = z.number().int().min(1).max(31);
const dayList = z.array(z.number().int().min(0).max(365)).max(10);

export const accountConfigSchema = z.object({
  terms: z.object({
    mode: z.enum(["days", "monthly_cutoff"]),
    days: z.number().int().min(0).max(365),
    cutoff_day: day,
    due_day: day,
  }),
  installments: z.object({
    enabled: z.boolean(),
    max: z.number().int().min(1).max(24),
    interval_days: z.number().int().min(1).max(90),
  }),
  interest: z.object({
    enabled: z.boolean(),
    rate_pct: z.number().min(0).max(100),
    period: z.enum(["monthly", "daily"]),
    method: z.enum(["simple", "compound"]),
    grace_days: z.number().int().min(0).max(90),
    cap_pct: z.number().min(0).max(1000).nullable(),
    min_amount: z.number().min(0),
  }),
  blocking: z.object({
    overdue_days: z.number().int().min(0).max(365).nullable(),
    allow_manager_override: z.boolean(),
  }),
  reminders: z.object({
    before_days: dayList,
    after_days: dayList,
    channel: z.enum(["email"]),
  }),
});

export type AccountConfig = z.infer<typeof accountConfigSchema>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type AccountConfigOverride = DeepPartial<AccountConfig>;

export const accountConfigOverrideSchema = z.object({
  terms: accountConfigSchema.shape.terms.partial().optional(),
  installments: accountConfigSchema.shape.installments.partial().optional(),
  interest: accountConfigSchema.shape.interest.partial().optional(),
  blocking: accountConfigSchema.shape.blocking.partial().optional(),
  reminders: accountConfigSchema.shape.reminders.partial().optional(),
});

export const ACCOUNT_CONFIG_DEFAULT: AccountConfig = {
  terms: { mode: "days", days: 30, cutoff_day: 25, due_day: 10 },
  installments: { enabled: false, max: 6, interval_days: 30 },
  interest: {
    enabled: false,
    rate_pct: 3,
    period: "monthly",
    method: "simple",
    grace_days: 5,
    cap_pct: 50,
    min_amount: 0,
  },
  blocking: { overdue_days: null, allow_manager_override: true },
  reminders: { before_days: [3], after_days: [1, 7, 15], channel: "email" },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(over) || !isObj(base)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    out[k] = isObj(b) && isObj(v) ? merge(b, v) : v;
  }
  return out as T;
}

export function effectiveAccountConfig(
  tenant: AccountConfigOverride | null | undefined,
  group?: AccountConfigOverride | null,
  customer?: AccountConfigOverride | null,
  legacyDueDays?: number | null,
): AccountConfig {
  let base = ACCOUNT_CONFIG_DEFAULT;
  if (legacyDueDays != null && legacyDueDays >= 0) {
    base = merge(base, { terms: { days: legacyDueDays } });
  }
  return merge(merge(merge(base, tenant), group), customer);
}

// Parse tolerante de lo que viene de la base (jsonb): si no valida, null.
export function parseOverride(v: unknown): AccountConfigOverride | null {
  if (!isObj(v)) return null;
  const r = accountConfigOverrideSchema.safeParse(v);
  return r.success ? (r.data as AccountConfigOverride) : null;
}

const pct = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;

// Resumen en palabras de una config efectiva (vista previa de grupo / cliente).
export function describeAccountConfig(c: AccountConfig): string[] {
  const t = c.terms;
  return [
    t.mode === "days"
      ? `Vence a ${t.days} días`
      : `Corte el día ${t.cutoff_day}, vence el ${t.due_day} del mes siguiente`,
    c.installments.enabled ? `Hasta ${c.installments.max} cuotas` : "Sin cuotas",
    c.interest.enabled
      ? `Punitorio ${pct(c.interest.rate_pct)} ${c.interest.period === "daily" ? "diario" : "mensual"} ${
          c.interest.method === "compound" ? "compuesto" : "simple"
        }`
      : "Sin punitorios",
    c.blocking.overdue_days === null
      ? "Sin bloqueo por mora"
      : `Bloquea con más de ${c.blocking.overdue_days} días de mora`,
  ];
}
