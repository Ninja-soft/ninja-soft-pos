"use client";

// =============================================================================
// PlanCards — tarjetas COMERCIALES de planes, reutilizables.
//
// Las usa:
//   • el registro (paso "Tu plan"): empuja a comprar mínimo Pro.
//   • el panel del dueño (cambiar/mejorar plan): "qué incluye cada uno a
//     diferencia del actual".
//
// Cada tarjeta muestra: logo/imagen del plan (o ícono+nombre vía PlanBadge),
// nombre secundario ninja, precio ARS, trial / pago, una lista de "qué incluye"
// derivada del catálogo de features (planComparison + featureInfo) y, si se pasa
// `comparedToKey`, las DIFERENCIAS resaltadas respecto de ese plan de referencia.
// Pro (is_recommended) siempre destacado. El CTA es configurable (render prop).
//
// No hace fetching de planes: los recibe ya cargados (forma `PlanCardModel`,
// derivable de public_plans() / signupPlans). Sí carga, una sola vez y cacheado,
// el catálogo de features (público: features_select = using(true)) para resolver
// inclusiones y diferencias.
// =============================================================================

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PlanBadge } from "@/components/internal/plans/PlanBadge";
import {
  diffPlans,
  featureIncludedInPlan,
  toComparablePlan,
  type ComparableFeature,
} from "@/lib/saas/planComparison";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { cn } from "@/lib/utils/cn";

// Forma mínima de un plan para la tarjeta. `modules` es el mapa featureKey->bool
// de plan.limits.modules; `limits` son los límites numéricos (usuarios/sucursales
// /productos) que también vendemos como highlights.
export interface PlanCardModel {
  key: string;
  name: string;
  secondaryName: string | null;
  imageUrl: string | null;
  icon: string | null;
  monthlyPriceArs: number;
  trialDays: number;
  isRecommended: boolean;
  sort: number;
  modules: Record<string, boolean>;
  limits: Record<string, number | null>;
}

// Catálogo de features (público). Cacheado: cambia rara vez.
function useFeatureCatalog() {
  return useQuery({
    queryKey: ["saas", "feature-catalog"],
    queryFn: async (): Promise<ComparableFeature[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("features")
        .select("key, label, grupo, is_basic, sort")
        .order("sort");
      if (error) throw error;
      return (data ?? []) as ComparableFeature[];
    },
    staleTime: 10 * 60_000,
  });
}

const ars = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
function fmtPrice(value: number): string {
  return ars.format(value);
}

function trialLabel(days: number): string {
  if (days <= 0) return "";
  return days === 1 ? "1 día gratis" : `${days} días gratis`;
}

// Highlights de límites concretos que el cliente entiende al instante.
function limitHighlights(limits: Record<string, number | null>): string[] {
  const out: string[] = [];
  const users = limits.max_users;
  out.push(users == null ? "Usuarios ilimitados" : `Hasta ${users} usuarios`);
  const stores = limits.max_stores;
  if (stores != null && stores > 1) out.push(`Hasta ${stores} sucursales`);
  else if (stores == null) out.push("Sucursales ilimitadas");
  const products = limits.max_products;
  if (products != null)
    out.push(`Hasta ${products.toLocaleString("es-AR")} productos`);
  else out.push("Productos ilimitados");
  return out;
}

// Label legible de una feature: preferimos el del catálogo (DB), con fallback al
// copy de featureInfo si hiciera falta.
function featureLabel(f: ComparableFeature): string {
  return f.label || FEATURE_INFO[f.key]?.desc?.split(":")[0] || f.key;
}

// Una línea de la lista de "qué incluye" / diferencias.
function FeatureLine({
  label,
  tone,
}: {
  label: string;
  tone: "included" | "added";
}) {
  const added = tone === "added";
  return (
    <li
      className={cn(
        "flex items-start gap-2 text-sm",
        added ? "text-ninja-flameSoft" : "text-ninja-lavender",
      )}
    >
      {added ? (
        <Plus size={15} className="mt-0.5 shrink-0 text-ninja-flame" strokeWidth={2.5} />
      ) : (
        <Check size={15} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
      )}
      <span className={cn(added && "font-medium text-ninja-softWhite")}>
        {label}
      </span>
    </li>
  );
}

function PlanCardItem({
  plan,
  features,
  comparedTo,
  selected,
  onSelect,
  cta,
}: {
  plan: PlanCardModel;
  features: ComparableFeature[];
  // Plan de referencia (el actual del dueño, o el inmediato anterior). Si está,
  // resaltamos lo que ESTE plan suma respecto de él.
  comparedTo: PlanCardModel | null;
  selected: boolean;
  onSelect?: () => void;
  cta?: ReactNode;
}) {
  const recommended = plan.isRecommended;
  const isContact = plan.trialDays <= 0;

  // Diferencias vs el plan de referencia (sólo lo que ESTE suma).
  const added = useMemo(() => {
    if (!comparedTo || comparedTo.key === plan.key) return [];
    const { onlyInB } = diffPlans(
      toComparablePlan({ key: comparedTo.key, name: comparedTo.name, sort: comparedTo.sort, limits: { modules: comparedTo.modules } }),
      toComparablePlan({ key: plan.key, name: plan.name, sort: plan.sort, limits: { modules: plan.modules } }),
      features,
    );
    return onlyInB.map((s) => s.label);
  }, [comparedTo, plan, features]);

  // "Qué incluye" (módulos destacados que el plan trae). Cuando hay comparación,
  // priorizamos las diferencias arriba y completamos con incluidas base.
  const includedLabels = useMemo(() => {
    const comp = toComparablePlan({
      key: plan.key,
      name: plan.name,
      sort: plan.sort,
      limits: { modules: plan.modules },
    });
    return features
      .filter((f) => !f.is_basic && featureIncludedInPlan(comp, f))
      .map((f) => featureLabel(f));
  }, [plan, features]);

  const limitLines = useMemo(() => limitHighlights(plan.limits), [plan.limits]);

  const hasDiff = added.length > 0;
  // Cuántas features mostrar (la tarjeta no debe ser un muro de texto).
  const baseList = hasDiff
    ? includedLabels.filter((l) => !added.includes(l)).slice(0, 3)
    : includedLabels.slice(0, 5);

  return (
    <div
      className={cn(
        "relative flex flex-col gap-4 rounded-2xl border p-5 text-left transition",
        selected
          ? "border-ninja-flame bg-ninja-flame/[0.06] ring-2 ring-ninja-flame/40"
          : recommended
            ? "border-ninja-flame/45 bg-muted/60 shadow-ninjaGlow"
            : "border-border bg-muted/60",
      )}
    >
      {recommended && (
        <span className="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-ninja-gradient px-2.5 py-0.5 text-[11px] font-bold text-white shadow-ninjaGlow">
          <Sparkles size={11} /> Recomendado
        </span>
      )}

      <button
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        aria-pressed={selected}
        className={cn(
          "flex items-start justify-between gap-3 rounded-lg text-left",
          onSelect && "cursor-pointer",
        )}
      >
        <PlanBadge
          plan={{
            name: plan.name,
            secondaryName: plan.secondaryName,
            imageUrl: plan.imageUrl,
            icon: plan.icon,
          }}
          size="sm"
        />
        {onSelect && (
          <span
            className={cn(
              "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition",
              selected
                ? "border-ninja-flame bg-ninja-flame text-white"
                : "border-muted-foreground/40",
            )}
            aria-hidden
          >
            {selected && <Check size={12} strokeWidth={3} />}
          </span>
        )}
      </button>

      <div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-black tracking-tight text-ninja-softWhite">
            {fmtPrice(plan.monthlyPriceArs)}
          </span>
          <span className="text-sm text-ninja-lavender">/mes</span>
        </div>
        {isContact ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-ninja-lavender">
            Pago inmediato · se activa al pagar
          </span>
        ) : (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-success">
            {trialLabel(plan.trialDays)} · sin tarjeta
          </span>
        )}
      </div>

      {/* Diferencias vs el plan de referencia (lo que ESTE suma). */}
      {hasDiff && (
        <div>
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ninja-flame">
            Sumás respecto del actual
          </div>
          <ul className="space-y-1.5">
            {added.slice(0, 6).map((l) => (
              <FeatureLine key={l} label={l} tone="added" />
            ))}
          </ul>
        </div>
      )}

      {/* Qué incluye (límites + módulos). */}
      <ul className="space-y-1.5">
        {limitLines.map((l) => (
          <FeatureLine key={l} label={l} tone="included" />
        ))}
        {baseList.map((l) => (
          <FeatureLine key={l} label={l} tone="included" />
        ))}
      </ul>

      {cta && <div className="mt-auto pt-1">{cta}</div>}
    </div>
  );
}

export function PlanCards({
  plans,
  selectedKey,
  onSelect,
  comparedToKey,
  renderCta,
  className,
  // 4 planes (Start/Pro/Business/Enterprise): 1 col mobile, 2 tablet, 4 desktop.
  // Así entran todos sin cortarse en el selector/registro.
  columnsClassName = "sm:grid-cols-2 lg:grid-cols-4",
}: {
  plans: PlanCardModel[];
  // Selección visual (registro). Si se pasa onSelect, las tarjetas son clickeables.
  selectedKey?: string | null;
  onSelect?: (planKey: string) => void;
  // Plan de referencia para resaltar diferencias (el actual del dueño).
  comparedToKey?: string | null;
  // CTA por plan (ej. botón "Mejorar" en el panel). Recibe el plan y si es el actual.
  renderCta?: (plan: PlanCardModel, isCompared: boolean) => ReactNode;
  className?: string;
  columnsClassName?: string;
}) {
  const { data: features = [] } = useFeatureCatalog();
  const compared = comparedToKey
    ? plans.find((p) => p.key === comparedToKey) ?? null
    : null;

  // Orden estable por sort (Start → Pro → Business → Enterprise).
  const ordered = useMemo(
    () => [...plans].sort((a, b) => a.sort - b.sort || a.monthlyPriceArs - b.monthlyPriceArs),
    [plans],
  );

  return (
    <div className={cn("grid gap-3", columnsClassName, className)}>
      {ordered.map((p) => (
        <PlanCardItem
          key={p.key}
          plan={p}
          features={features}
          comparedTo={compared}
          selected={selectedKey === p.key}
          onSelect={onSelect ? () => onSelect(p.key) : undefined}
          cta={renderCta?.(p, compared?.key === p.key)}
        />
      ))}
    </div>
  );
}
