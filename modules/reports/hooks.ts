"use client";

import { useQuery } from "@tanstack/react-query";
import { reportsApi } from "./api";

// storeId (F17 · H97): sucursal del chip del panel; null = todas las que el
// usuario puede ver (el servidor recorta a las permitidas). Va en la queryKey.
export function useSalesReport(
  fromISO: string,
  toISO: string,
  opts: { enabled?: boolean; storeId?: string | null } = {},
) {
  const storeId = opts.storeId ?? null;
  return useQuery({
    queryKey: ["reports", "sales", fromISO, toISO, storeId],
    queryFn: () => reportsApi.sales(fromISO, toISO, storeId),
    enabled: opts.enabled ?? true,
  });
}

// Consultas diferidas de gráficos: `enabled` se prende cuando la sección entra
// en pantalla, nunca en el primer paint de Reportes.
export function useSaleTimes(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "sale-times", fromISO, toISO, storeId],
    queryFn: () => reportsApi.saleTimes(fromISO, toISO, storeId),
    enabled,
    staleTime: 60_000,
  });
}

export function useCashFlow(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "cash-flow", fromISO, toISO, storeId],
    queryFn: () => reportsApi.cashMovements(fromISO, toISO, storeId),
    enabled,
    staleTime: 60_000,
  });
}

export function useWarrantyReport(fromISO: string, toISO: string, storeId: string | null = null) {
  return useQuery({
    queryKey: ["reports", "warranties", fromISO, toISO, storeId],
    queryFn: () => reportsApi.warranties(fromISO, toISO, storeId),
  });
}

// Productividad por profesional (H39): servicios, productos, facturado, comisión,
// propinas y ticket promedio por profesional en el período.
export function useStaffProductivity(
  fromISO: string,
  toISO: string,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "staff-productivity", fromISO, toISO, storeId],
    queryFn: () => reportsApi.staffProductivity(fromISO, toISO, storeId),
  });
}

// ── Reportes gastronómicos (F13 · H52) ──────────────────────────────────────
// Un hook por RPC. `enabled` gatea el fetch según el modo operativo del tenant
// (dining_enabled / delivery_enabled): si el negocio no usa mesas/delivery no se
// consultan. Las RPCs devuelven agregados coherentes (vacío/0 sin datos).

export function useGastroTablesReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "gastro-tables", fromISO, toISO, storeId],
    queryFn: () => reportsApi.gastroTables(fromISO, toISO, storeId),
    enabled,
  });
}

export function useGastroKitchenReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "gastro-kitchen", fromISO, toISO, storeId],
    queryFn: () => reportsApi.gastroKitchen(fromISO, toISO, storeId),
    enabled,
  });
}

export function useGastroDeliveryReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "gastro-delivery", fromISO, toISO, storeId],
    queryFn: () => reportsApi.gastroDelivery(fromISO, toISO, storeId),
    enabled,
  });
}

// Top ítems sale de mesa + delivery: se muestra si el tenant usa cualquiera de
// los dos modos (dining_enabled || delivery_enabled).
export function useGastroTopItemsReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["reports", "gastro-top-items", fromISO, toISO, storeId],
    queryFn: () => reportsApi.gastroTopItems(fromISO, toISO, storeId),
    enabled,
  });
}
