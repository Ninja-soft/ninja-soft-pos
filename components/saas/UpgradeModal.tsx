"use client";

import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { Flame, Lock, Check, Zap } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { featureInfo } from "@/lib/saas/featureInfo";
import { startOwnerSubscriptionCheckout } from "@/modules/saas/subscriptionBilling";
import {
  firstPlanWithFeature,
  useGlobalPlansForUpgrade,
  type PlanForUpgrade,
} from "@/modules/saas/gating";

// Ruta del panel del dueño (gestión de plan / facturación). Fallback cuando el
// upgrade self-serve no aplica (p. ej. el usuario no es dueño).
const OWNER_PANEL_ROUTE = "/dashboard-team";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // key de la feature gateada (busca el primer plan que la incluye).
  featureKey: string;
  // etiqueta humana de la feature ("Variantes", "Listas de precios"…).
  featureLabel: string;
}

function fmtMoney(n: number): string {
  return `$${Number(n ?? 0).toLocaleString("es-AR")}`;
}

// rpc tipado laxo: request_plan_change no está en los tipos generados.
function rpc(supabase: ReturnType<typeof createClient>) {
  return supabase.rpc as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

export function UpgradeModal({
  open,
  onOpenChange,
  featureKey,
  featureLabel,
}: UpgradeModalProps) {
  const { toast } = useToast();
  const { data: plans } = useGlobalPlansForUpgrade();
  const target: PlanForUpgrade | null = plans
    ? firstPlanWithFeature(plans, featureKey)
    : null;
  const planName = target?.name ?? "un plan superior";
  const info = featureInfo(featureKey);

  // Upgrade self-serve: fija el plan elegido (request_plan_change, owner-only) y
  // dispara el checkout del preapproval de Mercado Pago (mismo flujo que el panel
  // del dueño). Pago fácil = redirect a MP. Si el usuario no es dueño, el RPC
  // devuelve "forbidden" y lo mandamos al panel del dueño.
  const upgrade = useMutation({
    mutationFn: async (plan: PlanForUpgrade) => {
      const supabase = createClient();
      const { error } = await rpc(supabase)("request_plan_change", {
        p_plan_key: plan.key,
      });
      if (error) throw new Error(error.message ?? "error");
      const backUrl = `${window.location.origin}/dashboard-team?sub=ok`;
      return startOwnerSubscriptionCheckout(backUrl);
    },
    onSuccess: (initPoint) => {
      // Redirige a Mercado Pago para autorizar el pago de la suscripción.
      window.location.href = initPoint;
    },
    onError: (e: Error) => {
      if (e.message?.includes("forbidden")) {
        toast({
          title: "Pedile al dueño que mejore el plan",
          description:
            "Solo el dueño de la cuenta puede cambiar el plan y pagar.",
          variant: "info",
        });
        return;
      }
      toast({
        title: "No se pudo iniciar la mejora",
        description: "Probá desde el panel del dueño.",
        variant: "error",
      });
    },
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[3px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-popover/80 p-7 text-popover-foreground shadow-ninjaSoft backdrop-blur-2xl outline-none data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out">
          {/* Ícono Lock + flame */}
          <div className="mx-auto relative mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-ninja-flame/12 ring-1 ring-ninja-flame/25">
            <Lock size={26} className="text-ninja-flameSoft" />
            <Flame
              size={16}
              className="absolute -right-1.5 -top-1.5 text-ninja-flame drop-shadow"
              fill="currentColor"
            />
          </div>

          <Dialog.Title className="text-center text-lg font-bold tracking-tight">
            {featureLabel} no está en tu plan
          </Dialog.Title>
          {/* Qué hace la función (featureInfo). Cae a un texto genérico si la
              feature no tiene copy. */}
          <Dialog.Description className="mx-auto mt-2 max-w-xs text-center text-sm text-muted-foreground">
            {info?.desc ??
              `Esta función está disponible en ${planName}. Mejorá tu plan para activarla.`}
          </Dialog.Description>

          {/* Tarjeta del plan destino: logo + nombre + nombre ninja + precio. */}
          {target ? (
            <div className="mt-5 rounded-xl border border-ninja-flameSoft/30 bg-ninja-flame/5 p-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {target.image_url ? (
                    // Imagen del plan = banner rectangular (~2.5:1, con alpha).
                    // object-contain en una caja apaisada para que se vea entera,
                    // sin recortar ni deformar.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={target.image_url}
                      alt={target.name}
                      className="h-12 w-[5.25rem] shrink-0 rounded-lg border border-border bg-background/40 object-contain p-0.5"
                    />
                  ) : (
                    <span className="grid h-12 w-[5.25rem] shrink-0 place-items-center rounded-lg bg-ninja-gradient text-ninja-voidViolet">
                      <Flame size={20} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-wide text-ninja-flameSoft">
                      Disponible desde
                    </div>
                    <div className="truncate font-bold leading-tight">
                      Plan {target.name}
                      {target.secondary_name ? (
                        <span className="ml-1 font-normal text-muted-foreground">
                          · {target.secondary_name}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="ml-auto shrink-0 text-right">
                  <div className="font-price text-lg font-black tabular-nums">
                    {fmtMoney(target.monthly_price_ars)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">/ mes</div>
                </div>
              </div>
              {/* Qué desbloquea (impact) — refuerzo del valor. */}
              {info?.impact && (
                <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                  <span>Al mejorar, se activa {featureLabel.toLowerCase()} y todo lo del plan {target.name}.</span>
                </p>
              )}
            </div>
          ) : null}

          <div className="mt-6 flex w-full flex-col gap-2.5">
            {target ? (
              <>
                <Button
                  className="w-full"
                  loading={upgrade.isPending}
                  onClick={() => upgrade.mutate(target)}
                >
                  <Zap size={15} /> Mejorar a {target.name} y pagar
                </Button>
                <Link
                  href={OWNER_PANEL_ROUTE}
                  onClick={() => onOpenChange(false)}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "w-full",
                  )}
                >
                  Ver todos los planes
                </Link>
              </>
            ) : (
              <Link
                href={OWNER_PANEL_ROUTE}
                onClick={() => onOpenChange(false)}
                className={cn(buttonVariants({ variant: "primary" }), "w-full")}
              >
                <Flame size={15} /> Ver planes
              </Link>
            )}
            <Dialog.Close asChild>
              <Button variant="ghost" className="w-full">
                Ahora no
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
