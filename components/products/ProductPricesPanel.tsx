"use client";

import { useState } from "react";
import { CalendarClock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { LIST_KINDS } from "@/modules/prices/proApi";
import { usePriceProMutations, useProductPricesOverview } from "@/modules/prices/proHooks";
import { Field, fieldCls, formatWhen, friendlyPriceError, fromLocalInput, numOrNull } from "@/components/prices/shared";

// Ficha del producto (ADR-058): precio de hoy en cada lista (contado, por
// unidad) y los precios programados que vienen, con alta y baja.
export function ProductPricesPanel({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { data } = useProductPricesOverview(productId);
  const m = usePriceProMutations();
  const [listId, setListId] = useState("");
  const [price, setPrice] = useState("");
  const [when, setWhen] = useState("");

  if (!data) return null;

  function schedule() {
    const p = numOrNull(price);
    const at = fromLocalInput(when);
    if (p == null || p < 0 || !at) {
      toast({ title: "Cargá precio y fecha", variant: "error" });
      return;
    }
    m.scheduleSet.mutate(
      { list_id: listId || null, product_id: productId, price: p, effective_at: at },
      {
        onSuccess: () => {
          toast({ title: "Precio programado", variant: "success" });
          setPrice("");
          setWhen("");
        },
        onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
      },
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Precio por lista</h3>
        <p className="text-xs text-muted-foreground">Hoy, de contado y por unidad.</p>
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        <div className="flex items-center justify-between px-3 py-2 text-sm">
          <span>Precio de venta</span>
          <span className="font-medium tabular-nums">{formatCurrency(data.base)}</span>
        </div>
        {data.lists.map((l) => (
          <div key={l.list_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{l.name}</span>
              {l.kind !== "fixed" && <Badge tone="info">{LIST_KINDS.find((k) => k.value === l.kind)?.label}</Badge>}
              {l.item_price != null && <Badge>Precio fijo</Badge>}
              {!l.is_active && <Badge>Inactiva</Badge>}
              {l.is_active && !l.valid && <Badge>Fuera de vigencia</Badge>}
            </span>
            <span className="shrink-0 font-medium tabular-nums">{l.price == null ? "" : formatCurrency(l.price)}</span>
          </div>
        ))}
      </div>

      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarClock size={15} /> Próximos precios
        </h3>
        {data.upcoming.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Nada programado.</p>
        ) : (
          <div className="mt-2 divide-y divide-border rounded-md border border-border">
            {data.upcoming.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {s.list_name ?? "Precio de venta"}
                  <span className="text-muted-foreground"> · {formatWhen(s.effective_at)}</span>
                  {s.status === "pending" && <span className="text-muted-foreground"> · para aprobar</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-medium tabular-nums">{formatCurrency(s.price)}</span>
                  {canEdit && !s.batch_id && (
                    <button
                      type="button"
                      aria-label="Cancelar"
                      onClick={() => m.scheduleCancel.mutate(s.id)}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-[1.2fr_0.8fr_1.2fr_auto] sm:items-end">
          <Field label="Programar en">
            <select className={fieldCls} value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Precio de venta</option>
              {data.lists.map((l) => (
                <option key={l.list_id} value={l.list_id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Precio">
            <input className={fieldCls} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Desde">
            <input type="datetime-local" className={fieldCls} value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Button variant="secondary" onClick={schedule} loading={m.scheduleSet.isPending}>
            Programar
          </Button>
        </div>
      )}
    </section>
  );
}
