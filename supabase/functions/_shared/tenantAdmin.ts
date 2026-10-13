// =============================================================================
// Alta manual de negocios desde el panel interno (F7 · H11c, ADR-073).
// Lógica pura: la usan la Edge Function internal_create_tenant (Deno) y el
// formulario de /internal/tenants (Next). Sin imports de Deno ni de Node.
// =============================================================================

// Rubros soportados: mismo listado que el CHECK de tenants.industry y que
// lib/verticals/config.ts.
export const TENANT_INDUSTRIES = [
  "kiosco",
  "textil",
  "retail",
  "restaurante",
  "heladeria",
  "cafeteria",
  "panaderia",
  "peluqueria",
  "estetica",
  "servicios",
  "pyme",
  "otro",
] as const;

export type TenantIndustry = (typeof TENANT_INDUSTRIES)[number];

export const TRIAL_DAY_OPTIONS = [0, 7, 14, 30] as const;
export const MAX_TRIAL_DAYS = 90;
export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function slugifyTenantName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "negocio"
  );
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  industry: TenantIndustry;
  ownerEmail: string;
  ownerName: string | null;
  planKey: string;
  trialDays: number;
  reason: string | null;
}

export type CreateTenantError =
  | "invalid_name"
  | "invalid_industry"
  | "invalid_email"
  | "invalid_plan"
  | "invalid_trial_days"
  | "reason_too_long";

export type ParseResult =
  | { ok: true; value: CreateTenantInput }
  | { ok: false; error: CreateTenantError };

/** Valida y normaliza el cuerpo del alta manual. */
export function parseCreateTenantInput(raw: unknown): ParseResult {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 120) return { ok: false, error: "invalid_name" };

  const industry = typeof b.industry === "string" ? b.industry : "";
  if (!(TENANT_INDUSTRIES as readonly string[]).includes(industry)) {
    return { ok: false, error: "invalid_industry" };
  }

  const ownerEmail = typeof b.owner_email === "string" ? b.owner_email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(ownerEmail) || ownerEmail.length > 254) {
    return { ok: false, error: "invalid_email" };
  }
  const ownerNameRaw = typeof b.owner_name === "string" ? b.owner_name.trim() : "";
  const ownerName = ownerNameRaw ? ownerNameRaw.slice(0, 80) : null;

  const planKey = typeof b.plan_key === "string" ? b.plan_key.trim() : "";
  if (!/^[a-z0-9_-]{1,60}$/.test(planKey)) return { ok: false, error: "invalid_plan" };

  const trialDays = typeof b.trial_days === "number" ? b.trial_days : Number.NaN;
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > MAX_TRIAL_DAYS) {
    return { ok: false, error: "invalid_trial_days" };
  }

  const reasonRaw = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reasonRaw.length > MAX_REASON_LENGTH) return { ok: false, error: "reason_too_long" };

  return {
    ok: true,
    value: {
      name,
      slug: slugifyTenantName(name),
      industry: industry as TenantIndustry,
      ownerEmail,
      ownerName,
      planKey,
      trialDays,
      reason: reasonRaw || null,
    },
  };
}

/** Motivo válido para acciones críticas (suspender, reactivar, baja, acceso). */
export function isValidReason(reason: string | null | undefined): boolean {
  const r = (reason ?? "").trim();
  return r.length >= MIN_REASON_LENGTH && r.length <= MAX_REASON_LENGTH;
}
