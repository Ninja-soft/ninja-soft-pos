"use client";

import { useState } from "react";
import { Sparkles, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils/cn";
import { IndustryPresetButton } from "@/components/onboarding/IndustryPresetButton";
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
  // Rubro pendiente de confirmar (el cambio pasa por un aviso, ver más abajo).
  const [pending, setPending] = useState<string | null>(null);

  if (!ctx || !ctx.canManage) return null;
  const current = ctx.industry;

  // Tap en un rubro distinto: NO cambia directo. Abre un aviso que aclara qué
  // hace (y qué NO hace) el cambio de rubro, porque es un punto que confunde:
  // cambiar de rubro sólo adapta las FUNCIONES del POS — los productos, precios y
  // categorías son independientes del rubro y NO se tocan.
  function choose(v: string) {
    if (v === current || setIndustry.isPending) return;
    setPending(v);
  }

  function confirmChange() {
    if (!pending) return;
    const v = pending;
    setIndustry.mutate(v, {
      onSuccess: () => {
        setPending(null);
        toast({ title: "Rubro actualizado", variant: "success" });
      },
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

        {/* Configuración rápida por rubro (F12 · H35): siembra un catálogo de
            muestra y deja el negocio listo para cobrar sin Excel ni SQL. */}
        <div className="rounded-lg border border-ninja-flame/20 bg-ninja-flame/[0.05] p-4">
          <div className="flex items-start gap-2.5">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">¿Empezás de cero?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Elegí un preset de rubro (heladería, peluquería, cafetería,
                restaurante, rotisería…) y sembramos categorías y productos de
                muestra, listos como botones rápidos del POS. Los rubros
                gastronómicos además activan mesas/cocina o delivery. No duplica
                lo que ya tengas.
              </p>
            </div>
          </div>
          <div className="mt-3">
            <IndustryPresetButton size="sm" />
          </div>
        </div>
      </CardContent>

      {/* Aviso al cambiar de rubro: aclara que sólo se adaptan las funciones del
          POS y que el catálogo (productos/precios/categorías) NO se modifica.
          Resuelve la confusión de "cambiar de rubro me transfiere los productos":
          el rubro y el catálogo son independientes. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending
            ? `Cambiar a ${VERTICAL_LABELS[pending as keyof typeof VERTICAL_LABELS] ?? pending}`
            : "Cambiar de rubro"
        }
        description={
          "Cambiar de rubro sólo adapta las FUNCIONES del POS (mesas/comandas, " +
          "balanza, venta rápida, etc.). Tus productos, precios y categorías son " +
          "independientes del rubro y NO se modifican: tu catálogo queda intacto. " +
          "Si querés un catálogo distinto, agregá o eliminá productos a mano."
        }
        confirmLabel="Cambiar rubro"
        loading={setIndustry.isPending}
        onConfirm={confirmChange}
      />
    </Card>
  );
}
