// lib/saas/planComparison.ts
//
// Helper PURO (sin UI, sin React) para comparar planes a partir de su matriz de
// features. Lo consume el registro (qué incluye cada plan) y el panel del dueño
// ("qué incluye cada uno a diferencia del otro"). No hace fetching: recibe los
// datos ya cargados (planes con limits.modules + catálogo de features).
//
// Una feature se considera INCLUIDA en un plan si:
//   - su key aparece en plan.limits.modules con valor true, o
//   - no aparece en modules PERO es básica (is_basic) — las básicas vienen por
//     defecto en todo plan salvo que se apaguen explícitamente (modules[key] =
//     false). Esto refleja la semántica del gating real (tenant_has_feature),
//     donde la ausencia cae al fallback de is_basic.
//
// Todo es tipado y testeable; las entradas son "lo mínimo necesario" (Pick-like)
// para no acoplar a los tipos completos de la API.

// Forma mínima de una feature del catálogo.
export interface ComparableFeature {
  key: string;
  label: string;
  grupo: string;
  is_basic: boolean;
  sort: number;
}

// Forma mínima de un plan para comparar (subset de PlanWithCount).
export interface ComparablePlan {
  key: string;
  name: string;
  sort: number;
  // plan.limits.modules: mapa featureKey -> boolean (presencia = respeta el
  // valor; ausencia = fallback a is_basic de la feature).
  modules: Record<string, boolean>;
}

// Una feature dentro de un plan, con su estado de inclusión resuelto.
export interface PlanFeatureState {
  key: string;
  label: string;
  grupo: string;
  sort: number;
  isBasic: boolean;
  included: boolean;
}

// Resultado de "qué incluye un plan": features incluidas / excluidas (ordenadas).
export interface PlanFeatures {
  planKey: string;
  planName: string;
  features: PlanFeatureState[]; // todas las features del catálogo, con included.
  includedKeys: string[]; // solo las incluidas (orden de catálogo).
}

// Diferencia de UNA feature entre dos planes (a vs b).
export interface FeatureDiff {
  key: string;
  label: string;
  grupo: string;
  inA: boolean;
  inB: boolean;
}

// Comparación entre dos planes: qué tiene cada uno que el otro no.
export interface PlanPairDiff {
  aKey: string;
  bKey: string;
  // Features que A incluye y B no.
  onlyInA: PlanFeatureState[];
  // Features que B incluye y A no.
  onlyInB: PlanFeatureState[];
  // Features incluidas en ambos.
  inBoth: PlanFeatureState[];
  // Lista completa de diferencias (inA != inB), orden de catálogo.
  diffs: FeatureDiff[];
}

// ── Núcleo ──────────────────────────────────────────────────────────────────

// ¿La feature `f` está incluida en el plan `plan`? (semántica del gating real).
export function featureIncludedInPlan(
  plan: ComparablePlan,
  f: Pick<ComparableFeature, "key" | "is_basic">,
): boolean {
  const explicit = plan.modules[f.key];
  if (explicit === undefined) return f.is_basic; // ausente → fallback a básica.
  return explicit === true;
}

// Ordena features por (sort asc, luego key) para una salida estable.
function bySort(a: ComparableFeature, b: ComparableFeature): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.key.localeCompare(b.key);
}

// Resuelve el estado de inclusión de TODAS las features para un plan.
export function planFeatures(
  plan: ComparablePlan,
  features: ComparableFeature[],
): PlanFeatures {
  const ordered = [...features].sort(bySort);
  const states: PlanFeatureState[] = ordered.map((f) => ({
    key: f.key,
    label: f.label,
    grupo: f.grupo,
    sort: f.sort,
    isBasic: f.is_basic,
    included: featureIncludedInPlan(plan, f),
  }));
  return {
    planKey: plan.key,
    planName: plan.name,
    features: states,
    includedKeys: states.filter((s) => s.included).map((s) => s.key),
  };
}

// Mapa planKey -> PlanFeatures para toda la lista de planes.
export function comparePlans(
  plans: ComparablePlan[],
  features: ComparableFeature[],
): Record<string, PlanFeatures> {
  const out: Record<string, PlanFeatures> = {};
  for (const p of plans) out[p.key] = planFeatures(p, features);
  return out;
}

// Diferencias entre DOS planes (a vs b): qué incluye cada uno que el otro no.
export function diffPlans(
  a: ComparablePlan,
  b: ComparablePlan,
  features: ComparableFeature[],
): PlanPairDiff {
  const ordered = [...features].sort(bySort);
  const onlyInA: PlanFeatureState[] = [];
  const onlyInB: PlanFeatureState[] = [];
  const inBoth: PlanFeatureState[] = [];
  const diffs: FeatureDiff[] = [];

  for (const f of ordered) {
    const inA = featureIncludedInPlan(a, f);
    const inB = featureIncludedInPlan(b, f);
    const state: PlanFeatureState = {
      key: f.key,
      label: f.label,
      grupo: f.grupo,
      sort: f.sort,
      isBasic: f.is_basic,
      included: false, // se sobreescribe abajo según el bucket.
    };
    if (inA && inB) inBoth.push({ ...state, included: true });
    else if (inA && !inB) onlyInA.push({ ...state, included: true });
    else if (!inA && inB) onlyInB.push({ ...state, included: true });

    if (inA !== inB) {
      diffs.push({ key: f.key, label: f.label, grupo: f.grupo, inA, inB });
    }
  }

  return { aKey: a.key, bKey: b.key, onlyInA, onlyInB, inBoth, diffs };
}

// Para una lista ORDENADA de planes (p. ej. por sort: Start→Pro→Business→…),
// devuelve, para cada plan a partir del 2º, qué features SUMA respecto del plan
// inmediatamente anterior. Útil para mostrar "qué agrega cada nivel".
export interface PlanUpgradeDelta {
  fromKey: string;
  toKey: string;
  toName: string;
  // Features nuevas que el plan `to` incluye y `from` no.
  added: PlanFeatureState[];
}

export function upgradeDeltas(
  plansSorted: ComparablePlan[],
  features: ComparableFeature[],
): PlanUpgradeDelta[] {
  const out: PlanUpgradeDelta[] = [];
  for (let i = 1; i < plansSorted.length; i++) {
    const from = plansSorted[i - 1];
    const to = plansSorted[i];
    // noUncheckedIndexedAccess: el rango del for garantiza ambos definidos.
    if (!from || !to) continue;
    const { onlyInB } = diffPlans(from, to, features);
    out.push({
      fromKey: from.key,
      toKey: to.key,
      toName: to.name,
      added: onlyInB,
    });
  }
  return out;
}

// ── Adaptador opcional desde la forma de la API interna ──────────────────────
// PlanWithCount tiene `limits: { modules?: Record<string, unknown> }`. Esta
// función normaliza a ComparablePlan (modules como Record<string, boolean>).
export function toComparablePlan(p: {
  key: string;
  name: string;
  sort: number;
  limits?: { modules?: Record<string, unknown> | null } | null;
}): ComparablePlan {
  const rawModules = (p.limits?.modules ?? {}) as Record<string, unknown>;
  const modules: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rawModules)) modules[k] = Boolean(v);
  return { key: p.key, name: p.name, sort: p.sort, modules };
}
