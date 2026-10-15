"use client";

// Configuración de un depósito (ADR-136): si su stock cuenta para la venta,
// la prioridad con la que la venta toma de él y qué otras sucursales lo pueden
// vender. El servidor valida rol, plan (stock_sucursales para otras
// sucursales) y audita el cambio.

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { WAREHOUSE_KIND_LABEL, isSellable, warehouseErrorMessage, type Warehouse } from "@/lib/stock/warehouses";
import { useWarehouseMutations } from "@/modules/stock/warehouses";

export function WarehouseConfigModal({
  warehouse,
  linkedStoreIds,
  stores,
  multiStore,
  onOpenChange,
}: {
  warehouse: Warehouse | null;
  /** Sucursales (distintas de la del depósito) que hoy lo pueden vender. */
  linkedStoreIds: string[];
  stores: { id: string; name: string }[];
  /** ¿El plan tiene stock por sucursal? (sin él, sólo la propia sucursal). */
  multiStore: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const m = useWarehouseMutations();
  const [sellable, setSellable] = useState(true);
  const [priority, setPriority] = useState("100");
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    if (!warehouse) return;
    setSellable(isSellable(warehouse));
    setPriority(String(warehouse.sale_priority ?? 100));
    setPicked(linkedStoreIds);
    // Sólo al abrir otro depósito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouse?.id]);

  if (!warehouse) return null;
  const principal = warehouse.kind === "principal";
  const others = stores.filter((s) => s.id !== warehouse.store_id);
  const prio = Number(priority);
  const prioOk = Number.isInteger(prio) && prio >= 0 && prio <= 999;

  async function save() {
    if (!warehouse || !prioOk) return;
    try {
      await m.saveConfig.mutateAsync({
        id: warehouse.id,
        sellable: principal ? true : sellable,
        priority: prio,
        storeIds: multiStore ? picked : [],
      });
      toast({ title: `${warehouse.name}: configuración guardada`, variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={`Configurar ${warehouse.name}`}
      description={`${WAREHOUSE_KIND_LABEL[warehouse.kind]}. Definí si se vende su stock y desde qué sucursales.`}
      className="sm:max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!prioOk} loading={m.saveConfig.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3 text-sm">
          <span>
            <span className="block font-medium">Disponible para la venta</span>
            <span className="block text-xs text-muted-foreground">
              {principal
                ? "El salón de ventas siempre se vende."
                : sellable
                  ? "Su stock cuenta para vender en el POS y en el catálogo."
                  : "No se vende: sirve para merma, devoluciones o una reserva técnica."}
            </span>
          </span>
          <Switch label="Disponible para la venta" checked={principal || sellable} disabled={principal} onCheckedChange={setSellable} />
        </div>

        {!principal && (
          <Input
            label="Prioridad para vender"
            inputMode="numeric"
            value={priority}
            onChange={(e) => setPriority(e.target.value.replace(/\D/g, "").slice(0, 3))}
            hint="Cuando el salón no alcanza, la venta toma primero del depósito con el número más bajo (0 a 999)."
            error={prioOk ? undefined : "Poné un número de 0 a 999."}
          />
        )}

        <div>
          <p className="text-sm font-medium">Sucursales que lo pueden vender</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Su propia sucursal lo usa siempre. Las que marques ven su stock en el POS y venden con retiro o envío desde acá.
          </p>
          {!multiStore ? (
            <p className="mt-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              Vender stock de otra sucursal pide el stock por sucursal en tu plan.
            </p>
          ) : others.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No hay otras sucursales.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-lg bg-muted/30">
              {others.map((s) => {
                const on = picked.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm">
                      <Checkbox
                        checked={on}
                        aria-label={s.name}
                        disabled={!(principal || sellable)}
                        onCheckedChange={(v) => setPicked((p) => (v ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                      />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {!(principal || sellable) && picked.length > 0 && (
            <p className="mt-2 text-xs text-warning">Mientras no se venda, ninguna sucursal toma de este depósito.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
