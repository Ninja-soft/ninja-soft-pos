// =============================================================================
// Salud por negocio (F7 · H11c, ADR-084). Puntaje 0 a 100 con motivos legibles
// a partir de agregados que el panel interno ya tiene (internal_tenant_health y
// la ficha 360). Puro: lo usan el inicio de /internal (negocios en riesgo) y la
// ficha 360 del negocio.
// =============================================================================

export type HealthLevel = "ok" | "attention" | "risk";

export interface HealthInput {
  /** Estado efectivo: el de la suscripción o, si no hay, el del negocio. */
  status: string | null;
  createdAt: string | null;
  trialEndsAt?: string | null;
  lastLoginAt: string | null;
  lastSaleAt: string | null;
  sales7dCount: number;
  activeUsers: number;
  webhookErrors7d?: number;
  fiscalPending?: number;
}

export interface HealthResult {
  score: number;
  level: HealthLevel;
  reasons: string[];
}

const DAY = 86_400_000;

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / DAY);
}

export function tenantHealthScore(input: HealthInput, now: Date = new Date()): HealthResult {
  const reasons: string[] = [];
  let penalty = 0;
  const status = input.status ?? "trial";

  if (status === "suspended" || status === "cancelled") {
    return {
      score: 0,
      level: "risk",
      reasons: [status === "suspended" ? "Suspendido" : "Cancelado"],
    };
  }
  if (status === "past_due") {
    penalty += 30;
    reasons.push("Pago pendiente");
  }

  const age = daysSince(input.createdAt, now) ?? 0;

  const login = daysSince(input.lastLoginAt, now);
  if (login === null) {
    if (age >= 2) {
      penalty += 30;
      reasons.push("Nadie ingresó todavía");
    }
  } else if (login >= 14) {
    penalty += 25;
    reasons.push(`Sin ingresos hace ${login} días`);
  } else if (login >= 7) {
    penalty += 10;
    reasons.push(`Sin ingresos hace ${login} días`);
  }

  const sale = daysSince(input.lastSaleAt, now);
  if (sale === null) {
    if (age >= 3) {
      penalty += 20;
      reasons.push("Todavía no vendió");
    }
  } else if (sale >= 14) {
    penalty += 25;
    reasons.push(`Sin ventas hace ${sale} días`);
  } else if (input.sales7dCount === 0) {
    penalty += 10;
    reasons.push("Sin ventas esta semana");
  }

  if (input.activeUsers <= 0) {
    penalty += 20;
    reasons.push("Sin usuarios activos");
  }

  if (status === "trial" && input.trialEndsAt) {
    const left = Math.ceil((new Date(input.trialEndsAt).getTime() - now.getTime()) / DAY);
    if (Number.isFinite(left) && left <= 3 && (sale === null || input.sales7dCount === 0)) {
      penalty += 15;
      reasons.push(left <= 0 ? "Trial vencido sin uso" : `Trial vence en ${left} días sin uso`);
    }
  }

  if ((input.webhookErrors7d ?? 0) > 0) {
    penalty += 10;
    reasons.push(`${input.webhookErrors7d} errores de cobro en 7 días`);
  }
  if ((input.fiscalPending ?? 0) > 0) {
    penalty += 10;
    reasons.push(`${input.fiscalPending} comprobantes fiscales con problemas`);
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const level: HealthLevel = score >= 70 ? "ok" : score >= 40 ? "attention" : "risk";
  return { score, level, reasons };
}

export const HEALTH_LEVEL_LABELS: Record<HealthLevel, string> = {
  ok: "Saludable",
  attention: "Atención",
  risk: "En riesgo",
};

export const HEALTH_LEVEL_DOT: Record<HealthLevel, string> = {
  ok: "bg-success",
  attention: "bg-warning",
  risk: "bg-danger",
};

// Los N negocios con peor puntaje (empates: el más viejo primero, tiene más
// para perder). Excluye suspendidos y cancelados: ya están gestionados.
export function atRiskTenants<T extends { id: string; created_at: string }>(
  rows: { tenant: T; health: HealthResult }[],
  limit = 8,
): { tenant: T; health: HealthResult }[] {
  return rows
    .filter((r) => r.health.level !== "ok" && r.health.score > 0)
    .sort(
      (a, b) =>
        a.health.score - b.health.score ||
        a.tenant.created_at.localeCompare(b.tenant.created_at),
    )
    .slice(0, limit);
}
