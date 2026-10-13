"use client";

import { useState } from "react";
import { Lock, Undo2 } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { useBranchScope } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useSaveMpRefundSetting } from "@/modules/sales/mpRefund";
import { mpRefundErrorMessage } from "@/lib/payments/mpRefund";

// "Permitir devolver el dinero por Mercado Pago" (H21h · ADR-067). Lo prende
// sólo el dueño (mp_refund_settings_save); apagado por defecto. Con la feature
// `reintegro_mp` fuera del plan se muestra el candado.
export function MpRefundSetting({ enabled }: { enabled: boolean }) {
  const { toast } = useToast();
  const scope = useBranchScope();
  const isOwner = scope.data?.role === "owner";
  const feature = useFeature("reintegro_mp");
  const save = useSaveMpRefundSetting();
  const [upgrade, setUpgrade] = useState(false);
  const locked = feature === false;

  return (
    <div className="flex items-start justify-between gap-3 border-t border-border pt-4">
      <div className="flex min-w-0 gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          {locked ? <Lock size={15} /> : <Undo2 size={15} />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Permitir devolver el dinero por Mercado Pago</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            En una devolución, el reintegro vuelve a la tarjeta o a la cuenta de Mercado Pago del cliente (total o
            parcial). Lo hace un supervisor o un cajero con PIN de supervisor. La plata sale del saldo de tu cuenta de
            Mercado Pago.
          </p>
          {locked && (
            <button
              type="button"
              onClick={() => setUpgrade(true)}
              className="mt-1 text-xs font-medium text-ninja-flameSoft underline-offset-2 hover:underline"
            >
              Disponible desde el plan Pro
            </button>
          )}
          {!locked && !isOwner && (
            <p className="mt-1 text-xs text-muted-foreground">Sólo el dueño puede cambiarlo.</p>
          )}
        </div>
      </div>
      <Switch
        checked={enabled && !locked}
        disabled={locked || !isOwner || save.isPending}
        onCheckedChange={(c) =>
          save.mutate(c, {
            onSuccess: () =>
              toast({
                title: c ? "Reintegro por Mercado Pago habilitado" : "Reintegro por Mercado Pago deshabilitado",
                variant: "success",
              }),
            onError: (e) => toast({ title: mpRefundErrorMessage(e instanceof Error ? e.message : String(e)), variant: "error" }),
          })
        }
        label="Permitir devolver el dinero por Mercado Pago"
      />
      {upgrade && (
        <UpgradeModal
          open
          onOpenChange={(o) => !o && setUpgrade(false)}
          featureKey="reintegro_mp"
          featureLabel="Reintegro por Mercado Pago"
        />
      )}
    </div>
  );
}
