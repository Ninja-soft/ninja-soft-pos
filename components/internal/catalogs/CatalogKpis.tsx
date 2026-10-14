"use client";

// KPIs de la pestaña Catálogos: productos únicos, ofertas, tiendas, última
// sincronización y próxima automática.
import { CalendarClock, History, Layers, Store, Tag } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import {
  useCatalogDedupeStats,
  useCatalogStores,
  useCatalogSyncConfig,
  useCatalogSyncRuns,
} from "@/modules/internal/catalogsHooks";
import { nextRunIsFull, nextScheduledRun } from "@/modules/internal/catalogSyncSchedule";
import { fmtAgo, fmtDateTime, fmtNum, runStatus, StatTile } from "./catalogUi";

export function CatalogKpis() {
  const stats = useCatalogDedupeStats();
  const stores = useCatalogStores();
  const runs = useCatalogSyncRuns();
  const config = useCatalogSyncConfig();

  const s = stats.data;
  const last = runs.data?.[0] ?? null;
  const lastDone = runs.data?.find((r) => r.status !== "running") ?? null;
  const shown = last?.status === "running" ? last : lastDone;
  const st = shown ? runStatus(shown) : null;
  const next = config.data ? nextScheduledRun(config.data) : null;
  const enVenta = s?.tiendas.filter((t) => t.enCatalogo).length ?? 0;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <StatTile
        icon={Layers}
        label="Productos únicos"
        loading={stats.isLoading}
        value={s ? fmtNum(s.items) : "0"}
        hint={s ? `${fmtNum(s.itemsConVariasTiendas)} en 2 o más tiendas` : undefined}
      />
      <StatTile
        icon={Tag}
        label="Ofertas"
        loading={stats.isLoading}
        value={s ? fmtNum(s.ofertas) : "0"}
        hint={s ? `${fmtNum(s.ofertasVendedores)} de otros vendedores` : undefined}
      />
      <StatTile
        icon={Store}
        label="Tiendas"
        loading={stores.isLoading}
        value={fmtNum(stores.data?.length ?? 0)}
        hint={s ? `${enVenta} en venta` : undefined}
      />
      <StatTile
        icon={History}
        label={last?.status === "running" ? "Sincronización" : "Última sincronización"}
        loading={runs.isLoading}
        value={
          shown ? (
            <span className="text-lg">{last?.status === "running" ? (last.pausedAt ? "En pausa" : "En curso") : fmtAgo(shown.finishedAt ?? shown.startedAt)}</span>
          ) : (
            <span className="text-lg">Nunca</span>
          )
        }
        hint={
          shown && st ? (
            last?.status === "running" ? (
              `Empezó el ${fmtDateTime(shown.startedAt)}`
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Badge tone={st.tone}>{st.label}</Badge>
                <span>{fmtDateTime(shown.finishedAt ?? shown.startedAt)}</span>
              </span>
            )
          ) : undefined
        }
      />
      <StatTile
        icon={CalendarClock}
        label="Próxima automática"
        loading={config.isLoading}
        className="col-span-2 md:col-span-1"
        value={<span className="text-lg">{next ? fmtDateTime(next) : config.data?.enabled === false ? "Apagada" : "Sin fecha"}</span>}
        hint={next && config.data ? (nextRunIsFull(config.data) ? "Lectura completa" : "Sólo cambios") : undefined}
      />
    </div>
  );
}
