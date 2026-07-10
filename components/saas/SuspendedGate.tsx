"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Lock, LogOut, ShieldAlert, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  fetchOwnerBillingSummary,
  startOwnerSubscriptionCheckout,
} from "@/modules/saas/subscriptionBilling";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";

// =============================================================================
// Pantalla de bloqueo por cuenta SUSPENDIDA. Cubre toda la app del POS con un
// overlay del que solo se sale pagando (reactivación) o cerrando sesión. El POS
// no se monta detrás (lo decide el AppShell), así que esto es una pantalla
// completa, no un overlay translúcido con la app usable debajo.
//
// El botón "Pagar y reactivar" reusa el checkout self-serve existente
// (startOwnerSubscriptionCheckout → preapproval de Mercado Pago) y redirige a MP.
// Es owner-only por contrato del backend; para roles no-dueño mostramos un aviso
// para que contacten al dueño (y siempre dejamos cerrar sesión).
// =============================================================================

function fmtMoney(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toLocaleString("es-AR")}`;
}

// `cancelled` distingue la cuenta dada de baja / trial vencido (sin acceso) de
// la suspendida por falta de pago: misma pantalla de bloqueo (solo se sale
// pagando o cerrando sesión), pero el copy cambia para no decir "suspendida por
// falta de pago" a quien nunca tuvo un pago pendiente.
export function SuspendedGate({
  email,
  cancelled = false,
}: {
  email: string;
  cancelled?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  // Costo de reactivación (owner-gated). Para roles no-dueño viene null → no
  // mostramos precio ni botón de pago, solo el aviso de contactar al dueño.
  const { data: billing } = useQuery({
    queryKey: ["owner-billing-summary"],
    queryFn: async () => fetchOwnerBillingSummary(),
    retry: false,
  });
  const total = billing?.billing?.total ?? null;
  const canPay = billing != null; // owner/encargado con resumen de cobro

  const startCheckout = useMutation({
    mutationFn: async () => {
      const backUrl = `${window.location.origin}/dashboard-team?sub=ok`;
      return startOwnerSubscriptionCheckout(backUrl);
    },
    onSuccess: (initPoint) => {
      window.location.href = initPoint;
    },
    onError: () =>
      toast({ title: "No se pudo iniciar el pago", variant: "error" }),
  });

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="app-bg flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-ninjaXl border border-red-500/30 bg-card/80 p-6 shadow-ninjaSoft backdrop-blur-xl sm:p-8">
        <div className="mb-5 flex items-center gap-3">
          <Isotype className="h-9 w-auto" />
          <span className="grid h-10 w-10 place-items-center rounded-full border border-red-500/40 bg-red-500/10 text-red-400">
            <ShieldAlert size={20} />
          </span>
        </div>

        <h1 className="text-2xl font-black tracking-tight text-foreground">
          {cancelled ? "Cuenta sin plan activo" : "Cuenta suspendida"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {cancelled
            ? "Tu cuenta no tiene un plan activo (la prueba terminó o el plan se dio de baja). Activá un plan para volver a usar el sistema."
            : "Tu suscripción está suspendida por falta de pago. Para volver a usar el sistema, reactivá tu plan pagando."}
        </p>

        {total != null && (
          <div className="mt-5 flex items-baseline gap-2 rounded-xl border border-border bg-muted/20 p-4">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Total a pagar
            </span>
            <span className="ml-auto text-2xl font-black text-foreground">
              {fmtMoney(total)}
            </span>
            <span className="text-sm text-muted-foreground">/ mes</span>
          </div>
        )}

        <div className="mt-6 space-y-3">
          {canPay ? (
            <Button
              className="w-full"
              loading={startCheckout.isPending}
              onClick={() => startCheckout.mutate()}
            >
              <Zap size={16} /> {cancelled ? "Activar un plan" : "Pagar y reactivar"}
            </Button>
          ) : (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-xs text-warning">
              <Lock size={15} className="mt-0.5 shrink-0" />
              <span>
                {cancelled
                  ? "La cuenta de tu negocio no tiene un plan activo. Pedile al dueño que ingrese para activar un plan y volver a usar el sistema."
                  : "La cuenta de tu negocio está suspendida. Pedile al dueño que ingrese para reactivar el plan y volver a usar el sistema."}
              </span>
            </div>
          )}

          <Button variant="secondary" className="w-full" onClick={signOut}>
            <LogOut size={16} /> Cerrar sesión
          </Button>
        </div>

        <p className="mt-5 text-center text-[11px] text-muted-foreground">
          Sesión iniciada como <span className="font-medium">{email}</span>
        </p>
      </div>
    </div>
  );
}
