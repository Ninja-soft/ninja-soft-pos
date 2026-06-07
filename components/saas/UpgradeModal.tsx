"use client";

import Link from "next/link";
import { Flame, Lock } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button, buttonVariants } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  firstPlanWithFeature,
  useGlobalPlansForUpgrade,
} from "@/modules/saas/gating";

// Ruta del cliente para gestionar/mejorar el plan (sección plan en el panel del
// cliente). Si no existiera, el botón cae a un toast (ver más abajo).
const UPGRADE_ROUTE = "/dashboard-team";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // key de la feature gateada (busca el primer plan que la incluye).
  featureKey: string;
  // etiqueta humana de la feature ("Variantes", "Listas de precios"…).
  featureLabel: string;
}

export function UpgradeModal({
  open,
  onOpenChange,
  featureKey,
  featureLabel,
}: UpgradeModalProps) {
  const { toast } = useToast();
  const { data: plans } = useGlobalPlansForUpgrade();
  const target = plans ? firstPlanWithFeature(plans, featureKey) : null;
  const planName = target?.name ?? "un plan superior";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[3px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col items-center overflow-hidden rounded-2xl border border-white/10 bg-popover/80 p-7 text-center text-popover-foreground shadow-ninjaSoft backdrop-blur-2xl outline-none data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out">
          {/* Ícono Lock + flame */}
          <div className="relative mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-ninja-flame/12 ring-1 ring-ninja-flame/25">
            <Lock size={26} className="text-ninja-flameSoft" />
            <Flame
              size={16}
              className="absolute -right-1.5 -top-1.5 text-ninja-flame drop-shadow"
              fill="currentColor"
            />
          </div>

          <Dialog.Title className="text-lg font-bold tracking-tight">
            Función no incluida en tu plan
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            Para usar {featureLabel} necesitás el plan {planName}.
          </Dialog.Description>

          <div className="mt-6 flex w-full flex-col gap-2.5">
            {target ? (
              <Link
                href={UPGRADE_ROUTE}
                onClick={() => onOpenChange(false)}
                className={cn(buttonVariants({ variant: "primary" }), "w-full")}
              >
                <Flame size={15} /> Hacer upgrade
              </Link>
            ) : (
              <Button
                className="w-full"
                onClick={() => {
                  toast({
                    title: "Contactanos para mejorar tu plan",
                    variant: "info",
                  });
                  onOpenChange(false);
                }}
              >
                <Flame size={15} /> Hacer upgrade
              </Button>
            )}
            <Dialog.Close asChild>
              <Button variant="ghost" className="w-full">
                Cerrar
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
