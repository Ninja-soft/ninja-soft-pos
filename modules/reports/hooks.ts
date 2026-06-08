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
