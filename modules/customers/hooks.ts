"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { customersApi } from "./api";
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
