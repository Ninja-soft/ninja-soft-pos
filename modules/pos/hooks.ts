"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { posApi, type SaleItemInput, type SalePaymentInput } from "./api";

export function useOpenShift() {
  return useQuery({
    queryKey: ["pos", "open-shift"],
    queryFn: () => posApi.openShift(),
  });
}

export function useDefaultRegister() {
  return useQuery({
    queryKey: ["pos", "register"],
    queryFn: () => posApi.defaultRegister(),
  });
}

export function useMpMethod() {
  return useQuery({
    queryKey: ["pos", "mp-method"],
    queryFn: () => posApi.mpMethod(),
  });
}

export function usePosMutations() {
  const qc = useQueryClient();
  const invalidateShift = () =>
    qc.invalidateQueries({ queryKey: ["pos", "open-shift"] });

  return {
    open: useMutation({
      mutationFn: (vars: { registerId: string; opening: number }) =>
        posApi.open(vars.registerId, vars.opening),
      onSuccess: invalidateShift,
    }),
    close: useMutation({
      mutationFn: (vars: { shiftId: string; closing: number; notes?: string }) =>
        posApi.close(vars.shiftId, vars.closing, vars.notes),
      onSuccess: invalidateShift,
    }),
    sale: useMutation({
      mutationFn: (vars: {
        items: SaleItemInput[];
        payments: SalePaymentInput[];
        discountTotal: number;
      }) => posApi.createSale(vars.items, vars.payments, vars.discountTotal),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["products"] });
      },
    }),
  };
}
