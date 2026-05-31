"use client";

import { Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { useMyTenant, useSetMyIndustry } from "@/modules/tenants/hooks";
import {
  VERTICALS,
  VERTICAL_LABELS,
  VERTICAL_DESCRIPTIONS,
  verticalFeatures,
} from "@/lib/verticals/config";

const FEATURE_LABELS: Record<string, string> = {
  quickSale: "Venta rápida",
  byWeight: "Por peso",
  combos: "Combos y promos",
  variants: "Variantes (talle/color)",
  tables: "Mesas y comandas",
};

export function RubroCard() {
  const { toast } = useToast();
  const { data: ctx } = useMyTenant();
  const setIndustry = useSetMyIndustry();

  if (!ctx || !ctx.canManage) return null;
  const current = ctx.industry;

  function choose(v: string) {
    if (v === current || setIndustry.isPending) return;
    setIndustry.mutate(v, {
      onSuccess: () => toast({ title: "Rubro actualizado", variant: "success" }),
      onError: () => toast({ title: "No se pudo actualizar", variant: "error" }),
    });
  }

  return (
    <Card className="mt-6">
      <CardContent className="space-y-6 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
            <Store size={18} />
          </span>
          <div>
            <Heading as="h3" className="text-base">
              Rubro del negocio
            </Heading>
            <p className="text-sm text-muted-foreground">
              Define qué funciones del POS se adaptan a tu actividad.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {VERTICALS.map((v) => {
            const active = current === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => choose(v)}
                disabled={setIndustry.isPending}
                className={cn(
                  "rounded-lg border p-3 text-left transition disabled:opacity-60",
                  active
                    ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                    : "border-border hover:border-ninja-flameSoft/40",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      active ? "bg-ninja-flame" : "bg-transparent",
                    )}
                  />
                  <span className="text-sm font-medium">{VERTICAL_LABELS[v]}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {VERTICAL_DESCRIPTIONS[v]}
                </p>
              </button>
            );
          })}
        </div>

        {current && verticalFeatures(current).length > 0 && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Funciones activas
            </span>
            <div className="flex flex-wrap gap-2">
              {verticalFeatures(current).map((f) => (
                <span
                  key={f}
                  className="rounded-full bg-ninja-flame/12 px-2.5 py-1 text-xs font-medium text-ninja-flameSoft"
                >
                  {FEATURE_LABELS[f] ?? f}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
