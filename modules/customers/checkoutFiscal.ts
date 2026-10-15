"use client";

// Datos fiscales del cliente de la venta en la hoja de cobro (ADR-133 y
// ADR-146): condición frente al IVA, documento, verificación en ARCA y
// domicilio (para precargar el envío). Una sola consulta compartida por la
// letra del comprobante y los bloques Cliente y Entrega.

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { FiscalVerification } from "@/lib/customers/padron";

export type CheckoutCustomerFiscal = {
  id: string;
  name?: string | null;
  iva_condition: string | null;
  document_type: string | null;
  document_number: string | null;
  address?: string | null;
  fiscal_verification?: FiscalVerification;
  fiscal_verified_at?: string | null;
};

type LooseFrom = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }> };
    };
  };
};

export async function fetchCheckoutCustomerFiscal(id: string): Promise<CheckoutCustomerFiscal | null> {
  const sb = createClient() as unknown as LooseFrom;
  const full = await sb
    .from("customers")
    .select("id, name, iva_condition, document_type, document_number, address, fiscal_verification, fiscal_verified_at")
    .eq("id", id)
    .maybeSingle();
  if (!full.error) return (full.data as CheckoutCustomerFiscal | null) ?? null;
  // Sin la migración de ADR-133 las columnas nuevas no existen.
  const basic = await sb
    .from("customers")
    .select("id, name, iva_condition, document_type, document_number")
    .eq("id", id)
    .maybeSingle();
  return (basic.data as CheckoutCustomerFiscal | null) ?? null;
}

export function useCheckoutCustomerFiscal(customerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["checkout-customer-fiscal", customerId],
    queryFn: () => fetchCheckoutCustomerFiscal(customerId!),
    enabled: enabled && Boolean(customerId),
    staleTime: 30_000,
  });
}
