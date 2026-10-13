// =============================================================================
// Segmentación de recorridos y sugerencias (F15 · H70, H74 · ADR-089). Espejo
// puro de onboarding_audience_match (migración 20261108300100), con la misma
// resolución de plan, estado y rubro que los anuncios por segmento (ADR-084):
// familia del plan, estado de la suscripción o del negocio, rubro u "otro".
// La usa el panel interno para previsualizar a quién le llega.
// =============================================================================
import type { Audience } from "./schema";

export interface AudienceTenant {
  planFamily: string | null;
  status: string | null;
  industry: string | null;
  createdAt: string;
  features?: Record<string, boolean>;
}

const DAY = 86_400_000;

function inList(list: string[] | undefined, value: string): boolean {
  return !list || list.length === 0 || list.includes(value);
}

export function audienceMatches(
  aud: Audience,
  tenant: AudienceTenant,
  role: string | null,
  now: Date = new Date(),
): boolean {
  if (!inList(aud.plans, tenant.planFamily ?? "")) return false;
  if (!inList(aud.statuses, tenant.status ?? "")) return false;
  if (!inList(aud.industries, tenant.industry ?? "otro")) return false;
  if (!inList(aud.roles, role ?? "")) return false;
  // Optimista como el gating de plan: sin el mapa de features no se descarta.
  if (aud.features?.length && tenant.features) {
    if (aud.features.some((k) => tenant.features![k] === false)) return false;
  }
  const days = Math.floor((now.getTime() - new Date(tenant.createdAt).getTime()) / DAY);
  if (aud.min_days !== undefined && days < aud.min_days) return false;
  if (aud.max_days !== undefined && days > aud.max_days) return false;
  return true;
}

export function audienceSummary(
  aud: Audience,
  labels: { plans?: Record<string, string>; industries?: Record<string, string>; roles?: Record<string, string> } = {},
): string {
  const parts: string[] = [];
  const name = (m: Record<string, string> | undefined, v: string) => m?.[v] ?? v;
  if (aud.plans?.length) parts.push(`Plan ${aud.plans.map((p) => name(labels.plans, p)).join(" o ")}`);
  if (aud.statuses?.length) parts.push(`Estado ${aud.statuses.join(" o ")}`);
  if (aud.industries?.length) parts.push(`Rubro ${aud.industries.map((i) => name(labels.industries, i)).join(" o ")}`);
  if (aud.roles?.length) parts.push(`Rol ${aud.roles.map((r) => name(labels.roles, r)).join(" o ")}`);
  if (aud.features?.length) parts.push(`Con ${aud.features.join(", ")}`);
  if (aud.min_days !== undefined && aud.max_days !== undefined) parts.push(`Alta hace ${aud.min_days} a ${aud.max_days} días`);
  else if (aud.min_days !== undefined) parts.push(`Alta hace ${aud.min_days} días o más`);
  else if (aud.max_days !== undefined) parts.push(`Alta hace ${aud.max_days} días o menos`);
  return parts.length ? parts.join(" · ") : "Todos los negocios";
}

/** Quita listas vacías: el servidor guarda sólo los criterios usados. */
export function compactAudience(aud: Audience): Audience {
  const out: Audience = {};
  for (const k of ["plans", "statuses", "industries", "roles", "features"] as const) {
    const v = aud[k];
    if (v && v.length) (out as Record<string, unknown>)[k] = [...v];
  }
  if (aud.min_days !== undefined) out.min_days = aud.min_days;
  if (aud.max_days !== undefined) out.max_days = aud.max_days;
  return out;
}
