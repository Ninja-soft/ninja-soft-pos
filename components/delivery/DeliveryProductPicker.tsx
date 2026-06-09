"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useProducts } from "@/modules/products/hooks";
import { useMostradorPricing } from "@/modules/prices/hooks";
import { resolvePrice } from "@/lib/prices/resolve";
import { useDeliveryMutations } from "@/modules/delivery/hooks";
import { formatCurrency } from "@/lib/utils/format";

// Picker para agregar ítems a un pedido de delivery / takeaway (H49). Espeja
// TableProductPicker (H44): busca productos del catálogo (precio resuelto contra
// la lista mostrador, igual que el POS) y agrega la línea con un tap. También
// permite un ítem libre (monto manual). Los ítems se mandan a cocina al toque
// (fired); el cobro definitivo se hace en el POS reusando create_sale.
export function DeliveryProductPicker({
  open,
  onOpenChange,
  orderId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orderId: string | null;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: products } = useProducts(search);
  const { data: pricing } = useMostradorPricing();
  const { addItem } = useDeliveryMutations();

  const [freeName, setFreeName] = useState("");
  const [freeAmount, setFreeAmount] = useState("");

  const list = useMemo(
    () => (products ?? []).filter((p) => p.is_active),
    [products],
  );

  function priceFor(productId: string, basePrice: number): number {
    if (!pricing) return basePrice;
    return resolvePrice(basePrice, productId, null, pricing.list, pricing.items);
  }

  async function add(productId: string, name: string, price: number) {
    if (!orderId) return;
    try {
      await addItem.mutateAsync({
        order_id: orderId,
        product_id: productId,
        name,
        qty: 1,
        unit_price: price,
      });
      toast({ title: `${name} agregado`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo agregar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function addFree() {
    const amount = Number(freeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ title: "Poné un monto válido", variant: "error" });
      return;
    }
    if (!orderId) return;
    try {
      await addItem.mutateAsync({
        order_id: orderId,
        product_id: null,
        name: freeName.trim() || "Ítem",
        qty: 1,
        unit_price: amount,
      });
      setFreeName("");
      setFreeAmount("");
      toast({ title: "Ítem agregado", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo agregar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Agregar al pedido">
      <div className="space-y-4">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar producto por nombre, SKU o código…"
            autoFocus
            className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          />
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              {search
                ? "Sin resultados para esa búsqueda."
                : "Escribí para buscar un producto del catálogo."}
            </p>
          ) : (
            list.map((p) => {
              const price = priceFor(p.id, p.price);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => add(p.id, p.name, price)}
                  disabled={addItem.isPending}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-ninja-flameSoft/40 hover:bg-muted disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {p.name}
                    </span>
                    {p.sku && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.sku}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="price-hl font-price text-sm font-bold tabular-nums">
                      {formatCurrency(price)}
                    </span>
                    <span className="grid h-7 w-7 place-items-center rounded-md bg-ninja-flame/15 text-ninja-flameSoft">
                      <Plus size={15} />
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Ítem libre (monto manual) */}
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
            Ítem libre (monto manual)
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              label="Concepto"
              value={freeName}
              onChange={(e) => setFreeName(e.target.value)}
              placeholder="Ej. Gaseosa 1.5L"
              className="min-w-[140px] flex-1"
            />
            <Input
              label="Monto"
              type="number"
              min="0"
              step="1"
              value={freeAmount}
              onChange={(e) => setFreeAmount(e.target.value)}
              placeholder="0"
              className="w-28"
            />
            <Button variant="secondary" onClick={addFree} loading={addItem.isPending}>
              <Plus size={15} /> Agregar
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Listo
          </Button>
        </div>
      </div>
    </Modal>
  );
}
