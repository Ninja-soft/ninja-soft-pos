"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Zap } from "lucide-react";
import { useAccountStatus } from "@/modules/saas/accountStatus";
import { fetchOwnerBillingSummary, startOwnerSubscriptionCheckout } from "@/modules/saas/subscriptionBilling";
import { useToast } from "@/components/ui/Toast";

// =============================================================================
// Aviso NO bloqueante para cuentas en `past_due` (el pago falló pero todavía hay
// días de gracia antes de la suspensión). Se monta arriba del contenido del
// AppShell. El botón "Regularizar" reusa el checkout self-serve (owner-only);
// para roles no-dueño, falla suave y sugiere avisar al dueño.
// =============================================================================

export function PastDueBanner() {
  const { data } = useAccountStatus();
  const { toast } = useToast();

  const regularize = useMutation({
    mutationFn: async () => {
      // Confirma que el invocador es owner (resumen owner-gated) antes de checkout.
      const summary = await fetchOwnerBillingSummary().catch(() => null);
      if (summary == null) throw new Error("not_owner");
      const backUrl = `${window.location.origin}/dashboard-team?sub=ok`;
      return startOwnerSubscriptionCheckout(backUrl);
    },
    onSuccess: (initPoint) => {
      window.location.href = initPoint;
    },
    onError: (e: Error) =>
      toast({
        title:
          e.message === "not_owner"
            ? "Pedile al dueño que regularice el pago"
            : "No se pudo iniciar el pago",
        variant: e.message === "not_owner" ? "info" : "error",
      }),
  });

  if (!data?.isPastDue) return null;

  const days = data.pastDueDaysLeft;
  const daysText =
    days == null
      ? "Regularizá tu pago para no perder el acceso."
      : days <= 0
        ? "Regularizá hoy para no perder el acceso."
        : `Tenés ${days === 1 ? "1 día" : `${days} días`} para regularizar antes de que se bloquee.`;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm text-foreground">
      <AlertTriangle size={16} className="shrink-0 text-amber-400" />
      <span className="min-w-0 flex-1 font-medium">
        Tu pago falló. {daysText}
      </span>
      <button
        type="button"
        onClick={() => regularize.mutate()}
        disabled={regularize.isPending}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-amber-950 transition hover:bg-amber-400 disabled:opacity-60"
      >
        <Zap size={13} /> Regularizar
      </button>
    </div>
  );
}
