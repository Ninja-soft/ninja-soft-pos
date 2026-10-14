"use client";

// Referencia de mercado de un producto (ADR-109): a cuánto lo venden las
// tiendas y vendedores de los catálogos del negocio (desde / mediana / hasta,
// cuántos vendedores), la lista ordenada por precio y cómo queda el precio del
// negocio. Sólo lectura. Respeta el switch del dueño (Configuración >
// Operación > Productos > "Mostrar precios de referencia del mercado en
// productos"): apagado no se muestra ni se llama a la RPC.
import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ExternalLink, EyeOff, TrendingUp } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { NoData } from "@/components/ui/NoData";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { StoreLogo } from "@/components/catalog/StoreLogo";
import { useCatalogHintsActive, useCatalogPriceCompare } from "@/modules/catalog/hooks";
import {
  marketPosition,
  marketSummary,
  type MarketOffer,
  type MarketPosition,
} from "@/modules/catalog/priceReference";

export const HIDE_MARKET_REFERENCE_HREF =
  "/configuracion?seccion=operacion&grupo=productos#referencia-mercado";

const POSITION: Record<MarketPosition, { label: string; tone: BadgeTone }> = {
  below: { label: "Por debajo del mercado", tone: "success" },
  in_range: { label: "En rango con el mercado", tone: "info" },
  above: { label: "Por encima del mercado", tone: "danger" },
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Argentina/Buenos_Aires",
      })
    : "";

export function MarketOffersList({ offers, max = 8 }: { offers: MarketOffer[]; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? offers : offers.slice(0, max);
  return (
    <div className="space-y-1.5">
      <ul className="divide-y divide-border rounded-lg bg-muted">
        {shown.map((o) => (
          <li key={`${o.storeKey}|${o.seller}|${o.principal}`} className="flex items-center gap-3 px-3 py-2 text-sm">
            <StoreLogo storeKey={o.storeKey} name={o.storeName} logoUrl={o.storeLogo} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">{o.storeName}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {o.principal ? "Vende la tienda" : o.seller}
                {o.lastSeenAt ? ` · visto ${fmtDate(o.lastSeenAt)}` : ""}
              </span>
            </span>
            {!o.available && <Badge tone="neutral">Sin stock</Badge>}
            <span className="text-right tabular-nums">
              <span className={cn("block font-semibold", o.available ? "text-foreground" : "text-muted-foreground")}>
                {o.price != null ? formatCurrency(o.price) : <NoData />}
              </span>
              {o.listPrice != null && o.price != null && o.listPrice > o.price && (
                <span className="block text-[11px] text-muted-foreground line-through">
                  {formatCurrency(o.listPrice)}
                </span>
              )}
            </span>
            {o.url && (
              <a
                href={o.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label={`Ver en ${o.storeName}`}
                className="shrink-0 rounded p-1 text-muted-foreground transition hover:text-foreground"
              >
                <ExternalLink size={14} />
              </a>
            )}
          </li>
        ))}
      </ul>
      {offers.length > max && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {all ? "Ver menos" : `Ver las ${offers.length} ofertas`}
        </button>
      )}
    </div>
  );
}

export function MarketSummaryView({ offers, myPrice }: { offers: MarketOffer[]; myPrice?: number | null }) {
  const summary = marketSummary(offers);
  if (!summary) return null;
  const pos = myPrice != null ? marketPosition(myPrice, summary) : null;
  const stat = (label: string, value: string) => (
    <div className="min-w-0 rounded-lg bg-muted px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat("Desde", formatCurrency(summary.min))}
        {stat("Mediana", formatCurrency(summary.median))}
        {stat("Hasta", formatCurrency(summary.max))}
        {stat("Vendedores", String(summary.sellers))}
      </div>
      <p className="text-xs text-muted-foreground">
        Más barato en{" "}
        <span className="font-medium text-foreground">
          {summary.cheapest.storeName}
          {!summary.cheapest.principal ? ` / ${summary.cheapest.seller}` : ""}
        </span>
        {summary.stores > 1 ? ` · ${summary.stores} tiendas` : ""}
      </p>
      {pos ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={POSITION[pos].tone}>{POSITION[pos].label}</Badge>
          <span>
            Tu precio {formatCurrency(myPrice as number)}
            {pos === "below" && ` · ${formatCurrency(summary.min - (myPrice as number))} menos que el más barato`}
            {pos === "above" && ` · ${formatCurrency((myPrice as number) - summary.max)} más que el más caro`}
          </span>
        </div>
      ) : myPrice != null ? (
        <p className="text-xs text-muted-foreground">Cargá tu precio para ver cómo quedás contra el mercado.</p>
      ) : null}
    </div>
  );
}

export function MarketReferencePanel({
  ean,
  myPrice,
  className,
}: {
  ean: string | null | undefined;
  myPrice?: number | null;
  className?: string;
}) {
  const { active, ready } = useCatalogHintsActive();
  const clean = (ean ?? "").trim();
  const { data: offers, isLoading, isError } = useCatalogPriceCompare(clean, ready && active);
  if (!ready || !active || clean.length < 6) return null;

  return (
    <section className={cn("space-y-3", className)} aria-label="Referencia de mercado">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <TrendingUp size={15} className="text-ninja-flameSoft" /> Referencia de mercado
        </h4>
        <Link
          href={HIDE_MARKET_REFERENCE_HREF as Route}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <EyeOff size={13} /> Ocultar
        </Link>
      </div>
      {isLoading ? (
        <div className="grid h-16 place-items-center">
          <Spinner size={18} />
        </div>
      ) : isError ? (
        <p className="text-xs text-muted-foreground">No se pudo leer la referencia de mercado.</p>
      ) : !offers || offers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Ninguna tienda de tus catálogos vende este código de barras.
        </p>
      ) : (
        <>
          <MarketSummaryView offers={offers} myPrice={myPrice} />
          <MarketOffersList offers={offers} />
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        Precios de las tiendas de tus catálogos en su última lectura. Orientativo, no vinculante.
      </p>
    </section>
  );
}
