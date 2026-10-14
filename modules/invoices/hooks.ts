"use client";

// Personalización de comprobantes del negocio (ADR-112). Lee
// tenant_branding.invoice_style, iibb y activity_start en una consulta APARTE
// de la del ticket: si la migración todavía no se aplicó (columnas
// inexistentes), devuelve null y el comprobante usa los defaults, sin romper
// el ticket de siempre.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useFeature } from "@/modules/saas/gating";
import { resolveInvoiceStyle, type InvoiceEntitlements, type ResolvedInvoiceStyle } from "@/lib/invoices/style";
import type { SampleBrand } from "@/lib/tickets/sample";

export const INVOICE_SETTINGS_KEY = ["invoice-settings"];

export interface InvoiceSettingsRow {
  tenant_id: string;
  invoice_style: unknown;
  iibb: string | null;
  activity_start: string | null;
}

interface Loose {
  from: (t: string) => {
    select: (c: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  };
}

export function useInvoiceSettings(enabled = true) {
  return useQuery({
    queryKey: INVOICE_SETTINGS_KEY,
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<InvoiceSettingsRow | null> => {
      const sb = createClient() as unknown as Loose;
      const { data, error } = await sb.from("tenant_branding").select("tenant_id, invoice_style, iibb, activity_start").maybeSingle();
      if (error) return null;
      return (data as InvoiceSettingsRow | null) ?? null;
    },
  });
}

/** Qué incluye el plan (optimista mientras carga: no degrada lo guardado). */
export function useInvoiceEntitlements(): InvoiceEntitlements {
  const pro = useFeature("tickets_pro");
  const unbranded = useFeature("comprobantes_sin_sello");
  return { pro: pro !== false, unbranded: unbranded !== false };
}

/**
 * Estilo resuelto contra la marca efectiva (la de la sucursal de la venta) y el
 * plan, y la marca con los datos fiscales del emisor (IIBB, inicio de
 * actividades) agregados para el comprobante.
 */
export function useInvoiceStyle(brand: SampleBrand | null | undefined, enabled = true) {
  const { data: settings } = useInvoiceSettings(enabled);
  const { pro, unbranded } = useInvoiceEntitlements();
  return useMemo(() => {
    const style: ResolvedInvoiceStyle = resolveInvoiceStyle(settings?.invoice_style ?? {}, brand ?? null, { pro, unbranded });
    const invoiceBrand: SampleBrand | null = brand
      ? { ...brand, iibb: settings?.iibb ?? null, activity_start: settings?.activity_start ?? null }
      : null;
    return { style, brand: invoiceBrand };
  }, [settings, brand, pro, unbranded]);
}
