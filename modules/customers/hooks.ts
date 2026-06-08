"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { customersApi, customerGroupsApi } from "./api";
import type { CustomerOutput } from "./schemas";

export function useCustomers(search: string) {
  return useQuery({
    queryKey: ["customers", "list", search],
    queryFn: () => customersApi.list(search),
  });
}

// Listado paginado server-side de clientes. keepPreviousData evita parpadeos al
// cambiar de página o tipear (debounce desde la página).
export function useCustomersPaged(params: {
  page: number;
  pageSize: number;
  search?: string;
}) {
  return useQuery({
    queryKey: ["customers", "paged", params.page, params.pageSize, params.search ?? ""],
    queryFn: () => customersApi.listPaged(params),
    placeholderData: keepPreviousData,
  });
}

export function useStoreCreditBalance(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customers", "store-credit", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.storeCreditBalance(customerId!),
  });
}

export function useCustomerHistory(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customers", "history", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.history(customerId!),
  });
}

// Ítems de la última venta del cliente (H40 — recompra rápida). enabled evita el
// fetch sin id. Lo usa el POS al entrar con ?repeat=<customerId>.
export function useCustomerLastSaleItems(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customers", "last-sale-items", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.lastSaleItems(customerId!),
  });
}

// Próximos turnos del cliente (H40, reusa H38). Para el historial del cliente.
export function useCustomerUpcomingAppointments(
  customerId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["customers", "upcoming-appointments", customerId],
    enabled: Boolean(customerId),
    queryFn: () => customersApi.upcomingAppointments(customerId!),
  });
}

export function useAccountsReceivable(enabled = true) {
  return useQuery({
    queryKey: ["customers", "accounts-receivable"],
    enabled,
    queryFn: () => customersApi.accountsReceivable(),
  });
}

export function useBirthdays(month: number, enabled = true) {
  return useQuery({
    queryKey: ["customers", "birthdays", month],
    enabled,
    queryFn: () => customersApi.birthdays(month),
  });
}

export function useRequiredCustomerFields() {
  return useQuery({
    queryKey: ["customers", "required-fields"],
    queryFn: () => customersApi.requiredFields(),
  });
}

export function useCustomerGroups() {
  return useQuery({
    queryKey: ["customer-groups"],
    queryFn: () => customerGroupsApi.list(true),
  });
}

export function useCustomerMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["customers"] });
  return {
    create: useMutation({
      mutationFn: (input: CustomerOutput) => customersApi.create(input),
      onSuccess: invalidate,
    }),
    createQuick: useMutation({
      mutationFn: (input: {
        name: string;
        phone?: string | null;
        email?: string | null;
        document_type?: string | null;
        document_number?: string | null;
      }) => customersApi.createQuick(input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (vars: { id: string; input: CustomerOutput }) =>
        customersApi.update(vars.id, vars.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => customersApi.softDelete(id),
      onSuccess: invalidate,
    }),
  };
}
