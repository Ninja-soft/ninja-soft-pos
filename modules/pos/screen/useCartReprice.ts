"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useProductsByIds } from "@/modules/products/hooks";
import { cartRepriceChanges, modifiersDelta } from "@/lib/prices/cartReprice";
import { fromCents, toCents } from "@/lib/prices/rounding";
import type { PriceForArgs } from "@/modules/prices/proHooks";
import type { PriceResolution } from "@/lib/prices/resolve";
import { useCartStore } from "@/modules/pos/store";

// Repreciado del carrito al cambiar lista, condición, cliente o cantidad
// (escalas) (F18 · H100, ADR-058). Sólo con la foto de precios cargada (base
// con la migración); con la lista mostrador vieja el carrito queda como antes.
// En mesa o delivery no se toca: vale el precio guardado en el pedido.
export function useCartReprice({
  enabled,
  resolve,
}: {
  enabled: boolean;
  resolve: (a: PriceForArgs) => PriceResolution;
}) {
  const lines = useCartStore((s) => s.lines);
  const applyServerPrices = useCartStore((s) => s.applyServerPrices);

  const productIds = useMemo(
    () => (enabled ? lines.filter((l) => l.productId).map((l) => l.productId!) : []),
    [enabled, lines],
  );
  const variantIds = useMemo(
    () => [...new Set(enabled ? lines.filter((l) => l.variantId).map((l) => l.variantId!) : [])].sort(),
    [enabled, lines],
  );
  const { data: products } = useProductsByIds(productIds);
  const { data: variants } = useQuery({
    queryKey: ["products", "variant-prices", variantIds],
    queryFn: async () => {
      const { data, error } = await (createClient() as unknown as {
        from: (t: string) => {
          select: (c: string) => { in: (c: string, v: string[]) => Promise<{ data: unknown; error: unknown }> };
        };
      })
        .from("product_variants")
        .select("id, price_override")
        .in("id", variantIds);
      if (error) throw error;
      return (data ?? []) as { id: string; price_override: number | null }[];
    },
    enabled: variantIds.length > 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!enabled || !products) return;
    if (variantIds.length > 0 && !variants) return;
    const byId = new Map(products.map((p) => [p.id, p]));
    const vById = new Map((variants ?? []).map((v) => [v.id, v]));
    const changes = cartRepriceChanges(lines, (l) => {
      const p = byId.get(l.productId!);
      if (!p) return null;
      const v = l.variantId ? vById.get(l.variantId) : undefined;
      if (l.variantId && !v) return null;
      return resolve({
        productId: p.id,
        variantId: l.variantId ?? null,
        basePrice: Number(p.price),
        variantPrice: v?.price_override == null ? null : Number(v.price_override),
        qty: l.quantity,
      }).price;
    });
    if (changes.length > 0) applyServerPrices(changes.map((c) => ({ lineId: c.lineId, to: c.to })));
  }, [enabled, lines, products, variants, variantIds.length, resolve, applyServerPrices]);

  // Total del carrito con otra condición de pago (para "precio por plazo").
  const totalWithTerm = useCallback(
    (termId: string): number | null => {
      if (!enabled || !products) return null;
      const byId = new Map(products.map((p) => [p.id, p]));
      const vById = new Map((variants ?? []).map((v) => [v.id, v]));
      let cents = 0;
      for (const l of lines) {
        let unit = l.unitPrice;
        const fixed = !l.productId || l.priceOverride || l.giftPromoId || l.packCreditId || l.packId;
        if (!fixed) {
          const p = byId.get(l.productId!);
          const v = l.variantId ? vById.get(l.variantId) : undefined;
          if (!p || (l.variantId && !v)) return null;
          unit =
            resolve({
              productId: p.id,
              variantId: l.variantId ?? null,
              basePrice: Number(p.price),
              variantPrice: v?.price_override == null ? null : Number(v.price_override),
              qty: l.quantity,
              termId,
            }).price + modifiersDelta(l.modifiers);
        }
        if (l.packCreditId) continue;
        cents += toCents(unit * l.quantity) - toCents(l.discount ?? 0);
      }
      return fromCents(cents);
    },
    [enabled, lines, products, variants, resolve],
  );

  return { totalWithTerm };
}
