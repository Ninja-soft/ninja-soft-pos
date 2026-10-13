"use client";

// Sincronización del catálogo Tiendita con el feed del scraper (ADR-107):
// estado de la última corrida, próxima automática y "Sincronizar ahora" con
// progreso (polling de catalog_sync_runs mientras haya una corrida abierta).
import { useEffect, useRef } from "react";
import { AlertTriangle, CalendarClock, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useCatalogSyncRuns, useStartCatalogSync } from "@/modules/internal/catalogsHooks";
import { nextWeeklySync, syncProgress, type SyncRun, type SyncStatus } from "@/modules/internal/catalogSync";

const STATUS: Record<SyncStatus, { label: string; tone: BadgeTone }> = {
  running: { label: "Sincronizando", tone: "info" },
  ok: { label: "Completa", tone: "success" },
  partial: { label: "Con errores en algunas tiendas", tone: "warning" },
  error: { label: "Falló", tone: "danger" },
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-AR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Argentina/Buenos_Aires",
      })
    : "";

const fmtNum = (n: number) => n.toLocaleString("es-AR");

function modeLabel(run: SyncRun) {
  if (run.mode === "full") return "Completa";
  if (run.mode === "incremental") return "Sólo cambios";
  if (run.mode === "mixed") return "Mixta";
  return "";
}

export function CatalogSyncCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: runs, isLoading, error } = useCatalogSyncRuns();
  const start = useStartCatalogSync();
  const last = runs?.[0] ?? null;
  const running = last?.status === "running";

  // Al terminar una corrida se refrescan los conteos de tiendas y catálogos.
  const prevStatus = useRef<SyncStatus | null>(null);
  useEffect(() => {
    const status = last?.status ?? null;
    if (prevStatus.current === "running" && status && status !== "running") {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-stores"] });
      qc.invalidateQueries({ queryKey: ["internal", "catalogs"] });
    }
    prevStatus.current = status;
  }, [last?.status, qc]);

  async function syncNow() {
    try {
      await start.mutateAsync(false);
      toast({ title: "Sincronización en marcha", description: "Podés seguir el avance acá.", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo iniciar la sincronización",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  const next = nextWeeklySync();
  const progress = last ? syncProgress(last) : null;
  const current = last?.stores.find((s) => s.key === last.currentStore && !s.done);

  return (
    <Card className="mt-3">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1 text-sm">
            {isLoading ? (
              <SpinnerBlock className="py-2" />
            ) : last ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[last.status].tone}>{STATUS[last.status].label}</Badge>
                  {modeLabel(last) && <Badge tone="neutral">{modeLabel(last)}</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {last.trigger === "cron" ? "Automática" : "Manual"}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {running ? "Empezó " : "Última: "}
                  <span className="font-medium text-foreground">
                    {fmtDate(running ? last.startedAt : last.finishedAt ?? last.startedAt)}
                  </span>
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Todavía no hubo ninguna sincronización.</p>
            )}
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock size={13} /> Próxima automática: {fmtDate(next.toISOString())}
            </p>
          </div>
          <Button onClick={syncNow} loading={start.isPending} disabled={running || start.isPending}>
            {!start.isPending && <RefreshCw size={15} className={running ? "animate-spin" : undefined} />}
            {running ? "Sincronizando…" : "Sincronizar ahora"}
          </Button>
        </div>

        {error && (
          <Callout tone="danger" icon={AlertTriangle}>
            No se pudo leer el estado de la sincronización.
          </Callout>
        )}

        {running && progress && (
          <div className="space-y-1.5">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.pct}
            >
              <div className="h-full rounded-full bg-ninja-flame transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress.total
                ? `${progress.done} de ${progress.total} tiendas`
                : "Leyendo las tiendas del catálogo…"}
              {current && ` · ${current.label}: ${fmtNum(current.nuevos + current.actualizados)} productos procesados`}
            </p>
          </div>
        )}

        {last && last.stores.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Tienda</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Nuevos</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Actualizados</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Faltantes</th>
                  <th className="py-1.5 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {last.stores.map((s) => (
                  <tr key={s.key} className="border-t border-border">
                    <td className="py-1.5 pr-3 font-medium text-foreground">{s.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(s.nuevos)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(s.actualizados)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(s.faltantes)}</td>
                    <td className="py-1.5 text-xs">
                      {s.error ? (
                        <span className="text-danger" title={s.error}>
                          {s.done ? "Error" : "Reintentando"}
                        </span>
                      ) : s.done ? (
                        <span className="text-success">{s.full ? "Completa" : "Al día"}</span>
                      ) : (
                        <span className="text-muted-foreground">Pendiente</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold text-foreground">
                  <td className="py-1.5 pr-3">Total</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(last.nuevos)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(last.actualizados)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(last.faltantes)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {last?.lastError && last.status !== "ok" && (
          <Callout tone={last.status === "running" ? "warning" : "danger"} icon={AlertTriangle}>
            {last.lastError}
          </Callout>
        )}

        <p className="text-xs text-muted-foreground">
          Lee el catálogo del scraper de NinjaSoft: las tiendas nuevas se agregan solas, los productos se
          actualizan por tienda y EAN, y los que ya no están quedan como no disponibles (nunca se borran).
          Sale sola los sábados a las 6, después de la corrida del viernes.
        </p>
      </CardContent>
    </Card>
  );
}
