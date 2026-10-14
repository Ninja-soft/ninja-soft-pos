"use client";

// Sincronización del catálogo Tiendita con el feed del scraper (ADR-107,
// ADR-109): corrida actual o última (estado, tipo, origen), progreso global
// con tiempo transcurrido y estimación, resultados y tabla por tienda.
// ADR-113: "Sincronizar ahora" (incremental), "Lectura completa ahora",
// pausar / reanudar / cancelar la corrida abierta (auditado). Polling de
// catalog_sync_runs cada 4 s mientras haya una corrida abierta.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, DatabaseZap, Pause, Play, RefreshCw, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useCatalogSyncControl, useCatalogSyncRuns, useStartCatalogSync } from "@/modules/internal/catalogsHooks";
import { estimateEta, syncProgress, type SyncControlAction, type SyncStatus } from "@/modules/internal/catalogSync";
import { CatalogSyncStoresTable } from "./CatalogSyncStoresTable";
import { fmtDateTime, fmtMs, fmtNum, ProgressBar, RunStatusChip, runKindLabel } from "./catalogUi";

const CONTROL_DONE: Record<SyncControlAction, string> = {
  pause: "Corrida pausada. La tanda en curso termina su página y se detiene.",
  resume: "Corrida reanudada. Sigue en menos de un minuto.",
  cancel: "Corrida cancelada. Lo que ya se sincronizó queda.",
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? "");
}

function Result({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{fmtNum(value)}</div>
    </div>
  );
}

export function CatalogSyncCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: runs, isLoading, error } = useCatalogSyncRuns();
  const start = useStartCatalogSync();
  const control = useCatalogSyncControl();
  const [confirm, setConfirm] = useState<"full" | "cancel" | null>(null);
  const last = runs?.[0] ?? null;
  const open = last?.status === "running";
  const paused = open && !!last?.pausedAt;

  // Reloj para el tiempo transcurrido mientras hay una corrida abierta.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, [open]);

  // Al terminar una corrida se refrescan los conteos de tiendas y catálogos.
  const prevStatus = useRef<SyncStatus | null>(null);
  useEffect(() => {
    const status = last?.status ?? null;
    if (prevStatus.current === "running" && status && status !== "running") {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-stores"] });
      qc.invalidateQueries({ queryKey: ["internal", "catalogs"] });
      qc.invalidateQueries({ queryKey: ["internal", "catalog-dedupe-stats"] });
    }
    prevStatus.current = status;
  }, [last?.status, qc]);

  async function syncNow(full: boolean) {
    try {
      await start.mutateAsync(full);
      setConfirm(null);
      toast({
        title: full ? "Lectura completa en marcha" : "Sincronización en marcha",
        description: "Podés seguir el avance acá.",
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo iniciar la sincronización", description: errorText(e) || undefined, variant: "error" });
    }
  }

  async function runControl(action: SyncControlAction) {
    if (!last) return;
    try {
      await control.mutateAsync({ runId: last.id, action });
      setConfirm(null);
      toast({ title: CONTROL_DONE[action], variant: "success" });
    } catch (e) {
      const msg = errorText(e);
      toast({
        title: "No se pudo completar la acción",
        description: msg.includes("forbidden")
          ? "Sólo un admin o super admin del panel interno puede hacerlo."
          : msg.includes("run_not_open")
            ? "La corrida ya no está abierta."
            : msg || undefined,
        variant: "error",
      });
    }
  }

  const progress = last ? syncProgress(last) : null;
  const eta = last && open ? estimateEta(last, runs ?? [], now) : null;

  const actions = !open ? (
    <>
      <Button onClick={() => syncNow(false)} loading={start.isPending} disabled={start.isPending || isLoading}>
        {!start.isPending && <RefreshCw size={15} />}
        Sincronizar ahora
      </Button>
      <Button variant="secondary" onClick={() => setConfirm("full")} disabled={start.isPending || isLoading}>
        <DatabaseZap size={15} /> Lectura completa ahora
      </Button>
    </>
  ) : (
    <>
      {paused ? (
        <Button onClick={() => runControl("resume")} loading={control.isPending} disabled={control.isPending}>
          {!control.isPending && <Play size={15} />}
          Reanudar
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => runControl("pause")} loading={control.isPending} disabled={control.isPending}>
          {!control.isPending && <Pause size={15} />}
          Pausar corrida
        </Button>
      )}
      <Button variant="ghost" onClick={() => setConfirm("cancel")} disabled={control.isPending}>
        <XCircle size={15} /> Cancelar corrida
      </Button>
    </>
  );

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">{open ? "Corrida en curso" : "Última corrida"}</p>
            {isLoading ? (
              <div aria-busy className="space-y-2">
                <Skeleton className="h-6 w-56" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : last ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <RunStatusChip run={last} />
                  <Badge tone="neutral">{runKindLabel(last)}</Badge>
                  <Badge tone="neutral">{last.trigger === "cron" ? "Automática" : "Manual"}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {open ? "Empezó el " : "Terminó el "}
                  <span className="font-medium text-foreground">
                    {fmtDateTime(open ? last.startedAt : last.finishedAt ?? last.startedAt)}
                  </span>
                  {paused && last.pausedAt && <> · en pausa desde el {fmtDateTime(last.pausedAt)}</>}
                </p>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </div>

        {error && (
          <Callout tone="danger" icon={AlertTriangle}>
            No se pudo leer el estado de la sincronización.
          </Callout>
        )}

        {!isLoading && !last && !error && (
          <EmptyState
            compact
            icon={RefreshCw}
            title="Todavía no hubo ninguna sincronización"
            description="La primera corrida lee el catálogo maestro completo. Después corre sola según la agenda."
          />
        )}

        {open && progress && last && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">
                {paused
                  ? "En pausa"
                  : progress.phase === "feed"
                    ? `Leyendo el catálogo maestro: ${fmtNum(last.feed?.recibidos ?? 0)} productos en ${fmtNum(progress.done)} páginas`
                    : `Cerrando tiendas: ${progress.done} de ${progress.total}`}
              </span>
              <span className="tabular-nums text-muted-foreground">{progress.pct} %</span>
            </div>
            <ProgressBar pct={progress.pct} label="Avance de la corrida" />
            {eta && (
              <p className="text-xs text-muted-foreground">
                Lleva {fmtMs(eta.elapsedMs)}
                {eta.etaMs !== null
                  ? eta.etaMs > 0
                    ? ` · faltan unos ${fmtMs(eta.etaMs)} (según la última corrida ${eta.basis === "full" ? "completa" : "de sólo cambios"})`
                    : " · por terminar"
                  : paused
                    ? ""
                    : " · sin estimación todavía"}
              </p>
            )}
          </div>
        )}

        {last && (last.nuevos > 0 || last.actualizados > 0 || last.ofertasNuevas > 0 || last.ofertasActualizadas > 0) && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Result label="Productos nuevos" value={last.nuevos} />
            <Result label="Productos actualizados" value={last.actualizados} />
            <Result label="Ofertas nuevas" value={last.ofertasNuevas} />
            <Result label="Ofertas con cambios" value={last.ofertasActualizadas} />
          </div>
        )}

        {last && last.stores.length > 0 && <CatalogSyncStoresTable run={last} />}

        {last?.lastError && last.status !== "ok" && (
          <Callout tone={last.status === "running" || last.status === "cancelled" ? "warning" : "danger"} icon={AlertTriangle}>
            {last.lastError}
          </Callout>
        )}

        <p className="text-xs text-muted-foreground">
          Lee el catálogo maestro del scraper de NinjaSoft: un producto por EAN con la mejor ficha de todas las tiendas (los que no tienen EAN entran por tienda con su código),
          más las ofertas de cada tienda y vendedor. Las tiendas nuevas se agregan solas y las ofertas que ya no están
          quedan como no disponibles (nunca se borran).
        </p>

        <ConfirmDialog
          open={confirm === "full"}
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Lectura completa ahora"
          description="Lee todo el catálogo maestro desde cero (con 1M de publicaciones son varias horas en tandas). Al terminar, las ofertas que ya no están en el feed quedan como no disponibles. Queda registrado en la auditoría."
          confirmLabel="Empezar lectura completa"
          loading={start.isPending}
          onConfirm={() => syncNow(true)}
        />
        <ConfirmDialog
          open={confirm === "cancel"}
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Cancelar la corrida"
          description="La corrida se corta y queda como cancelada en el historial. Lo que ya se sincronizó se queda y no se marcan faltantes. La próxima incremental pide desde la última corrida buena."
          confirmLabel="Cancelar corrida"
          cancelLabel="Volver"
          danger
          loading={control.isPending}
          onConfirm={() => runControl("cancel")}
        />
      </CardContent>
    </Card>
  );
}
