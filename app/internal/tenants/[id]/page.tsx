"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Eyebrow, Display, Heading } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import {
  useInternalTenants,
  useTenantFlags,
  useInternalMutations,
} from "@/modules/internal/hooks";

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
  const { setPlan, setStatus, setFlag } = useInternalMutations(params.id);

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
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={15} /> Negocios
      </Link>
      <Eyebrow>Negocio</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">
        {tenant?.name ?? "…"}
      </Display>
      <p className="mt-2 text-muted-foreground">{tenant?.slug}</p>

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
      </div>

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
