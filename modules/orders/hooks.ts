"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import { orderConfig, reservedByProduct, type OrderConfig } from "@/lib/orders/logic";
import { ordersApi, type CreateOrderInput, type Dispatch, type SaleOrder } from "./api";

// Pedidos de salón y expedición (F11 · H32, ADR-129).

export const ORDERS_KEY = ["sale-orders"] as const;
export const DISPATCHES_KEY = ["dispatches"] as const;
export const ORDER_CONFIG_KEY = ["sale-orders", "config"] as const;

export function useOrderConfig(enabled = true) {
  const q = useQuery({
    queryKey: ORDER_CONFIG_KEY,
    enabled,
    staleTime: 60_000,
    queryFn: () => ordersApi.rawConfig(),
  });
  const cfg = useMemo<OrderConfig>(() => orderConfig(q.data ?? null), [q.data]);
  return { ...q, config: cfg, raw: q.data ?? null };
}

/** Pedidos abiertos (para la caja) o el historial. Se refresca solo. */
export function useSaleOrders(storeId: string | null, open: boolean, enabled = true) {
  return useQuery({
    queryKey: [...ORDERS_KEY, storeId, open],
    enabled,
    staleTime: 10_000,
    refetchInterval: open ? 20_000 : false,
    refetchOnWindowFocus: true,
    queryFn: () => ordersApi.list({ storeId, open }),
  });
}

export function useSaleOrder(id: string | null) {
  return useQuery({
    queryKey: [...ORDERS_KEY, "one", id],
    enabled: Boolean(id),
    staleTime: 5_000,
    queryFn: () => ordersApi.get(id!),
  });
}

export function useDispatches(storeId: string | null, open: boolean, enabled = true) {
  return useQuery({
    queryKey: [...DISPATCHES_KEY, storeId, open],
    enabled,
    staleTime: 10_000,
    refetchInterval: open ? 15_000 : false,
    refetchOnWindowFocus: true,
    queryFn: () => ordersApi.dispatches({ storeId, open }),
  });
}

/** ADR-149 (R18): entregas y remitos de una venta (detalle de la venta). */
export function useSaleDeliveries(saleId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...DISPATCHES_KEY, "sale", saleId],
    enabled: enabled && Boolean(saleId),
    staleTime: 15_000,
    queryFn: () => ordersApi.saleDeliveries(saleId!),
  });
}

/** ADR-149 (A1): lo que falta entregar de una venta, por número. */
export function useSalePending(saleNumber: number | null) {
  return useQuery({
    queryKey: [...DISPATCHES_KEY, "pending", saleNumber],
    enabled: Boolean(saleNumber && saleNumber > 0),
    staleTime: 5_000,
    retry: false,
    queryFn: async () => ordersApi.salePending(await ordersApi.saleIdByNumber(saleNumber!)),
  });
}

export function useOrderMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ORDERS_KEY });
    qc.invalidateQueries({ queryKey: DISPATCHES_KEY });
    qc.invalidateQueries({ queryKey: ["stock-reserved"] });
    qc.invalidateQueries({ queryKey: ["stock-reservations"] });
  };
  return {
    create: useMutation({ mutationFn: (i: CreateOrderInput) => ordersApi.create(i), onSuccess: invalidate }),
    cancel: useMutation({
      mutationFn: (v: { id: string; reason: string }) => ordersApi.cancel(v.id, v.reason),
      onSuccess: invalidate,
    }),
    advance: useMutation({
      mutationFn: (v: { id: string; to: "pendiente" | "armando" | "listo" | "en_transito" }) =>
        ordersApi.dispatchAdvance(v.id, v.to),
      onSuccess: invalidate,
    }),
    deliver: useMutation({
      mutationFn: (v: { id: string; code: string | null; deliveredTo: string | null; overrideReason: string | null }) =>
        ordersApi.dispatchDeliver(v.id, v.code, v.deliveredTo, v.overrideReason),
      onSuccess: invalidate,
    }),
    ship: useMutation({
      mutationFn: (v: { id: string; tracking: string | null; shipmentId?: string | null }) =>
        ordersApi.dispatchShip(v.id, v.tracking, v.shipmentId ?? null),
      onSuccess: invalidate,
    }),
    cancelDispatch: useMutation({
      mutationFn: (v: { id: string; reason: string }) => ordersApi.dispatchCancel(v.id, v.reason),
      onSuccess: invalidate,
    }),
    forSale: useMutation({
      mutationFn: (v: Parameters<typeof ordersApi.dispatchForSale>[1] & { saleNumber: number }) =>
        ordersApi.dispatchForSale(v.saleNumber, {
          delivery_type: v.delivery_type,
          fulfillment_store_id: v.fulfillment_store_id,
          pickup_name: v.pickup_name,
          ship_address: v.ship_address,
          ...(v.items ? { items: v.items } : {}),
        }),
      onSuccess: invalidate,
    }),
  };
}

/**
 * Reservado vigente por producto para el disponible del POS (reservas y
 * pedidos). Sin reservas_stock no pide nada. Con sucursal, sólo esa.
 */
export function useReservedStock(storeId: string | null, enabled = true) {
  const on = useFeature("reservas_stock") === true && enabled;
  const q = useQuery({
    queryKey: ["stock-reserved", storeId ?? "all"],
    enabled: on,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: () => ordersApi.reservedByStore(storeId),
  });
  const byProduct = useMemo(() => reservedByProduct(q.data ?? [], storeId), [q.data, storeId]);
  return { enabled: on, rows: q.data ?? [], byProduct };
}

export type { SaleOrder, Dispatch };
