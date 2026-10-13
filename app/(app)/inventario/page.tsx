"use client";

import { useEffect, useState } from "react";
import { ClipboardCheck, Lock } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { selectCls } from "@/components/stock/transfers/shared";
import { CycleCountPanel } from "@/components/stock/inventory/CycleCountPanel";
import { SerialWarrantyPanel } from "@/components/stock/inventory/SerialWarrantyPanel";
import { cn } from "@/lib/utils/cn";
import { useFeature } from "@/modules/saas/gating";
import { useCurrentStoreId, useStores } from "@/modules/stock/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";

type Tab = "conteo" | "series";

const COPY: Record<Tab, { key: string; label: string; pitch: string }> = {
  conteo: {
    key: "conteo_ciclico",
    label: "Conteo cíclico",
    pitch: "Contá un poco cada día, empezando por lo que más vende, y medí la exactitud de tu stock.",
  },
  series: {
    key: "garantias_serie",
    label: "Garantías por número de serie",
    pitch: "Buscá un IMEI o una serie, mirá si está en garantía y seguí el reclamo de posventa.",
  },
};

// Inventario PRO (F14 · H64, ADR-092): conteo cíclico ABC y garantías por serie.
export default function InventarioPage() {
  const cycle = useFeature("conteo_ciclico");
  const serials = useFeature("garantias_serie");
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: stores = [] } = useStores();
  const currentStoreId = useCurrentStoreId();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conteo");
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    if (!storeId && currentStoreId) setStoreId(currentStoreId);
  }, [currentStoreId, storeId]);

  // El cajero sólo ve garantías (el conteo es del dueño o el encargado).
  useEffect(() => {
    if (me && !canManage) setTab("series");
  }, [me, canManage]);

  const enabled = tab === "conteo" ? cycle : serials;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Catálogo"
        title="Inventario PRO"
        icon={ClipboardCheck}
        description="Conteo cíclico por clase ABC y garantías por número de serie."
      />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        {canManage && (
          <Segmented<Tab>
            aria-label="Sección"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "conteo", label: "Conteo cíclico" },
              { value: "series", label: "Garantías por serie" },
            ]}
          />
        )}
        {tab === "conteo" && stores.length > 1 && (
          <select
            aria-label="Sucursal"
            className={cn(selectCls, "h-10 sm:max-w-[14rem]")}
            value={storeId ?? ""}
            onChange={(e) => setStoreId(e.target.value)}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="mt-6">
        {enabled === false ? (
          <div className="rounded-lg bg-muted/40 p-8 text-center">
            <Lock className="mx-auto text-ninja-flameSoft" size={28} />
            <p className="mt-3 font-semibold">{COPY[tab].label} no está incluido en tu plan</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{COPY[tab].pitch}</p>
            <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
              Ver planes
            </Button>
            <UpgradeModal
              open={upgradeOpen}
              onOpenChange={setUpgradeOpen}
              featureKey={COPY[tab].key}
              featureLabel={COPY[tab].label}
            />
          </div>
        ) : enabled ? (
          tab === "conteo" ? (
            <CycleCountPanel storeId={storeId} />
          ) : (
            <SerialWarrantyPanel canManage={canManage} />
          )
        ) : null}
      </div>
    </PageContainer>
  );
}
