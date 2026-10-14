"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/Card";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { createClient } from "@/lib/supabase/client";
import {
  activationMilestones,
  activationScore,
  isActivated,
  parseActivation,
} from "@/lib/saas/activation";

function fmt(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
}

// Métricas de activación del negocio (F12 · H42, ADR-082). Lee la RPC
// internal_tenant_activation, que exige el scope del panel interno.
export function ActivationCard({ tenantId }: { tenantId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["internal", "activation", tenantId],
    queryFn: async () => {
      const { data, error } = await createClient().rpc("internal_tenant_activation" as never, {
        p_tenant: tenantId,
      } as never);
      if (error) throw error;
      return parseActivation(data);
    },
    staleTime: 60_000,
  });

  return (
    <Card className="mt-3">
      <CardContent className="p-5">
        {isLoading ? (
          <SkeletonLines lines={2} />
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">No se pudieron leer las métricas de activación.</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {isActivated(data) ? "Activado" : "Todavía no activado"} · {activationScore(data)}% de los hitos
              </span>
              <span className="text-xs text-muted-foreground">Alta {fmt(data.tenant_created_at)}</span>
            </div>
            <ul className="divide-y divide-border">
              {activationMilestones(data).map((m) => (
                <li key={m.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${m.done ? "bg-success" : "bg-muted-foreground/40"}`}
                    />
                    {m.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[fmt(m.at), m.detail].filter(Boolean).join(" · ") || "Pendiente"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Taps y segundos por venta todavía no se miden.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
