"use client";

import { useQuery } from "@tanstack/react-query";
import { reportsApi } from "./api";

export function useSalesReport(fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ["reports", "sales", fromISO, toISO],
    queryFn: () => reportsApi.sales(fromISO, toISO),
  });
}
