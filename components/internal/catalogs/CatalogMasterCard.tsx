"use client";

// Catálogo maestro (ADR-109), panel interno: productos únicos vs ofertas por
// tienda y de otros vendedores, y cuánto se ahorra por deduplicar por EAN.
// El detalle por tienda vive en "Tiendas de origen"; el comparador por EAN en
// CatalogPriceCompare.
import { AlertTriangle, Layers } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Callout } from "@/components/ui/Callout";
import { useCatalogDedupeStats } from "@/modules/internal/catalogsHooks";
import { fmtNum, SectionHeader, StatTile } from "./catalogUi";
import { CatalogPriceCompare } from "./CatalogPriceCompare";

export function CatalogMasterCard() {
  const { data: stats, isLoading, error } = useCatalogDedupeStats();
  const globalPct = stats && stats.items ? Math.round((stats.itemsGlobales / stats.items) * 100) : 0;

  return (
    <section data-shot="maestro" className="space-y-4">
      <SectionHeader
        icon={Layers}
        title="Catálogo maestro"
        description="Un producto por EAN con la mejor ficha de todas las tiendas, y una oferta por tienda y vendedor."
      />

      {error ? (
        <Callout tone="danger" icon={AlertTriangle}>
          No se pudieron leer las estadísticas del catálogo.
        </Callout>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            loading={isLoading}
            label="Productos únicos"
            value={stats ? fmtNum(stats.items) : ""}
            hint={stats ? `${fmtNum(stats.itemsConVariasTiendas)} en 2 o más tiendas` : undefined}
          />
          <StatTile
            loading={isLoading}
            label="Ofertas de tiendas"
            value={stats ? fmtNum(stats.ofertasTienda) : ""}
            hint="una por tienda y producto"
          />
          <StatTile
            loading={isLoading}
            label="Otros vendedores"
            value={stats ? fmtNum(stats.ofertasVendedores) : ""}
            hint="sólo para comparar precios"
          />
          <StatTile
            loading={isLoading}
            label="Ahorro por EAN"
            value={stats ? `${stats.ahorroPct.toLocaleString("es-AR")} %` : ""}
            hint={stats ? `${fmtNum(stats.ahorro)} fichas menos` : undefined}
          />
        </div>
      )}

      {stats && stats.items > 0 && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <p className="text-sm font-medium text-foreground">Cómo se arma</p>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full bg-ninja-flame" style={{ width: `${globalPct}%` }} />
            </div>
            <div className="flex flex-wrap justify-between gap-3 text-sm">
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full bg-ninja-flame" aria-hidden />
                <span>
                  <span className="font-semibold tabular-nums text-foreground">{fmtNum(stats.itemsGlobales)}</span> con EAN
                  válido: se fusionan entre tiendas
                </span>
              </span>
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" aria-hidden />
                <span>
                  <span className="font-semibold tabular-nums text-foreground">{fmtNum(stats.itemsPorTienda)}</span> con código
                  propio de una tienda (pesables, marca propia o inválidos): no se fusionan
                </span>
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <CatalogPriceCompare />
    </section>
  );
}
