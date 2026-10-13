"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  CREATABLE_KINDS,
  WAREHOUSE_KIND_LABEL,
  warehouseErrorMessage,
  type Warehouse,
  type WarehouseKind,
} from "@/lib/stock/warehouses";
import { useWarehouseMutations } from "@/modules/stock/warehouses";
import { selectCls } from "@/components/stock/transfers/shared";

// Alta y edición de un depósito de la sucursal (F11 · H33). El salón de
// ventas (principal) se crea solo con el primer depósito; se puede renombrar.
export function WarehouseFormModal({
  open,
  onOpenChange,
  storeId,
  warehouse,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string;
  warehouse: Warehouse | null;
}) {
  const { toast } = useToast();
  const m = useWarehouseMutations();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<WarehouseKind>("reserva");

  useEffect(() => {
    if (!open) return;
    setName(warehouse?.name ?? "");
    setCode(warehouse?.code ?? "");
    setKind(warehouse?.kind ?? "reserva");
  }, [open, warehouse]);

  async function submit() {
    try {
      await m.save.mutateAsync({
        id: warehouse?.id ?? null,
        storeId,
        name: name.trim(),
        kind,
        code: code.trim() || null,
        sort: warehouse?.sort ?? 0,
      });
      toast({ title: warehouse ? "Depósito actualizado" : "Depósito creado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

  const isPrincipal = warehouse?.kind === "principal";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={warehouse ? "Editar depósito" : "Nuevo depósito"}
      className="sm:max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!name.trim()} loading={m.save.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <Input
          label="Código (opcional)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={20}
          placeholder="Para importar desde Excel"
        />
        {isPrincipal ? (
          <p className="text-sm text-muted-foreground">
            Es el salón de ventas: su stock es lo que queda de la sucursal después de los otros depósitos.
          </p>
        ) : (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Tipo</span>
            <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as WarehouseKind)}>
              {CREATABLE_KINDS.map((k) => (
                <option key={k} value={k} className="bg-popover text-popover-foreground">
                  {WAREHOUSE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}

// Conteo de un depósito (no principal): deja el depósito en la cantidad
// contada moviendo la diferencia desde o hacia el salón.
export function WarehouseCountModal({
  target,
  onOpenChange,
}: {
  target: { warehouse: Warehouse; productId: string; variantId: string | null; name: string; current: number } | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const m = useWarehouseMutations();
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!target) return;
    setQty(String(target.current));
    setNotes("");
  }, [target]);

  const value = Number(qty.replace(",", "."));
  const valid = qty.trim() !== "" && Number.isFinite(value) && value >= 0;

  async function submit() {
    if (!target) return;
    try {
      await m.setStock.mutateAsync({
        warehouseId: target.warehouse.id,
        productId: target.productId,
        variantId: target.variantId,
        qty: value,
        notes: notes.trim() || null,
      });
      toast({ title: "Conteo guardado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={Boolean(target)}
      onOpenChange={onOpenChange}
      title={target ? `Contar en ${target.warehouse.name}` : "Contar"}
      description={target?.name}
      className="sm:max-w-sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid} loading={m.setStock.isPending}>
            Guardar conteo
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Cantidad contada"
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          autoFocus
        />
        <Input label="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          La diferencia se mueve desde o hacia el salón de ventas; el stock de la sucursal no cambia.
        </p>
      </div>
    </Modal>
  );
}
