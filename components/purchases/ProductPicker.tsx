"use client";

// Buscador de productos para Compras: nombre, SKU o código, lector de códigos y
// elección de variante. Los kits no se compran (se compran sus componentes).

import { useMemo, useState } from "react";
import { Plus, ScanLine, Search } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { useScanner } from "@/modules/pos/useScanner";
import {
  productsApi,
  variantsApi,
  variantLabel,
  type Product,
  type ProductVariant,
} from "@/modules/products/api";
import { useProducts } from "@/modules/products/hooks";
import { purchaseErrorMessage } from "@/lib/purchases/orders";

export function ProductPicker({
  onPick,
  enabled = true,
  placeholder = "Buscá por nombre, SKU o código",
  autoFocus = true,
}: {
  onPick: (p: Product, v: ProductVariant | null) => void;
  enabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [pickVariantsOf, setPickVariantsOf] = useState<{
    product: Product;
    variants: ProductVariant[];
  } | null>(null);

  const { data: found = [], isFetching } = useProducts(enabled ? search : "");
  const results = useMemo(
    () => (search.trim().length >= 2 ? found.filter((p) => !p.is_kit).slice(0, 8) : []),
    [found, search],
  );

  async function pick(p: Product) {
    if (p.has_variants) {
      const variants = await variantsApi.list(p.id);
      setPickVariantsOf({ product: p, variants });
      return;
    }
    onPick(p, null);
    setSearch("");
  }

  useScanner(
    async (code) => {
      try {
        const r = await productsApi.findByCode(code);
        if (!r) {
          toast({ title: `No encontramos el código ${code}`, variant: "error" });
          return;
        }
        if (r.product.is_kit) {
          toast({ title: `${r.product.name} es un kit: comprá sus componentes`, variant: "error" });
          return;
        }
        if (r.product.has_variants && !r.variant) {
          await pick(r.product);
          return;
        }
        onPick(r.product, r.variant ?? null);
      } catch (e) {
        toast({ title: "No se pudo leer el código", description: purchaseErrorMessage(e), variant: "error" });
      }
    },
    { enabled },
  );

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          autoFocus={autoFocus}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
          aria-label="Buscar producto"
          className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-10 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
        />
        <ScanLine
          size={16}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-label="Lector de códigos activo"
        />
      </div>
      {pickVariantsOf && (
        <div className="rounded-xl bg-muted p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">{pickVariantsOf.product.name}: elegí la variante</span>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setPickVariantsOf(null)}
            >
              Cerrar
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {pickVariantsOf.variants.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  onPick(pickVariantsOf.product, v);
                  setSearch("");
                }}
                className="rounded-full bg-background px-3 py-1 text-xs ring-1 ring-border transition hover:ring-ninja-flameSoft"
              >
                {variantLabel(v)}
              </button>
            ))}
          </div>
        </div>
      )}
      {results.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-border">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => void pick(p)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.sku ?? p.barcode ?? ""}
                    {p.has_variants ? " · con variantes" : ""}
                  </span>
                </span>
                <Plus size={16} className="shrink-0 text-ninja-flameSoft" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {search.trim().length >= 2 && !isFetching && results.length === 0 && (
        <p className="text-xs text-muted-foreground">Sin resultados (los kits no se compran).</p>
      )}
    </div>
  );
}
