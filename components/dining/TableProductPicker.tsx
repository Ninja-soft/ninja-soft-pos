"use client";

import { useMemo, useState } from "react";
import { Clock, Flame, Plus, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useProducts } from "@/modules/products/hooks";
import { useMostradorPricing } from "@/modules/prices/hooks";
import { resolvePrice } from "@/lib/prices/resolve";
import { useTableOrderMutations } from "@/modules/dining/hooks";
import { COURSE_LABELS, MAX_COURSE } from "@/modules/dining/api";
import { formatCurrency } from "@/lib/utils/format";

// Picker para agregar ítems al pedido de una mesa (H44). Busca productos del
// catálogo (precio resuelto contra la lista mostrador, igual que el POS) y agrega
// la línea al pedido con un tap. También permite un ítem libre (monto manual).
//
// Modificadores/variantes en la mesa: follow-up (H47). Acá se agrega al precio de
// lista; el cobro definitivo se hace en el POS reusando create_sale.
export function TableProductPicker({
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
  const { addItem } = useTableOrderMutations();

  // Ítem libre (monto manual) para algo fuera del catálogo.
  const [freeName, setFreeName] = useState("");
  const [freeAmount, setFreeAmount] = useState("");

  // Cursos / despacho por tiempos (F13 · H47): tiempo al que entran los ítems que
  // se agreguen, y si van "en espera" (hold) o se disparan a cocina al toque.
  // Default: Tiempo 1, sin hold (= comportamiento actual; no rompe el flujo rápido).
  const [course, setCourse] = useState(1);
  const [hold, setHold] = useState(false);

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
        course,
        hold,
      });
      toast({
        title: `${name} agregado`,
        description: hold
          ? `En espera · Tiempo ${course}`
          : `Tiempo ${course} · a cocina`,
        variant: "success",
      });
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
        course,
        hold,
      });
      setFreeName("");
      setFreeAmount("");
      toast({
        title: "Ítem agregado",
        description: hold
          ? `En espera · Tiempo ${course}`
          : `Tiempo ${course} · a cocina`,
        variant: "success",
      });
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

        {/* Tiempo (course) y despacho: a qué tiempo entran los ítems y si van
            "en espera" o se mandan a cocina al toque (F13 · H47). */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-2.5 py-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Tiempo
            <select
              value={course}
              onChange={(e) => setCourse(Number(e.target.value))}
              aria-label="Tiempo (course) de los ítems a agregar"
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
            >
              {Array.from({ length: MAX_COURSE }, (_, i) => i + 1).map((c) => (
                <option key={c} value={c}>
                  {c} · {COURSE_LABELS[c] ?? `Tiempo ${c}`}
                </option>
              ))}
            </select>
          </label>

          {/* Toggle hold: enviar al toque vs dejar en espera. */}
          <div className="ml-auto inline-flex rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setHold(false)}
              className={
                !hold
                  ? "flex items-center gap-1 rounded-md bg-ninja-flame/15 px-2.5 py-1 text-xs font-medium text-ninja-flameSoft"
                  : "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
              }
            >
              <Flame size={13} /> A cocina
            </button>
            <button
              type="button"
              onClick={() => setHold(true)}
              className={
                hold
                  ? "flex items-center gap-1 rounded-md bg-amber-400/15 px-2.5 py-1 text-xs font-medium text-amber-300"
                  : "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
              }
            >
              <Clock size={13} /> En espera
            </button>
          </div>
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
              placeholder="Ej. Cubierto"
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
