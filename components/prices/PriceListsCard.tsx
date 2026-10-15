"use client";

import { useState } from "react";
import { DollarSign, Download, Pencil, Plus, Tags, Trash2, TrendingUp, Upload } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FeatureGate } from "@/components/saas/FeatureGate";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { PRICE_CHANNELS, type PriceList } from "@/modules/prices/api";
import { LIST_KINDS, type ProList } from "@/modules/prices/proApi";
import {
  useApplyDuePrices,
  usePriceProLists,
  usePriceProMutations,
  usePriceSettings,
} from "@/modules/prices/proHooks";
import { exportPriceLists } from "@/modules/prices/xlsx";
import { GatedButton } from "@/components/saas/GatedAction";
import { ImportWizard } from "@/components/import/ImportWizard";
import { priceListImportDefinition } from "@/modules/imports/entities";
import { describeRounding } from "@/lib/prices/rounding";
import { PriceListEditorModal } from "@/components/prices/PriceListEditorModal";
import { PriceListFormModal } from "@/components/prices/PriceListFormModal";
import { BulkUpdateWizard, type WizardMode } from "@/components/prices/BulkUpdateWizard";
import { FxDollarPanel } from "@/components/prices/FxDollarPanel";
import {
  FxIndexPanel,
  PaymentTermsPanel,
  PriceBatchesPanel,
  UpcomingPricesPanel,
} from "@/components/prices/PriceProPanels";
import { fieldCls, formatWhen, friendlyPriceError, numOrNull } from "@/components/prices/shared";

type Tab = "lists" | "changes" | "dollar" | "upcoming" | "terms" | "fx";

const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(PRICE_CHANNELS.map((c) => [c.value, c.label]));

// Listas de precios (H10 → F18 · H100, ADR-058). Simple por defecto: listas
// con % y precios fijos, actualizar precios en masa e importar / exportar. El
// modo profesional (listas_precios_pro) suma tipos, programados, plazos,
// cotizaciones e índices y aprobación de cambios masivos.
export function PriceListsCard() {
  const { toast } = useToast();
  const { data: myTenant } = useMyTenant();
  const tenantId = myTenant?.tenantId;
  const isOwner = myTenant?.role === "owner";
  useApplyDuePrices();
  const { data: settings } = usePriceSettings();
  const { data: lists } = usePriceProLists();
  const m = usePriceProMutations();
  const hasPro = useFeature("listas_precios_pro") !== false && (settings?.pro ?? false);
  const pro = hasPro && settings?.mode === "pro";
  const hasUsd = useFeature("precios_usd") !== false && (settings?.usd ?? false);

  const [tab, setTab] = useState<Tab>("lists");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProList | null>(null);
  const [pricing, setPricing] = useState<ProList | null>(null);
  const [toDelete, setToDelete] = useState<ProList | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<WizardMode | undefined>(undefined);
  const [floorDraft, setFloorDraft] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = lists ?? [];

  function setMode(mode: "simple" | "pro") {
    m.saveSettings.mutate(
      { mode },
      { onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }) },
    );
  }

  async function onExport() {
    setBusy(true);
    try {
      await exportPriceLists(all);
    } catch {
      toast({ title: "No se pudo exportar", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "lists", label: "Listas" },
    { value: "changes", label: "Cambios" },
    ...(hasUsd ? [{ value: "dollar" as const, label: "Dólar" }] : []),
    ...(pro
      ? [
          { value: "upcoming" as const, label: "Programados" },
          { value: "terms" as const, label: "Plazos" },
          { value: "fx" as const, label: "Dólar e índices" },
        ]
      : []),
  ];
  const activeTab = tabs.some((t) => t.value === tab) ? tab : "lists";

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FeatureGate feature="listas_precios_pro" featureLabel="Listas de precios PRO">
            <Segmented
              aria-label="Modo"
              size="sm"
              value={pro ? "pro" : "simple"}
              onChange={(v) => setMode(v)}
              options={[
                { value: "simple", label: "Simple" },
                { value: "pro", label: "Profesional" },
              ]}
            />
          </FeatureGate>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onExport} loading={busy}>
              <Download size={15} /> Exportar
            </Button>
            {/* Importación con el asistente único (TX-4): revisión en el servidor y confirmación. */}
            <GatedButton
              feature="importacion_excel"
              featureLabel="Importación Excel"
              variant="secondary"
              size="sm"
              onClick={() => setImportOpen(true)}
              disabled={busy}
            >
              <Upload size={15} /> Importar
            </GatedButton>
            {hasUsd && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBulkMode("fx");
                  setBulkOpen(true);
                }}
              >
                <DollarSign size={15} /> Actualizar por dólar
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setBulkMode(undefined);
                setBulkOpen(true);
              }}
            >
              <TrendingUp size={15} /> Actualizar precios
            </Button>
          </div>
        </div>

        {pro && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5">
            <span className="text-sm">
              Aprobación de cambios masivos
              <span className="block text-xs text-muted-foreground">
                El encargado propone y el dueño aprueba. Quien carga no aprueba.
              </span>
            </span>
            <Switch
              checked={settings?.require_approval ?? false}
              disabled={!isOwner}
              onCheckedChange={(v) =>
                m.saveSettings.mutate(
                  { require_approval: v },
                  { onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }) },
                )
              }
              label="Aprobación de cambios masivos"
            />
          </div>
        )}

        {pro && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5">
            <span className="text-sm">
              Margen mínimo sobre el costo final
              <span className="block text-xs text-muted-foreground">
                El POS, el catálogo y Mercado Libre nunca cobran menos que el costo final más este margen (con IVA). Vacío = sin
                mínimo.
              </span>
            </span>
            <div className="flex items-center gap-2">
              <input
                className={fieldCls + " h-9 w-24 text-right"}
                inputMode="decimal"
                aria-label="Margen mínimo %"
                disabled={!isOwner}
                placeholder="Sin mínimo"
                value={floorDraft ?? (settings?.floor_margin_pct != null ? String(settings.floor_margin_pct).replace(".", ",") : "")}
                onChange={(e) => setFloorDraft(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">%</span>
              {floorDraft !== null && (
                <Button
                  size="sm"
                  onClick={() =>
                    m.saveSettings.mutate(
                      { floor_margin_pct: numOrNull(floorDraft) },
                      {
                        onSuccess: () => {
                          setFloorDraft(null);
                          toast({ title: "Margen mínimo guardado", variant: "success" });
                        },
                        onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
                      },
                    )
                  }
                >
                  Guardar
                </Button>
              )}
            </div>
          </div>
        )}

        {tabs.length > 1 && <Segmented aria-label="Sección" size="sm" value={activeTab} onChange={setTab} options={tabs} />}

        {activeTab === "lists" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {pro
                  ? "Fijas, derivadas, sobre costo o en dólares, con vigencia, escalas y redondeo."
                  : "Precios distintos por canal o cliente: un % sobre el precio de venta y precios fijos por producto."}
              </p>
              <FeatureGate feature="listas_precios" featureLabel="Listas de precios">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!tenantId}
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  <Plus size={15} /> Nueva lista
                </Button>
              </FeatureGate>
            </div>
            {all.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">Sin listas de precios. Creá la primera.</p>
            )}
            {all.map((l) => (
              <div
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{l.name}</span>
                    <Badge>{CHANNEL_LABELS[l.channel] ?? l.channel}</Badge>
                    {pro && l.kind !== "fixed" && <Badge tone="info">{LIST_KINDS.find((k) => k.value === l.kind)?.label}</Badge>}
                    {l.adjustment_pct != null && (
                      <Badge tone="neutral">
                        {Number(l.adjustment_pct) > 0 ? "+" : ""}
                        {Number(l.adjustment_pct)}%
                      </Badge>
                    )}
                    {l.pos_selectable && <Badge tone="neutral">En el POS</Badge>}
                    {l.prices_include_tax === false && <Badge tone="neutral">Sin IVA</Badge>}
                  </div>
                  {(l.valid_from || l.valid_to || (pro && l.rounding)) && (
                    <div className="text-xs text-muted-foreground">
                      {l.valid_from ? `Desde ${formatWhen(l.valid_from)} ` : ""}
                      {l.valid_to ? `hasta ${formatWhen(l.valid_to)}` : ""}
                      {pro && l.rounding ? ` · ${describeRounding(l.rounding)}` : ""}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={l.is_active !== false}
                    onCheckedChange={(v) => m.updateList.mutate({ id: l.id, patch: { is_active: v } })}
                    label="Activa"
                  />
                  <button
                    type="button"
                    title="Configurar lista"
                    aria-label="Configurar lista"
                    onClick={() => {
                      setEditing(l);
                      setFormOpen(true);
                    }}
                    className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    title="Precios por producto"
                    aria-label="Precios por producto"
                    onClick={() => setPricing(l)}
                    className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    <Tags size={15} />
                  </button>
                  <button
                    type="button"
                    title="Eliminar"
                    aria-label="Eliminar"
                    onClick={() => setToDelete(l)}
                    className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === "changes" && <PriceBatchesPanel lists={all} isOwner={isOwner} />}
        {activeTab === "dollar" && (
          <FxDollarPanel
            lists={all}
            isOwner={isOwner}
            onUpdateByDollar={() => {
              setBulkMode("fx");
              setBulkOpen(true);
            }}
          />
        )}
        {activeTab === "upcoming" && <UpcomingPricesPanel lists={all} />}
        {activeTab === "terms" && <PaymentTermsPanel />}
        {activeTab === "fx" && <FxIndexPanel />}
      </CardContent>

      <PriceListFormModal open={formOpen} onOpenChange={setFormOpen} list={editing} lists={all} pro={pro} />
      <PriceListEditorModal
        list={pricing as unknown as PriceList | null}
        tenantId={tenantId}
        open={pricing !== null}
        onOpenChange={(o) => !o && setPricing(null)}
      />
      <BulkUpdateWizard
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        lists={all}
        pro={pro}
        requireApproval={pro && (settings?.require_approval ?? false) && !isOwner}
        initialMode={bulkMode}
      />

      <ImportWizard
        definition={priceListImportDefinition}
        open={importOpen}
        onOpenChange={setImportOpen}
        context={{ priceLists: all.map((l) => l.name) }}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Eliminar lista de precios"
        description={toDelete ? `¿Eliminar la lista "${toDelete.name}"? Es una baja lógica.` : undefined}
        confirmLabel="Eliminar"
        danger
        loading={m.updateList.isPending}
        onConfirm={() =>
          toDelete &&
          m.updateList.mutate(
            { id: toDelete.id, patch: { deleted_at: new Date().toISOString() } as never },
            {
              onSuccess: () => {
                toast({ title: "Lista eliminada", variant: "success" });
                setToDelete(null);
              },
              onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
            },
          )
        }
      />
    </Card>
  );
}
