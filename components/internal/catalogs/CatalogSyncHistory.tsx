"use client";

// Historial de corridas de la sync del catálogo (ADR-113): inicio, origen
// (automática o manual), tipo, estado, duración y resultados.
import { History } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { useCatalogSyncRuns } from "@/modules/internal/catalogsHooks";
import { formatDuration } from "@/modules/internal/catalogSyncSchedule";
import { fmtDateTime, fmtNum, RunStatusChip, runKindLabel } from "./catalogUi";

export function CatalogSyncHistory() {
  const { data: runs, isLoading } = useCatalogSyncRuns();

  return (
    <Card className="min-w-0">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <History size={16} className="text-muted-foreground" aria-hidden />
          <p className="font-semibold text-foreground">Historial de corridas</p>
        </div>
        {isLoading ? (
          <SkeletonLines lines={5} />
        ) : !runs?.length ? (
          <EmptyState compact icon={History} title="Sin corridas todavía" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">Inicio</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Estado</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Duración</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Productos</th>
                    <th scope="col" className="py-2 text-right font-medium">Ofertas</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-2.5 pr-3">
                        <div className="whitespace-nowrap tabular-nums text-foreground">{fmtDateTime(r.startedAt)}</div>
                        <div className="whitespace-nowrap text-xs text-muted-foreground">
                          {r.trigger === "cron" ? "Automática" : "Manual"} · {runKindLabel(r)}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3" title={r.lastError ?? undefined}>
                        <RunStatusChip run={r} />
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums text-foreground">
                        {formatDuration(r.startedAt, r.status === "running" ? null : r.finishedAt ?? r.startedAt)}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums text-foreground" title="Nuevos / actualizados">
                        {fmtNum(r.nuevos)} / {fmtNum(r.actualizados)}
                      </td>
                      <td className="whitespace-nowrap py-2.5 text-right tabular-nums text-foreground" title="Nuevas / con cambios / faltantes">
                        {fmtNum(r.ofertasNuevas)} / {fmtNum(r.ofertasActualizadas)} / {fmtNum(r.faltantes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Productos: nuevos / actualizados. Ofertas: nuevas / con cambios / faltantes.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
