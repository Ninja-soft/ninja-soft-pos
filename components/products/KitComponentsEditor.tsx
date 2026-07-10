"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  useProducts,
  useKitComponents,
  useSaveKitComponents,
} from "@/modules/products/hooks";

interface Row {
  componentProductId: string;
  name: string;
  quantity: number;
}

// Editor de componentes de un kit/combo. Al vender el kit se descuenta el stock
// de estos componentes según su cantidad (lo resuelve create_sale).
export function KitComponentsEditor({ kitId }: { kitId: string }) {
  const { toast } = useToast();
  const { data: products } = useProducts("");
  const { data: existing } = useKitComponents(kitId, true);
  const save = useSaveKitComponents(kitId);
  const [rows, setRows] = useState<Row[]>([]);
  const [pick, setPick] = useState("");
  const [qty, setQty] = useState("1");

  useEffect(() => {
    if (existing) {
      setRows(
        existing.map((c) => ({
          componentProductId: c.componentProductId,
          name: c.name,
          quantity: c.quantity,
        })),
      );
    }
  }, [existing]);

  function add() {
    const prod = products?.find((p) => p.id === pick);
    const q = Number(qty);
    if (!prod) {
      toast({ title: "Elegí un producto", variant: "error" });
      return;
    }
    if (prod.id === kitId) {
      toast({ title: "Un kit no puede contenerse a sí mismo", variant: "error" });
      return;
    }
    if (rows.some((r) => r.componentProductId === prod.id)) {
      toast({ title: "Ese componente ya está", variant: "error" });
      return;
    }
    if (!Number.isFinite(q) || q <= 0) {
      toast({ title: "Cantidad inválida", variant: "error" });
      return;
    }
    setRows([...rows, { componentProductId: prod.id, name: prod.name, quantity: q }]);
    setPick("");
    setQty("1");
  }

  function persist() {
    save.mutate(
      rows.map((r) => ({
        componentProductId: r.componentProductId,
        quantity: r.quantity,
      })),
      {
        onSuccess: () => toast({ title: "Componentes guardados", variant: "success" }),
        onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
      },
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 text-sm font-medium text-foreground">
        Componentes del combo
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        El combo no tiene stock propio. Al venderlo se descuenta el stock de estos
        productos según la cantidad.
      </p>

      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">Sin componentes aún.</p>
        )}
        {rows.map((r) => (
          <div
            key={r.componentProductId}
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
          >
            <span className="truncate text-sm">{r.name}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">x{r.quantity}</span>
              <button
                type="button"
                onClick={() =>
                  setRows(rows.filter((x) => x.componentProductId !== r.componentProductId))
                }
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
        >
          <option value="">Elegir producto…</option>
          {products
            ?.filter((p) => p.id !== kitId && !p.is_kit)
            .map((p) => (
              <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                {p.name}
              </option>
            ))}
        </select>
        <input
          type="number"
          step="0.001"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="h-9 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
        />
        <Button type="button" variant="secondary" size="sm" onClick={add}>
          <Plus size={15} />
        </Button>
      </div>

      <div className="mt-3 flex justify-end">
        <Button type="button" size="sm" onClick={persist} loading={save.isPending}>
          Guardar componentes
        </Button>
      </div>
    </div>
  );
}
