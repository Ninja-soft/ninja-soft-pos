"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Display, Heading } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  useInternalTenants,
  useTenantFlags,
  useInternalMutations,
} from "@/modules/internal/hooks";
import { VERTICALS, VERTICAL_LABELS } from "@/lib/verticals/config";

const PLANS = [
  { key: "start", name: "Start" },
  { key: "pro", name: "Pro" },
  { key: "business", name: "Business" },
  { key: "enterprise", name: "Enterprise" },
];
const STATUSES = [
  { key: "trial", name: "Trial" },
  { key: "active", name: "Activo" },
  { key: "past_due", name: "Pago pendiente" },
  { key: "suspended", name: "Suspendido" },
  { key: "cancelled", name: "Cancelado" },
];
const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

export default function InternalTenantDetail({
  params,
}: {
  params: { id: string };
}) {
  const { toast } = useToast();
  const { data: tenants } = useInternalTenants();
  const tenant = tenants?.find((t) => t.id === params.id);
  const { data: flags } = useTenantFlags(params.id);
  const { setPlan, setStatus, setFlag, setIndustry } = useInternalMutations(
    params.id,
  );
  const supabase = createClient();
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  // Genera el link de suscripción (preapproval) de Mercado Pago para el tenant.
  const checkout = useMutation({
    mutationFn: async () => {
      const backUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}/internal/tenants/${params.id}`
          : undefined;
      const { data, error } = await supabase.functions.invoke(
        "mp_subscription_checkout",
        { body: { tenant_id: params.id, back_url: backUrl } },
      );
      if (error) throw error;
      const res = data as { init_point?: string; error?: string };
      if (res?.error || !res?.init_point) throw new Error(res?.error ?? "sin_link");
      return res.init_point;
    },
    onSuccess: (u) => {
      setCheckoutUrl(u);
      toast({ title: "Link de cobro generado", variant: "success" });
    },
    onError: (e: Error) =>
      toast({ title: "No se pudo generar", description: e.message, variant: "error" }),
  });

  function wrap(p: Promise<unknown>, ok: string) {
    p.then(() => toast({ title: ok, variant: "success" })).catch((e) =>
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
    );
  }

  return (
    <>
      <Link
        href="/internal/tenants"
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft size={15} /> Volver a negocios
      </Link>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Display className="text-3xl md:text-4xl">
          {tenant?.name ?? "…"}
        </Display>
        {(() => {
          const st = tenant?.subStatus ?? tenant?.status;
          return st ? (
            <span className="rounded-md bg-ninja-flame/12 px-2.5 py-1 text-xs font-semibold text-ninja-flameSoft">
              {STATUSES.find((s) => s.key === st)?.name ?? st}
            </span>
          ) : null;
        })()}
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{tenant?.slug}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan
            </label>
            <select
              className={selectCls}
              value={tenant?.planKey ?? "start"}
              onChange={(e) =>
                wrap(setPlan.mutateAsync(e.target.value), "Plan actualizado")
              }
            >
              {PLANS.map((p) => (
                <option key={p.key} value={p.key} className="bg-ninja-deepViolet">
                  {p.name}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Estado de suscripción
            </label>
            <select
              className={selectCls}
              value={tenant?.subStatus ?? tenant?.status ?? "trial"}
              onChange={(e) =>
                wrap(setStatus.mutateAsync(e.target.value), "Estado actualizado")
              }
            >
              {STATUSES.map((s) => (
                <option key={s.key} value={s.key} className="bg-ninja-deepViolet">
                  {s.name}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Rubro
            </label>
            <select
              className={selectCls}
              value={tenant?.industry ?? "otro"}
              onChange={(e) =>
                wrap(setIndustry.mutateAsync(e.target.value), "Rubro actualizado")
              }
            >
              {VERTICALS.map((v) => (
                <option key={v} value={v} className="bg-ninja-deepViolet">
                  {VERTICAL_LABELS[v]}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
      </div>

      <Heading className="mt-8" as="h2">
        Cobro de suscripción
      </Heading>
      <Card className="mt-3">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <Button disabled={checkout.isPending} onClick={() => checkout.mutate()}>
            {checkout.isPending ? "Generando…" : "Generar link de cobro (Mercado Pago)"}
          </Button>
          {checkoutUrl && (
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ninja-flameSoft hover:underline"
            >
              <ExternalLink size={15} /> Abrir link de pago
            </a>
          )}
          <p className="w-full text-xs text-muted-foreground">
            Crea una suscripción mensual en Mercado Pago con la cuenta de NinjaSoft
            por el plan del negocio. El estado se actualiza solo cuando el cliente
            paga.
          </p>
        </CardContent>
      </Card>

      <Heading className="mt-8" as="h2">
        Feature flags
      </Heading>
      <Card className="mt-3">
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {flags?.map((f) => {
              const effective = f.enabled ?? f.defaultEnabled;
              return (
                <li
                  key={f.key}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div>
                    <div className="font-mono text-sm">{f.key}</div>
                    {f.description && (
                      <div className="text-xs text-muted-foreground">
                        {f.description}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      wrap(
                        setFlag.mutateAsync({ flagKey: f.key, enabled: !effective }),
                        "Flag actualizada",
                      )
                    }
                    className={
                      effective
                        ? "h-6 w-11 rounded-full bg-ninja-flame px-0.5 transition"
                        : "h-6 w-11 rounded-full bg-muted px-0.5 transition"
                    }
                    aria-label={`Toggle ${f.key}`}
                  >
                    <span
                      className={
                        effective
                          ? "block h-5 w-5 translate-x-5 rounded-full bg-white transition"
                          : "block h-5 w-5 translate-x-0 rounded-full bg-white transition"
                      }
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
