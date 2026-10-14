"use client";

// Marca y estilo del presupuesto: los mismos del comprobante (ADR-112) de la
// sucursal (color, logo, nombre de fantasía, sello y modelo de ticket). Los
// datos de contacto del negocio en el presupuesto (ADR-123) salen de
// Configuración → Presupuestos; vacíos, el teléfono de la marca.
import { useMemo } from "react";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { useInvoiceStyle } from "@/modules/invoices/hooks";
import { useQuoteSettings } from "@/modules/quotes/hooks";
import type { QuoteBrand } from "@/lib/quotes/logic";

export function useQuoteBrand(enabled = true, storeId?: string | null) {
  const { data: ticketBrand } = useTicketBranding(enabled, storeId);
  const { style, brand } = useInvoiceStyle(ticketBrand ?? null, enabled);
  const { data: settings } = useQuoteSettings(enabled);
  const quoteBrand = useMemo<QuoteBrand | null>(
    () =>
      brand
        ? {
            legal_name: brand.legal_name,
            trade_name: style.tradeName,
            cuit: brand.cuit,
            address: brand.address,
            phone: settings?.contact_phone?.trim() || brand.phone,
            email: settings?.contact_email?.trim() || null,
            iva_condition: brand.iva_condition ?? null,
          }
        : null,
    [brand, style.tradeName, settings?.contact_phone, settings?.contact_email],
  );
  return {
    style,
    brand: quoteBrand,
    /** Teléfono de la marca (lo que sale si el presupuesto no tiene uno propio). */
    brandPhone: brand?.phone ?? null,
    ticketWidth: ticketBrand?.ticket_width === "58" ? ("58" as const) : ("80" as const),
  };
}
