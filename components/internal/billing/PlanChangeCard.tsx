"use client";

// =============================================================================
// Ficha del negocio › Cuenta corriente › Plan y ciclo (F20-10 · H136 · ADR-131):
// botón al simulador de cambio de plan y el cambio programado (si hay), con
// "Cancelar" con motivo. Cambiar el plan es de admin o super admin.
// =============================================================================

import { useState } from "react";
import { CalendarClock, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { PlanChangeDialog } from "@/components/internal/billing/PlanChangeDialog";
import { formatDay } from "@/lib/billing/ledger";
import {
  CHANGE_KIND_LABELS,
  planChangeErrorMessage,
  useCancelPlanChange,
  useScheduledPlanChange,
} from "@/modules/billing/planChange";

export function PlanChangeCard({ tenantId, canChange }: { tenantId: string; canChange: boolean }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const { data: scheduled } = useScheduledPlanChange(tenantId);
  const cancel = useCancelPlanChange(tenantId);

  return (
    <section aria-labelledby="plan-change-title">
      <SectionHeader
        title={<span id="plan-change-title">Plan y ciclo</span>}
        icon={Repeat}
        description="Simulá un upgrade, un downgrade o el pase entre mensual y anual antes de confirmarlo. El prorrateo queda en la cuenta corriente."
        actions={
          canChange ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Simular cambio
            </Button>
          ) : undefined
        }
      />
      {scheduled ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <CalendarClock size={18} className="shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                Cambio programado para el {formatDay(scheduled.effective_on)}
              </p>
              <p className="text-xs text-muted-foreground">
                <Badge tone="info" className="mr-1.5 rounded-md">
                  {CHANGE_KIND_LABELS[scheduled.kind] ?? scheduled.kind}
                </Badge>
                {scheduled.to_plan ? `Plan ${scheduled.to_plan}` : ""}
                {scheduled.to_cycle ? ` · ${scheduled.to_cycle === "yearly" ? "anual" : "mensual"}` : ""}
              </p>
            </div>
          </div>
          {canChange && (
            <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
              Cancelar
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No hay cambios programados.</p>
      )}

      {canChange && <PlanChangeDialog tenantId={tenantId} open={open} onOpenChange={setOpen} />}

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancelar el cambio programado"
        description="El plan y el ciclo siguen como están. Queda en la auditoría."
        confirmLabel="Cancelar el cambio"
        danger
        loading={cancel.isPending}
        onConfirm={async (reason) => {
          if (!scheduled) return;
          try {
            await cancel.mutateAsync({ changeId: scheduled.id, reason });
            toast({ title: "Cambio cancelado", variant: "success" });
            setCancelOpen(false);
          } catch (e) {
            toast({ title: "No se pudo cancelar", description: planChangeErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}
