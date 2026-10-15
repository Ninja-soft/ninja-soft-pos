"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Zap } from "lucide-react";
import { useAccountStatus } from "@/modules/saas/accountStatus";
import { useMyRestriction } from "@/modules/billing/mora";
import { formatDay } from "@/lib/billing/ledger";
import {
  ACCOUNT_MODE_CHECKOUT_MESSAGE,
  fetchOwnerBillingSummary,
  startOwnerSubscriptionCheckout,
} from "@/modules/saas/subscriptionBilling";
import { useToast } from "@/components/ui/Toast";
import { appOrigin } from "@/lib/site";

// =============================================================================
// Aviso NO bloqueante para cuentas en `past_due` (el pago falló pero todavía hay
// días de gracia antes de la suspensión). Se monta arriba del contenido del
// AppShell. El botón "Regularizar" reusa el checkout self-serve (owner-only);
// para roles no-dueño, falla suave y sugiere avisar al dueño.
// =============================================================================

export function PastDueBanner() {
  const { data } = useAccountStatus();
  // F20-9 (ADR-128): la suspensión la decide la escalera de mora configurable;
  // si hay fecha prevista, el aviso la muestra.
  const { data: restriction } = useMyRestriction(Boolean(data?.isPastDue));
  const { toast } = useToast();

  const regularize = useMutation({
    mutationFn: async () => {
      // Confirma que el invocador es owner (resumen owner-gated) antes de checkout.
      const summary = await fetchOwnerBillingSummary().catch(() => null);
      if (summary == null) throw new Error("not_owner");
      const backUrl = `${appOrigin()}/dashboard-team?sub=ok`;
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
            : e.message === "billing_mode_not_mp"
              ? ACCOUNT_MODE_CHECKOUT_MESSAGE
              : "No se pudo iniciar el pago",
        variant: e.message === "not_owner" || e.message === "billing_mode_not_mp" ? "info" : "error",
      }),
  });

  if (!data?.isPastDue) return null;

  const suspendOn = restriction?.suspend_on ?? null;
  const daysText = suspendOn
    ? `Regularizá antes del ${formatDay(suspendOn)} para no perder el acceso.`
    : "Regularizá tu pago para no perder el acceso.";

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-transparent bg-amber-500/15 px-4 py-2.5 text-sm text-foreground">
      <AlertTriangle size={16} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 font-medium">
        Tenés un pago pendiente. {daysText}
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
