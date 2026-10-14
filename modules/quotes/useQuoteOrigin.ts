"use client";

// Cobro de un presupuesto en el POS (ADR-122): /pos?quote=<id> carga sus
// renglones en el carrito UNA vez (precio acordado; si difiere de la lista
// viaja como cambio de precio con motivo, ADR-056) y el cliente. La venta se
// cobra por el flujo normal (create_sale no cambia) y después quote_link_sale
// marca el presupuesto como convertido.
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import { productsApi } from "@/modules/products/api";
import { useCartStore, type CartLine } from "@/modules/pos/store";
import { quotesApi } from "@/modules/quotes/api";
import { QUOTES_KEY, useQuote } from "@/modules/quotes/hooks";
import {
  effectiveQuoteStatus,
  quoteConvertible,
  quoteErrorMessage,
  quoteItemsToCart,
  quoteNumberLabel,
} from "@/lib/quotes/logic";

type Customer = { id: string; name: string } | null;

export function useQuoteOrigin({ setCustomer }: { setCustomer: (c: Customer) => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const quoteId = params.get("quote");
  const { data: quote } = useQuote(quoteId);
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    const q = quote;
    if (!q || loadedRef.current === q.id) return;
    loadedRef.current = q.id;
    const eff = effectiveQuoteStatus(q.status, q.valid_until);
    if (!quoteConvertible(eff)) {
      toast({
        title: eff === "converted" ? "Este presupuesto ya se convirtió en venta" : "Este presupuesto no se puede cobrar",
        description: eff === "expired" ? "Está vencido: editalo para extender la validez." : undefined,
        variant: "error",
      });
      router.replace("/pos");
      return;
    }
    let cancelled = false;
    (async () => {
      let current: Awaited<ReturnType<typeof productsApi.getByIds>> = [];
      try {
        current = await productsApi.getByIds(q.items.map((i) => i.product_id ?? "").filter(Boolean));
      } catch {
        /* sin datos frescos: los renglones entran como monto libre */
      }
      if (cancelled) return;
      const map = new Map(
        current.map((p) => [p.id, { price: Number(p.price), unit: p.unit ?? "un", category_id: p.category_id ?? null, active: true }]),
      );
      const reason = `Presupuesto N° ${quoteNumberLabel(q.pto_vta, q.number)}`;
      const lines = quoteItemsToCart(q.items, map, reason, () => crypto.randomUUID()) as unknown as CartLine[];
      useCartStore.setState({ lines, discountTotal: Number(q.discount_total) || 0 });
      if (q.customer_id && q.customer_name) setCustomer({ id: q.customer_id, name: q.customer_name });
    })();
    return () => {
      cancelled = true;
    };
    // setCustomer es estable; router y toast también.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);

  const active = Boolean(quote && quoteId && quoteConvertible(effectiveQuoteStatus(quote.status, quote.valid_until)));

  function exit() {
    loadedRef.current = null;
    useCartStore.getState().clear();
    setCustomer(null);
    router.replace("/pos");
  }

  /** Después de cobrar: el presupuesto queda convertido con esta venta. */
  function afterSale(saleId: string | null) {
    if (!quoteId) return;
    const id = quoteId;
    loadedRef.current = null;
    router.replace("/pos");
    if (!saleId) {
      toast({ title: "Venta sin conexión: marcá el presupuesto como convertido cuando se sincronice", variant: "info" });
      return;
    }
    void quotesApi
      .linkSale(id, saleId)
      .then(() => qc.invalidateQueries({ queryKey: QUOTES_KEY }))
      .catch((e) =>
        toast({ title: "La venta se cobró, pero el presupuesto no quedó convertido", description: quoteErrorMessage(e), variant: "error" }),
      );
  }

  return {
    quoteId,
    quote: quote ?? null,
    active,
    label: quote ? quoteNumberLabel(quote.pto_vta, quote.number) : "",
    exit,
    afterSale,
  };
}
