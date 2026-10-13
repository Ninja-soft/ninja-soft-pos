"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import { channelsApi, type ChannelOrder, type ConnectSettings, type MapInput } from "./api";

const KEY = ["delivery-channels"] as const;

export function useChannelsAccess() {
  const f = useFeature("canales_delivery");
  return { ready: f !== undefined, enabled: f === true, locked: f === false };
}

export function useChannelProviders() {
  return useQuery({ queryKey: [...KEY, "providers"], queryFn: () => channelsApi.providers(), staleTime: 300_000 });
}

export function useChannelConnections(enabled = true) {
  return useQuery({ queryKey: [...KEY, "connections"], queryFn: () => channelsApi.connections(), enabled });
}

/**
 * Pedidos de las apps para el tablero. Se refresca cada 5 s: así el estado que
 * informa la app y la posición del repartidor se ven en vivo.
 */
export function useChannelOrders(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "orders"],
    queryFn: () => channelsApi.orders(),
    enabled,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
}

/** Mapa delivery_order_id -> pedido de app (para las tarjetas del tablero). */
export function useChannelOrdersByDeliveryId(enabled = true) {
  const q = useChannelOrders(enabled);
  const map = useMemo(() => {
    const m = new Map<string, ChannelOrder>();
    for (const o of q.data ?? []) m.set(o.delivery_order_id, o);
    return m;
  }, [q.data]);
  return { ...q, map };
}

export function useChannelOutbox(connectionId: string | null) {
  return useQuery({
    queryKey: [...KEY, "outbox", connectionId],
    queryFn: () => channelsApi.outbox(connectionId!),
    enabled: Boolean(connectionId),
    refetchInterval: 10_000,
  });
}

export function useChannelEvents(connectionId: string | null) {
  return useQuery({
    queryKey: [...KEY, "events", connectionId],
    queryFn: () => channelsApi.events(connectionId!),
    enabled: Boolean(connectionId),
    refetchInterval: 10_000,
  });
}

export function useChannelMapping(connectionId: string | null) {
  const rows = useQuery({
    queryKey: [...KEY, "map", connectionId],
    queryFn: () => channelsApi.mapRows(connectionId!),
    enabled: Boolean(connectionId),
  });
  const external = useQuery({
    queryKey: [...KEY, "external", connectionId],
    queryFn: () => channelsApi.externalItems(connectionId!),
    enabled: Boolean(connectionId),
  });
  const products = useQuery({ queryKey: [...KEY, "products"], queryFn: () => channelsApi.products(), staleTime: 60_000 });
  return { rows, external, products };
}

export function useCredentialKeys(connectionId: string | null) {
  return useQuery({
    queryKey: [...KEY, "credentials", connectionId],
    queryFn: () => channelsApi.credentialKeys(connectionId!),
    enabled: Boolean(connectionId),
  });
}

export function useChannelMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: ["delivery"] });
    qc.invalidateQueries({ queryKey: ["dining", "kds"] });
  };
  // Después de una acción del local, la cola sale al toque (el cron es respaldo).
  const flushSoon = () => {
    channelsApi
      .flush()
      .catch(() => undefined)
      .finally(() => qc.invalidateQueries({ queryKey: KEY }));
  };
  return {
    connect: useMutation({
      mutationFn: (v: {
        provider: Parameters<typeof channelsApi.connect>[0];
        storeId: string;
        label: string | null;
        externalStoreId: string | null;
        settings: ConnectSettings;
      }) => channelsApi.connect(v.provider, v.storeId, v.label, v.externalStoreId, v.settings),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Record<string, unknown> }) => channelsApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    disconnect: useMutation({
      mutationFn: (v: { id: string; reason: string | null }) => channelsApi.disconnect(v.id, v.reason),
      onSuccess: inv,
    }),
    setCredentials: useMutation({
      mutationFn: (v: { id: string; credentials: Record<string, unknown> }) => channelsApi.setCredentials(v.id, v.credentials),
      onSuccess: inv,
    }),
    mapSet: useMutation({
      mutationFn: (v: { connectionId: string; rows: MapInput[] }) => channelsApi.mapSet(v.connectionId, v.rows),
      onSuccess: inv,
    }),
    retryOutbox: useMutation({
      mutationFn: (id: string) => channelsApi.retryOutbox(id),
      onSuccess: () => {
        inv();
        flushSoon();
      },
    }),
    accept: useMutation({
      mutationFn: (v: { id: string; prep: number }) => channelsApi.accept(v.id, v.prep),
      onSuccess: () => {
        inv();
        flushSoon();
      },
    }),
    reject: useMutation({
      mutationFn: (v: { id: string; reason: string }) => channelsApi.reject(v.id, v.reason),
      onSuccess: () => {
        inv();
        flushSoon();
      },
    }),
    ready: useMutation({
      mutationFn: (id: string) => channelsApi.ready(id),
      onSuccess: () => {
        inv();
        flushSoon();
      },
    }),
    pickedUp: useMutation({
      mutationFn: (id: string) => channelsApi.pickedUp(id),
      onSuccess: () => {
        inv();
        flushSoon();
      },
    }),
    delivered: useMutation({
      mutationFn: (id: string) => channelsApi.delivered(id),
      onSuccess: inv,
    }),
    bill: useMutation({ mutationFn: (id: string) => channelsApi.bill(id), onSuccess: inv }),
    closeUnbilled: useMutation({
      mutationFn: (v: { id: string; reason: string }) => channelsApi.closeUnbilled(v.id, v.reason),
      onSuccess: inv,
    }),
    flush: useMutation({ mutationFn: () => channelsApi.flush(), onSuccess: inv }),
    simulate: useMutation({
      mutationFn: (v: { connectionId: string; body: Record<string, unknown> }) => channelsApi.simulate(v.connectionId, v.body),
      onSuccess: inv,
    }),
  };
}

/**
 * Facturación automática de lo que la app marcó retirado o entregado (sin
 * sesión no hay turno): mientras el tablero está abierto en una caja de la
 * sucursal, lo factura en el turno de esa persona. El servidor decide qué
 * conexiones son automáticas y de qué sucursal.
 */
export function useAutoBillPending(orders: ChannelOrder[] | undefined, enabled: boolean) {
  const qc = useQueryClient();
  const busy = useRef(false);
  const pending = (orders ?? []).filter(
    (o) => o.billing_status === "pendiente" && !o.sale_id && (o.external_status === "retirado" || o.external_status === "entregado"),
  ).length;
  useEffect(() => {
    if (!enabled || pending === 0 || busy.current) return;
    busy.current = true;
    channelsApi
      .billPending()
      .then((r) => {
        if (r.billed > 0 || r.failed > 0) {
          qc.invalidateQueries({ queryKey: KEY });
          qc.invalidateQueries({ queryKey: ["delivery"] });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
      });
  }, [enabled, pending, qc]);
}
