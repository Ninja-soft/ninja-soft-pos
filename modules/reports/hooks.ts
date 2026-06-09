"use client";

import { useQuery } from "@tanstack/react-query";
import { reportsApi } from "./api";

export function useSalesReport(fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ["reports", "sales", fromISO, toISO],
    queryFn: () => reportsApi.sales(fromISO, toISO),
  });
}

export function useWarrantyReport(fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ["reports", "warranties", fromISO, toISO],
    queryFn: () => reportsApi.warranties(fromISO, toISO),
  });
}

// Productividad por profesional (H39): servicios, productos, facturado, comisión,
// propinas y ticket promedio por profesional en el período.
export function useStaffProductivity(fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ["reports", "staff-productivity", fromISO, toISO],
    queryFn: () => reportsApi.staffProductivity(fromISO, toISO),
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
) {
  return useQuery({
    queryKey: ["reports", "gastro-tables", fromISO, toISO],
    queryFn: () => reportsApi.gastroTables(fromISO, toISO),
    enabled,
  });
}

export function useGastroKitchenReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["reports", "gastro-kitchen", fromISO, toISO],
    queryFn: () => reportsApi.gastroKitchen(fromISO, toISO),
    enabled,
  });
}

export function useGastroDeliveryReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["reports", "gastro-delivery", fromISO, toISO],
    queryFn: () => reportsApi.gastroDelivery(fromISO, toISO),
    enabled,
  });
}

// Top ítems sale de mesa + delivery: se muestra si el tenant usa cualquiera de
// los dos modos (dining_enabled || delivery_enabled).
export function useGastroTopItemsReport(
  fromISO: string,
  toISO: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["reports", "gastro-top-items", fromISO, toISO],
    queryFn: () => reportsApi.gastroTopItems(fromISO, toISO),
    enabled,
  });
}
