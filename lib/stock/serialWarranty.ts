// lib/stock/serialWarranty.ts
//
// Garantías por número de serie (F14 · H64, ADR-092). PURO. Espejo de
// serial_lookup (migración 20261109200400).
//
// Vencimiento = fecha de venta + meses de fábrica + meses de la garantía
// extendida vendida en el mismo ticket. Vigente si la venta no está anulada,
// la unidad no se devolvió y el vencimiento es hoy o después.

export type ClaimStatus = "open" | "in_repair" | "resolved" | "rejected";

export interface SerialSale {
  line_id: string;
  sale_id: string;
  sale_number: number | null;
  sale_status: string;
  sold_at: string;
  sale_date: string;
  product_id: string | null;
  product_name: string;
  serial: string;
  returned: boolean;
  store_id: string | null;
  store_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  manufacturer_months: number;
  manufacturer_until: string | null;
  extended_label: string | null;
  extended_months: number;
  warranty_until: string | null;
  in_warranty: boolean;
}

export interface SerialClaim {
  id: string;
  serial: string;
  product_id: string | null;
  sale_id: string | null;
  in_warranty: boolean;
  warranty_until: string | null;
  status: ClaimStatus;
  reason: string;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SerialLookup {
  serial: string;
  sales: SerialSale[];
  in_stock: { product_id: string; product_name: string; serial: string; status: string }[];
  claims: SerialClaim[];
}

/** Normaliza como el servidor (mayúsculas, sin espacios en los bordes). */
export function normalizeSerial(s: string): string {
  return s.trim().toUpperCase();
}

/** Suma meses a una fecha YYYY-MM-DD (como date + interval en Postgres). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, last);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export function warrantyUntil(saleDate: string, manufacturerMonths: number, extendedMonths: number): string | null {
  const months = Math.max(0, manufacturerMonths || 0) + Math.max(0, extendedMonths || 0);
  return months > 0 ? addMonths(saleDate, months) : null;
}

export type WarrantyState = "vigente" | "vencida" | "sin_garantia" | "anulada" | "devuelta";

export function warrantyState(
  s: Pick<SerialSale, "sale_status" | "returned" | "warranty_until">,
  todayIso: string,
): WarrantyState {
  if (s.sale_status !== "completed") return "anulada";
  if (s.returned) return "devuelta";
  if (!s.warranty_until) return "sin_garantia";
  return s.warranty_until >= todayIso ? "vigente" : "vencida";
}

/** Días que le quedan (negativo si venció). null sin garantía. */
export function daysLeft(until: string | null, todayIso: string): number | null {
  if (!until) return null;
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
}

export const WARRANTY_STATE_LABEL: Record<WarrantyState, string> = {
  vigente: "En garantía",
  vencida: "Garantía vencida",
  sin_garantia: "Sin garantía",
  anulada: "Venta anulada",
  devuelta: "Unidad devuelta",
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  open: "Abierto",
  in_repair: "En reparación",
  resolved: "Resuelto",
  rejected: "Rechazado",
};

/** Transiciones permitidas (cerrado no se reabre). */
export function nextClaimStatuses(s: ClaimStatus): ClaimStatus[] {
  if (s === "open") return ["in_repair", "resolved", "rejected"];
  if (s === "in_repair") return ["resolved", "rejected"];
  return [];
}

export function serialErrorMessage(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? "");
  if (/serial_too_short/.test(msg)) return "Escribí al menos 3 caracteres de la serie.";
  if (/feature_not_in_plan: garantias_serie/.test(msg)) return "Tu plan no incluye garantías por número de serie.";
  if (/reason_required/.test(msg)) return "Contá qué le pasa al equipo.";
  if (/resolution_required/.test(msg)) return "Escribí cómo se resolvió.";
  if (/claim_closed/.test(msg)) return "El reclamo ya está cerrado.";
  if (/forbidden/.test(msg)) return "No tenés permiso para esto.";
  return "No se pudo completar la acción.";
}
