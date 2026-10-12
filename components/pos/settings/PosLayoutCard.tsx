"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useFeature } from "@/modules/saas/gating";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useProducts, useProductsByIds } from "@/modules/products/hooks";
import { usePosLayout, usePosLayoutMutations, useResolvedTenders } from "@/modules/pos/layoutHooks";
import { resolveLayout, type PosLayout } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";
import { PosLayoutEditor, type QuickKeyProduct } from "./PosLayoutEditor";

// Configuración, Diseño del POS. El dueño o encargado define el diseño del
// negocio; cualquier usuario puede guardarse uno propio para su pantalla.
export function PosLayoutCard() {
  const { toast } = useToast();
  const { data: myTenant } = useMyTenant();
  const canManage = Boolean(myTenant?.canManage);
  const { business, user, hasUserOverride, ready } = usePosLayout();
  const { saveBusiness, saveUser } = usePosLayoutMutations();
  const { data: diningEnabled } = useDiningEnabled();
  const quickKeysPro = useFeature("pos_quick_keys_pro") !== false;
  const gate = useFeatureGate("pos_quick_keys_pro", "Teclas rápidas Pro");
  const tenders = useResolvedTenders({ hasCustomer: false, storeCreditBalance: 0 });

  const [scope, setScope] = useState<"business" | "user">("business");
  const [draft, setDraft] = useState<PosLayout | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (myTenant && !canManage) setScope("user");
  }, [myTenant, canManage]);

  // Borrador según el alcance elegido.
  useEffect(() => {
    if (!ready) return;
    setDraft(scope === "business" ? resolveLayout(business) : resolveLayout(business, user));
    // Se recalcula al cambiar de alcance o al terminar de cargar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ready]);

  const { data: results } = useProducts(query);
  const ids = useMemo(() => (draft?.quickKeys ?? []).map((k) => k.productId), [draft?.quickKeys]);
  const { data: keyProductsData } = useProductsByIds(ids);
  const keyProducts = useMemo(() => {
    const m = new Map<string, QuickKeyProduct>();
    for (const p of keyProductsData ?? []) m.set(p.id, { id: p.id, name: p.name, price: p.price });
    for (const p of results ?? []) m.set(p.id, { id: p.id, name: p.name, price: p.price });
    return m;
  }, [keyProductsData, results]);

  async function save() {
    if (!draft) return;
    try {
      if (scope === "business") {
        await saveBusiness.mutateAsync(draft);
        toast({ title: "Diseño del negocio guardado", variant: "success" });
      } else {
        // El override de usuario no lleva teclas rápidas (son del negocio).
        const { quickKeys: _omit, ...own } = draft;
        void _omit;
        await saveUser.mutateAsync(own);
        toast({ title: "Tu diseño quedó guardado", variant: "success" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("pos_quick_keys_pro")) {
        gate.run(() => {});
        toast({ title: "Más de 12 teclas o color por tecla requieren Teclas rápidas Pro", variant: "error" });
      } else {
        toast({ title: "No se pudo guardar el diseño", description: msg || undefined, variant: "error" });
      }
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Gratis en todos los planes. Aplicalo a todo el negocio o sólo a tu usuario.
        </p>
        <div className="inline-flex gap-1 rounded-lg bg-fg-6 p-1">
          {(
            [
              ["business", "Para todo el negocio"],
              ["user", "Sólo para mí"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              disabled={k === "business" && !canManage}
              onClick={() => setScope(k)}
              className={cn(
                "h-8 rounded-md px-3 text-[13px] font-semibold transition disabled:opacity-40",
                scope === k ? "bg-card text-foreground ring-1 ring-border" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!draft ? null : (
        <PosLayoutEditor
          value={draft}
          onChange={setDraft}
          diningEnabled={Boolean(diningEnabled)}
          tenders={tenders}
          quickKeysPro={quickKeysPro && scope === "business"}
          onLockedQuickKeys={() => (scope === "user" ? toast({ title: "Las teclas rápidas se definen para todo el negocio", variant: "info" }) : gate.run(() => {}))}
          productQuery={query}
          onProductQuery={setQuery}
          productResults={(results ?? []).map((p) => ({ id: p.id, name: p.name, price: p.price }))}
          keyProducts={keyProducts}
        />
      )}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 bg-[color-mix(in_srgb,var(--background)_85%,transparent)] px-1 py-3 backdrop-blur">
        {scope === "user" && hasUserOverride && (
          <Button
            variant="ghost"
            onClick={() =>
              saveUser.mutate(null, {
                onSuccess: () => {
                  setDraft(resolveLayout(business));
                  toast({ title: "Volviste al diseño del negocio", variant: "success" });
                },
              })
            }
          >
            <RotateCcw size={15} /> Usar el del negocio
          </Button>
        )}
        <Button onClick={save} loading={saveBusiness.isPending || saveUser.isPending} disabled={!draft}>
          {scope === "business" ? "Guardar para el negocio" : "Guardar para mí"}
        </Button>
      </div>
      {gate.modal}
    </section>
  );
}
