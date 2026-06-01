"use client";

import {
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
