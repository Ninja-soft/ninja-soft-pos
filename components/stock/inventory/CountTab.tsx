"use client";

// Conteo e inventario físico (ADR-137): dos caminos claros.
//   1. Contar todo con la planilla: se descarga el Excel con los productos de
//      la sucursal (o de un depósito), se completa la columna Cantidad y se
//      sube; cada diferencia queda como ajuste con motivo Conteo (y pasa por
//      aprobación si supera el umbral).
//   2. Conteo cíclico ABC (ADR-092, Pro): un poco cada día, empezando por lo
//      que más vende.

import { useState } from "react";
import { ClipboardCheck, Download, Lock, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { CycleCountPanel } from "@/components/stock/inventory/CycleCountPanel";
import { useFeature } from "@/modules/saas/gating";
import { downloadCountSheet } from "@/modules/stock/inventoryExport";
import { useWarehouses } from "@/modules/stock/warehouses";

const WHOLE = "__store__";

export function CountTab({
  store,
  storeLabels,
  canImport,
  canExport,
  withWarehouses,
  canCycle,
  onImport,
}: {
  store: { id: string; name: string; label: string } | null;
  storeLabels: string[];
  canImport: boolean;
  canExport: boolean;
  withWarehouses: boolean;
  /** El conteo cíclico es del dueño o el encargado (ADR-092). */
  canCycle: boolean;
  onImport: () => void;
}) {
  const { toast } = useToast();
  const cycle = useFeature("conteo_ciclico");
  const { data: warehouses = [] } = useWarehouses(withWarehouses && store ? store.id : null);
  const [warehouseId, setWarehouseId] = useState(WHOLE);
  const [onlyWithStock, setOnlyWithStock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  async function download() {
    if (!store) return;
    setBusy(true);
    try {
      const wh = warehouses.find((w) => w.id === warehouseId) ?? null;
      const r = await downloadCountSheet({
        store,
        warehouse: wh ? { id: wh.id, name: wh.name, kind: wh.kind } : null,
        onlyWithStock,
        stores: storeLabels,
        warehouses: warehouses.map((w) => w.name),
      });
      toast({
        title: `Planilla lista con ${r.rows} productos`,
        description:
          r.withoutCode > 0
            ? `${r.withoutCode} productos no tienen SKU ni código de barras y no se pueden contar por Excel: cargales un código.`
            : "Completá la columna Cantidad con lo que contaste y subila con Subir conteo.",
        variant: r.withoutCode > 0 ? "info" : "success",
      });
    } catch {
      toast({ title: "No se pudo generar la planilla", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      {(canExport || canImport) && (
        <section className="border-t-2 border-ninja-flame pt-4">
          <h2 className="text-base font-semibold">Contar todo con una planilla</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Descargá la planilla: trae cada producto con su código y lo que dice el sistema.</li>
            <li>Contá y anotá la cantidad en la columna Cantidad (lo que no contaste, dejalo vacío).</li>
            <li>Subila: vas a ver fila por fila qué cambia antes de confirmar.</li>
          </ol>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end">
            {warehouses.length > 1 && (
              <Select
                label="Qué vas a contar"
                value={warehouseId}
                options={[
                  { value: WHOLE, label: "Toda la sucursal" },
                  ...warehouses.map((w) => ({ value: w.id, label: w.name })),
                ]}
                onChange={setWarehouseId}
              />
            )}
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={onlyWithStock} onCheckedChange={setOnlyWithStock} aria-label="Sólo productos con stock" />
              Sólo productos con stock
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {canExport && (
              <GatedButton
                feature="export_xlsx"
                featureLabel="Exportar a Excel"
                variant="secondary"
                onClick={download}
                loading={busy}
                disabled={!store}
              >
                <Download size={16} /> Descargar planilla para contar
              </GatedButton>
            )}
            {canImport && (
              <GatedButton feature="importacion_excel" featureLabel="Importación Excel" onClick={onImport}>
                <Upload size={16} /> Subir conteo
              </GatedButton>
            )}
          </div>
        </section>
      )}

      <section>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ClipboardCheck size={17} aria-hidden /> Conteo cíclico: un poco cada día
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          En lugar de cerrar para contar todo, el sistema te propone cada día qué contar: lo que más vende se cuenta más
          seguido. Mide la exactitud de tu stock en cada conteo.
        </p>
        <div className="mt-4">
          {cycle === false ? (
            <div className="rounded-lg bg-muted/40 p-6 text-center">
              <Lock className="mx-auto text-ninja-flameSoft" size={24} />
              <p className="mt-2 font-semibold">El conteo cíclico no está incluido en tu plan</p>
              <Button className="mt-3" onClick={() => setUpgradeOpen(true)}>
                Ver planes
              </Button>
              <UpgradeModal
                open={upgradeOpen}
                onOpenChange={setUpgradeOpen}
                featureKey="conteo_ciclico"
                featureLabel="Conteo cíclico"
              />
            </div>
          ) : cycle && !canCycle ? (
            <p className="text-sm text-muted-foreground">El conteo cíclico lo hace el dueño o un encargado.</p>
          ) : cycle ? (
            <CycleCountPanel storeId={store?.id ?? null} />
          ) : null}
        </div>
      </section>
    </div>
  );
}
