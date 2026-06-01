"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useWarrantyPlans, useWarrantyPlanMutations } from "@/modules/products/hooks";
import { formatCurrency } from "@/lib/utils/format";

// Gestión completa de planes de garantía extendida (H28). Reusado en
// Configuración → Garantías y en Productos → Garantías.
export function WarrantyPlansManager() {
  const { toast } = useToast();
  const { data: plans } = useWarrantyPlans(false);
  const { create, setActive, remove } = useWarrantyPlanMutations();
  const [label, setLabel] = useState("");
  const [months, setMonths] = useState("");
  const [price, setPrice] = useState("");
  const [pricePct, setPricePct] = useState("");
  const [comm, setComm] = useState("");
  const [desc, setDesc] = useState("");

  const inputCls =
    "h-10 rounded-lg border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft";

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
        price_pct: Number(pricePct) || 0,
        commission_pct: Number(comm) || 0,
        description: desc.trim() || null,
      },
      {
        onSuccess: () => {
          setLabel("");
          setMonths("");
          setPrice("");
          setPricePct("");
          setComm("");
          setDesc("");
          toast({ title: "Plan creado", variant: "success" });
        },
        onError: () => toast({ title: "No se pudo crear", variant: "error" }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted-foreground">
            Nombre del plan
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Garantía 12 meses" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-xs text-muted-foreground">
            Meses extra
            <input value={months} onChange={(e) => setMonths(e.target.value)} type="number" min="0" placeholder="12" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-xs text-muted-foreground">
            Prima fija ($)
            <input value={price} onChange={(e) => setPrice(e.target.value)} type="number" min="0" placeholder="0" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-xs text-muted-foreground">
            Prima % del precio
            <input value={pricePct} onChange={(e) => setPricePct(e.target.value)} type="number" min="0" placeholder="0" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-xs text-muted-foreground">
            Comisión vendedor (%)
            <input value={comm} onChange={(e) => setComm(e.target.value)} type="number" min="0" placeholder="0" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-xs text-muted-foreground">
            Descripción
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Cubre fallas de fábrica" className={`${inputCls} mt-1 w-full`} />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Usá prima fija <strong>o</strong> % del precio. Si cargás %, se calcula sobre
          el total al cobrar.
        </p>
        <div className="mt-2 flex justify-end">
          <Button onClick={add} loading={create.isPending}>
            <Plus size={15} /> Agregar plan
          </Button>
        </div>
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {(plans ?? []).length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Sin planes de garantía. Agregá el primero.
          </p>
        )}
        {(plans ?? []).map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className={p.is_active ? "min-w-0" : "min-w-0 text-muted-foreground line-through"}>
              <span className="font-medium">{p.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {p.months} meses ·{" "}
                {Number(p.price_pct) > 0
                  ? `${p.price_pct}% del precio`
                  : formatCurrency(Number(p.price))}
                {Number(p.commission_pct) ? ` · com ${p.commission_pct}%` : ""}
              </span>
              {p.description && (
                <span className="block truncate text-xs text-muted-foreground">{p.description}</span>
              )}
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
  );
}
