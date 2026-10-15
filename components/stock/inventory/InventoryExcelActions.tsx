"use client";

// Excel de Inventario (ADR-137): "Descargar Excel" con el stock (esta
// sucursal o todas, con depósitos y costo según permisos) e "Importar Excel"
// para cargar ajustes y conteos con el asistente único (ADR-078).

import { useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { exportStockWorkbook } from "@/modules/stock/inventoryExport";

type Scope = "one" | "all";

export function InventoryExcelActions({
  stores,
  storeId,
  canExport,
  canImport,
  showCost,
  withWarehouses,
  businessName,
  onImport,
}: {
  stores: { id: string; name: string }[];
  storeId: string | null;
  canExport: boolean;
  canImport: boolean;
  showCost: boolean;
  withWarehouses: boolean;
  businessName: string | null;
  onImport: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("one");
  const [busy, setBusy] = useState(false);
  const current = stores.find((s) => s.id === storeId) ?? stores[0] ?? null;

  if (!canExport && !canImport) return null;

  async function run() {
    const list = scope === "all" ? stores : current ? [current] : [];
    if (list.length === 0) return;
    setBusy(true);
    try {
      await exportStockWorkbook({ stores: list, showCost, withWarehouses, businessName });
      setOpen(false);
    } catch {
      toast({ title: "No se pudo generar el Excel", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canExport && (
        <GatedButton feature="export_xlsx" featureLabel="Exportar a Excel" variant="secondary" onClick={() => setOpen(true)}>
          <Download size={16} /> Descargar Excel
        </GatedButton>
      )}
      {canImport && (
        <GatedButton feature="importacion_excel" featureLabel="Importación Excel" variant="secondary" onClick={onImport}>
          <Upload size={16} /> Importar Excel
        </GatedButton>
      )}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Descargar el stock en Excel"
        description="Una hoja por sucursal con producto, SKU, código de barras, categoría y stock."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={run} loading={busy}>
              <FileSpreadsheet size={16} /> Descargar
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {stores.length > 1 && (
            <Segmented<Scope>
              aria-label="Qué sucursales"
              fill
              value={scope}
              onChange={setScope}
              options={[
                { value: "one", label: current ? current.name : "Esta sucursal" },
                { value: "all", label: "Todas las sucursales" },
              ]}
            />
          )}
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {withWarehouses && <li>Con una columna por depósito (salón de ventas y depósitos internos).</li>}
            {showCost ? <li>Con el costo y el valor del stock al costo.</li> : <li>Sin costos (tu usuario no los ve).</li>}
            <li>Para corregir stock en cantidad, usá la planilla para contar de la pestaña Conteo.</li>
          </ul>
        </div>
      </Modal>
    </div>
  );
}
