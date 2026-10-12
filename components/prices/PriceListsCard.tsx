"use client";

import { useRef, useState } from "react";
import { Download, Pencil, Plus, Tags, Trash2, TrendingUp, Upload } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/Callout";
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
import { exportPriceLists, parsePricesXlsx, planPriceImport, type PriceImportPlan } from "@/modules/prices/xlsx";
import { describeRounding } from "@/lib/prices/rounding";
import { PriceListEditorModal } from "@/components/prices/PriceListEditorModal";
import { PriceListFormModal } from "@/components/prices/PriceListFormModal";
import { BulkUpdateWizard } from "@/components/prices/BulkUpdateWizard";
import {
  FxIndexPanel,
  PaymentTermsPanel,
  PriceBatchesPanel,
  UpcomingPricesPanel,
} from "@/components/prices/PriceProPanels";
import { formatWhen, friendlyPriceError } from "@/components/prices/shared";

type Tab = "lists" | "changes" | "upcoming" | "terms" | "fx";

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

  const [tab, setTab] = useState<Tab>("lists");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProList | null>(null);
  const [pricing, setPricing] = useState<ProList | null>(null);
  const [toDelete, setToDelete] = useState<ProList | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [importPlan, setImportPlan] = useState<(PriceImportPlan & { invalid: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function onFile(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    try {
      const parsed = await parsePricesXlsx(await f.arrayBuffer());
      if (parsed.fatalError) {
        toast({ title: parsed.fatalError, variant: "error" });
        return;
      }
      const valid = parsed.rows.filter((r) => r.errors.length === 0).map((r) => r.data);
      const plan = await planPriceImport(valid, all);
      setImportPlan({ ...plan, invalid: parsed.rows.length - valid.length });
    } catch {
      toast({ title: "No se pudo leer el archivo", variant: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function confirmImport() {
    if (!importPlan) return;
    let applied = 0;
    let scheduled = 0;
    try {
      for (const [listId, rows] of importPlan.byList) {
        const r = await m.importList.mutateAsync({ listId, rows });
        applied += r.applied;
        scheduled += r.scheduled;
      }
      toast({ title: `Importado: ${applied} precios${scheduled ? `, ${scheduled} programados` : ""}`, variant: "success" });
      setImportPlan(null);
    } catch (e) {
      toast({ title: friendlyPriceError(e), variant: "error" });
    }
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "lists", label: "Listas" },
    { value: "changes", label: "Cambios" },
    ...(pro
      ? [
          { value: "upcoming" as const, label: "Programados" },
          { value: "terms" as const, label: "Plazos" },
          { value: "fx" as const, label: "Dólar e índices" },
        ]
      : []),
  ];
  const activeTab = tabs.some((t) => t.value === tab) ? tab : "lists";
  const importCount = importPlan ? [...importPlan.byList.values()].reduce((a, r) => a + r.length, 0) : 0;

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
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload size={15} /> Importar
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button size="sm" onClick={() => setBulkOpen(true)}>
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
      />

      <Modal
        open={importPlan !== null}
        onOpenChange={(o) => !o && setImportPlan(null)}
        title="Importar precios"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setImportPlan(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmImport} loading={m.importList.isPending} disabled={importCount === 0}>
              Importar {importCount}
            </Button>
          </div>
        }
      >
        {importPlan && (
          <div className="space-y-3 text-sm">
            <p>
              {importCount} precios para cargar en {importPlan.byList.size} lista
              {importPlan.byList.size === 1 ? "" : "s"}. Los que tienen fecha futura quedan programados.
            </p>
            {(importPlan.unknownList > 0 || importPlan.unknownProduct > 0 || importPlan.invalid > 0) && (
              <Callout tone="warning">
                Se omiten: {importPlan.invalid} filas con errores, {importPlan.unknownList} con una lista que no existe y{" "}
                {importPlan.unknownProduct} sin producto con ese SKU o código.
              </Callout>
            )}
          </div>
        )}
      </Modal>

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
