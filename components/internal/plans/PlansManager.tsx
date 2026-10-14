"use client";

import { useState } from "react";
import { Pencil, Plus, Star, Tag } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Typography";
import { usePlansWithCounts } from "@/modules/internal/hooks";
import type { PlanWithCount } from "@/modules/internal/api";
import { formatCurrency } from "@/lib/utils/format";
import { PlanEditorModal } from "./PlanEditorModal";
import { PlanBadge } from "./PlanBadge";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { TableStateRow, TableWrap } from "@/components/ui/Table";

export function PlansManager() {
  const { data: plans, isLoading } = usePlansWithCounts();
  // null editing + creating flag: open editor for create when `creating`.
  const [editing, setEditing] = useState<PlanWithCount | null>(null);
  const [creating, setCreating] = useState(false);

  const open = creating || editing !== null;

  return (
    <>
      <SectionHeader
        title="Planes globales"
        icon={Tag}
        description="Lo que ve el cliente al elegir plan. El precio es mensual y en pesos."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} /> Nuevo plan
          </Button>
        }
      />

      <TableWrap className="mt-3">
        <table className="w-full min-w-[600px] text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3 text-right">Precio mensual</th>
              <th className="hidden px-4 py-3 md:table-cell">Prueba</th>
              <th className="px-4 py-3 text-right">Suscriptos</th>
              <th className="hidden px-4 py-3 sm:table-cell">Estado</th>
              <th className="px-4 py-3 text-right">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && <TableStateRow colSpan={6} loading />}
            {!isLoading && (plans?.length ?? 0) === 0 && (
              <TableStateRow colSpan={6}>
                <EmptyState
                  compact
                  icon={Tag}
                  title="No hay planes cargados"
                  description="Creá el primero para que los negocios puedan suscribirse."
                  action={
                    <Button size="sm" onClick={() => setCreating(true)}>
                      <Plus size={15} /> Nuevo plan
                    </Button>
                  }
                />
              </TableStateRow>
            )}
            {(plans ?? []).map((p) => (
              <tr key={p.id} className="transition hover:bg-muted/40">
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2.5">
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
                      <Badge tone="gold" title="Plan recomendado">
                        <Star size={11} className="fill-current" aria-hidden />
                        Recomendado
                      </Badge>
                    )}
                    {!p.isActive && (
                      <Badge tone="neutral" className="sm:hidden">
                        Inactivo
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                  <Money>{formatCurrency(p.monthlyPrice)}</Money>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground md:table-cell">
                  {p.trialDays > 0 ? `${p.trialDays} días` : "Sin prueba"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {p.subscriberCount}
                </td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <Badge tone={p.isActive ? "success" : "neutral"}>
                    {p.isActive ? "Activo" : "Inactivo"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditing(p)}
                    aria-label={`Editar ${p.name}`}
                  >
                    <Pencil size={14} /> <span className="hidden sm:inline">Editar</span>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

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
