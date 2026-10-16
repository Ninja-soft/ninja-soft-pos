"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { CustomerAddress, GeoAddress, GeoSuggestion } from "@/lib/geo/address";

// Direcciones (ADR-157): Edge `geo` (Photon, Georef y Nominatim con caché y
// cupo) y las direcciones del cliente (customer_addresses, escrituras por
// RPC). Las RPC nuevas no están en types/database.ts: cliente suelto.
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Loose {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await loose().rpc<T>(fn, args);
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

type GeoFail = { ok: false; error: string };

/** Edge geo: devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T | GeoFail> {
  const { data, error } = await createClient().functions.invoke("geo", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    try {
      const detail = ctx ? ((await ctx.json()) as Record<string, unknown>) : null;
      if (detail && typeof detail === "object") return detail as T | GeoFail;
    } catch {
      // Sin cuerpo: error de red.
    }
    return { ok: false, error: "provider_error" };
  }
  return data as T;
}

export const geoApi = {
  suggest: (q: string, near?: { lat: number; lng: number } | null) =>
    edge<{ ok: true; suggestions: GeoSuggestion[]; disabled?: boolean }>({ action: "suggest", q, near: near ?? null }),
  normalize: (address: GeoAddress) =>
    edge<{ ok: true; address: GeoAddress; normalized: boolean }>({ action: "normalize", address }),
  reverse: (lat: number, lng: number) =>
    edge<{ ok: true; address: GeoAddress | null }>({ action: "reverse", lat, lng }),
};

const ADDRESS_COLS =
  "id, customer_id, label, street, number, floor, apartment, locality, partido, province, province_code, postal_code, " +
  "between_streets, reference, lat, lng, geo_source, geo_quality, normalized, contact_name, contact_phone, delivery_notes, " +
  "is_default, created_at";

export const customerAddressesApi = {
  list: async (customerId: string): Promise<CustomerAddress[]> => {
    const { data, error } = await createClient()
      .from("customer_addresses" as never)
      .select(ADDRESS_COLS)
      .eq("customer_id", customerId)
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as CustomerAddress[];
  },
  save: (customerId: string, id: string | null, data: Partial<GeoAddress> & { is_default?: boolean }) =>
    rpc<CustomerAddress>("customer_address_save", { p_customer_id: customerId, p_id: id, p_data: data }),
  remove: (id: string) => rpc<void>("customer_address_delete", { p_id: id }),
};

export function useCustomerAddresses(customerId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["customer-addresses", customerId],
    queryFn: () => customerAddressesApi.list(customerId!),
    enabled: Boolean(customerId) && enabled,
    staleTime: 30_000,
  });
}

export function useCustomerAddressMutations(customerId: string | null | undefined) {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["customer-addresses", customerId] });
  return {
    save: useMutation({
      mutationFn: (v: { id: string | null; data: Partial<GeoAddress> & { is_default?: boolean } }) =>
        customerAddressesApi.save(customerId!, v.id, v.data),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => customerAddressesApi.remove(id),
      onSuccess: inv,
    }),
  };
}
