"use client";

import { useMemo } from "react";
import { CreditCard } from "lucide-react";
import { Heading } from "@/components/ui/Typography";
import { DIRECT_BRANDS, groupProvidersByBrand, connectionKeyOf, type ProviderRow } from "@/lib/payments/catalog";
import type { PlanForUpgrade } from "@/modules/saas/gating";
import { BrandCard, ManualCard, SoonList, brandBucket, type BrandBucket, type ChannelHandlers } from "./BrandCard";
import { ChannelLegend, Eyebrow } from "./ui";
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
  const groups = useMemo(() => groupProvidersByBrand(providers), [providers]);
  const manual = groups.filter((g) => DIRECT_BRANDS.has(g.brand.key));
  const brands = groups.filter((g) => !manual.includes(g));
  const buckets = useMemo(() => {
    const out: Record<BrandBucket, typeof brands> = { active: [], available: [], locked: [], soon: [] };
    brands.forEach((g) => out[brandBucket(g, byKey, features, plans)].push(g));
    return out;
  }, [brands, byKey, features, plans]);

  const enabled = methods.filter((m) => m.enabled).length;
  const connected = brands.filter((g) => {
    const k = connectionKeyOf(g.brand.key);
    return k && byKey.get(k)?.config?.connected;
  }).length;

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <div>
          <Heading as="h2" className="flex items-center gap-2 text-base">
            <CreditCard size={18} /> Medios de pago
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">
            Conectá tus cuentas y elegí con qué canales cobrás en el POS.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
            <strong className="text-foreground">{enabled}</strong> {enabled === 1 ? "canal activo" : "canales activos"}
          </span>
          <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
            <strong className="text-foreground">{connected}</strong>{" "}
            {connected === 1 ? "cuenta conectada" : "cuentas conectadas"}
          </span>
        </div>
        <ChannelLegend />
      </div>

      {manual.length > 0 && (
        <div className="space-y-2.5">
          <Eyebrow>Cobros directos</Eyebrow>
          <ManualCard groups={manual} byKey={byKey} handlers={handlers} />
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
              <SoonList groups={list} />
            ) : (
              <div className="space-y-3">
                {list.map((g) => (
                  <BrandCard
                    key={g.brand.key}
                    group={g}
                    byKey={byKey}
                    features={features}
                    plans={plans}
                    handlers={handlers}
                    planSummary={planSummary}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
