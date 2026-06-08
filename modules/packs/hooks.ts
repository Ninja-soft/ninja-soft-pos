"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  servicePacksApi,
  customerPackCreditsApi,
  type ServicePackInput,
} from "./api";

// ── Definición de packs ───────────────────────────────────────────────────────

export function useServicePacks(activeOnly = false) {
  return useQuery({
    queryKey: ["service-packs", activeOnly],
    queryFn: () => servicePacksApi.list(activeOnly),
  });
}

export function useServicePackMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["service-packs"] });
  return {
    create: useMutation({
      mutationFn: (input: ServicePackInput) => servicePacksApi.create(input),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<ServicePackInput> }) =>
        servicePacksApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => servicePacksApi.softDelete(id),
      onSuccess: inv,
    }),
  };
}

// ── Saldo de sesiones del cliente ──────────────────────────────────────────────

// Saldos de pack de un cliente. La key incluye onlyAvailable para no mezclar el
// listado del historial (todos) con el del POS (sólo disponibles).
export function useCustomerPackCredits(
  customerId: string | null | undefined,
  onlyAvailable = false,
) {
  return useQuery({
    queryKey: ["customer-pack-credits", customerId, onlyAvailable],
    enabled: Boolean(customerId),
    queryFn: () => customerPackCreditsApi.list(customerId!, onlyAvailable),
  });
}
