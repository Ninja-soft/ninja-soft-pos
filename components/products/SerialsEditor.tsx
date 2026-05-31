"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  useProductSerials,
  useSerialMutations,
} from "@/modules/products/hooks";

// Carga de N° de serie (IMEI/S/N) de un producto serializado. Los disponibles
// se eligen al vender; los vendidos quedan como histórico.
export function SerialsEditor({ productId }: { productId: string }) {
  const { toast } = useToast();
  const { data: serials } = useProductSerials(productId, true);
  const { add, remove } = useSerialMutations(productId);
  const [text, setText] = useState("");

  const inStock = (serials ?? []).filter((s) => s.status === "in_stock");
  const sold = (serials ?? []).filter((s) => s.status === "sold");

  function addSerials() {
    const list = text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) {
      toast({ title: "Ingresá al menos un serial", variant: "error" });
      return;
    }
    add.mutate(list, {
      onSuccess: () => {
        setText("");
        toast({ title: "Seriales cargados", variant: "success" });
      },
      onError: () => toast({ title: "No se pudo cargar", variant: "error" }),
    });
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 text-sm font-medium text-foreground">
        Números de serie (IMEI / S/N)
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Cargá los seriales disponibles (uno por línea o separados por coma). El
        stock disponible es la cantidad de seriales sin vender. Al cobrar, el
        cajero elige cuál sale.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {inStock.length === 0 && (
          <span className="text-xs text-muted-foreground">Sin seriales disponibles.</span>
        )}
        {inStock.map((s) => (
          <span
            key={s.id}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {s.serial}
            <button
              type="button"
              onClick={() => remove.mutate(s.id)}
              className="text-muted-foreground hover:text-destructive"
              title="Quitar"
            >
              <Trash2 size={12} />
            </button>
          </span>
        ))}
      </div>

      {sold.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          Vendidos: {sold.map((s) => s.serial).join(", ")}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="IMEI-001&#10;IMEI-002"
          className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
        />
        <Button type="button" variant="secondary" size="sm" onClick={addSerials} loading={add.isPending}>
          <Plus size={15} /> Cargar
        </Button>
      </div>
    </div>
  );
}
