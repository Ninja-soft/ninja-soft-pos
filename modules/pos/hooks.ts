"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  posApi,
  paymentPlansApi,
  type PaymentPlanInput,
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

// Planes activos de todos los medios (POS al cobrar).
export function usePaymentPlans() {
  return useQuery({
    queryKey: ["pos", "payment-plans", "active"],
    queryFn: () => paymentPlansApi.listActive(),
  });
}

// Planes de un medio concreto (editor de Configuración).
export function useProviderPlans(providerKey: string | null) {
  return useQuery({
    queryKey: ["pos", "payment-plans", "provider", providerKey],
    enabled: Boolean(providerKey),
    queryFn: () => paymentPlansApi.listByProvider(providerKey!),
  });
}

type SeedRows = Omit<PaymentPlanInput, "provider_key">[];

export function usePaymentPlanMutations(providerKey: string) {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["pos", "payment-plans"] });
  return {
    setCell: useMutation({
      mutationFn: (v: PaymentPlanInput) => paymentPlansApi.setCell(v),
      onSuccess: inv,
    }),
    removeCell: useMutation({
      mutationFn: (v: { base: string; brand: string | null; installments: number }) =>
        paymentPlansApi.removeCell(providerKey, v.base, v.brand, v.installments),
      onSuccess: inv,
    }),
    create: useMutation({
      mutationFn: (v: PaymentPlanInput) => paymentPlansApi.create(v),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<PaymentPlanInput> }) =>
        paymentPlansApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    seed: useMutation({
      mutationFn: (rows: SeedRows) => paymentPlansApi.seedTypical(providerKey, rows),
      onSuccess: inv,
    }),
    bulkUpsert: useMutation({
      mutationFn: (rows: SeedRows) => paymentPlansApi.bulkUpsert(providerKey, rows),
      onSuccess: inv,
    }),
    replaceProvider: useMutation({
      mutationFn: (rows: SeedRows) => paymentPlansApi.replaceProvider(providerKey, rows),
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
        // Refresca saldo de vale (si se pagó con store_credit) y ventas/reportes.
        qc.invalidateQueries({ queryKey: ["customers"] });
        qc.invalidateQueries({ queryKey: ["sales"] });
      },
    }),
  };
}
