import { z } from "zod";

// SLA del KDS por estación (F13 · H46). Espejo del CHECK `_kds_sla_valid`
// (migración 20261105200200_kds_sla_estacion): claves 'default' o una estación,
// valores { warn, late } enteros 1..240 con warn < late.

export interface KdsSlaRule {
  warn: number;
  late: number;
}
export type KdsSlaConfig = Record<string, KdsSlaRule>;
export type KdsTone = "ok" | "warn" | "late";

// Umbrales históricos del KDS (ámbar a 5 min, rojo a 10 min).
export const KDS_SLA_FALLBACK: KdsSlaRule = { warn: 5, late: 10 };
export const KDS_SLA_MAX_MIN = 240;

export const KdsSlaRuleSchema = z
  .object({
    warn: z.number().int().min(1).max(KDS_SLA_MAX_MIN),
    late: z.number().int().min(1).max(KDS_SLA_MAX_MIN),
  })
  .refine((r) => r.warn < r.late, {
    message: "El aviso tiene que ser antes que la demora",
    path: ["late"],
  });

export const KdsSlaConfigSchema = z.record(z.string().min(1).max(40), KdsSlaRuleSchema);

// Lee lo que venga de la DB sin confiar en la forma: descarta reglas inválidas.
export function parseKdsSla(raw: unknown): KdsSlaConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: KdsSlaConfig = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = KdsSlaRuleSchema.safeParse(v);
    if (r.success && k.length > 0 && k.length <= 40) out[k] = r.data;
  }
  return out;
}

// Regla efectiva de una estación: la propia, si no la 'default', si no 5/10.
export function resolveKdsSla(config: KdsSlaConfig | null | undefined, station: string | null): KdsSlaRule {
  const c = config ?? {};
  if (station && c[station]) return c[station];
  return c.default ?? KDS_SLA_FALLBACK;
}

// Tono de alerta según los minutos transcurridos. Un ítem listo no alerta.
export function kdsTone(mins: number, rule: KdsSlaRule, isReady = false): KdsTone {
  if (isReady) return "ok";
  if (mins >= rule.late) return "late";
  if (mins >= rule.warn) return "warn";
  return "ok";
}
