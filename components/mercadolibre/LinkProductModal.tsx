"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { selectCls } from "@/components/stock/transfers/shared";
import { useProducts, useVariants } from "@/modules/products/hooks";
import { useMlMutations, type MlItem } from "@/modules/mercadolibre/hooks";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";

// Vincular una publicación (o una variación clásica) con un producto o
// variante del POS (ADR-104). Desde ahí, stock y precio se sincronizan solos
// y las ventas descuentan ese producto. Los combos no se vinculan.
export function LinkProductModal({ item, onClose }: { item: MlItem | null; onClose: () => void }) {
  const { toast } = useToast();
  const { link } = useMlMutations();
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string>("");
  const [variationId, setVariationId] = useState("");
  const { data: products = [], isFetching } = useProducts(search);
  const selected = products.find((p) => p.id === productId) ?? null;
  const { data: variants = [] } = useVariants(productId, Boolean(selected?.has_variants));

  const close = () => {
    setSearch("");
    setProductId(null);
    setVariantId("");
    setVariationId("");
    onClose();
  };

  const needsVariation = Boolean(item?.has_variations);
  const needsVariant = Boolean(selected?.has_variants);
  const valid =
    Boolean(item && productId) &&
    (!needsVariant || Boolean(variantId)) &&
    (!needsVariation || /^\d{3,22}$/.test(variationId.trim()));

  const submit = () => {
    if (!item || !productId || !valid) return;
    link.mutate(
      {
        itemId: item.id,
        variationId: needsVariation ? variationId.trim() : null,
        productId,
        variantId: needsVariant ? variantId : null,
      },
      {
        onSuccess: () => {
          toast({ title: "Publicación vinculada", description: "El stock y el precio se envían en unos segundos.", variant: "success" });
          close();
        },
        onError: (e) => toast({ title: "No se pudo vincular", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open={item !== null}
      onOpenChange={(o) => !o && close()}
      title="Vincular con un producto"
      description={item ? `${item.ml_item_id} · ${item.title}` : undefined}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid} loading={link.isPending}>
            Vincular
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Buscá por nombre, SKU o código de barras"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar producto"
          />
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {products.slice(0, 30).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setProductId(p.id);
                setVariantId("");
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                p.id === productId ? "bg-ninja-flame/10" : "hover:bg-secondary/60",
              )}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.sku ?? p.barcode ?? ""}</span>
            </button>
          ))}
          {!isFetching && products.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">No hay productos con esa búsqueda.</p>
          )}
        </div>
        {needsVariant && (
          <select className={selectCls} value={variantId} onChange={(e) => setVariantId(e.target.value)} aria-label="Variante">
            <option value="">Elegí la variante</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.option1}
                {v.option2 ? ` / ${v.option2}` : ""}
                {v.sku ? ` (${v.sku})` : ""}
              </option>
            ))}
          </select>
        )}
        {needsVariation && (
          <Input
            label="Id de la variación en Mercado Libre"
            inputMode="numeric"
            hint="La publicación es clásica con variaciones: cada variación se vincula aparte (Importar publicaciones las sugiere por SKU)."
            value={variationId}
            onChange={(e) => setVariationId(e.target.value)}
          />
        )}
      </div>
    </Modal>
  );
}
