"use client";

// Configuración de compras (F18 · H101, ADR-050): modo simple o profesional,
// base de costo para los márgenes y reglas de recepción.

import { useEffect, useState } from "react";
import { Briefcase, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { useToast } from "@/components/ui/Toast";
import { COST_BASES, COST_BASIS_HINT, COST_BASIS_LABEL } from "@/lib/purchases/costs";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { CURRENCIES, CURRENCY_LABEL } from "@/lib/purchases/suppliers";
import { useMyTenant } from "@/modules/tenants/hooks";
import { DEFAULT_PURCHASE_SETTINGS, type PurchaseSettings } from "@/modules/purchases/api";
import { usePurchaseMutations, usePurchaseSettings, usePurchasesAccess } from "@/modules/purchases/hooks";
import { selectCls } from "./shared";

function Row({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </div>
  );
}

export function PurchaseSettingsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const { data } = usePurchaseSettings(open);
  const access = usePurchasesAccess();
  const { saveSettings } = usePurchaseMutations();
  const [s, setS] = useState<PurchaseSettings>(DEFAULT_PURCHASE_SETTINGS);

  useEffect(() => {
    if (open && data) setS(data);
  }, [open, data]);

  const set = <K extends keyof PurchaseSettings>(k: K, v: PurchaseSettings[K]) =>
    setS((p) => ({ ...p, [k]: v }));

  async function save() {
    try {
      await saveSettings.mutateAsync(s);
      toast({ title: "Configuración de compras guardada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const basisChanged = data && (data.cost_basis !== s.cost_basis || data.sync_product_cost !== s.sync_product_cost);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Configuración de compras"
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={saveSettings.isPending} disabled={!me?.canManage}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Modo de trabajo</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <ChoiceCard
              selected={s.mode === "simple"}
              onClick={() => set("mode", "simple")}
              icon={<Sparkles size={18} />}
              title="Simple"
              description="Pedidos, recepción y facturas en pesos. Lo justo para reponer el negocio."
            />
            <ChoiceCard
              selected={s.mode === "pro"}
              onClick={() => set("mode", "pro")}
              icon={<Briefcase size={18} />}
              title="Profesional"
              description={
                access.importEnabled
                  ? "Suma moneda y tipo de cambio por operación, pesos y volúmenes y la hoja de costeo de importación."
                  : "Suma moneda y tipo de cambio por operación. La hoja de costeo de importación es del plan Business."
              }
            />
          </div>
          {s.mode === "pro" && (
            <label className="block max-w-xs">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Moneda habitual de compra</span>
              <select
                className={selectCls}
                value={s.default_currency}
                onChange={(e) => set("default_currency", e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c} className="bg-popover text-popover-foreground">
                    {CURRENCY_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Costo para calcular márgenes</h3>
          <div className="space-y-2">
            {COST_BASES.map((b) => (
              <ChoiceCard
                key={b}
                indicator
                selected={s.cost_basis === b}
                onClick={() => set("cost_basis", b)}
                title={COST_BASIS_LABEL[b]}
                description={COST_BASIS_HINT[b]}
              />
            ))}
          </div>
          <div className="divide-y divide-border rounded-2xl bg-muted">
            <Row
              title="Actualizar el costo de los productos"
              description="El costo de cada producto (márgenes, valor del inventario, traslados) sigue al costo elegido arriba cada vez que cambia."
              checked={s.sync_product_cost}
              onChange={(v) => set("sync_product_cost", v)}
            />
          </div>
          {basisChanged && s.sync_product_cost && (
            <p className="text-xs text-warning">
              Al guardar se recalcula el costo de todos los productos que tengan ese dato.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Recepción de mercadería</h3>
          <div className="divide-y divide-border rounded-2xl bg-muted">
            <Row
              title="El cajero puede recibir"
              description="Quien está en la sucursal registra lo que llegó del proveedor."
              checked={s.cashier_can_receive}
              onChange={(v) => set("cashier_can_receive", v)}
            />
            <Row
              title="Permitir recepciones sin orden de compra"
              description="Para compras al paso o proveedores sin pedido previo. El dueño siempre puede."
              checked={s.allow_free_receipts}
              onChange={(v) => set("allow_free_receipts", v)}
            />
            <Row
              title="Permitir recibir de más"
              description="Si llega más de lo pedido, se suma al stock como sobrante."
              checked={s.allow_over_receive}
              onChange={(v) => set("allow_over_receive", v)}
            />
            <Row
              title="Exigir motivo en las diferencias"
              description="Al cerrar una orden, faltantes y sobrantes quedan con motivo."
              checked={s.require_difference_reason}
              onChange={(v) => set("require_difference_reason", v)}
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}
