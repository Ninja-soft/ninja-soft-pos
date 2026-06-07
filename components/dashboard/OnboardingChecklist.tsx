"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CreditCard,
  Flame,
  Package,
  Receipt,
  Rocket,
  ShoppingCart,
  Store,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils/cn";

type StatusKey = "fiscal" | "mp" | "producto" | "ticket" | "venta";

type OnboardingStatus = Record<StatusKey, boolean>;

const STEPS: {
  key: StatusKey;
  label: string;
  desc: string;
  icon: React.ElementType;
  cta: string;
  href: Route;
}[] = [
  {
    key: "fiscal",
    label: "Datos del negocio",
    desc: "Razón social, CUIT y condición de IVA para tus comprobantes.",
    icon: Store,
    cta: "Completar",
    href: "/configuracion?seccion=marca" as Route,
  },
  {
    key: "mp",
    label: "Medios de pago",
    desc: "Conectá Mercado Pago y cobrá con QR desde el POS.",
    icon: CreditCard,
    cta: "Conectar",
    href: "/configuracion?seccion=pagos" as Route,
  },
  {
    key: "producto",
    label: "Cargá productos",
    desc: "Sumá tu primer artículo para empezar a vender.",
    icon: Package,
    cta: "Cargar",
    href: "/productos",
  },
  {
    key: "ticket",
    label: "Diseño de ticket",
    desc: "Elegí cómo se ve el comprobante que entregás.",
    icon: Receipt,
    cta: "Elegir",
    href: "/configuracion?seccion=tickets" as Route,
  },
  {
    key: "venta",
    label: "Primera venta",
    desc: "Cerrá una venta de prueba y dejá todo listo.",
    icon: ShoppingCart,
    cta: "Vender",
    href: "/pos",
  },
];

const COLLAPSE_KEY = "onboarding-checklist-collapsed";

// Anillo de progreso (SVG) con gradiente flame.
function ProgressRing({ pct }: { pct: number }) {
  const size = 56;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <span className="relative inline-flex h-14 w-14 shrink-0 items-center justify-center">
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id="onb-ring" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FF4B22" />
            <stop offset="50%" stopColor="#FF8A1F" />
            <stop offset="100%" stopColor="#FFD21F" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-border"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke="url(#onb-ring)"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <span className="absolute font-display text-sm font-bold tabular-nums text-foreground">
        {pct}%
      </span>
    </span>
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
    queryFn: async (): Promise<OnboardingStatus> => {
      const { data, error } = await supabase.rpc("onboarding_status");
      if (error) throw error;
      const r = (data ?? {}) as Partial<Record<StatusKey, boolean>>;
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

  const done = status ? STEPS.filter((s) => status[s.key]).length : 0;
  const total = STEPS.length;
  const allDone = done === total;
  const pct = Math.round((done / total) * 100);

  // Estado de éxito efímero: cuando el checklist pasa a completo en la sesión,
  // mostramos una tarjeta de logro una sola vez (luego desaparece sola).
  const wasComplete = useRef<boolean | null>(null);
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    if (!status) return;
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
  }, [allDone, status, toast]);

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
  if (!status || dismissed) return null;

  // Estado de logro efímero (una vez completado dentro de la sesión).
  if (allDone) {
    if (!celebrate) return null;
    return (
      <div className="mt-6 animate-slide-up">
        <div className="relative overflow-hidden rounded-ninjaLg border border-ninja-flame/25 bg-card/80 p-5 shadow-ninjaSoft backdrop-blur-xl sm:p-6">
          <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-ninja-flame/15 blur-3xl" />
          <div className="relative flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-ninjaMd bg-ninja-gradient text-white shadow-ninjaGlow">
              <Rocket size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-lg font-bold leading-tight">
                ¡Todo listo para vender!
              </h2>
              <p className="text-sm text-muted-foreground">
                Configuraste tu negocio. Esta guía no volverá a aparecer.
              </p>
            </div>
            <button
              onClick={() => setCelebrate(false)}
              aria-label="Cerrar"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Pill compacto cuando el usuario eligió "Saltar por ahora".
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsedPersist(false)}
        className="group mt-6 inline-flex items-center gap-2.5 rounded-ninjaFull border border-ninja-flame/25 bg-ninja-flame/[0.07] py-2 pl-2 pr-4 text-sm font-medium text-foreground shadow-sm transition hover:border-ninja-flame/40 hover:bg-ninja-flame/10"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ninja-gradient text-white">
          <Flame size={13} />
        </span>
        <span>Puesta en marcha</span>
        <span className="font-display text-xs font-bold tabular-nums text-ninja-flameSoft">
          {done}/{total}
        </span>
        <ArrowRight
          size={14}
          className="text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-ninja-flameSoft"
        />
      </button>
    );
  }

  return (
    <>
      <div className="relative mt-6 animate-slide-up overflow-hidden rounded-ninjaLg border border-border bg-card/70 shadow-ninjaSoft backdrop-blur-xl">
        {/* Glow decorativo flame */}
        <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-ninja-flame/10 blur-3xl" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-ninja-flame/40 to-transparent" />

        <div className="relative p-5 sm:p-6">
          {/* Cerrar para siempre */}
          <button
            onClick={() => setConfirmOpen(true)}
            aria-label="Ocultar la guía para siempre"
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
          >
            <X size={16} />
          </button>

          {/* Header: medallón + título + anillo de progreso */}
          <div className="flex items-start gap-4 pr-8">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ninjaMd bg-ninja-gradient text-white shadow-ninjaGlow">
              <Flame size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-lg font-bold leading-tight sm:text-xl">
                Puesta en marcha
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{done}</span> de{" "}
                <span className="font-medium text-foreground">{total}</span> completados
                {" · "}
                cuando termines, esto desaparece.
              </p>
            </div>
            <div className="hidden sm:block">
              <ProgressRing pct={pct} />
            </div>
          </div>

          {/* Barra de progreso (visible siempre; el anillo se oculta en mobile) */}
          <div className="mt-4 flex items-center gap-3 sm:hidden">
            <div className="h-2 flex-1 overflow-hidden rounded-ninjaFull bg-muted">
              <div
                className="h-full rounded-ninjaFull bg-ninja-gradient transition-[width] duration-700 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-display text-xs font-bold tabular-nums text-ninja-flameSoft">
              {pct}%
            </span>
          </div>

          {/* Pasos */}
          <ul className="mt-5 space-y-1.5">
            {STEPS.map((step, i) => {
              const ok = status[step.key];
              const Icon = step.icon;
              return (
                <li
                  key={step.key}
                  className={cn(
                    "group flex items-center gap-3.5 rounded-ninjaMd border px-3 py-3 transition-colors sm:gap-4",
                    ok
                      ? "border-transparent bg-transparent"
                      : "border-border/70 bg-background/40 hover:border-ninja-flame/30 hover:bg-ninja-flame/[0.04]",
                  )}
                >
                  {/* Indicador de estado */}
                  {ok ? (
                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
                      <span className="absolute inset-0 rounded-full bg-ninja-flame/10" />
                      <span className="absolute inset-[3px] rounded-full ring-1 ring-inset ring-ninja-flame/30" />
                      <Check
                        size={17}
                        strokeWidth={3}
                        className="relative animate-scale-in text-ninja-flameSoft"
                      />
                    </span>
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 font-display text-sm font-bold tabular-nums text-muted-foreground transition group-hover:border-ninja-flame/40 group-hover:text-ninja-flameSoft">
                      {i + 1}
                    </span>
                  )}

                  {/* Ícono + textos */}
                  <span
                    className={cn(
                      "hidden h-9 w-9 shrink-0 items-center justify-center rounded-ninjaSm sm:flex",
                      ok
                        ? "text-muted-foreground/50"
                        : "bg-ninja-flame/[0.08] text-ninja-flameSoft",
                    )}
                  >
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-sm font-semibold transition-colors",
                        ok
                          ? "text-muted-foreground line-through decoration-ninja-flame/30"
                          : "text-foreground",
                      )}
                    >
                      {step.label}
                    </div>
                    {!ok && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {step.desc}
                      </p>
                    )}
                  </div>

                  {/* CTA solo si está pendiente */}
                  {ok ? (
                    <span className="shrink-0 text-xs font-medium text-ninja-flameSoft/70">
                      Listo
                    </span>
                  ) : (
                    <Link href={step.href} className="shrink-0">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1.5 border-ninja-flame/30 text-ninja-flameSoft hover:bg-ninja-flame/10"
                      >
                        {step.cta}
                        <ArrowRight size={14} />
                      </Button>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Saltar por ahora */}
          <div className="mt-4 flex justify-end border-t border-border/60 pt-3">
            <button
              onClick={() => setCollapsedPersist(true)}
              className="text-sm font-medium text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
            >
              Saltar por ahora
            </button>
          </div>
        </div>
      </div>

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
