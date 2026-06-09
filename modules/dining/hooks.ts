"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  areasApi,
  tablesApi,
  tableOrdersApi,
  kdsApi,
  type AreaInput,
  type TableInput,
  type TableStatus,
  type AddItemInput,
  type KdsStatus,
} from "./api";

// ── Modo gastronómico (H43): pos_settings.dining_enabled ───────────────────────
// Lee el toggle del tenant. Gatea el nav del POS (Salón) y la gestión de salones.
// La columna no está en los tipos generados (no se regeneran): select + cast.
export function useDiningEnabled() {
  return useQuery({
    queryKey: ["dining", "enabled"],
    queryFn: async (): Promise<boolean> => {
      const supabase = createClient();
      const { data } = await supabase
        .from("pos_settings")
        .select("dining_enabled")
        .maybeSingle();
      return Boolean((data as { dining_enabled?: boolean } | null)?.dining_enabled);
    },
    staleTime: 60_000,
  });
}

// ── Salones ────────────────────────────────────────────────────────────────────

export function useDiningAreas() {
  return useQuery({ queryKey: ["dining", "areas"], queryFn: () => areasApi.list() });
}

export function useAreaMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["dining", "areas"] });
  return {
    create: useMutation({ mutationFn: (i: AreaInput) => areasApi.create(i), onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<AreaInput> }) => areasApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => areasApi.softDelete(id), onSuccess: inv }),
  };
}

// ── Mesas ──────────────────────────────────────────────────────────────────────

export function useDiningTables() {
  return useQuery({ queryKey: ["dining", "tables"], queryFn: () => tablesApi.list() });
}

export function useTableMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["dining", "tables"] });
  return {
    create: useMutation({ mutationFn: (i: TableInput) => tablesApi.create(i), onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<TableInput> }) => tablesApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => tablesApi.softDelete(id), onSuccess: inv }),
    setStatus: useMutation({
      mutationFn: (v: { id: string; status: TableStatus }) => tablesApi.setStatus(v.id, v.status),
      onSuccess: inv,
    }),
  };
}

// ── Totales acumulados de los pedidos abiertos (grid de Salón) ─────────────────
export function useOpenTableTotals() {
  return useQuery({
    queryKey: ["dining", "open-totals"],
    queryFn: () => tableOrdersApi.openTotals(),
    // Refresca seguido: el grid muestra el total vivo de cada mesa.
    refetchInterval: 15_000,
  });
}

// ── Pedido de mesa (ítems) ──────────────────────────────────────────────────────

export function useTableOrderItems(orderId: string | null) {
  return useQuery({
    queryKey: ["dining", "order-items", orderId],
    enabled: Boolean(orderId),
    queryFn: () => tableOrdersApi.itemsByOrder(orderId!),
  });
}

export function useTableOrder(orderId: string | null) {
  return useQuery({
    queryKey: ["dining", "order", orderId],
    enabled: Boolean(orderId),
    queryFn: () => tableOrdersApi.getById(orderId!),
  });
}

export function useTableOrderMutations() {
  const qc = useQueryClient();
  // Tras cualquier cambio refrescá tiles (estado/mozo), totales y la cuenta.
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["dining", "tables"] });
    qc.invalidateQueries({ queryKey: ["dining", "open-totals"] });
    qc.invalidateQueries({ queryKey: ["dining", "order-items"] });
    qc.invalidateQueries({ queryKey: ["dining", "order"] });
  };
  return {
    open: useMutation({
      mutationFn: (v: { tableId: string; waiterUserId?: string | null }) =>
        tableOrdersApi.open(v.tableId, v.waiterUserId),
      onSuccess: inv,
    }),
    addItem: useMutation({
      mutationFn: (i: AddItemInput) => tableOrdersApi.addItem(i),
      onSuccess: inv,
    }),
    setItemQty: useMutation({
      mutationFn: (v: { itemId: string; qty: number }) =>
        tableOrdersApi.setItemQty(v.itemId, v.qty),
      onSuccess: inv,
    }),
    removeItem: useMutation({
      mutationFn: (itemId: string) => tableOrdersApi.removeItem(itemId),
      onSuccess: inv,
    }),
    cancel: useMutation({
      mutationFn: (orderId: string) => tableOrdersApi.cancel(orderId),
      onSuccess: inv,
    }),
  };
}

// ── KDS / pantalla de cocina (F13 · H46) ───────────────────────────────────────
// Tiempo real por polling: refetch cada ~4s sobre kds_tickets (tenant-scoped por
// RLS). station null/'' = todas las estaciones. refetchOnWindowFocus para que al
// volver a la pantalla esté fresco. La pantalla es de monitoreo: mantiene los
// datos previos entre fetches (placeholderData) para no parpadear.
export function useKdsTickets(station: string | null) {
  return useQuery({
    queryKey: ["dining", "kds", station ?? "all"],
    queryFn: () => kdsApi.tickets(station),
    refetchInterval: 4_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
}

export function useKdsMutations() {
  const qc = useQueryClient();
  return {
    setStatus: useMutation({
      mutationFn: (v: { itemId: string; status: KdsStatus }) =>
        kdsApi.setStatus(v.itemId, v.status),
      // Refrescá todas las vistas KDS (cualquier estación) y la cuenta de la mesa.
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["dining", "kds"] });
        qc.invalidateQueries({ queryKey: ["dining", "order-items"] });
      },
    }),
  };
}

// ── Comanda impresa por estación (F13 · H45) ───────────────────────────────────
// Líneas del pedido + contexto para armar la(s) comanda(s) de cocina. onlyNew =
// imprime sólo lo nuevo (no enviado); false = reimprimir todo. enabled gatea el
// fetch al abrir el modal de comanda. Sin caché agresiva: se quiere el estado
// fresco de printed_at cada vez que se abre.
export function useComandaData(orderId: string | null, onlyNew: boolean, enabled: boolean) {
  return useQuery({
    queryKey: ["dining", "comanda", orderId, onlyNew ? "new" : "all"],
    enabled: enabled && Boolean(orderId),
    queryFn: () => tableOrdersApi.comandaItems(orderId!, onlyNew),
    staleTime: 0,
  });
}

export function useMarkComandaPrinted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { orderId: string; itemIds: string[] }) =>
      tableOrdersApi.markPrinted(v.orderId, v.itemIds),
    // Tras marcar, refrescá la comanda (para que las nuevas dejen de aparecer)
    // y la cuenta/KDS por consistencia.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dining", "comanda"] });
      qc.invalidateQueries({ queryKey: ["dining", "order-items"] });
    },
  });
}
