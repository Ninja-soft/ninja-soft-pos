"use client";

// Catálogo maestro (ADR-109), panel interno: productos únicos vs ofertas por
// tienda, cuánto se ahorra por deduplicar por EAN, y un comparador de precios
// por EAN con todas las tiendas y vendedores.
import { useState } from "react";
import { AlertTriangle, Layers, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { StoreLogo } from "@/components/catalog/StoreLogo";
import { MarketOffersList, MarketSummaryView } from "@/components/catalog/MarketReferencePanel";
import { useCatalogDedupeStats, useInternalPriceCompare } from "@/modules/internal/catalogsHooks";

const fmtNum = (n: number) => n.toLocaleString("es-AR");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function CatalogMasterCard() {
  const { data: stats, isLoading, error } = useCatalogDedupeStats();
  const [ean, setEan] = useState("");
  const compare = useInternalPriceCompare(ean);

  return (
    <Card className="mt-3">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-center gap-2 font-semibold">
          <Layers size={16} className="text-ninja-flameSoft" /> Catálogo maestro
        </div>

        {isLoading ? (
          <SpinnerBlock className="py-4" />
        ) : error ? (
          <Callout tone="danger" icon={AlertTriangle}>
            No se pudieron leer las estadísticas del catálogo.
          </Callout>
        ) : stats ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Productos únicos"
                value={fmtNum(stats.items)}
                hint={`${fmtNum(stats.itemsConVariasTiendas)} en 2+ tiendas`}
              />
              <Stat
                label="Ofertas de tiendas"
                value={fmtNum(stats.ofertasTienda)}
                hint="una por tienda y producto"
              />
              <Stat label="Otros vendedores" value={fmtNum(stats.ofertasVendedores)} hint="sólo comparación" />
              <Stat
                label="Ahorro por EAN"
                value={`${stats.ahorroPct.toLocaleString("es-AR")} %`}
                hint={`${fmtNum(stats.ahorro)} fichas menos`}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {fmtNum(stats.itemsGlobales)} productos con EAN válido (se fusionan entre tiendas) y{" "}
              {fmtNum(stats.itemsPorTienda)} con código propio de una tienda (pesables, marca propia o
              códigos inválidos: no se fusionan).
            </p>
            {stats.tiendas.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">Tienda</th>
                      <th className="py-1.5 pr-3 text-right font-medium">De la tienda</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Otros vendedores</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Disponibles</th>
                      <th className="py-1.5 font-medium">Catálogo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.tiendas.map((t) => (
                      <tr key={t.key} className="border-t border-border">
                        <td className="py-1.5 pr-3 font-medium text-foreground">
                          <span className="flex items-center gap-2">
                            <StoreLogo storeKey={t.key} name={t.name} size={20} />
                            {t.name}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(t.ofertasTienda)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(t.ofertasVendedores)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(t.disponibles)}</td>
                        <td className="py-1.5 text-xs">
                          {t.enCatalogo ? (
                            <Badge tone="success">En venta</Badge>
                          ) : (
                            <Badge tone="neutral">Sólo comparación</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Search size={15} /> Comparar precios por EAN
          </div>
          <Input
            variant="filled"
            label="Código de barras"
            inputMode="numeric"
            placeholder="7790070012050"
            value={ean}
            onChange={(e) => setEan(e.target.value)}
            className="max-w-xs"
          />
          {ean.trim().length >= 6 &&
            (compare.isLoading ? (
              <SpinnerBlock className="py-3" />
            ) : compare.error ? (
              <Callout tone="danger" icon={AlertTriangle}>
                No se pudo comparar ese código.
              </Callout>
            ) : !compare.data?.length ? (
              <p className="text-xs text-muted-foreground">Ninguna tienda tiene ese código.</p>
            ) : (
              <>
                <MarketSummaryView offers={compare.data} />
                <MarketOffersList offers={compare.data} max={12} />
              </>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
