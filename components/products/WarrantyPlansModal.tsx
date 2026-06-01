"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useWarrantyPlans, useWarrantyPlanMutations } from "@/modules/products/hooks";
import { formatCurrency } from "@/lib/utils/format";

// Planes de garantía extendida (H28): meses extra, prima fija y comisión del
// vendedor. Owner/manager los administra.
export function WarrantyPlansModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: plans } = useWarrantyPlans(false);
  const { create, setActive, remove } = useWarrantyPlanMutations();
  const [label, setLabel] = useState("");
  const [months, setMonths] = useState("");
  const [price, setPrice] = useState("");
  const [comm, setComm] = useState("");

  function add() {
    if (label.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    create.mutate(
      {
        label: label.trim(),
        months: Number(months) || 0,
        price: Number(price) || 0,
        commission_pct: Number(comm) || 0,
      },
      {
        onSuccess: () => {
          setLabel("");
          setMonths("");
          setPrice("");
          setComm("");
        },
        onError: () => toast({ title: "No se pudo crear", variant: "error" }),
      },
    );
  }

  const inputCls =
    "h-10 rounded-lg border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Planes de garantía extendida" className="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Meses extra de garantía con una prima fija y comisión para el vendedor.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Nombre"
            className={`${inputCls} col-span-2`}
          />
          <input value={months} onChange={(e) => setMonths(e.target.value)} type="number" min="0" placeholder="Meses" className={inputCls} />
          <input value={price} onChange={(e) => setPrice(e.target.value)} type="number" min="0" placeholder="Prima $" className={inputCls} />
          <input value={comm} onChange={(e) => setComm(e.target.value)} type="number" min="0" placeholder="Com %" className={inputCls} />
        </div>
        <div className="flex justify-end">
          <Button onClick={add} loading={create.isPending}>
            <Plus size={15} /> Agregar plan
          </Button>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {(plans ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin planes. Agregá el primero.
            </p>
          )}
          {(plans ?? []).map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className={p.is_active ? "" : "text-muted-foreground line-through"}>
                <span className="font-medium">{p.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {p.months} meses · {formatCurrency(Number(p.price))}
                  {Number(p.commission_pct) ? ` · com ${p.commission_pct}%` : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <Switch
                  checked={p.is_active}
                  onCheckedChange={(v) => setActive.mutate({ id: p.id, is_active: v })}
                  label="Activo"
                />
                <button
                  onClick={() => remove.mutate(p.id)}
                  title="Eliminar"
                  className="text-muted-foreground transition hover:text-destructive"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
