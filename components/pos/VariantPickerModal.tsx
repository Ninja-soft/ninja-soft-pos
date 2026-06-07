"use client";

import { Modal } from "@/components/ui/Modal";
import { useVariants } from "@/modules/products/hooks";
import { variantLabel, variantPrice } from "@/modules/products/api";
import { formatCurrency, formatQty } from "@/lib/utils/format";

export interface VariantPickerProduct {
  id: string;
  name: string;
  sku: string | null;
  price: number;
}

// Picker de variante al agregar un producto con has_variants (mismo patrón que
// el picker de serial). Lista las variantes activas con precio y stock; al
// tocar una, agrega esa variante al carrito y cierra. El stock es informativo:
// el server (create_sale) es el que valida según track_stock/allow_negative.
export function VariantPickerModal({
  product,
  onClose,
  onPick,
}: {
  product: VariantPickerProduct | null;
  onClose: () => void;
  onPick: (args: {
    variantId: string;
    variantLabel: string;
    price: number;
  }) => void;
}) {
  const { data: variants } = useVariants(product?.id ?? null, product !== null);

  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && onClose()}
      title={product ? `Variante — ${product.name}` : "Variante"}
    >
      <div className="space-y-3">
        {(variants ?? []).length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Este producto no tiene variantes cargadas. Definilas en la ficha del
            producto.
          </p>
        )}
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {(variants ?? []).map((v) => {
            const price = variantPrice(v, product?.price ?? 0);
            const out = v.stock <= 0;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() =>
                  product &&
                  onPick({
                    variantId: v.id,
                    variantLabel: variantLabel(v),
                    price,
                  })
                }
                className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition hover:border-ninja-flameSoft/40 hover:bg-muted"
              >
                <span className="truncate text-sm font-medium text-foreground">
                  {variantLabel(v)}
                </span>
                <span className="text-sm font-semibold text-foreground">
                  {formatCurrency(price)}
                </span>
                <span
                  className={
                    out
                      ? "inline-flex w-fit rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-300"
                      : "inline-flex w-fit rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {formatQty(v.stock)} en stock
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
