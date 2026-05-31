"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";

const KIND_LABELS: Record<string, string> = {
  manual: "Manual",
  gateway: "Pasarela",
  qr: "QR",
  orchestrator: "Orquestador",
};

type Provider = { key: string; name: string; kind: string; sort: number };
type Method = {
  provider_key: string;
  enabled: boolean;
  sandbox: boolean;
  surcharge_pct: number;
};

export function PaymentMethodsCard({ tenantId }: { tenantId: string }) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: providers = [] } = useQuery({
    queryKey: ["payment-providers"],
    queryFn: async (): Promise<Provider[]> => {
      const { data } = await supabase
        .from("payment_providers")
        .select("key, name, kind, sort")
        .eq("is_active", true)
        .order("sort");
      return (data ?? []) as Provider[];
    },
  });

  const { data: methods = [] } = useQuery({
    queryKey: ["tenant-payment-methods", tenantId],
    queryFn: async (): Promise<Method[]> => {
      const { data } = await supabase
        .from("tenant_payment_methods")
        .select("provider_key, enabled, sandbox, surcharge_pct")
        .eq("tenant_id", tenantId);
      return (data ?? []) as Method[];
    },
  });

  const byKey = useMemo(() => {
    const m = new Map<string, Method>();
    methods.forEach((x) => m.set(x.provider_key, x));
    return m;
  }, [methods]);

  const save = useMutation({
    mutationFn: async (vars: {
      provider_key: string;
      enabled?: boolean;
      sandbox?: boolean;
      surcharge_pct?: number;
    }) => {
      const cur = byKey.get(vars.provider_key);
      const { error } = await supabase.from("tenant_payment_methods").upsert(
        {
          tenant_id: tenantId,
          provider_key: vars.provider_key,
          enabled: vars.enabled ?? cur?.enabled ?? false,
          sandbox: vars.sandbox ?? cur?.sandbox ?? true,
          surcharge_pct: vars.surcharge_pct ?? cur?.surcharge_pct ?? 0,
        },
        { onConflict: "tenant_id,provider_key" },
      );
      if (error) throw error;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods", tenantId] }),
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  return (
    <section className="mt-8">
      <Heading as="h2" className="flex items-center gap-2">
        <CreditCard size={18} /> Medios de pago
      </Heading>
      <p className="mt-1 text-sm text-muted-foreground">
        Activá los medios que aceptás y su recargo. Las pasarelas se conectan en una
        etapa siguiente.
      </p>
      <Card className="mt-3">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Medio</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3 text-right">Recargo %</th>
                <th className="px-4 py-3 text-right">Activo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {providers.map((p) => {
                const m = byKey.get(p.key);
                return (
                  <tr key={p.key}>
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {KIND_LABELS[p.kind] ?? p.kind}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        defaultValue={m?.surcharge_pct ?? 0}
                        onBlur={(e) =>
                          save.mutate({
                            provider_key: p.key,
                            surcharge_pct: Number(e.target.value) || 0,
                          })
                        }
                        className="h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <Switch
                          checked={m?.enabled ?? false}
                          onCheckedChange={(v) =>
                            save.mutate({ provider_key: p.key, enabled: v })
                          }
                          label={`Activar ${p.name}`}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}
