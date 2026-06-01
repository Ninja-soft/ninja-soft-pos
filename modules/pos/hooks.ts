"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  posApi,
  paymentPlansApi,
  type SaleItemInput,
  type SalePaymentInput,
} from "./api";

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

export function usePosSettings() {
  return useQuery({
    queryKey: ["pos", "settings"],
    queryFn: () => posApi.posSettings(),
  });
}

export function usePaymentPlans(activeOnly = true) {
  return useQuery({
    queryKey: ["pos", "payment-plans", activeOnly],
    queryFn: () => paymentPlansApi.list(activeOnly),
  });
}

export function usePaymentPlanMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["pos", "payment-plans"] });
  return {
    create: useMutation({
      mutationFn: (v: { label: string; surcharge_pct: number }) =>
        paymentPlansApi.create(v.label, v.surcharge_pct),
      onSuccess: inv,
    }),
    setActive: useMutation({
      mutationFn: (v: { id: string; is_active: boolean }) =>
        paymentPlansApi.setActive(v.id, v.is_active),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => paymentPlansApi.remove(id), onSuccess: inv }),
  };
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
        customerId?: string | null;
      }) =>
        posApi.createSale(
          vars.items,
          vars.payments,
          vars.discountTotal,
          vars.customerId,
        ),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["products"] });
      },
    }),
  };
}
