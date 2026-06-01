"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { usePaymentPlans, usePaymentPlanMutations } from "@/modules/pos/hooks";

// Planes de pago con recargo (H27): ej. "Visa 3 cuotas" +8%. El recargo se
// aplica al cobrar y entra como ítem "Recargo …" en la venta.
export function PaymentPlansModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: plans } = usePaymentPlans(false);
  const { create, setActive, remove } = usePaymentPlanMutations();
  const [label, setLabel] = useState("");
  const [pct, setPct] = useState("");

  function add() {
    if (label.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    create.mutate(
      { label: label.trim(), surcharge_pct: Number(pct) || 0 },
      {
        onSuccess: () => {
          setLabel("");
          setPct("");
        },
        onError: () => toast({ title: "No se pudo crear", variant: "error" }),
      },
    );
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Planes de pago y recargos" className="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Ej. “Visa 3 cuotas” +8%. Al cobrar, el cajero elige el plan y el recargo
          se suma al total como un ítem.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Nombre (ej. Visa 3 cuotas)"
            className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft"
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <span className="flex items-center gap-1">
            <input
              type="number"
              step="0.5"
              min="0"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              placeholder="0"
              className="h-10 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </span>
          <Button onClick={add} loading={create.isPending}>
            <Plus size={15} /> Agregar
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
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <span className={p.is_active ? "text-sm" : "text-sm text-muted-foreground line-through"}>
                {p.label}
                {Number(p.surcharge_pct) ? (
                  <span className="ml-1 text-xs text-ninja-flameSoft">+{p.surcharge_pct}%</span>
                ) : null}
              </span>
              <span className="flex items-center gap-3">
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
