"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pausedSalesApi, isNetworkFailure } from "./api";
import { isPausedVisible, localKey, mergePaused, parseLocal, serializeLocal, type PausedSale } from "./logic";

// Ventas pausadas de la sucursal del POS (ADR-106): servidor + las que se
// pausaron sin conexión en este equipo (localStorage por negocio y usuario),
// que se suben solas al volver la conexión.

function readStore(key: string | null): PausedSale[] {
  if (!key) return [];
  try {
    return parseLocal(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}
function writeStore(key: string | null, list: PausedSale[]) {
  if (!key) return;
  try {
    if (list.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, serializeLocal(list));
  } catch {
    /* sin almacenamiento (modo privado): queda en memoria */
  }
}

export function pausedSalesKey(storeId: string | null) {
  return ["paused-sales", storeId] as const;
}

export function usePausedSales(opts: {
  storeId: string | null;
  tenantId: string | null;
  userId: string | null;
  offline: boolean;
}) {
  const qc = useQueryClient();
  const key = opts.tenantId && opts.userId ? localKey(opts.tenantId, opts.userId) : null;
  const [local, setLocal] = useState<PausedSale[]>([]);
  // Reloj de la lista: el vencimiento a las 24 h (ADR-108) se ve sin recargar.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  // Las pausadas sin conexión también vencen: sin pagos, se borran de este equipo.
  useEffect(() => {
    const all = readStore(key);
    const alive = all.filter((s) => isPausedVisible(s));
    if (alive.length !== all.length) writeStore(key, alive);
    setLocal(alive);
  }, [key]);

  const q = useQuery({
    queryKey: pausedSalesKey(opts.storeId),
    enabled: Boolean(opts.storeId) && !opts.offline,
    staleTime: 5_000,
    queryFn: () => pausedSalesApi.listOpen(opts.storeId),
    // Con un QR esperando, más seguido: el webhook lo concilia en la base.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.payments.some((p) => p.kind === "intent" && p.status === "pending"))
        ? 10_000
        : 30_000,
    refetchOnWindowFocus: true,
  });

  const saveLocal = useCallback(
    (s: PausedSale) => {
      setLocal((prev) => {
        const next = [{ ...s, localOnly: true }, ...prev.filter((x) => x.id !== s.id)];
        writeStore(key, next);
        return next;
      });
    },
    [key],
  );
  const removeLocal = useCallback(
    (id: string) => {
      setLocal((prev) => {
        const next = prev.filter((x) => x.id !== id);
        writeStore(key, next);
        return next;
      });
    },
    [key],
  );

  // Subida de las pausadas sin conexión (idempotente por id).
  const syncing = useRef(false);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (opts.offline || syncing.current || !opts.storeId) return;
    const pending = local.filter((s) => s.status === "paused" && !syncErrors[s.id]);
    if (pending.length === 0) return;
    syncing.current = true;
    void (async () => {
      for (const s of pending) {
        try {
          await pausedSalesApi.pause({
            id: s.id,
            storeId: s.store_id,
            registerId: s.register_id,
            // El turno pudo cerrarse: sin turno se engancha a la próxima apertura.
            cashShiftId: null,
            customerId: s.customer_id,
            customerName: s.customer_name,
            label: s.label,
            cart: s.cart,
            checkout: s.checkout,
            saleArgs: {},
            total: s.total,
            itemCount: s.item_count,
            payments: s.payments,
            source: "offline",
          });
          removeLocal(s.id);
        } catch (e) {
          if (isNetworkFailure(e)) break;
          setSyncErrors((m) => ({ ...m, [s.id]: e instanceof Error ? e.message : "error" }));
        }
      }
      syncing.current = false;
      void qc.invalidateQueries({ queryKey: ["paused-sales"] });
    })();
  }, [opts.offline, opts.storeId, local, syncErrors, removeLocal, qc]);

  const list = useMemo(() => {
    const at = new Date(now);
    return mergePaused(
      q.data ?? [],
      local.filter((s) => s.status === "paused" && (!opts.storeId || s.store_id === opts.storeId)),
    ).filter((s) => isPausedVisible(s, at));
  }, [q.data, local, opts.storeId, now]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["paused-sales"] }), [qc]);

  return { list, now, local, saveLocal, removeLocal, refresh, loading: q.isLoading, syncErrors };
}
