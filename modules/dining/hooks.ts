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
  type OrderPriority,
} from "./api";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { KdsSlaConfigSchema, parseKdsSla, type KdsSlaConfig } from "@/lib/gastro/kdsSla";

// ── Modo gastronómico (H43): pos_settings.dining_enabled ───────────────────────
// Lee el toggle del tenant. Gatea el nav del POS (Salón) y la gestión de salones.
// La columna no está en los tipos generados (no se regeneran): select + cast.
export async function fetchDiningEnabled(): Promise<boolean> {
  const supabase = createClient();
  const { data } = await supabase
    .from("pos_settings")
    .select("dining_enabled")
    .maybeSingle();
  return Boolean((data as { dining_enabled?: boolean } | null)?.dining_enabled);
}

export const DINING_ENABLED_KEY = ["dining", "enabled"] as const;

export function useDiningEnabled() {
  return useQuery({
    queryKey: DINING_ENABLED_KEY,
    queryFn: fetchDiningEnabled,
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
  // Disparar/recolocar tiempos cambia lo que ve la cocina: refrescá también KDS
  // y comanda además de la cuenta.
  const invKitchen = () => {
    inv();
    qc.invalidateQueries({ queryKey: ["dining", "kds"] });
    qc.invalidateQueries({ queryKey: ["dining", "comanda"] });
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
    // Cursos / despacho por tiempos (F13 · H47).
    setItemCourse: useMutation({
      mutationFn: (v: { itemId: string; course: number }) =>
        tableOrdersApi.setItemCourse(v.itemId, v.course),
      onSuccess: invKitchen,
    }),
    fireCourse: useMutation({
      mutationFn: (v: { orderId: string; course: number | null }) =>
        tableOrdersApi.fireCourse(v.orderId, v.course),
      onSuccess: invKitchen,
    }),
    // Mover / unir / transferir mesas (F13 · H44). Cambian lo que ve la cocina
    // (la etiqueta de mesa del KDS), por eso refrescan también KDS y comanda.
    move: useMutation({
      mutationFn: (v: { orderId: string; targetTableId: string }) =>
        tableOrdersApi.move(v.orderId, v.targetTableId),
      onSuccess: invKitchen,
    }),
    transferItems: useMutation({
      mutationFn: (v: { itemIds: string[]; targetTableId: string }) =>
        tableOrdersApi.transferItems(v.itemIds, v.targetTableId),
      onSuccess: invKitchen,
    }),
    // Anulación con motivo de un ítem enviado (F13 · H45).
    voidItem: useMutation({
      mutationFn: (v: { itemId: string; qty: number | null; reason: string }) =>
        tableOrdersApi.voidItem(v.itemId, v.qty, v.reason),
      onSuccess: () => {
        invKitchen();
        qc.invalidateQueries({ queryKey: ["dining", "kds-voids"] });
      },
    }),
    markVoidsPrinted: useMutation({
      mutationFn: (voidIds: string[]) => tableOrdersApi.markVoidsPrinted(voidIds),
    }),
    // Cuenta por comensal (ADR-097).
    setItemsDiner: useMutation({
      mutationFn: (v: { itemIds: string[]; diner: number | null }) =>
        tableOrdersApi.setItemsDiner(v.itemIds, v.diner),
      onSuccess: inv,
    }),
    split: useMutation({
      mutationFn: (v: { orderId: string; lines: { item_id: string; qty: number | null }[]; label: string }) =>
        tableOrdersApi.split(v.orderId, v.lines, v.label),
      onSuccess: () => {
        invKitchen();
        qc.invalidateQueries({ queryKey: ["dining", "splits"] });
      },
    }),
    unsplit: useMutation({
      mutationFn: (splitId: string) => tableOrdersApi.unsplit(splitId),
      onSuccess: () => {
        invKitchen();
        qc.invalidateQueries({ queryKey: ["dining", "splits"] });
      },
    }),
    // Prioridad en cocina (ADR-097).
    setPriority: useMutation({
      mutationFn: (v: { orderId: string; priority: OrderPriority }) =>
        tableOrdersApi.setPriority("mesa", v.orderId, v.priority),
      onSuccess: invKitchen,
    }),
  };
}

// ── Cuentas separadas de un pedido (ADR-097) ───────────────────────────────────
export function useTableSplits(parentOrderId: string | null) {
  return useQuery({
    queryKey: ["dining", "splits", parentOrderId],
    enabled: Boolean(parentOrderId),
    queryFn: () => tableOrdersApi.splits(parentOrderId!),
  });
}

// ── Relevo de mozo (F13 · H44) ─────────────────────────────────────────────────
export function useSetTableWaiter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tableId: string; waiterUserId: string }) =>
      tablesApi.setWaiter(v.tableId, v.waiterUserId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dining", "tables"] }),
  });
}

// ── Anulaciones recientes para el KDS (F13 · H45) ──────────────────────────────
export function useKdsRecentVoids(station: string | null, enabled = true) {
  return useQuery({
    queryKey: ["dining", "kds-voids", station ?? "all"],
    enabled,
    queryFn: () => kdsApi.recentVoids(station),
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
  });
}

export function useAckKdsVoid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (voidId: string) => kdsApi.ackVoid(voidId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dining", "kds-voids"] }),
  });
}

// ── SLA del KDS por estación (F13 · H46): pos_settings.kds_sla ──────────────────
export const KDS_SLA_KEY = ["dining", "kds-sla"] as const;

export function useKdsSla() {
  return useQuery({
    queryKey: KDS_SLA_KEY,
    staleTime: 60_000,
    queryFn: async (): Promise<KdsSlaConfig> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("pos_settings")
        .select("kds_sla" as never)
        .maybeSingle();
      if (error) throw error;
      return parseKdsSla((data as { kds_sla?: unknown } | null)?.kds_sla);
    },
  });
}

export function useSaveKdsSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: KdsSlaConfig) => {
      const parsed = KdsSlaConfigSchema.parse(config);
      const tenantId = await getCurrentTenantId();
      if (!tenantId) throw new Error("no_tenant");
      const supabase = createClient();
      const { error } = await supabase
        .from("pos_settings")
        .upsert({ tenant_id: tenantId, kds_sla: parsed } as never, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KDS_SLA_KEY }),
  });
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

// Tiempos en espera por pedido (ADR-097): la cocina ve qué viene y lo marcha.
export function useKdsHeldCourses(station: string | null) {
  return useQuery({
    queryKey: ["dining", "kds-held", station ?? "all"],
    queryFn: () => kdsApi.heldCourses(station),
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
  });
}

export function useKdsMutations() {
  const qc = useQueryClient();
  return {
    fireCourse: useMutation({
      mutationFn: (v: { source: "mesa" | "delivery"; orderId: string; course: number }) =>
        kdsApi.fireCourse(v.source, v.orderId, v.course),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["dining", "kds"] });
        qc.invalidateQueries({ queryKey: ["dining", "kds-held"] });
        qc.invalidateQueries({ queryKey: ["dining", "order-items"] });
        qc.invalidateQueries({ queryKey: ["delivery", "order-items"] });
      },
    }),
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
