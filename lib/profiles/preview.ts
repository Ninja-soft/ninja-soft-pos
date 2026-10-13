// Vista previa de "Cambiar rubro": qué cambia en el negocio si se aplica un
// perfil. Puro y testeable. Es el ESPEJO de la RPC apply_business_profile
// (migración 20261102200000_perfiles_rubro.sql): mismas reglas, para que lo que
// el dueño ve antes de confirmar sea lo que el servidor hace.
//
//   - Flags: sólo se PRENDEN. Uno que ya está prendido queda igual; uno que pide
//     una feature de plan que el negocio no tiene queda bloqueado ("disponible en
//     plan X"). Los flags prendidos que el perfil no usa NO se apagan.
//   - Diseño del POS: sólo se fija si el negocio nunca lo personalizó
//     (pos_layout vacío). "Salón" sólo si las mesas quedan prendidas.
//   - Categorías: se crean las que faltan (comparación sin mayúsculas); nunca se
//     borra ni renombra ninguna.
//   - Features de plan y medios de pago: sólo se informan. Nunca se activan.

import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import type { PosPreset } from "@/lib/pos/layout";
import {
  FLAG_INFO,
  PAYMENT_LABELS,
  PROFILE_FLAGS,
  type BusinessProfile,
  type ProfileFlag,
} from "./businessProfiles";

/** Nombre corto de las features de plan que un perfil puede sugerir. */
export const PLAN_FEATURE_LABELS: Record<string, string> = {
  variantes: "Variantes de talle y color",
  cuenta_corriente: "Cuenta corriente de clientes",
  medidas_bultos: "Medidas y bultos",
  listas_precios: "Listas de precios",
  agenda: "Agenda de turnos",
  packs: "Packs y sesiones",
  pos_quick_keys_pro: "Teclas rápidas Pro",
  balanza: "Balanza y códigos pesables",
};

export interface ProfileContext {
  /** Perfil aplicado hoy (tenant_business_profiles), si hay. */
  currentProfile: string | null;
  /** tenants.industry actual. */
  currentVertical: string | null;
  /** Flags operativos actuales de pos_settings (sin fila = todo apagado). */
  flags: Partial<Record<ProfileFlag, boolean>>;
  /** pos_settings.pos_layout tal cual está guardado ({} = nunca personalizado). */
  posLayout: Record<string, unknown> | null;
  /** Nombres de categorías activas del negocio. */
  categories: string[];
  /** Features efectivas del negocio (gating_summary). Ausente = no incluida. */
  features: Record<string, boolean>;
}

export type FlagStatus = "activate" | "already_on" | "locked";

export interface FlagChange {
  key: ProfileFlag;
  label: string;
  help: string;
  status: FlagStatus;
  /** Plan mínimo que la incluye (sólo cuando status = locked). */
  minPlan?: string;
}

export interface Suggestion {
  key: string;
  label: string;
  included: boolean;
  minPlan: string | null;
}

export interface ProfilePreview {
  profile: BusinessProfile;
  sameProfile: boolean;
  industry: { from: string | null; to: string; changes: boolean };
  flags: FlagChange[];
  /** Flags prendidos hoy que el perfil no usa: quedan como están. */
  keptOn: ProfileFlag[];
  layout: { status: "apply" | "keep_custom" | "same"; preset: PosPreset };
  categories: { create: string[]; existing: string[] };
  planFeatures: Suggestion[];
  payments: Suggestion[];
  /** Cantidad de cambios reales que hace el servidor al confirmar. */
  changeCount: number;
}

const norm = (s: string) => s.trim().toLocaleLowerCase("es");

function minPlanOf(key: string): string | null {
  return FEATURE_INFO[key]?.minPlan ?? null;
}

function hasFeature(features: Record<string, boolean>, key: string): boolean {
  return features[key] === true;
}

/** ¿El layout guardado es el de fábrica (nunca personalizado)? */
export function isLayoutUntouched(posLayout: Record<string, unknown> | null): boolean {
  return !posLayout || Object.keys(posLayout).length === 0;
}

export function buildProfilePreview(
  profile: BusinessProfile,
  ctx: ProfileContext,
  opts: { createCategories?: boolean } = {},
): ProfilePreview {
  const createCategories = opts.createCategories ?? true;

  const flags: FlagChange[] = profile.flags.map((key) => {
    const info = FLAG_INFO[key];
    const base = { key, label: info.label, help: info.help };
    if (ctx.flags[key]) return { ...base, status: "already_on" as const };
    if (info.feature && !hasFeature(ctx.features, info.feature)) {
      return { ...base, status: "locked" as const, minPlan: minPlanOf(info.feature) ?? undefined };
    }
    return { ...base, status: "activate" as const };
  });

  const keptOn = PROFILE_FLAGS.filter((k) => ctx.flags[k] && !profile.flags.includes(k));

  // Mesas prendidas después de aplicar (para permitir el diseño Salón).
  const diningAfter =
    Boolean(ctx.flags.dining_enabled) ||
    flags.some((f) => f.key === "dining_enabled" && f.status === "activate");

  let layoutStatus: ProfilePreview["layout"]["status"];
  if (!isLayoutUntouched(ctx.posLayout)) layoutStatus = "keep_custom";
  else if (profile.posPreset === "mostrador") layoutStatus = "same";
  else if (profile.posPreset === "salon" && !diningAfter) layoutStatus = "same";
  else layoutStatus = "apply";

  const existingNames = new Set(ctx.categories.map(norm));
  const seen = new Set<string>();
  const create: string[] = [];
  const existing: string[] = [];
  for (const c of profile.categories) {
    const n = norm(c);
    if (seen.has(n)) continue;
    seen.add(n);
    if (existingNames.has(n)) existing.push(c);
    else create.push(c);
  }

  const planFeatures: Suggestion[] = profile.planFeatures.map((key) => ({
    key,
    label: PLAN_FEATURE_LABELS[key] ?? key,
    included: hasFeature(ctx.features, key),
    minPlan: minPlanOf(key),
  }));

  const payments: Suggestion[] = profile.payments.map((key) => ({
    key,
    label: PAYMENT_LABELS[key] ?? key,
    included: hasFeature(ctx.features, key),
    minPlan: minPlanOf(key),
  }));

  const industryChanges = ctx.currentVertical !== profile.vertical;
  const activated = flags.filter((f) => f.status === "activate").length;
  const changeCount =
    activated +
    (layoutStatus === "apply" ? 1 : 0) +
    (createCategories ? create.length : 0) +
    (industryChanges ? 1 : 0);

  return {
    profile,
    sameProfile: ctx.currentProfile === profile.key,
    industry: { from: ctx.currentVertical, to: profile.vertical, changes: industryChanges },
    flags,
    keptOn,
    layout: { status: layoutStatus, preset: profile.posPreset },
    categories: { create: createCategories ? create : [], existing },
    planFeatures,
    payments,
    changeCount,
  };
}
