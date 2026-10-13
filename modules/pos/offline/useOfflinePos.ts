"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Product } from "@/modules/products/api";
import { offlineApi } from "@/modules/pos/offline/api";
import { idbAvailable, idbKv, idbQueueStore } from "@/lib/pos/offline/idb";
import {
  OFFLINE_POLICY_DEFAULTS,
  checkOfflineSale,
  type OfflinePaymentLike,
  type OfflinePolicy,
} from "@/lib/pos/offline/policy";
import { OfflineQueue, buildEntry, type BuildEntryInput, type OfflineQueueEntry } from "@/lib/pos/offline/queue";
import {
  buildSnapshot,
  searchSnapshot,
  findByCodeInSnapshot,
  shiftCountKey,
  snapshotKey,
  snapshotMatches,
  type OfflineSnapshot,
} from "@/lib/pos/offline/snapshot";
import { classifySyncError, syncQueue, type SyncSummary } from "@/lib/pos/offline/sync";
import { writeLastPos } from "@/modules/pos/offline/offlineSession";

// Venta offline en el POS (ADR-077): conectividad, foto local, cola y
// sincronización automática al volver la conexión.

const DEVICE_KEY = "ninja-pos-device.v1";
const SNAPSHOT_EVERY_MS = 10 * 60_000;
const SYNC_EVERY_MS = 30_000;
const PING_EVERY_MS = 15_000;

function deviceId(): string | null {
  try {
    const prev = window.localStorage.getItem(DEVICE_KEY);
    if (prev) return prev;
    const id = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/** Error de red (no llegó a NinjaSoft). */
export function isNetworkError(e: unknown): boolean {
  return classifySyncError(e) === "retry";
}

export interface OfflineSaleInput {
  total: number;
  change: number;
  payments: OfflinePaymentLike[];
  extraKinds: string[];
  anyPriceOverride: boolean;
  hasServerOrigin: boolean;
  payload: BuildEntryInput["payload"];
  lines: BuildEntryInput["lines"];
}

export type OfflineSaveResult = { ok: true; entry: OfflineQueueEntry } | { ok: false; message: string };

export function useOfflinePos(ctx: {
  tenantId: string | null;
  userId: string | null;
  shiftId: string | null;
  storeId: string | null;
  policy: OfflinePolicy | null | undefined;
  onSynced?: (s: SyncSummary) => void;
  /**
   * POS abierto sin conexión (H65): usa la foto guardada tal cual y nunca la
   * reescribe (su turno puede no ser el actual).
   */
  frozenSnapshot?: boolean;
}) {
  const qc = useQueryClient();
  const { tenantId, userId, shiftId, storeId, frozenSnapshot = false } = ctx;
  const scope = useMemo(() => (tenantId && userId ? { tenantId, userId } : null), [tenantId, userId]);
  const available = useMemo(() => (typeof window === "undefined" ? false : idbAvailable()), []);
  const queue = useMemo(() => (available ? new OfflineQueue(idbQueueStore()) : null), [available]);

  const [online, setOnline] = useState(true);
  const [serverDown, setServerDown] = useState(false);
  const [pending, setPending] = useState(0);
  const [held, setHeld] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [snapshot, setSnapshot] = useState<OfflineSnapshot<Product> | null>(null);
  const syncingRef = useRef(false);
  const onSyncedRef = useRef(ctx.onSynced);
  onSyncedRef.current = ctx.onSynced;

  const isOffline = !online || serverDown;
  // Política: la del servidor si llegó; si no, la de la foto; si no, defaults.
  const policy = ctx.policy ?? snapshot?.policy ?? OFFLINE_POLICY_DEFAULTS;

  // ── Conectividad ─────────────────────────────────────────────────────────
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Red del dispositivo arriba pero NinjaSoft sin responder: ping hasta volver.
  useEffect(() => {
    if (!serverDown || !online) return;
    const t = setInterval(() => {
      void offlineApi.ping().then((ok) => ok && setServerDown(false));
    }, PING_EVERY_MS);
    return () => clearInterval(t);
  }, [serverDown, online]);

  const refreshCounts = useCallback(async () => {
    if (!queue || !scope) return;
    try {
      const c = await queue.counts(scope);
      setPending(c.pending);
      setHeld(c.hold);
    } catch {
      // IndexedDB no disponible: quedan en 0.
    }
  }, [queue, scope]);

  // ── Foto local ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!available || !scope) return;
    let alive = true;
    void idbKv
      .get<OfflineSnapshot<Product>>(snapshotKey(scope.tenantId, scope.userId))
      .then((s) => alive && snapshotMatches(s, scope.tenantId, scope.userId) && setSnapshot(s ?? null))
      .catch(() => undefined);
    void refreshCounts();
    return () => {
      alive = false;
    };
  }, [available, scope, refreshCounts]);

  const policyRef = useRef(policy);
  policyRef.current = policy;
  useEffect(() => {
    if (!available || !scope || isOffline || frozenSnapshot) return;
    let alive = true;
    const write = async () => {
      try {
        const products = await offlineApi.catalog();
        if (!alive) return;
        const snap = buildSnapshot({
          tenantId: scope.tenantId,
          userId: scope.userId,
          products,
          policy: policyRef.current,
          shift: shiftId ? { id: shiftId, storeId } : null,
        });
        await idbKv.set(snapshotKey(scope.tenantId, scope.userId), snap);
        // H65: puntero para abrir el POS sin conexión con este usuario.
        await writeLastPos(scope.tenantId, scope.userId);
        if (alive) setSnapshot(snap);
      } catch {
        // Sin foto nueva: queda la anterior.
      }
    };
    void write();
    const t = setInterval(write, SNAPSHOT_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [available, scope, isOffline, shiftId, storeId, frozenSnapshot]);

  // ── Sincronización ───────────────────────────────────────────────────────
  const syncNow = useCallback(async () => {
    if (!queue || !scope || syncingRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const summary = await syncQueue(queue, scope, offlineApi.sync);
      if (summary.stopped === "network") setServerDown(true);
      else setServerDown(false);
      if (summary.results.length > 0) {
        void qc.invalidateQueries({ queryKey: ["sales"] });
        void qc.invalidateQueries({ queryKey: ["products"] });
        void qc.invalidateQueries({ queryKey: ["offline-sales"] });
      }
      if (summary.results.length > 0 || summary.held > 0 || summary.stopped === "auth") onSyncedRef.current?.(summary);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      await refreshCounts();
    }
  }, [queue, scope, qc, refreshCounts]);

  useEffect(() => {
    if (!online) return;
    void syncNow();
  }, [online, syncNow]);

  useEffect(() => {
    if (!online || pending === 0) return;
    const t = setInterval(() => void syncNow(), SYNC_EVERY_MS);
    return () => clearInterval(t);
  }, [online, pending, syncNow]);

  // ── Guardar una venta offline ────────────────────────────────────────────
  const saveSale = useCallback(
    async (input: OfflineSaleInput): Promise<OfflineSaveResult> => {
      if (!queue || !scope) return { ok: false, message: "Este navegador no permite guardar ventas sin conexión" };
      let count = 0;
      if (shiftId) {
        try {
          count = (await idbKv.get<number>(shiftCountKey(scope.tenantId, scope.userId, shiftId))) ?? 0;
        } catch {
          count = await queue.countInShift(scope, shiftId);
        }
      }
      const check = checkOfflineSale({
        policy,
        total: input.total,
        countInShift: count,
        shiftId,
        hasSession: true,
        payments: input.payments,
        extraKinds: input.extraKinds,
        anyPriceOverride: input.anyPriceOverride,
        hasServerOrigin: input.hasServerOrigin,
      });
      if (!check.ok) return { ok: false, message: check.message };
      try {
        const entry = await buildEntry({
          tenantId: scope.tenantId,
          userId: scope.userId,
          shiftId: shiftId!,
          storeId,
          deviceId: deviceId(),
          snapshotAt: snapshot?.at ?? null,
          total: input.total,
          payload: input.payload,
          lines: input.lines,
          change: input.change,
        });
        const saved = await queue.enqueue(entry);
        await idbKv.set(shiftCountKey(scope.tenantId, scope.userId, shiftId!), count + 1);
        await refreshCounts();
        return { ok: true, entry: saved };
      } catch {
        return { ok: false, message: "No se pudo guardar la venta en este dispositivo" };
      }
    },
    [queue, scope, shiftId, storeId, policy, snapshot?.at, refreshCounts],
  );

  const releaseHeld = useCallback(async () => {
    if (!queue || !scope) return;
    for (const e of await queue.list(scope, "hold")) await queue.release(e.client_sale_id);
    await refreshCounts();
    await syncNow();
  }, [queue, scope, refreshCounts, syncNow]);

  const snapshotProducts = snapshot?.products ?? null;
  const searchProducts = useCallback(
    (q: string): Product[] | null => (snapshotProducts ? searchSnapshot(snapshotProducts, q) : null),
    [snapshotProducts],
  );
  const findByCode = useCallback(
    (code: string): Product | null => (snapshotProducts ? findByCodeInSnapshot(snapshotProducts, code) : null),
    [snapshotProducts],
  );

  return {
    available,
    isOffline,
    online,
    serverDown,
    pending,
    held,
    syncing,
    policy,
    snapshotAt: snapshot?.at ?? null,
    searchProducts,
    findByCode,
    markServerDown: () => setServerDown(true),
    saveSale,
    syncNow,
    releaseHeld,
  };
}

export type OfflinePos = ReturnType<typeof useOfflinePos>;
