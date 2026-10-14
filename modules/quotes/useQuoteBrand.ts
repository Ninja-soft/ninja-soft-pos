"use client";

// Marca y estilo del presupuesto: los mismos del comprobante (ADR-112) de la
// sucursal (color, logo, nombre de fantasía, sello y modelo de ticket).
import { useMemo } from "react";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { useInvoiceStyle } from "@/modules/invoices/hooks";
import type { QuoteBrand } from "@/lib/quotes/logic";

export function useQuoteBrand(enabled = true, storeId?: string | null) {
  const { data: ticketBrand } = useTicketBranding(enabled, storeId);
  const { style, brand } = useInvoiceStyle(ticketBrand ?? null, enabled);
  const quoteBrand = useMemo<QuoteBrand | null>(
    () =>
      brand
        ? {
            legal_name: brand.legal_name,
            trade_name: style.tradeName,
            cuit: brand.cuit,
            address: brand.address,
            phone: brand.phone,
            iva_condition: brand.iva_condition ?? null,
          }
        : null,
    [brand, style.tradeName],
  );
  return { style, brand: quoteBrand, ticketWidth: ticketBrand?.ticket_width === "58" ? ("58" as const) : ("80" as const) };
}
