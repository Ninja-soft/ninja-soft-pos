"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import {
  DEFAULT_PURCHASE_SETTINGS,
  purchasesApi,
  type DocFilters,
  type InvoiceSaveInput,
  type OrderFilters,
  type OrderSaveInput,
  type PaymentInput,
  type PurchaseSettings,
  type ReceiveInput,
  type SupplierInput,
  type SupplierProductInput,
} from "./api";

/** Estado de las features de compras para la UI (la barrera real es el servidor). */
export function usePurchasesAccess() {
  const compras = useFeature("compras");
  const importacion = useFeature("compras_importacion");
  const { data: settings } = usePurchaseSettings();
  const s = settings ?? DEFAULT_PURCHASE_SETTINGS;
  return {
    ready: compras !== undefined,
    enabled: compras === true,
    locked: compras === false,
    importEnabled: compras === true && importacion === true,
    /** Modo profesional activo (multi-moneda y costeo de importación). */
    pro: compras === true && s.mode === "pro",
    settings: s,
  };
}

export function usePurchaseSettings(enabled = true) {
  return useQuery({
    queryKey: ["purchase-settings"],
    queryFn: () => purchasesApi.settings(),
    enabled,
    staleTime: 60_000,
  });
}

export function useSuppliers(opts: { includeArchived?: boolean } = {}, enabled = true) {
  return useQuery({
    queryKey: ["suppliers", opts],
    queryFn: () => purchasesApi.suppliers(opts),
    enabled,
    staleTime: 30_000,
  });
}

export function useSupplierProducts(f: { supplierId?: string; productId?: string }, enabled = true) {
  return useQuery({
    queryKey: ["supplier-products", f],
    queryFn: () => purchasesApi.supplierProducts(f),
    enabled: enabled && Boolean(f.supplierId || f.productId),
  });
}

export function useCostHistory(productId: string | null) {
  return useQuery({
    queryKey: ["products", "cost-history", productId],
    queryFn: () => purchasesApi.costHistory(productId!),
    enabled: Boolean(productId),
  });
}

export function usePurchaseOrders(f: OrderFilters, enabled = true) {
  return useQuery({
    queryKey: ["purchase-orders", f],
    queryFn: () => purchasesApi.orders(f),
    enabled,
  });
}

export function usePurchaseOrder(id: string | null) {
  return useQuery({
    queryKey: ["purchase-order", id],
    queryFn: () => purchasesApi.order(id!),
    enabled: Boolean(id),
  });
}

export function usePurchaseSuggestions(storeId: string | null, supplierId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["purchase-suggestions", storeId, supplierId],
    queryFn: () => purchasesApi.suggestions(storeId!, supplierId),
    enabled: enabled && Boolean(storeId),
  });
}

export function useReceipts(f: DocFilters & { storeId?: string | null }, enabled = true) {
  return useQuery({
    queryKey: ["goods-receipts", f],
    queryFn: () => purchasesApi.receipts(f),
    enabled,
  });
}

export function useReceipt(id: string | null) {
  return useQuery({
    queryKey: ["goods-receipt", id],
    queryFn: () => purchasesApi.receipt(id!),
    enabled: Boolean(id),
  });
}

export function useSupplierInvoices(f: DocFilters, enabled = true) {
  return useQuery({
    queryKey: ["supplier-invoices", f],
    queryFn: () => purchasesApi.invoices(f),
    enabled,
  });
}

export function useSupplierPayments(f: DocFilters, enabled = true) {
  return useQuery({
    queryKey: ["supplier-payments", f],
    queryFn: () => purchasesApi.payments(f),
    enabled,
  });
}

export function useSupplierBalances(enabled = true) {
  return useQuery({
    queryKey: ["supplier-balances"],
    queryFn: () => purchasesApi.balances(),
    enabled,
  });
}

export function useSupplierEntries(supplierId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["supplier-entries", supplierId ?? "all"],
    queryFn: () => purchasesApi.entries(supplierId ?? null),
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      "suppliers",
      "supplier-products",
      "purchase-orders",
      "purchase-order",
      "purchase-suggestions",
      "goods-receipts",
      "goods-receipt",
      "supplier-invoices",
      "supplier-payments",
      "supplier-balances",
      "supplier-entries",
      // Stock y costos de productos (incluye stock por sucursal e historial).
      "products",
      "product",
      "stock-transfers",
    ]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function usePurchaseMutations() {
  const inv = useInvalidate();
  const qc = useQueryClient();
  return {
    saveSettings: useMutation({
      mutationFn: (s: Partial<PurchaseSettings>) => purchasesApi.saveSettings(s),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["purchase-settings"] });
        inv();
      },
    }),
    createSupplier: useMutation({
      mutationFn: (v: SupplierInput) => purchasesApi.createSupplier(v),
      onSuccess: inv,
    }),
    updateSupplier: useMutation({
      mutationFn: (v: { id: string; input: Partial<SupplierInput> }) =>
        purchasesApi.updateSupplier(v.id, v.input),
      onSuccess: inv,
    }),
    archiveSupplier: useMutation({
      mutationFn: (v: { id: string; archived: boolean }) => purchasesApi.archiveSupplier(v.id, v.archived),
      onSuccess: inv,
    }),
    saveSupplierProduct: useMutation({
      mutationFn: (v: SupplierProductInput) => purchasesApi.saveSupplierProduct(v),
      onSuccess: inv,
    }),
    removeSupplierProduct: useMutation({
      mutationFn: (id: string) => purchasesApi.removeSupplierProduct(id),
      onSuccess: inv,
    }),
    setReplacement: useMutation({
      mutationFn: (v: { id: string; fxRate: number }) => purchasesApi.setReplacementFromSupplier(v.id, v.fxRate),
      onSuccess: inv,
    }),
    saveOrder: useMutation({ mutationFn: (v: OrderSaveInput) => purchasesApi.saveOrder(v), onSuccess: inv }),
    sendOrder: useMutation({ mutationFn: (id: string) => purchasesApi.sendOrder(id), onSuccess: inv }),
    reopenOrder: useMutation({ mutationFn: (id: string) => purchasesApi.reopenOrder(id), onSuccess: inv }),
    cancelOrder: useMutation({
      mutationFn: (v: { id: string; reason: string }) => purchasesApi.cancelOrder(v.id, v.reason),
      onSuccess: inv,
    }),
    closeOrder: useMutation({
      mutationFn: (v: { id: string; reason: string }) => purchasesApi.closeOrder(v.id, v.reason),
      onSuccess: inv,
    }),
    receive: useMutation({ mutationFn: (v: ReceiveInput) => purchasesApi.receive(v), onSuccess: inv }),
    applyCosting: useMutation({
      mutationFn: (v: Parameters<typeof purchasesApi.applyCosting>[0]) => purchasesApi.applyCosting(v),
      onSuccess: inv,
    }),
    saveInvoice: useMutation({
      mutationFn: (v: { id: string | null; input: InvoiceSaveInput; receiptIds: string[] }) =>
        purchasesApi.saveInvoice(v.id, v.input, v.receiptIds),
      onSuccess: inv,
    }),
    voidInvoice: useMutation({
      mutationFn: (v: { id: string; reason: string }) => purchasesApi.voidInvoice(v.id, v.reason),
      onSuccess: inv,
    }),
    createPayment: useMutation({
      mutationFn: (v: PaymentInput) => purchasesApi.createPayment(v),
      onSuccess: inv,
    }),
    voidPayment: useMutation({
      mutationFn: (v: { id: string; reason: string }) => purchasesApi.voidPayment(v.id, v.reason),
      onSuccess: inv,
    }),
  };
}
