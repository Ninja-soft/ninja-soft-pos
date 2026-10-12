"use client";

import { useMemo } from "react";
import { CreditCard } from "lucide-react";
import { Heading } from "@/components/ui/Typography";
import { DIRECT_BRANDS, groupProvidersByBrand, connectionKeyOf, type ProviderRow } from "@/lib/payments/catalog";
import type { PlanForUpgrade } from "@/modules/saas/gating";
import { BrandCard, ManualCard, type ChannelHandlers } from "./BrandCard";
import { Eyebrow } from "./ui";
import type { Method } from "./types";

// Vista presentacional (sin Supabase): la usan PaymentMethodsCard y los tests
// visuales con datos simulados.
export function PaymentMethodsView({
  providers,
  methods,
  features,
  plans,
  handlers,
}: {
  providers: ProviderRow[];
  methods: Method[];
  features: Record<string, boolean> | undefined;
  plans: PlanForUpgrade[];
  handlers: ChannelHandlers;
}) {
  const byKey = useMemo(() => {
    const m = new Map<string, Method>();
    methods.forEach((x) => m.set(x.provider_key, x));
    return m;
  }, [methods]);
  const groups = useMemo(() => groupProvidersByBrand(providers), [providers]);
  const manual = groups.filter((g) => DIRECT_BRANDS.has(g.brand.key));
  const brands = groups.filter((g) => !manual.includes(g));

  const enabled = methods.filter((m) => m.enabled).length;
  const connected = brands.filter((g) => {
    const k = connectionKeyOf(g.brand.key);
    return k && byKey.get(k)?.config?.connected;
  }).length;

  return (
    <section className="space-y-6">
      <div>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <CreditCard size={18} /> Medios de pago
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Conectá tus cuentas y elegí con qué canales cobrás en el POS.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
            <strong className="text-foreground">{enabled}</strong> {enabled === 1 ? "canal activo" : "canales activos"}
          </span>
          <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
            <strong className="text-foreground">{connected}</strong>{" "}
            {connected === 1 ? "cuenta conectada" : "cuentas conectadas"}
          </span>
        </div>
      </div>

      {manual.length > 0 && (
        <div className="space-y-2.5">
          <Eyebrow>Cobros directos</Eyebrow>
          <ManualCard groups={manual} byKey={byKey} handlers={handlers} />
        </div>
      )}

      <div className="space-y-2.5">
        <Eyebrow>Cuentas de cobro</Eyebrow>
        <div className="space-y-3">
          {brands.map((g) => (
            <BrandCard
              key={g.brand.key}
              group={g}
              byKey={byKey}
              features={features}
              plans={plans}
              handlers={handlers}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
