"use client";

// App del repartidor (ADR-161): datos con respaldo offline y cola de
// acciones. Con señal se lee del servidor y se guarda una copia en
// IndexedDB; sin señal se usa la copia. Cada acción se encola con su id y se
// manda enseguida si hay señal (las RPC son idempotentes por ese id).

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { isPermanentEventError } from "@/lib/logistics/logic";
import { repartoKv, repartoQueueStore } from "@/lib/logistics/idb";
import { syncQueue, type QueuedAction, type Transport } from "@/lib/logistics/offline";
import { LOGISTICS_BUCKET, normalizeRouteDetail, type RouteDetail } from "@/modules/logistics/api";
import type { RouteStatus, VehicleKind } from "@/lib/logistics/logic";

export interface MyRoute {
  id: string;
  number: number;
  service_date: string;
  status: RouteStatus;
  started_at: string | null;
  closed_at: string | null;
  is_helper: boolean;
  store_name: string;
  vehicle: { name: string; plate: string | null; kind: VehicleKind } | null;
  stops: number;
  done: number;
}

const isOffline = (e: unknown) => /Failed to fetch|NetworkError|network|Load failed|fetch/i.test(String((e as { message?: string })?.message ?? e ?? ""));

async function withFallback<T>(key: string, load: () => Promise<T>): Promise<{ data: T; cached: boolean }> {
  try {
    const data = await load();
    await repartoKv.set(key, data);
    return { data, cached: false };
  } catch (e) {
    const saved = await repartoKv.get<T>(key);
    if (saved !== undefined && (isOffline(e) || (typeof navigator !== "undefined" && navigator.onLine === false))) {
      return { data: saved, cached: true };
    }
    throw e;
  }
}

export function useMyRoutes() {
  return useQuery({
    queryKey: ["reparto", "mine"],
    queryFn: () =>
      withFallback<MyRoute[]>("routes", async () => {
        const { data, error } = await createClient().rpc("driver_my_routes" as never);
        if (error) throw error;
        return (data ?? []) as unknown as MyRoute[];
      }),
    refetchInterval: 60_000,
    retry: 0,
  });
}

export function useDriverRoute(id: string | null) {
  return useQuery({
    queryKey: ["reparto", "route", id],
    queryFn: () =>
      withFallback<RouteDetail>(`route:${id}`, async () => {
        const { data, error } = await createClient().rpc("route_detail" as never, { p_route: id } as never);
        if (error) throw error;
        return normalizeRouteDetail(data);
      }),
    enabled: Boolean(id),
    refetchInterval: 45_000,
    retry: 0,
  });
}

/** Negocio activo (del token guardado: sirve sin señal) para la carpeta de las fotos. */
export async function currentTenantId(): Promise<string | null> {
  const { data } = await createClient().auth.getSession();
  const t = (data.session?.user.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id;
  return t ?? null;
}

const transport: Transport = {
  upload: async (path, blob, contentType) => {
    const { error } = await createClient().storage.from(LOGISTICS_BUCKET).upload(path, blob, { contentType, upsert: false });
    if (error) throw error;
  },
  send: async (a) => {
    const sb = createClient();
    const call =
      a.kind === "start"
        ? sb.rpc("route_start" as never, { p_route: a.routeId, p_event: a.payload } as never)
        : a.kind === "close"
          ? sb.rpc("route_close" as never, { p_route: a.routeId, p_event: a.payload } as never)
          : sb.rpc("delivery_event_record" as never, { p: a.payload } as never);
    const { data, error } = await call;
    if (error) throw error;
    return data;
  },
};

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine !== false);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * Cola de acciones: encolar, mandar y ver lo pendiente. Se manda sola al
 * encolar, al volver la señal y cada 30 s mientras quede algo.
 */
export function useActionQueue() {
  const qc = useQueryClient();
  const online = useOnline();
  const [items, setItems] = useState<QueuedAction[]>([]);
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);
  const store = useRef(repartoQueueStore());

  const refresh = useCallback(async () => {
    setItems(await store.current.getAll());
  }, []);

  const sync = useCallback(async () => {
    if (busy.current) return null;
    busy.current = true;
    setSyncing(true);
    try {
      const r = await syncQueue(store.current, transport, isPermanentEventError);
      if (r.sent > 0) void qc.invalidateQueries({ queryKey: ["reparto"] });
      return r;
    } finally {
      busy.current = false;
      setSyncing(false);
      await refresh();
    }
  }, [qc, refresh]);

  const enqueue = useCallback(
    async (a: QueuedAction) => {
      await store.current.put(a);
      await refresh();
      if (typeof navigator === "undefined" || navigator.onLine !== false) return sync();
      return null;
    },
    [refresh, sync],
  );

  const discard = useCallback(
    async (id: string) => {
      await store.current.delete(id);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);

  const pending = items.filter((a) => !a.failed).length;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void sync(), 30_000);
    return () => clearInterval(t);
  }, [pending, sync]);

  return { items, pending, failed: items.filter((a) => a.failed), syncing, online, enqueue, sync, discard };
}

/** Ubicación del momento (alta precisión, hasta 10 s). null si no se pudo. */
export function currentPosition(timeoutMs = 10_000): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15_000 },
    );
  });
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Respaldo RFC 4122 v4.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Identificador del teléfono (para la auditoría del evento). */
export function deviceId(): string {
  try {
    const k = "ninja-reparto-device";
    const v = localStorage.getItem(k);
    if (v) return v;
    const n = newId();
    localStorage.setItem(k, n);
    return n;
  } catch {
    return "sin-id";
  }
}
