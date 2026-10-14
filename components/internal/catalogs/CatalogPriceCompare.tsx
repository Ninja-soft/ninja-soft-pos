"use client";

// Comparador de precios por EAN del panel interno (ADR-109): todas las
// tiendas y vendedores (catalog_price_compare con internal_scope).
import { useState } from "react";
import { AlertTriangle, ScanBarcode, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { MarketOffersList, MarketSummaryView } from "@/components/catalog/MarketReferencePanel";
import { useInternalPriceCompare } from "@/modules/internal/catalogsHooks";

export function CatalogPriceCompare() {
  const [ean, setEan] = useState("");
  const compare = useInternalPriceCompare(ean);
  const ready = ean.trim().length >= 6;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="flex items-center gap-2 font-semibold text-foreground">
              <Search size={16} className="text-muted-foreground" aria-hidden /> Comparar precios por EAN
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">Todas las tiendas y vendedores que tienen ese código.</p>
          </div>
          <div className="w-full sm:w-64">
            <Input
              variant="filled"
              aria-label="Código de barras"
              inputMode="numeric"
              placeholder="Código de barras, ej. 7790070012050"
              value={ean}
              onChange={(e) => setEan(e.target.value)}
            />
          </div>
        </div>

        {!ready ? (
          <EmptyState compact icon={ScanBarcode} title="Escribí un código de barras" description="Al menos 6 dígitos." />
        ) : compare.isLoading ? (
          <SkeletonLines lines={4} />
        ) : compare.error ? (
          <Callout tone="danger" icon={AlertTriangle}>
            No se pudo comparar ese código.
          </Callout>
        ) : !compare.data?.length ? (
          <EmptyState compact icon={ScanBarcode} title="Ninguna tienda tiene ese código" />
        ) : (
          <div className="space-y-3">
            <MarketSummaryView offers={compare.data} />
            <MarketOffersList offers={compare.data} max={12} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
