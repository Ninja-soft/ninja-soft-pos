"use client";

import { useMemo, useState } from "react";
import { BadgePercent, BarChart3, LineChart, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { PromotionSimModal } from "@/components/promotions/PromotionSimModal";
import { PromotionPerfModal } from "@/components/promotions/PromotionPerfModal";
import { PromotionWizard } from "@/components/promotions/PromotionWizard";
import { cn } from "@/lib/utils/cn";
import { useFeature } from "@/modules/saas/gating";
import { useBrands, useCategories } from "@/modules/products/hooks";
import { useBranches } from "@/modules/branches/hooks";
import { usePromotions, usePromotionMutations } from "@/modules/promotions/hooks";
import { commercialApi, useChangeRequests } from "@/modules/commercial/api";
import type { Promotion } from "@/modules/promotions/api";
import { arPromoClock } from "@/lib/promotions/engine";
import {
  actionPhrase,
  conditionPhrases,
  promoStatus,
  validityText,
  type PromoNames,
  type PromoStatus,
} from "@/lib/promotions/describe";

// Configuración → Promociones (F9, ADR-074). Listado con estado y vigencia,
// asistente de alta, pausa, simulador y rendimiento. La escritura la valida la
// base (rol, plan con `promociones` y sucursales); el POS y create_sale aplican
// las promos con el mismo motor.

const DOT: Record<PromoStatus["tone"], string> = {
  success: "bg-success",
  info: "bg-info",
  neutral: "bg-muted-foreground/50",
  warning: "bg-warning",
};

export function PromotionsManager() {
  const feature = useFeature("promociones");
  const [upgrade, setUpgrade] = useState(false);

  if (feature === false) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md bg-muted/40 p-5">
        <span className="grid h-10 w-10 place-items-center rounded-md bg-muted text-muted-foreground">
          <Lock size={18} />
        </span>
        <div>
          <p className="font-semibold">Las promociones son del plan Pro</p>
          <p className="mt-1 text-sm text-muted-foreground">
            2x1, segunda unidad, descuentos por cantidad, combos, promos con tarjetas y bancos, por día y horario. El POS las
            aplica solas y el ticket muestra cada una. Los cupones siguen disponibles abajo.
          </p>
        </div>
        <Button onClick={() => setUpgrade(true)}>Ver planes</Button>
        {upgrade && (
          <UpgradeModal open onOpenChange={(o) => !o && setUpgrade(false)} featureKey="promociones" featureLabel="Promociones" />
        )}
      </div>
    );
  }
  return <PromotionsList />;
}

function PromotionsList() {
  const { data: promos, isLoading } = usePromotions();
  const { remove, setActive } = usePromotionMutations();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [creating, setCreating] = useState(false);
  const [delTarget, setDelTarget] = useState<Promotion | null>(null);
  const [simPromo, setSimPromo] = useState<Promotion | null>(null);
  const [perfOpen, setPerfOpen] = useState(false);

  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data: branches } = useBranches();
  const names: PromoNames = useMemo(
    () => ({
      categories: Object.fromEntries((categories ?? []).map((c) => [c.id, c.name])),
      brands: Object.fromEntries((brands ?? []).map((b) => [b.id, b.name])),
      stores: Object.fromEntries((branches ?? []).map((s) => [s.id, s.name])),
    }),
    [categories, brands, branches],
  );
  const clock = arPromoClock();
  // ADR-092: cambios de un encargado que esperan la aprobación del dueño.
  const approvalsOn = useFeature("aprobaciones_comerciales") === true;
  const { data: pendingReqs = [], refetch: refetchPending } = useChangeRequests("pending", approvalsOn);
  const pendingIds = useMemo(
    () => new Set(pendingReqs.filter((r) => r.entity_type === "promotions").map((r) => r.entity_id)),
    [pendingReqs],
  );

  async function doDelete() {
    if (!delTarget) return;
    try {
      await remove.mutateAsync(delTarget.id);
      toast({ title: "Promoción eliminada", variant: "success" });
      setDelTarget(null);
    } catch (e) {
      toast({ title: "No se pudo eliminar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  }

  async function toggle(p: Promotion, active: boolean) {
    try {
      await setActive.mutateAsync({ id: p.id, active });
      const held =
        active && approvalsOn
          ? (await commercialApi.requests("pending")).some((r) => r.entity_type === "promotions" && r.entity_id === p.id)
          : false;
      if (approvalsOn) void refetchPending();
      toast({
        title: held ? "Queda pendiente de aprobación" : active ? "Promoción activada" : "Promoción pausada",
        description: held ? "Es de alto impacto: el dueño la revisa en Control comercial." : undefined,
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo cambiar", description: e instanceof Error ? e.message : undefined, variant: "error" });
    }
  }

  const list = promos ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        El POS aplica solas las promociones que corresponden y el servidor las vuelve a calcular al cobrar. Las excluyentes
        compiten entre sí y queda la que más le conviene al cliente; las acumulables se suman.
      </p>

      {isLoading ? (
        <SpinnerBlock className="py-6" />
      ) : list.length === 0 ? (
        <div className="rounded-md bg-muted/50">
          <EmptyState
            compact
            icon={BadgePercent}
            title="Todavía no hay promociones"
            description="Creá una, por ejemplo 2x1 en gaseosas o 20% los miércoles con Visa."
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((p) => {
            const st = promoStatus(p, clock);
            const conds = conditionPhrases(p, names);
            return (
              <li key={p.id} className="rounded-md border border-border bg-card px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-sm font-semibold text-foreground">{p.name}</span>
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span aria-hidden className={cn("h-2 w-2 rounded-full", DOT[st.tone])} />
                        {st.label}
                      </span>
                      {p.stackable && <span className="text-xs text-muted-foreground">· Acumulable</span>}
                      {pendingIds.has(p.id) && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-warning">
                          <span aria-hidden className="h-2 w-2 rounded-full bg-warning" />
                          Pendiente de aprobación
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-foreground/80">{actionPhrase(p, names)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {validityText(p)}
                      {conds.length > 0 ? ` · ${conds.join(" · ")}` : ""}
                    </p>
                  </div>
                  <Switch
                    checked={p.is_active}
                    onCheckedChange={(v) => toggle(p, v)}
                    label={p.is_active ? "Pausar promoción" : "Activar promoción"}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                    <Pencil size={14} /> Editar
                  </Button>
                  {p.action_type !== "gift" && (
                    <Button variant="ghost" size="sm" onClick={() => setSimPromo(p)}>
                      <LineChart size={14} /> Simular
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setDelTarget(p)} className="hover:text-danger">
                    <Trash2 size={14} /> Eliminar
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={15} /> Nueva promoción
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setPerfOpen(true)}>
          <BarChart3 size={15} /> Rendimiento
        </Button>
      </div>

      <PromotionWizard
        open={creating || editing !== null}
        promo={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={delTarget !== null}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title={`Eliminar la promoción "${delTarget?.name ?? ""}"`}
        description="Se da de baja la promoción. Las ventas ya cobradas no cambian y el ticket la sigue mostrando."
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={doDelete}
      />

      <PromotionSimModal promo={simPromo} onClose={() => setSimPromo(null)} />
      <PromotionPerfModal open={perfOpen} onClose={() => setPerfOpen(false)} />
    </div>
  );
}
