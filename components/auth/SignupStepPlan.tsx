"use client";

import { Check, Sparkles, Phone } from "lucide-react";
import { PlanBadge } from "@/components/internal/plans/PlanBadge";
import {
  useSignupPlans,
  formatPlanPrice,
  type SignupPlan,
} from "@/modules/saas/signupPlans";
import { cn } from "@/lib/utils/cn";

// Módulos destacados a resaltar en la tarjeta (orden = prioridad). Sólo se
// muestran los que el plan incluye; tope de 3 para no saturar la tarjeta.
const HIGHLIGHT_MODULES: { key: string; label: string }[] = [
  { key: "facturacion_afip", label: "Facturación AFIP" },
  { key: "mercado_pago", label: "Cobros con Mercado Pago" },
  { key: "variantes", label: "Variantes de producto" },
  { key: "multi_sucursal", label: "Multi-sucursal" },
  { key: "metricas_avanzadas", label: "Métricas avanzadas" },
  { key: "roles_permisos", label: "Roles y permisos" },
  { key: "panel_dueno", label: "Panel del dueño" },
  { key: "soporte_prioritario", label: "Soporte prioritario" },
  { key: "api_publica", label: "API pública" },
];

// Construye 3–4 "highlights" legibles de un plan: primero límites concretos
// (usuarios/sucursales/productos), luego módulos destacados que incluya.
function planHighlights(plan: SignupPlan): string[] {
  const out: string[] = [];
  const limits = plan.limits?.limits ?? {};
  const modules = plan.limits?.modules ?? {};

  const users = limits.max_users;
  out.push(
    users == null ? "Usuarios ilimitados" : `Hasta ${users} usuarios`,
  );

  const stores = limits.max_stores;
  if (stores != null && stores > 1) out.push(`Hasta ${stores} sucursales`);
  else if (stores == null) out.push("Sucursales ilimitadas");

  const products = limits.max_products;
  if (products != null) out.push(`Hasta ${products.toLocaleString("es-AR")} productos`);
  else out.push("Productos ilimitados");

  for (const m of HIGHLIGHT_MODULES) {
    if (out.length >= 5) break;
    if (modules[m.key] === true) out.push(m.label);
  }
  return out.slice(0, 5);
}

function trialLabel(days: number): string {
  if (days <= 0) return "";
  return days === 1 ? "1 día gratis" : `${days} días gratis`;
}

function PlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: SignupPlan;
  selected: boolean;
  onSelect: () => void;
}) {
  const recommended = plan.isRecommended;
  const isContact = plan.trialDays <= 0; // Enterprise: pago/contacto.
  const highlights = planHighlights(plan);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "relative flex flex-col gap-4 rounded-2xl border p-5 text-left transition",
        selected
          ? "border-ninja-flame bg-ninja-flame/[0.06] ring-2 ring-ninja-flame/40"
          : recommended
            ? "border-ninja-flame/40 bg-white/[0.03] hover:border-ninja-flame/70"
            : "border-white/10 bg-white/[0.03] hover:border-ninja-flameSoft/50 hover:bg-white/[0.06]",
      )}
    >
      {recommended && (
        <span className="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-ninja-gradient px-2.5 py-0.5 text-[11px] font-bold text-white shadow-ninjaGlow">
          <Sparkles size={11} /> Recomendado
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <PlanBadge
          plan={{
            name: plan.name,
            secondaryName: plan.secondaryName,
            icon: plan.icon,
          }}
          size="sm"
        />
        {/* Radio visual */}
        <span
          className={cn(
            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition",
            selected
              ? "border-ninja-flame bg-ninja-flame text-white"
              : "border-white/25",
          )}
          aria-hidden
        >
          {selected && <Check size={12} strokeWidth={3} />}
        </span>
      </div>

      <div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-black tracking-tight text-ninja-softWhite">
            {formatPlanPrice(plan.monthlyPriceArs)}
          </span>
          <span className="text-sm text-ninja-lavender">/mes</span>
        </div>
        {isContact ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-ninja-lavender">
            <Phone size={11} /> Pago inmediato · se activa al pagar
          </span>
        ) : (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
            {trialLabel(plan.trialDays)} · sin tarjeta
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {highlights.map((h) => (
          <li
            key={h}
            className="flex items-start gap-2 text-sm text-ninja-lavender"
          >
            <Check
              size={15}
              className="mt-0.5 shrink-0 text-ninja-flameSoft"
            />
            <span>{h}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

export function SignupStepPlan({
  value,
  onChange,
}: {
  // key del plan elegido (null hasta resolver el plan recomendado por defecto).
  value: string | null;
  onChange: (planKey: string) => void;
}) {
  const { data: plans, isLoading, isError } = useSignupPlans();

  if (isLoading) {
    return (
      <div className="grid place-items-center py-10">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-ninja-flameSoft border-t-transparent" />
      </div>
    );
  }

  if (isError || !plans || plans.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-ninja-lavender">
        No pudimos cargar los planes ahora. Vas a poder elegirlo desde tu panel
        después de crear la cuenta.
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-sans text-xl font-bold tracking-[-0.01em] text-ninja-softWhite">
        Elegí tu plan
      </h3>
      <p className="mt-1 text-sm text-ninja-lavender">
        Empezá con tu prueba gratis. Podés cambiar de plan cuando quieras.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {plans.map((p) => (
          <PlanCard
            key={p.key}
            plan={p}
            selected={value === p.key}
            onSelect={() => onChange(p.key)}
          />
        ))}
      </div>
    </div>
  );
}
