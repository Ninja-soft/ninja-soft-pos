"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  ClipboardList,
  History,
  Lock,
  Package,
  ShieldCheck,
  Wallet,
  Barcode,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { ImportWizard } from "@/components/import/ImportWizard";
import { SerialWarrantyPanel } from "@/components/stock/inventory/SerialWarrantyPanel";
import { InventoryStockTab } from "@/components/stock/inventory/InventoryStockTab";
import { AdjustmentsTab, PendingBanner } from "@/components/stock/inventory/AdjustmentsTab";
import { AdjustmentFormModal } from "@/components/stock/inventory/AdjustmentFormModal";
import { CountTab } from "@/components/stock/inventory/CountTab";
import { MovementsTab } from "@/components/stock/inventory/MovementsTab";
import { ValuationTab } from "@/components/stock/inventory/ValuationTab";
import { InventoryExcelActions } from "@/components/stock/inventory/InventoryExcelActions";
import { StorePicker } from "@/components/stock/inventory/shared";
import { useRolePermissions } from "@/lib/permissions/useRole";
import type { AdjustReason } from "@/lib/stock/adjustments";
import type { StockSheetRow } from "@/lib/stock/inventorySheet";
import { stockAdjustmentImportDefinition } from "@/modules/imports/stockAdjustments";
import { useFeature } from "@/modules/saas/gating";
import { useAdjustmentPolicy, useStockAdjustments } from "@/modules/stock/adjustments";
import { useCurrentStoreId, useMultiStoreStock, useStores } from "@/modules/stock/hooks";
import { useWarehouses } from "@/modules/stock/warehouses";
import { useMyTenant } from "@/modules/tenants/hooks";

type Tab = "stock" | "ajustes" | "conteo" | "movimientos" | "valuacion" | "series";

// Qué se hace en cada sección, en una línea (se muestra debajo de las pestañas).
const TAB_COPY: Record<Tab, { label: string; what: string; icon: typeof Package }> = {
  stock: {
    label: "Stock",
    icon: Package,
    what: "Cuánto hay de cada producto en la sucursal y en cada depósito. Tocá Ajustar para corregir uno.",
  },
  ajustes: {
    label: "Ajustes",
    icon: ClipboardList,
    what: "Sumá, restá o fijá stock con un motivo (rotura, vencimiento, robo, conteo...). Si lo configurás, los ajustes grandes los aprueba el dueño o un auditor.",
  },
  conteo: {
    label: "Conteo",
    icon: ClipboardCheck,
    what: "Inventario físico: descargá la planilla, contá y subila, o contá un poco cada día con el conteo cíclico.",
  },
  movimientos: {
    label: "Movimientos",
    icon: History,
    what: "Cada entrada y salida de stock (ventas, compras, ajustes, traslados) con quién y cuándo.",
  },
  valuacion: {
    label: "Valuación",
    icon: Wallet,
    what: "Cuánto vale tu stock al costo y a precio de venta, por categoría.",
  },
  series: {
    label: "Series y garantías",
    icon: Barcode,
    what: "Buscá un IMEI o un número de serie, mirá si está en garantía y seguí el reclamo de posventa.",
  },
};

const TABS: Tab[] = ["stock", "ajustes", "conteo", "movimientos", "valuacion", "series"];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as string[]).includes(v);
}

// Inventario (F14 · H64, ADR-092 y ADR-137): stock actual con foto, ajustes con
// motivo y aprobación, conteos, movimientos, valuación y series, con Excel
// para descargar y cargar rápido.
export default function InventarioPage() {
  const { data: me } = useMyTenant();
  const { role, allows: can } = useRolePermissions();
  const serials = useFeature("garantias_serie");
  const depositos = useFeature("depositos");
  const { data: allStores = [] } = useStores();
  const multi = useMultiStoreStock();
  const currentStoreId = useCurrentStoreId();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [valuationStore, setValuationStore] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("stock");
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustRow, setAdjustRow] = useState<StockSheetRow | null>(null);
  const [adjustReason, setAdjustReason] = useState<AdjustReason | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Sin stock por sucursal en el plan, se trabaja sobre la sucursal principal.
  const stores = useMemo(() => {
    const principal = allStores.find((s) => s.is_default) ?? allStores[0];
    return multi.enabled ? allStores : principal ? [principal] : [];
  }, [allStores, multi.enabled]);

  useEffect(() => {
    if (storeId && stores.some((s) => s.id === storeId)) return;
    const pick = stores.find((s) => s.id === currentStoreId) ?? stores[0];
    if (pick) setStoreId(pick.id);
  }, [stores, currentStoreId, storeId]);

  // ?tab=ajustes (desde las notificaciones de aprobación).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (isTab(t)) setTab(t);
  }, []);

  const canAdjust = can("stock.adjust");
  const canCount = can("stock.count") || canAdjust;
  const canExport = can("stock.export");
  const canImport = can("stock.import");
  const showCost = can("stock.valuation");
  const withWarehouses = depositos === true;

  const visibleTabs = TABS.filter((t) => {
    if (t === "conteo") return canCount || canExport;
    if (t === "valuacion") return showCost;
    return true;
  });
  useEffect(() => {
    if (!visibleTabs.includes(tab)) setTab("stock");
  }, [visibleTabs, tab]);

  const { data: policy } = useAdjustmentPolicy();
  const { data: pendingAll = [] } = useStockAdjustments(null, "pending");
  const canApproveAny =
    role === "owner" || (policy?.approver === "auditor" && Boolean(policy?.feature) && can("stock.adjust.approve"));
  const pendingForMe = canApproveAny ? pendingAll.length : 0;

  const { data: warehouses = [] } = useWarehouses(withWarehouses ? storeId : null);
  const store = stores.find((s) => s.id === storeId) ?? null;
  const storeLabels = allStores.map((s) => s.name);
  const importContext = useMemo(
    () => ({ stores: storeLabels, warehouses: warehouses.map((w) => w.name) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allStores, warehouses],
  );

  function openAdjust(row: StockSheetRow | null, reason: AdjustReason | null = null) {
    setAdjustRow(row);
    setAdjustReason(reason);
    setAdjustOpen(true);
  }

  const showStorePicker = stores.length > 1 && tab !== "series" && tab !== "valuacion";

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Catálogo"
        title="Inventario"
        icon={ClipboardCheck}
        description="Mirá cuánto hay de cada producto, corregí el stock con un motivo, contá y descargá o cargá todo en Excel."
        actions={
          <InventoryExcelActions
            stores={stores}
            storeId={storeId}
            canExport={canExport}
            canImport={canImport}
            showCost={showCost}
            withWarehouses={withWarehouses}
            businessName={me?.name ?? null}
            onImport={() => setImportOpen(true)}
          />
        }
      />

      {tab !== "ajustes" && (
        <div className="mt-4">
          <PendingBanner count={pendingForMe} onOpen={() => setTab("ajustes")} />
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Segmented<Tab>
          aria-label="Sección de inventario"
          size="sm"
          scrollOnMobile
          value={tab}
          onChange={setTab}
          options={visibleTabs.map((t) => ({ value: t, label: TAB_COPY[t].label }))}
        />
        {showStorePicker && (
          <StorePicker stores={stores} value={storeId} onChange={(id) => id && setStoreId(id)} className="lg:max-w-[16rem]" />
        )}
        {tab === "valuacion" && stores.length > 1 && (
          <StorePicker
            stores={stores}
            value={valuationStore}
            onChange={setValuationStore}
            allLabel="Todas las sucursales"
            className="lg:max-w-[16rem]"
          />
        )}
      </div>

      <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
        {(() => {
          const Icon = TAB_COPY[tab].icon;
          return <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />;
        })()}
        {TAB_COPY[tab].what}
      </p>

      {multi.locked && tab !== "series" && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck size={13} aria-hidden /> Tu plan no incluye stock por sucursal: se muestra la sucursal principal.
        </p>
      )}

      <div className="mt-5">
        {tab === "stock" && (
          <InventoryStockTab
            storeId={storeId}
            canAdjust={canAdjust || canCount}
            showCost={showCost}
            withWarehouses={withWarehouses}
            onAdjust={(r) => openAdjust(r, canAdjust ? null : "conteo")}
          />
        )}
        {tab === "ajustes" && (
          <AdjustmentsTab
            storeId={storeId}
            role={role}
            canAdjust={canAdjust || canCount}
            canApproveCap={can("stock.adjust.approve")}
            canConfigure={can("stock.settings")}
            onNew={() => openAdjust(null, canAdjust ? null : "conteo")}
          />
        )}
        {tab === "conteo" && (
          <CountTab
            store={store ? { ...store, label: store.name } : null}
            storeLabels={storeLabels}
            canImport={canImport}
            canExport={canExport}
            withWarehouses={withWarehouses}
            canCycle={role === "owner" || role === "manager"}
            onImport={() => setImportOpen(true)}
          />
        )}
        {tab === "movimientos" && <MovementsTab storeId={storeId} />}
        {tab === "valuacion" && <ValuationTab storeId={stores.length > 1 ? valuationStore : storeId} />}
        {tab === "series" &&
          (serials === false ? (
            <div className="rounded-lg bg-muted/40 p-8 text-center">
              <Lock className="mx-auto text-ninja-flameSoft" size={28} />
              <p className="mt-3 font-semibold">Garantías por número de serie no está incluido en tu plan</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{TAB_COPY.series.what}</p>
              <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
                Ver planes
              </Button>
              <UpgradeModal
                open={upgradeOpen}
                onOpenChange={setUpgradeOpen}
                featureKey="garantias_serie"
                featureLabel="Garantías por número de serie"
              />
            </div>
          ) : serials ? (
            <SerialWarrantyPanel canManage={Boolean(me?.canManage)} />
          ) : null)}
      </div>

      <AdjustmentFormModal
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        stores={stores}
        storeId={storeId}
        row={adjustRow}
        role={role}
        showCost={showCost}
        withWarehouses={withWarehouses}
        reasonPreset={adjustReason}
      />

      <ImportWizard
        definition={stockAdjustmentImportDefinition}
        open={importOpen}
        onOpenChange={setImportOpen}
        context={importContext}
      />
    </PageContainer>
  );
}
