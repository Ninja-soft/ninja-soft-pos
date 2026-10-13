"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelAtProvider,
  createProviderCharge,
  pendingChargesApi,
  syncProviderStatus,
  type ListFilters,
  type ParkArgs,
  type ReplaceArgs,
} from "./api";
import { effectiveStatus, type PendingCharge, type ShareChannel } from "./logic";

// Cobros en espera (ADR-048). Sin Realtime en el proyecto: sondeo con TanStack
// Query (10 s con cobros abiertos, 30 s sin). Las keys cuelgan de
// ["pending-charges"] para invalidar todo junto.

const KEY = ["pending-charges"] as const;

export function usePendingCharges(f: ListFilters, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "list", f.storeId ?? "all", (f.statuses ?? []).join(","), f.since ?? null, f.limit ?? 200],
    queryFn: () => pendingChargesApi.list(f),
    enabled,
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as PendingCharge[];
      return rows.some((r) => r.status === "waiting" || r.status === "paid") ? 10_000 : 30_000;
    },
    refetchIntervalInBackground: false,
  });
}

export function usePendingCharge(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "one", id],
    queryFn: () => pendingChargesApi.get(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const c = q.state.data as PendingCharge | null | undefined;
      return c && (c.status === "waiting" || c.status === "paid") ? 8_000 : false;
    },
  });
}

export function usePendingChargeEvents(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "events", id],
    queryFn: () => pendingChargesApi.events(id!),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

export function usePendingChargeMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: ["sales"] });
  };
  return {
    park: useMutation({ mutationFn: (a: ParkArgs) => pendingChargesApi.park(a), onSuccess: inv }),
    complete: useMutation({
      mutationFn: (v: { id: string; force?: boolean }) => pendingChargesApi.complete(v.id, v.force ?? false),
      onSuccess: inv,
    }),
    cancel: useMutation({
      mutationFn: async (v: { charge: PendingCharge; reason: string | null }) => {
        const r = await pendingChargesApi.cancel(v.charge.id, v.reason, v.charge.version);
        // Baja en el proveedor (best-effort): el intent ya quedó cancelado acá.
        await cancelAtProvider(r.provider_key, r.channel, r.intent_id);
        return r;
      },
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (v: { charge: PendingCharge; patch: Record<string, unknown> }) =>
        pendingChargesApi.update(v.charge.id, v.patch, v.charge.version),
      onSuccess: inv,
    }),
    // Link nuevo con el mismo carrito (vencido o para cambiar de link).
    regenerate: useMutation({
      mutationFn: async (v: { charge: PendingCharge; expiresMinutes: number }) => {
        const c = v.charge;
        const created = await createProviderCharge(c.provider_key, c.channel, c.amount, c.customer_id, c.share_url);
        try {
          const r = await pendingChargesApi.replace({
            id: c.id,
            newIntentId: created.intent_id,
            version: c.version,
            channel: c.channel,
            shareUrl: /^https?:\/\//.test(created.init_point) ? created.init_point : null,
            qrData: created.qr_data ?? (/^https?:\/\//.test(created.init_point) ? null : created.init_point),
            expiresMinutes: v.expiresMinutes,
          });
          await cancelAtProvider(r.old_provider_key, r.old_channel, r.old_intent_id);
          return r;
        } catch (e) {
          // El intent nuevo no quedó enganchado: se da de baja.
          await cancelAtProvider(c.provider_key, c.channel, created.intent_id);
          throw e;
        }
      },
      onSuccess: inv,
    }),
    replace: useMutation({
      mutationFn: async (a: ReplaceArgs) => {
        const r = await pendingChargesApi.replace(a);
        await cancelAtProvider(r.old_provider_key, r.old_channel, r.old_intent_id);
        return r;
      },
      onSuccess: inv,
    }),
    markShared: useMutation({
      mutationFn: (v: { id: string; via: ShareChannel; to?: string | null }) =>
        pendingChargesApi.markShared(v.id, v.via, v.to),
      onSuccess: inv,
    }),
    sendEmail: useMutation({
      mutationFn: (v: { id: string; to: string; note?: string }) => pendingChargesApi.sendEmail(v.id, v.to, v.note),
      onSuccess: inv,
    }),
    ack: useMutation({ mutationFn: (id: string) => pendingChargesApi.ack(id), onSuccess: inv }),
  };
}

/**
 * Sondeo de los cobros abiertos de la sucursal contra su proveedor, mientras
 * el POS o la pestaña están abiertos: cubre proveedores sin webhook y webhooks
 * perdidos. El estado se sincroniza en el intent y el trigger de la base
 * registra la venta. Un cobro por vez, el que hace más que no se consulta.
 * Los pagados sin venta se reintentan (p. ej. ya hay caja abierta).
 */
export function usePendingChargesSync(charges: PendingCharge[] | undefined, enabled: boolean) {
  const lastRef = useRef(new Map<string, number>());
  const qc = useQueryClient();
  const listRef = useRef(charges);
  listRef.current = charges;

  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      const now = Date.now();
      const open = (listRef.current ?? []).filter((c) => {
        const s = effectiveStatus(c);
        return s === "waiting" || (c.status === "paid" && !c.needs_review);
      });
      if (open.length === 0) return;
      const next = [...open].sort(
        (a, b) => (lastRef.current.get(a.id) ?? 0) - (lastRef.current.get(b.id) ?? 0),
      )[0]!;
      if (now - (lastRef.current.get(next.id) ?? 0) < 15_000) return;
      busy = true;
      lastRef.current.set(next.id, now);
      try {
        if (next.status === "paid") {
          await pendingChargesApi.complete(next.id).catch(() => null);
        } else {
          const st = await syncProviderStatus(next.provider_key, next.channel, next.intent_id);
          if (st === "approved") await pendingChargesApi.complete(next.id).catch(() => null);
        }
        qc.invalidateQueries({ queryKey: KEY });
      } finally {
        busy = false;
      }
    };
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, [enabled, qc]);
}
