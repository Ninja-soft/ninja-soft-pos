"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  salesApi,
  returnReasonsApi,
  returnSettingsApi,
  branchesApi,
  vouchersApi,
  type ReturnItemInput,
  type ReturnReasonInput,
  type ReturnSettings,
  type SalesPageParams,
} from "./api";

export function useSales(range?: { from?: Date; to?: Date }) {
  return useQuery({
    queryKey: [
      "sales",
      "list",
      range?.from?.toISOString() ?? null,
      range?.to?.toISOString() ?? null,
    ],
    queryFn: () => salesApi.list(range),
  });
}

// Listado paginado server-side de ventas. keepPreviousData evita el parpadeo al
// pasar de página o al teclear en la búsqueda (debounce desde la página).
export function useSalesPaged(params: SalesPageParams) {
  return useQuery({
    queryKey: [
      "sales",
      "paged",
      params.page,
      params.pageSize,
      params.search ?? "",
      params.status ?? "",
      params.range?.from?.toISOString() ?? null,
      params.range?.to?.toISOString() ?? null,
    ],
    queryFn: () => salesApi.listPaged(params),
    placeholderData: keepPreviousData,
  });
}

export function useSalesByNumber(n: number | null) {
  return useQuery({
    queryKey: ["sales", "by-number", n],
    enabled: n !== null && Number.isFinite(n),
    queryFn: () => salesApi.byNumber(n as number),
  });
}

export function useReturnsList() {
  return useQuery({
    queryKey: ["sales", "returns-list"],
    queryFn: () => salesApi.listReturns(),
  });
}

export function useSaleNumberFormat() {
  return useQuery({
    queryKey: ["sales", "number-format"],
    queryFn: () => salesApi.numberFormat(),
  });
}

export function useSaleDetail(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sales", "detail", id],
    queryFn: () => salesApi.get(id!),
    enabled: enabled && Boolean(id),
  });
}

export function useVoidSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      salesApi.void(vars.id, vars.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useReturnReasons(activeOnly = true) {
  return useQuery({
    queryKey: ["return-reasons", activeOnly],
    queryFn: () => returnReasonsApi.list(activeOnly),
  });
}

export function useReturnReasonMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["return-reasons"] });
  return {
    create: useMutation({
      mutationFn: (input: ReturnReasonInput) => returnReasonsApi.create(input),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; input: Partial<ReturnReasonInput> }) =>
        returnReasonsApi.update(v.id, v.input),
      onSuccess: inv,
    }),
    setActive: useMutation({
      mutationFn: (v: { id: string; is_active: boolean }) =>
        returnReasonsApi.setActive(v.id, v.is_active),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => returnReasonsApi.remove(id), onSuccess: inv }),
  };
}

// Política de devolución + validez del vale (sección Devoluciones de Config).
export function useReturnSettings() {
  return useQuery({
    queryKey: ["return-settings"],
    queryFn: () => returnSettingsApi.get(),
  });
}

export function useSaveReturnSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tenantId: string; input: ReturnSettings }) =>
      returnSettingsApi.save(v.tenantId, v.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["return-settings"] }),
  });
}

// Sucursales del tenant (para el scoping del vale en multi-sucursal).
export function useBranches(enabled = true) {
  return useQuery({
    queryKey: ["branches"],
    enabled,
    queryFn: () => branchesApi.list(),
    staleTime: 60_000,
  });
}

// Devolución PRO (return_sale_v2): motivo → destino de stock, política y vale.
export function useReturnSaleV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: Parameters<typeof salesApi.returnV2>[0]) => salesApi.returnV2(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["vouchers"] });
    },
  });
}

// Canje de vale por código en el POS.
export function useRedeemVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { code: string; customerId?: string | null; storeId?: string | null }) =>
      vouchersApi.redeem(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["vouchers"] });
    },
  });
}

export function useRecentVouchers(enabled = true) {
  return useQuery({
    queryKey: ["vouchers", "recent"],
    enabled,
    queryFn: () => vouchersApi.listRecent(),
  });
}

// Legacy (return_sale H29) — se mantiene por compatibilidad. El flujo nuevo usa
// useReturnSaleV2.
export function useReturnSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      saleId: string;
      items: ReturnItemInput[];
      reason: string;
      refund: "cash" | "store_credit";
    }) => salesApi.return(vars.saleId, vars.items, vars.reason, vars.refund),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}
