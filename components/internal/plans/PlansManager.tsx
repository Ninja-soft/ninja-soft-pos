"use client";

import { useState } from "react";
import { Pencil, Plus, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Heading, Money } from "@/components/ui/Typography";
import { usePlansWithCounts } from "@/modules/internal/hooks";
import type { PlanWithCount } from "@/modules/internal/api";
import { formatCurrency } from "@/lib/utils/format";
import { PlanEditorModal } from "./PlanEditorModal";
import { PlanBadge } from "./PlanBadge";

function StatusChip({ active }: { active: boolean }) {
  return (
    <span
      className={
        active
          ? "inline-flex items-center whitespace-nowrap rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-semibold text-success"
          : "inline-flex items-center whitespace-nowrap rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground"
      }
    >
      {active ? "Activo" : "Inactivo"}
    </span>
  );
}

export function PlansManager() {
  const { data: plans, isLoading } = usePlansWithCounts();
  // null editing + creating flag: open editor for create when `creating`.
  const [editing, setEditing] = useState<PlanWithCount | null>(null);
  const [creating, setCreating] = useState(false);

  const open = creating || editing !== null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading as="h2">Planes</Heading>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={15} /> Nuevo plan
        </Button>
      </div>

      <Card className="mt-3">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Precio mensual</th>
                  <th className="px-4 py-3">Trial</th>
                  <th className="px-4 py-3">Suscriptos</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-foreground">
                {isLoading && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      Cargando planes…
                    </td>
                  </tr>
                )}
                {!isLoading && (plans?.length ?? 0) === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-muted-foreground"
                    >
                      No hay planes cargados. Creá el primero.
                    </td>
                  </tr>
                )}
                {(plans ?? []).map((p) => (
                  <tr key={p.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <PlanBadge
                          plan={{
                            name: p.name,
                            secondaryName: p.secondaryName,
                            imageUrl: p.imageUrl,
                            icon: p.icon,
                          }}
                          size="sm"
                        />
                        {p.isRecommended && (
                          <span
                            title="Plan recomendado"
                            className="inline-flex items-center gap-1 rounded-full border border-ninja-gold/40 bg-ninja-gold/10 px-2 py-0.5 text-[11px] font-semibold text-ninja-gold"
                          >
                            <Star size={11} className="fill-ninja-gold" />
                            Recomendado
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Money>{formatCurrency(p.monthlyPrice)}</Money>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {p.trialDays > 0 ? `${p.trialDays} días` : "Sin trial"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {p.subscriberCount}
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip active={p.isActive} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditing(p)}
                      >
                        <Pencil size={14} /> Editar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <PlanEditorModal
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        plan={editing}
      />
    </>
  );
}
