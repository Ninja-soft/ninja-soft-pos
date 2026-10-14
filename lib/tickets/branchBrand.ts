// Marca del ticket por sucursal (F17 · ADR-049). Lógica pura.
//
// Orden: datos del negocio (tenant_branding) ← overrides del dominio "ticket"
// (grupo y sucursal: razón social, CUIT, teléfono, dirección, título,
// leyenda, pie) ← datos propios de la sucursal:
//   * use_store_contact: dirección y teléfono salen de la ficha de la
//     sucursal (Sucursales y cajas), no se tipean dos veces.
//   * logo de la sucursal (opcional): si no tiene, hereda el del negocio.

import { resolveEffective, type ConfigOverride, type ResolveTarget } from "@/lib/config/inheritance";
import type { SampleBrand } from "./sample";

export interface StoreContact {
  address?: string | null;
  city?: string | null;
  province?: string | null;
  phone?: string | null;
  logo_url?: string | null;
}

export function storeAddressLine(s: StoreContact): string | null {
  const parts = [s.address, s.city, s.province].map((x) => (x ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// ADR-124: trade_name (nombre de fantasía) también se pisa por grupo o sucursal.
const TICKET_FIELDS = ["trade_name", "legal_name", "cuit", "phone", "address", "ticket_title", "ticket_legend", "ticket_footer"] as const;

export function effectiveTicketBrand(
  brand: SampleBrand | null,
  overrides: ConfigOverride[],
  target: ResolveTarget,
  store: StoreContact | null,
): SampleBrand | null {
  if (!brand && !store) return brand;
  const base: Record<string, unknown> = { use_store_contact: false };
  for (const k of TICKET_FIELDS) base[k] = brand?.[k] ?? null;
  const eff = resolveEffective("ticket", "", base, overrides, target).value;
  const out: SampleBrand = {
    ...(brand ?? {
      trade_name: null,
      logo_url: null,
      legal_name: null,
      cuit: null,
      phone: null,
      address: null,
      ticket_footer: null,
      ticket_width: null,
      ticket_title: null,
      ticket_legend: null,
      ticket_show_qr: null,
      ticket_show_logo: null,
    }),
  };
  for (const k of TICKET_FIELDS) {
    const v = eff[k];
    out[k] = typeof v === "string" ? v : null;
  }
  if (eff.use_store_contact === true && store) {
    out.address = storeAddressLine(store) ?? out.address;
    out.phone = (store.phone ?? "").trim() || out.phone;
  }
  // Logo propio de la sucursal sólo con multi-sucursal activa (si no, hereda).
  if (store?.logo_url && target.multiStore) out.logo_url = store.logo_url;
  return out;
}
