"use client";

import { useMemo, useState } from "react";
import { SearchField } from "@/components/ui/SearchField";
import { brandMatches } from "@/lib/payments/search";
import { DIRECT_BRANDS, groupProvidersByBrand, connectionKeyOf, type ProviderRow } from "@/lib/payments/catalog";
import type { PlanForUpgrade } from "@/modules/saas/gating";
import { BrandCard, ManualCard, SoonList, brandBucket, type BrandBucket, type ChannelHandlers } from "./BrandCard";
import { BrandLogo, ChannelLegend, Eyebrow } from "./ui";
import type { Method } from "./types";
import type { PlanSummary } from "@/modules/pos/planConstants";

// Secciones de cuentas, en orden: conectadas, disponibles, de otro plan y
// próximamente.
const SECTIONS: { bucket: BrandBucket; title: string }[] = [
  { bucket: "active", title: "Tus cuentas" },
  { bucket: "available", title: "Para conectar" },
  { bucket: "locked", title: "En otros planes" },
  { bucket: "soon", title: "Próximamente" },
];

// Vista presentacional (sin Supabase): la usan PaymentMethodsCard y los tests
// visuales con datos simulados.
export function PaymentMethodsView({
  providers,
  methods,
  features,
  plans,
  handlers,
  planSummary,
}: {
  providers: ProviderRow[];
  methods: Method[];
  features: Record<string, boolean> | undefined;
  plans: PlanForUpgrade[];
  handlers: ChannelHandlers;
  /** Planes de cuotas activos por provider_key (botón "Planes de cuotas"). */
  planSummary?: Record<string, PlanSummary>;
}) {
  const byKey = useMemo(() => {
    const m = new Map<string, Method>();
    methods.forEach((x) => m.set(x.provider_key, x));
    return m;
  }, [methods]);
  const allGroups = useMemo(() => groupProvidersByBrand(providers), [providers]);
  // Buscador: por nombre o por lo que cobra (QR, tarjeta, transferencia…).
  const [query, setQuery] = useState("");
  const groups = useMemo(() => allGroups.filter((g) => brandMatches(g, query)), [allGroups, query]);
  const manual = groups.filter((g) => DIRECT_BRANDS.has(g.brand.key));
  const brands = groups.filter((g) => !manual.includes(g));
  const allBrands = allGroups.filter((g) => !DIRECT_BRANDS.has(g.brand.key));
  const goTo = (key: string) => {
    const g = allGroups.find((x) => x.brand.key === key);
    const anchor = DIRECT_BRANDS.has(key)
      ? "medio-directos"
      : g && brandBucket(g, byKey, features, plans) === "soon"
        ? "medio-proximamente"
        : `medio-${key}`;
    const el = typeof document !== "undefined" ? document.getElementById(anchor) : null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const buckets = useMemo(() => {
    const out: Record<BrandBucket, typeof brands> = { active: [], available: [], locked: [], soon: [] };
    brands.forEach((g) => out[brandBucket(g, byKey, features, plans)].push(g));
    return out;
  }, [brands, byKey, features, plans]);

  const enabled = methods.filter((m) => m.enabled).length;
  const connected = allBrands.filter((g) => {
    const k = connectionKeyOf(g.brand.key);
    return k && byKey.get(k)?.config?.connected;
  }).length;

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md bg-muted px-2.5 py-1 text-muted-foreground">
            <strong className="text-foreground">{enabled}</strong> {enabled === 1 ? "canal activo" : "canales activos"}
          </span>
          <span className="rounded-md bg-muted px-2.5 py-1 text-muted-foreground">
            <strong className="text-foreground">{connected}</strong>{" "}
            {connected === 1 ? "cuenta conectada" : "cuentas conectadas"}
          </span>
        </div>
        <ChannelLegend />
      </div>

      <div className="space-y-3">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="Buscar medio de pago: Mercado Pago, QR, tarjeta, transferencia, cuotas…"
          aria-label="Buscar medio de pago"
        />
        <div className="flex flex-wrap gap-2" role="list" aria-label="Medios de pago">
          {groups.map((g) => (
            <button
              key={g.brand.key}
              type="button"
              role="listitem"
              onClick={() => goTo(g.brand.key)}
              className="inline-flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-sm transition hover:bg-secondary"
            >
              <BrandLogo brandKey={g.brand.key} name={g.brand.name} size={22} />
              <span className="font-medium">{g.brand.name}</span>
            </button>
          ))}
        </div>
        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No encontramos &ldquo;{query.trim()}&rdquo;. Probá con el nombre de la marca o con lo que cobra (QR, tarjeta, transferencia).
          </p>
        )}
      </div>

      {manual.length > 0 && (
        <div className="space-y-2.5">
          <Eyebrow>Cobros directos</Eyebrow>
          <div id="medio-directos" className="scroll-mt-24">
            <ManualCard groups={manual} byKey={byKey} handlers={handlers} />
          </div>
        </div>
      )}

      {SECTIONS.map(({ bucket, title }) => {
        const list = buckets[bucket];
        if (list.length === 0) return null;
        return (
          <div key={bucket} className="space-y-2.5">
            <Eyebrow>
              {title} <span className="ml-1 font-medium normal-case tracking-normal">· {list.length}</span>
            </Eyebrow>
            {bucket === "soon" ? (
              <div id="medio-proximamente" className="scroll-mt-24">
                <SoonList groups={list} />
              </div>
            ) : (
              <div className="space-y-3">
                {list.map((g) => (
                  <div key={g.brand.key} id={`medio-${g.brand.key}`} className="scroll-mt-24">
                    <BrandCard
                      group={g}
                      byKey={byKey}
                      features={features}
                      plans={plans}
                      handlers={handlers}
                      planSummary={planSummary}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
