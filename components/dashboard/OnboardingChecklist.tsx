"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CreditCard,
  Flame,
  Package,
  Receipt,
  Rocket,
  ShoppingCart,
  Store,
  X,
  Utensils,
  CalendarDays,
  Wallet,
  Users,
  GraduationCap,
  FileText,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { buttonVariants } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IndustryPresetButton } from "@/components/onboarding/IndustryPresetButton";
import { ProfileOnboardingPrompt } from "@/components/profiles/ProfileOnboardingPrompt";
import { cn } from "@/lib/utils/cn";
import { useGating } from "@/modules/saas/gating";
import { useProfileContext } from "@/modules/profiles/hooks";
import { useOnboardingActivation } from "@/modules/help/hooks";
import {
  buildActivationChecklist,
  checklistProfile,
  type ChecklistKey,
  type ChecklistStep,
  type ChecklistStatus,
} from "@/lib/onboarding/activationChecklist";

// Pasos dinámicos por rubro y plan (F15 · H71 · ADR-086): la lista sale de
// lib/onboarding/activationChecklist.ts con el perfil por rubro (ADR-075).
type BaseKey = "fiscal" | "mp" | "producto" | "ticket" | "venta";

const ICONS: Record<ChecklistKey, React.ElementType> = {
  fiscal: Store,
  producto: Package,
  mp: CreditCard,
  ticket: Receipt,
  mesas: Utensils,
  agenda: CalendarDays,
  caja: Wallet,
  equipo: Users,
  escuela: GraduationCap,
  arca: FileText,
  venta: ShoppingCart,
};

const COLLAPSE_KEY = "onboarding-checklist-collapsed";

// Foco visible común a los controles propios de la tarjeta.
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

function pendingCopy(left: number) {
  return left === 1 ? "Te falta 1 paso para dejar todo listo." : `Te faltan ${left} pasos para dejar todo listo.`;
}

// Progreso segmentado: un segmento por paso. Hechos en tono de éxito, el
// siguiente paso en naranja (es la acción), el resto neutro.
function SegmentedProgress({
  steps,
  status,
  nextKey,
}: {
  steps: readonly ChecklistStep[];
  status: ChecklistStatus;
  nextKey: ChecklistKey | null;
}) {
  const done = steps.filter((s) => status[s.key] === true).length;
  return (
    <div
      role="progressbar"
      aria-label="Progreso de la puesta en marcha"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={done}
      aria-valuetext={`${done} de ${steps.length} pasos completados`}
      className="flex gap-1"
    >
      {steps.map((s) => (
        <span
          key={s.key}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors duration-500",
            status[s.key] === true ? "bg-success" : s.key === nextKey ? "bg-[var(--pos-solid)]" : "bg-border",
          )}
        />
      ))}
    </div>
  );
}

export interface OnboardingChecklistCardProps {
  steps: readonly ChecklistStep[];
  status: ChecklistStatus;
  onPostpone: () => void;
  onDismiss: () => void;
  /** Atajos extra al pie (perfil por rubro, catálogo de muestra). */
  children?: React.ReactNode;
}

/**
 * Vista de la "Puesta en marcha" (sólo presentación, sin datos): el siguiente
 * paso pendiente es el protagonista, el resto de pendientes va compacto debajo
 * y los completados se resumen en una fila desplegable.
 */
export function OnboardingChecklistCard({
  steps,
  status,
  onPostpone,
  onDismiss,
  children,
}: OnboardingChecklistCardProps) {
  const [showDone, setShowDone] = useState(false);
  const [showAllRest, setShowAllRest] = useState(false);
  const doneSteps = steps.filter((s) => status[s.key] === true);
  const pending = steps.filter((s) => status[s.key] !== true);
  const [next, ...rest] = pending;
  // Con muchos pendientes, "Después" muestra los primeros y el resto a pedido.
  const REST_PREVIEW = 3;
  const restCollapsible = rest.length > REST_PREVIEW + 1;
  const visibleRest = restCollapsible && !showAllRest ? rest.slice(0, REST_PREVIEW) : rest;
  const hiddenRest = rest.length - REST_PREVIEW;
  const total = steps.length;
  const NextIcon = next ? ICONS[next.key] : Rocket;
  const nextIndex = next ? steps.indexOf(next) + 1 : 0;

  return (
    <section
      aria-labelledby="onboarding-title"
      className="mt-6 animate-slide-up rounded-lg border border-border bg-card"
    >
      {/* Encabezado: título, cuánto falta, progreso segmentado y controles */}
      <div className="p-4 sm:p-6">
        <div className="flex items-start gap-3 sm:gap-4">
          <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-md bg-ninja-flame/10 text-ninja-flameSoft sm:flex">
            <Flame size={20} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h2 id="onboarding-title" className="font-display text-lg font-bold leading-tight sm:text-xl">
                Puesta en marcha
              </h2>
              <span className="font-display text-sm font-bold tabular-nums text-muted-foreground">
                {doneSteps.length}/{total}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{pendingCopy(pending.length)}</p>
          </div>
          <div className="-mr-1.5 -mt-1 flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onPostpone}
              className={cn(
                "hidden rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground sm:inline-flex",
                FOCUS,
              )}
            >
              Ocultar por ahora
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Ocultar la guía para siempre"
              title="Ocultar para siempre"
              className={cn(
                "rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground",
                FOCUS,
              )}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>

        <div className="mt-4 sm:pl-[60px]">
          <SegmentedProgress steps={steps} status={status} nextKey={next?.key ?? null} />
        </div>
      </div>

      <div className="border-t border-border p-4 sm:p-6">
        {/* Protagonista: el siguiente paso */}
        {next && (
          <div className="rounded-lg border border-border bg-muted/40 p-4 sm:p-5">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ninja-flameSoft">
              Siguiente paso · {nextIndex} de {total}
            </p>
            <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-ninja-flame/10 text-ninja-flameSoft">
                  <NextIcon size={20} aria-hidden />
                </span>
                <div className="min-w-0">
                  <h3 className="font-display text-lg font-bold leading-snug text-foreground">{next.label}</h3>
                  <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{next.desc}</p>
                </div>
              </div>
              <Link
                href={next.href as Route}
                className={cn(buttonVariants({ variant: "primary", size: "lg" }), "w-full shrink-0 sm:w-auto")}
              >
                {next.cta}
                <ArrowRight size={16} aria-hidden />
              </Link>
            </div>
          </div>
        )}

        {/* Después: el resto de pendientes, compactos */}
        {rest.length > 0 && (
          <div className="mt-5">
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Después
            </h3>
            <ul id="onboarding-rest-list" className="mt-2 divide-y divide-border">
              {visibleRest.map((step) => {
                const Icon = ICONS[step.key];
                return (
                  <li key={step.key} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Icon size={16} aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold leading-snug text-foreground">{step.label}</div>
                        <p className="mt-0.5 text-xs leading-snug text-muted-foreground sm:truncate">{step.desc}</p>
                      </div>
                    </div>
                    <Link
                      href={step.href as Route}
                      aria-label={`${step.cta}: ${step.label}`}
                      className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "w-full shrink-0 gap-1.5 sm:w-auto")}
                    >
                      {step.cta}
                      <ArrowRight size={14} aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
            {restCollapsible && (
              <button
                type="button"
                onClick={() => setShowAllRest((v) => !v)}
                aria-expanded={showAllRest}
                aria-controls="onboarding-rest-list"
                className={cn(
                  "group mb-1 inline-flex items-center gap-1.5 rounded-md py-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground",
                  FOCUS,
                )}
              >
                {showAllRest ? "Ver menos" : hiddenRest === 1 ? "Ver 1 paso más" : `Ver ${hiddenRest} pasos más`}
                <ChevronDown
                  size={16}
                  aria-hidden
                  className={cn("shrink-0 transition-transform", showAllRest && "rotate-180")}
                />
              </button>
            )}
          </div>
        )}

        {/* Completados: una sola fila desplegable */}
        {doneSteps.length > 0 && (
          <div className={cn(rest.length > 0 ? "mt-2 border-t border-border pt-3" : "mt-4")}>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              aria-expanded={showDone}
              aria-controls="onboarding-done-list"
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-sm transition",
                FOCUS,
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <Check size={14} strokeWidth={3} aria-hidden />
              </span>
              <span className="shrink-0 font-medium text-foreground">
                {doneSteps.length === 1 ? "1 paso listo" : `${doneSteps.length} pasos listos`}
              </span>
              {!showDone && (
                <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">
                  {doneSteps.map((s) => s.label).join(" · ")}
                </span>
              )}
              <ChevronDown
                size={16}
                aria-hidden
                className={cn(
                  "ml-auto shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
                  showDone && "rotate-180",
                )}
              />
            </button>
            {showDone && (
              <ul id="onboarding-done-list" className="mt-2 flex flex-wrap gap-2">
                {doneSteps.map((s) => (
                  <li key={s.key}>
                    <Link
                      href={s.href as Route}
                      aria-label={`${s.label} (listo). Revisar`}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-1.5 pr-3 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground",
                        FOCUS,
                      )}
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success">
                        <Check size={10} strokeWidth={3.5} aria-hidden />
                      </span>
                      {s.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {children}

        {/* En celular, "Ocultar por ahora" va al pie para no apretar el título. */}
        <button
          type="button"
          onClick={onPostpone}
          className={cn(
            buttonVariants({ variant: "ghost", size: "md" }),
            "mt-3 w-full font-medium text-muted-foreground sm:hidden",
          )}
        >
          Ocultar por ahora
        </button>
      </div>
    </section>
  );
}

export function OnboardingCelebration({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-6 animate-slide-up rounded-lg border border-border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-success/15 text-success">
          <Rocket size={22} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-bold leading-tight">¡Todo listo para vender!</h2>
          <p className="text-sm text-muted-foreground">Configuraste tu negocio. Esta guía no volverá a aparecer.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className={cn(
            "shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground",
            FOCUS,
          )}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function OnboardingCollapsedPill({
  done,
  total,
  onExpand,
}: {
  done: number;
  total: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Mostrar la puesta en marcha: ${done} de ${total} pasos completados`}
      className={cn(
        "group mt-6 inline-flex items-center gap-2.5 rounded-md border border-border bg-card py-2 pl-2 pr-4 text-sm font-medium text-foreground transition hover:bg-muted/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded bg-ninja-flame/10 text-ninja-flameSoft">
        <Flame size={13} aria-hidden />
      </span>
      <span>Puesta en marcha</span>
      <span className="font-display text-xs font-bold tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
      <ArrowRight
        size={14}
        aria-hidden
        className="text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </button>
  );
}

export function OnboardingChecklist() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: ctx } = useQuery({
    queryKey: ["onboarding-ctx"],
    queryFn: async (): Promise<{ tenantId: string } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return { tenantId: mem.tenant_id };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: status } = useQuery({
    queryKey: ["onboarding-status"],
    enabled: !!tenantId,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<BaseKey, boolean>> => {
      const { data, error } = await supabase.rpc("onboarding_status");
      if (error) throw error;
      const r = (data ?? {}) as Partial<Record<BaseKey, boolean>>;
      return {
        fiscal: !!r.fiscal,
        mp: !!r.mp,
        producto: !!r.producto,
        ticket: !!r.ticket,
        venta: !!r.venta,
      };
    },
  });

  const { data: dismissed } = useQuery({
    queryKey: ["onboarding-dismissed", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<boolean> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("onboarding_dismissed")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      return Boolean((data as { onboarding_dismissed?: boolean } | null)?.onboarding_dismissed);
    },
  });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v);
    if (typeof window !== "undefined") {
      if (v) window.localStorage.setItem(COLLAPSE_KEY, "1");
      else window.localStorage.removeItem(COLLAPSE_KEY);
    }
  };

  // Señales extra (caja, equipo, salón, agenda, ARCA, Escuela) y pasos según
  // el perfil por rubro aplicado (o el sugerido por el rubro del alta).
  // Sin la migración nueva la RPC falla: el checklist sigue con los pasos base.
  const { data: extra, isFetched: extraFetched } = useOnboardingActivation(!!tenantId);
  const { tenant, applied } = useProfileContext();
  const { data: gating } = useGating();
  const STEPS = buildActivationChecklist({
    profile: checklistProfile(applied?.profile_key, tenant?.industry),
    features: gating?.features ?? {},
  });
  const merged: ChecklistStatus | null = status && extraFetched && gating ? { ...(extra ?? {}), ...status } : null;

  const ready = merged !== null;
  const done = merged ? STEPS.filter((s) => merged[s.key] === true).length : 0;
  const total = STEPS.length;
  const allDone = done === total;

  // Estado de éxito efímero: cuando el checklist pasa a completo en la sesión,
  // mostramos una tarjeta de logro una sola vez (luego desaparece sola).
  const wasComplete = useRef<boolean | null>(null);
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    if (!ready) return;
    if (wasComplete.current === null) {
      wasComplete.current = allDone;
      return;
    }
    if (!wasComplete.current && allDone) {
      setCelebrate(true);
      toast({
        title: "¡Negocio configurado!",
        description: "Ya tenés todo listo para vender.",
        variant: "success",
      });
    }
    wasComplete.current = allDone;
  }, [allDone, ready, toast]);

  const dismiss = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("pos_settings")
        .upsert(
          { tenant_id: tenantId, onboarding_dismissed: true } as never,
          { onConflict: "tenant_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["onboarding-dismissed", tenantId] });
    },
    onError: () => toast({ title: "No se pudo ocultar la guía", variant: "error" }),
  });

  // Sin datos o descartado: no renderiza nada.
  if (!merged || dismissed) return null;

  // Estado de logro efímero (una vez completado dentro de la sesión).
  if (allDone) {
    if (!celebrate) return null;
    return <OnboardingCelebration onClose={() => setCelebrate(false)} />;
  }

  // Pill compacto cuando el usuario eligió "Ocultar por ahora".
  if (collapsed) {
    return <OnboardingCollapsedPill done={done} total={total} onExpand={() => setCollapsedPersist(false)} />;
  }

  return (
    <>
      <OnboardingChecklistCard
        steps={STEPS}
        status={merged}
        onPostpone={() => setCollapsedPersist(true)}
        onDismiss={() => setConfirmOpen(true)}
      >
        {/* Perfil por rubro (F5 · ADR-075): al crear el negocio, el dueño elige
            el perfil de su rubro con vista previa de lo que cambia. */}
        <ProfileOnboardingPrompt />

        {/* Configuración rápida por rubro (F12 · H35): atajo para sembrar un
            catálogo de muestra cuando todavía no se cargaron productos. Deja
            el negocio listo para cobrar sin Excel ni SQL. */}
        {!merged.producto && (
          <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">¿Heladería, peluquería, cafetería?</span>{" "}
              Sembrá un catálogo de muestra por rubro en un par de clics.
            </p>
            <IndustryPresetButton size="sm" className="w-full shrink-0 sm:w-auto" />
          </div>
        )}
      </OnboardingChecklistCard>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="¿Ocultar la guía para siempre?"
        description="No volverá a aparecer en este negocio. Igual podés configurar todo desde cada sección."
        confirmLabel="Ocultar para siempre"
        danger
        loading={dismiss.isPending}
        onConfirm={() => dismiss.mutate()}
      />
    </>
  );
}
