"use client";

import { useState } from "react";
import { Ban, Play, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { useTenantLifecycle } from "@/modules/internal/hooks";
import {
  LIFECYCLE_COPY,
  lifecycleActions,
  lifecycleErrorMessage,
  lifecycleState,
  type LifecycleAction,
  type StaffLevel,
} from "@/lib/internal/tenantLifecycle";

const STATE_TEXT = {
  operating: { label: "Operando", dot: "bg-success" },
  suspended: { label: "Suspendido", dot: "bg-warning" },
  cancelled: { label: "Cancelado", dot: "bg-muted-foreground" },
  deleted: { label: "Dado de baja", dot: "bg-destructive" },
} as const;

// Suspender / reactivar / baja lógica con motivo obligatorio (ADR-073).
// El efecto es server-side: assert_account_active bloquea venta, caja y
// devoluciones del negocio suspendido, cancelado o dado de baja.
export function TenantLifecycleCard({
  tenant,
  level,
}: {
  tenant: { id: string; slug: string; status: string; deletedAt: string | null };
  level: StaffLevel;
}) {
  const { toast } = useToast();
  const mut = useTenantLifecycle(tenant.id);
  const [pending, setPending] = useState<LifecycleAction | null>(null);
  const state = lifecycleState(tenant);
  const actions = lifecycleActions(state, level);
  const st = STATE_TEXT[state];

  return (
    <Card className="border-t-2 border-t-border">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-muted-foreground">Ciclo de vida</div>
            <div className="mt-1 inline-flex items-center gap-2 text-base font-semibold text-foreground">
              <span aria-hidden className={`h-2 w-2 rounded-full ${st.dot}`} />
              {st.label}
              {tenant.deletedAt && (
                <span className="text-xs font-normal text-muted-foreground">
                  desde {new Date(tenant.deletedAt).toLocaleDateString("es-AR")}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {actions.includes("suspend") && (
              <Button variant="secondary" size="sm" onClick={() => setPending("suspend")}>
                <Ban size={15} /> Suspender
              </Button>
            )}
            {actions.includes("reactivate") && (
              <Button size="sm" onClick={() => setPending("reactivate")}>
                <Play size={15} /> Reactivar
              </Button>
            )}
            {actions.includes("delete") && (
              <Button variant="destructive" size="sm" onClick={() => setPending("delete")}>
                <Trash2 size={15} /> Dar de baja
              </Button>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {state === "operating"
            ? "Suspender corta la venta, la caja y las devoluciones al instante. Cada acción pide motivo y queda en la auditoría."
            : "El negocio no puede vender ni abrir caja hasta que se reactive."}
          {actions.length === 0 && " Tu nivel de staff es de sólo lectura."}
        </p>
      </CardContent>

      {pending && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={LIFECYCLE_COPY[pending].title}
          description={LIFECYCLE_COPY[pending].description}
          confirmLabel={LIFECYCLE_COPY[pending].confirm}
          danger={pending !== "reactivate"}
          typeToConfirm={pending === "delete" ? tenant.slug : undefined}
          loading={mut.isPending}
          onConfirm={(reason) =>
            mut.mutate(
              { action: pending, reason },
              {
                onSuccess: () => {
                  toast({ title: LIFECYCLE_COPY[pending].success, variant: "success" });
                  setPending(null);
                },
                onError: (e) =>
                  toast({
                    title: "No se pudo completar",
                    description: lifecycleErrorMessage(e instanceof Error ? e.message : (e as { message?: string })?.message),
                    variant: "error",
                  }),
              },
            )
          }
        />
      )}
    </Card>
  );
}
