"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";
import {
  useSignupPlans,
  formatPlanPrice,
  type SignupPlan,
} from "@/modules/saas/signupPlans";
import { useAiPublicConfig } from "@/modules/saas/aiPublicConfig";
import { PlanCards, type PlanCardModel } from "@/components/saas/PlanCards";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";
import { AssistantMark } from "@/components/ai/AssistantMark";

// Mapea un SignupPlan (forma del selector) al modelo de PlanCards.
function toPlanCardModel(p: SignupPlan): PlanCardModel {
  return {
    key: p.key,
    name: p.name,
    secondaryName: p.secondaryName,
    imageUrl: p.imageUrl,
    icon: p.icon,
    monthlyPriceArs: p.monthlyPriceArs,
    trialDays: p.trialDays,
    isRecommended: p.isRecommended,
    sort: p.sort,
    modules: p.limits?.modules ?? {},
    limits: p.limits?.limits ?? {},
  };
}

// Beneficios cortos del Asistente IA para la venta en el registro.
const AI_BENEFITS = [
  "Consultá tus ventas en lenguaje natural",
  "Resolvé dudas del sistema al instante",
  "Sugerencias para vender y reponer mejor",
  "Disponible para todo tu equipo, en cada pantalla",
];

export function SignupStepPlan({
  value,
  onChange,
  addonAi,
  onAddonAiChange,
}: {
  // key del plan elegido (null hasta resolver el plan recomendado por defecto).
  value: string | null;
  onChange: (planKey: string) => void;
  // Estado del toggle "sumar Asistente IA" (controlado por el wizard).
  addonAi: boolean;
  onAddonAiChange: (v: boolean) => void;
}) {
  const { data: plans, isLoading, isError } = useSignupPlans();
  // ai_public_config() tiene grant a anon (payload público, sin secretos), así
  // que resuelve también en el flujo email PRE-AUTH: el precio "+$X/mes" del
  // addon se muestra sin sesión. Si no hay config → null → copy genérico.
  const { data: aiCfg } = useAiPublicConfig();

  const planModels = useMemo<PlanCardModel[]>(
    () => (plans ?? []).map(toPlanCardModel),
    [plans],
  );

  // Plan de referencia para resaltar diferencias: el recomendado (Pro). Así las
  // tarjetas muestran "qué suma cada plan" empujando al menos a Pro.
  const comparedToKey = useMemo(() => {
    const rec = (plans ?? []).find((p) => p.isRecommended);
    return rec?.key ?? null;
  }, [plans]);

  const recommendedName = (plans ?? []).find((p) => p.isRecommended)?.name ?? null;
  const aiPrice = (aiCfg?.addon_price_ars ?? "").trim();
  const aiTrialDays = Number(aiCfg?.addon_trial_days ?? "") || 0;

  if (isLoading) {
    return (
      <div className="grid place-items-center py-10">
        <Spinner size={24} />
      </div>
    );
  }

  if (isError || !plans || plans.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground">
        No pudimos cargar los planes ahora. Vas a poder elegirlo desde tu panel
        después de crear la cuenta.
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-sans text-xl font-bold tracking-[-0.01em] text-foreground">
        Elegí tu plan
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Mirá qué suma cada plan. Empezá con tu prueba gratis y cambiá cuando
        quieras.
      </p>

      <PlanCards
        className="mt-5"
        plans={planModels}
        selectedKey={value}
        onSelect={onChange}
        comparedToKey={comparedToKey}
        columnsClassName="gap-4 sm:grid-cols-2"
        diffLabel={recommendedName ? `Suma sobre ${recommendedName}` : "Suma sobre el recomendado"}
      />

      {/* ── Add-on IA: venta + toggle ── */}
      <button
        type="button"
        onClick={() => onAddonAiChange(!addonAi)}
        aria-pressed={addonAi}
        className={cn(
          "mt-4 flex w-full flex-col gap-3 rounded-lg border p-4 pr-10 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          addonAi
            ? "choice-on choice-check"
            : "border-border bg-card hover:bg-secondary",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <AssistantMark size={40} sparkle={false} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">
                  Sumar Asistente IA
                </span>
                {aiPrice ? (
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    +{formatPlanPrice(Number(aiPrice))}/mes
                  </span>
                ) : null}
                {aiTrialDays > 0 && (
                  <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                    {aiTrialDays} días gratis
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {aiCfg?.commercial_text?.trim() ||
                  "Inteligencia artificial que conoce tu negocio: te responde sobre ventas, stock y cómo usar cada función."}
              </p>
            </div>
          </div>
          {/* Switch visual (el click del bloque entero hace el toggle). */}
          <span className="pointer-events-none mt-1 shrink-0">
            <Switch checked={addonAi} onCheckedChange={onAddonAiChange} />
          </span>
        </div>

        <ul className="grid gap-1 sm:grid-cols-2">
          {AI_BENEFITS.map((b) => (
            <li
              key={b}
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <Check size={13} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        {addonAi && (
          <p className="text-[11px] text-ninja-flameSoft">
            {aiTrialDays > 0
              ? `Lo activamos con tus ${aiTrialDays} días gratis al crear tu cuenta.`
              : "Se suma a tu suscripción al crear tu cuenta. Lo podés dar de baja cuando quieras."}
          </p>
        )}
      </button>
    </div>
  );
}
