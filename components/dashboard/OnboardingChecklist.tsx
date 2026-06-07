"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CreditCard,
  Landmark,
  Package,
  Receipt,
  ShoppingCart,
  Sparkles,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button, buttonVariants } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils/cn";

type StatusKey = "fiscal" | "mp" | "producto" | "ticket" | "venta";

type OnboardingStatus = Record<StatusKey, boolean>;

const STEPS: {
  key: StatusKey;
  label: string;
  icon: React.ElementType;
  cta: string;
  href: Route;
}[] = [
  {
    key: "fiscal",
    label: "Cargá tus datos fiscales",
    icon: Landmark,
    cta: "Completar",
    href: "/configuracion?seccion=marca" as Route,
  },
  {
    key: "mp",
    label: "Conectá Mercado Pago",
    icon: CreditCard,
    cta: "Conectar",
    href: "/configuracion?seccion=pagos" as Route,
  },
  {
    key: "producto",
    label: "Cargá tu primer producto",
    icon: Package,
    cta: "Cargar",
    href: "/productos",
  },
  {
    key: "ticket",
    label: "Elegí tu diseño de ticket",
    icon: Receipt,
    cta: "Elegir",
    href: "/configuracion?seccion=tickets" as Route,
  },
  {
    key: "venta",
    label: "Hacé tu primera venta",
    icon: ShoppingCart,
    cta: "Vender",
    href: "/pos",
  },
];

const COLLAPSE_KEY = "onboarding-checklist-collapsed";

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
      return Boolean(data?.onboarding_dismissed);
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

  // Toast único cuando el checklist pasa a completo dentro de la sesión.
  const wasComplete = useRef<boolean | null>(null);
  const done = status ? STEPS.filter((s) => status[s.key]).length : 0;
  const total = STEPS.length;
  const allDone = done === total;

  useEffect(() => {
    if (!status) return;
    if (wasComplete.current === null) {
      wasComplete.current = allDone;
      return;
    }
    if (!wasComplete.current && allDone) {
      toast({ title: "¡Listo! 🎉", description: "Tu negocio quedó configurado.", variant: "success" });
    }
    wasComplete.current = allDone;
  }, [allDone, status, toast]);

  const dismiss = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("pos_settings")
        .upsert(
          { tenant_id: tenantId, onboarding_dismissed: true },
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

  // No mostrar nada hasta tener datos, si está descartado o si está todo listo.
  if (!status || dismissed || allDone) return null;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsedPersist(false)}
        className="mt-6 inline-flex items-center gap-2 rounded-full border border-ninja-flame/30 bg-ninja-flame/10 px-4 py-2 text-sm font-medium text-ninja-flameSoft transition hover:bg-ninja-flame/15"
      >
        <Sparkles size={15} />
        Guía de configuración · {done}/{total}
      </button>
    );
  }

  const pct = Math.round((done / total) * 100);

  return (
    <>
      <Card className="relative mt-6 overflow-hidden border-ninja-flame/20 bg-ninja-flame/[0.04] backdrop-blur-xl">
        <CardContent className="p-5 sm:p-6">
          <button
            onClick={() => setConfirmOpen(true)}
            aria-label="Ocultar la guía para siempre"
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>

          <div className="flex items-center gap-2.5 pr-8">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ninja-flame/15 text-ninja-flameSoft">
              <Sparkles size={18} />
            </span>
            <div>
              <h2 className="font-display text-lg font-bold leading-tight">
                Configurá tu negocio en 5 pasos
              </h2>
              <p className="text-sm text-muted-foreground">
                {done} de {total} listos · Apenas termines, esto desaparece.
              </p>
            </div>
          </div>

          {/* Barra de progreso con gradiente flame */}
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-ninja-gradient transition-[width] duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>

          <ul className="mt-4 divide-y divide-border/60">
            {STEPS.map((step) => {
              const ok = status[step.key];
              const Icon = ok ? CheckCircle2 : step.icon;
              return (
                <li
                  key={step.key}
                  className="flex items-center gap-3 py-2.5"
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      ok
                        ? "text-ninja-flameSoft"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon
                      size={ok ? 22 : 18}
                      className={ok ? "animate-scale-in" : undefined}
                    />
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm",
                      ok && "text-muted-foreground line-through",
                    )}
                  >
                    {step.label}
                  </span>
                  {!ok && (
                    <Link
                      href={step.href}
                      className={buttonVariants({ size: "sm" })}
                    >
                      {step.cta}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex justify-end">
            <button
              onClick={() => setCollapsedPersist(true)}
              className="text-sm text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
            >
              Saltar por ahora
            </button>
          </div>
        </CardContent>
      </Card>

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
