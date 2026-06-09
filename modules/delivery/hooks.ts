"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  deliveryApi,
  deliveryZonesApi,
  type CreateDeliveryInput,
  type AddDeliveryItemInput,
  type DeliveryStatus,
  type DeliveryZoneInput,
} from "./api";

// ── Gating: pos_settings.delivery_enabled (F13 · H49) ──────────────────────────
// Lee el toggle del tenant. Gatea el nav (/delivery) y la vista. La columna no
// está en los tipos generados (no se regeneran): select + cast. Independiente de
// dining_enabled: delivery puede ir SIN mesas.
export function useDeliveryEnabled() {
  return useQuery({
    queryKey: ["delivery", "enabled"],
    queryFn: async (): Promise<boolean> => {
      const supabase = createClient();
      const { data } = await supabase
        .from("pos_settings")
        .select("delivery_enabled")
        .maybeSingle();
      return Boolean(
        (data as { delivery_enabled?: boolean } | null)?.delivery_enabled,
      );
    },
    staleTime: 60_000,
  });
}

// ── Board: pedidos activos + totales ───────────────────────────────────────────
export function useDeliveryOrders() {
  return useQuery({
    queryKey: ["delivery", "orders"],
    queryFn: () => deliveryApi.list(),
    // El board es operativo: refrescá seguido para ver pedidos nuevos / cambios.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useDeliveryOrder(orderId: string | null) {
  return useQuery({
    queryKey: ["delivery", "order", orderId],
    enabled: Boolean(orderId),
    queryFn: () => deliveryApi.getById(orderId!),
  });
}

export function useDeliveryItemTotals() {
  return useQuery({
    queryKey: ["delivery", "item-totals"],
    queryFn: () => deliveryApi.openItemTotals(),
    refetchInterval: 15_000,
  });
}

export function useDeliveryOrderItems(orderId: string | null) {
  return useQuery({
    queryKey: ["delivery", "order-items", orderId],
    enabled: Boolean(orderId),
    queryFn: () => deliveryApi.itemsByOrder(orderId!),
  });
}

// ── Comanda impresa por estación (F13 · H49, espeja H45) ───────────────────────
// Líneas disparadas del pedido + contexto para armar la(s) comanda(s) de cocina.
// onlyNew = sólo lo nuevo (no enviado); false = reimprimir todo. enabled gatea el
// fetch al abrir el modal. staleTime 0: se quiere el printed_at fresco cada vez.
export function useDeliveryComandaData(
  orderId: string | null,
  onlyNew: boolean,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["delivery", "comanda", orderId, onlyNew ? "new" : "all"],
    enabled: enabled && Boolean(orderId),
    queryFn: () => deliveryApi.comandaItems(orderId!, onlyNew),
    staleTime: 0,
  });
}

export function useMarkDeliveryComandaPrinted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { orderId: string; itemIds: string[] }) =>
      deliveryApi.markComandaPrinted(v.orderId, v.itemIds),
    // Tras marcar, refrescá la comanda (para que las nuevas dejen de aparecer) y
    // la cuenta/KDS por consistencia.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["delivery", "comanda"] });
      qc.invalidateQueries({ queryKey: ["delivery", "order-items"] });
      qc.invalidateQueries({ queryKey: ["dining", "kds"] });
    },
  });
}

// ── Mutaciones del pedido de delivery ──────────────────────────────────────────
export function useDeliveryMutations() {
  const qc = useQueryClient();
  // Tras cualquier cambio refrescá el board, totales y la cuenta del pedido.
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["delivery", "orders"] });
    qc.invalidateQueries({ queryKey: ["delivery", "item-totals"] });
    qc.invalidateQueries({ queryKey: ["delivery", "order-items"] });
    qc.invalidateQueries({ queryKey: ["delivery", "order"] });
  };
  // Agregar/quitar ítems cambia lo que ve la cocina → refrescá también el KDS.
  const invKitchen = () => {
    inv();
    qc.invalidateQueries({ queryKey: ["dining", "kds"] });
  };
  return {
    create: useMutation({
      mutationFn: (i: CreateDeliveryInput) => deliveryApi.create(i),
      onSuccess: inv,
    }),
    addItem: useMutation({
      mutationFn: (i: AddDeliveryItemInput) => deliveryApi.addItem(i),
      onSuccess: invKitchen,
    }),
    setItemQty: useMutation({
      mutationFn: (v: { itemId: string; qty: number }) =>
        deliveryApi.setItemQty(v.itemId, v.qty),
      onSuccess: invKitchen,
    }),
    removeItem: useMutation({
      mutationFn: (itemId: string) => deliveryApi.removeItem(itemId),
      onSuccess: invKitchen,
    }),
    setStatus: useMutation({
      mutationFn: (v: { orderId: string; status: DeliveryStatus }) =>
        deliveryApi.setStatus(v.orderId, v.status),
      onSuccess: inv,
    }),
    assignCourier: useMutation({
      mutationFn: (v: { orderId: string; courierName: string }) =>
        deliveryApi.assignCourier(v.orderId, v.courierName),
      onSuccess: inv,
    }),
    cancel: useMutation({
      mutationFn: (orderId: string) => deliveryApi.cancel(orderId),
      onSuccess: invKitchen,
    }),
  };
}

// ── Zonas de envío (F13 · H49 follow-up) ───────────────────────────────────────
// Lista de zonas del tenant. includeInactive: true para la gestión (muestra
// también las desactivadas); false (default) para el selector del alta.
export function useDeliveryZones(includeInactive = false) {
  return useQuery({
    queryKey: ["delivery", "zones", includeInactive ? "all" : "active"],
    queryFn: () => deliveryZonesApi.list(includeInactive),
    staleTime: 30_000,
  });
}

export function useDeliveryZoneMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["delivery", "zones"] });
  return {
    create: useMutation({
      mutationFn: (i: DeliveryZoneInput) => deliveryZonesApi.create(i),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<DeliveryZoneInput> }) =>
        deliveryZonesApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => deliveryZonesApi.softDelete(id),
      onSuccess: inv,
    }),
  };
}
