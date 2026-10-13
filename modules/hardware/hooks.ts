"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resolveEffective } from "@/lib/config/inheritance";
import {
  emptyRegisterHardware,
  loadBridgeAuth,
  loadHardwarePairing,
  parseStoreHardware,
  type RegisterHardware,
  type ScaleDevice,
  type StoreHardware,
} from "@/lib/hardware/config";
import { ScaleReader, ScaleSimulatorTransport, drawerTransport, kickDrawer, scaleTransport, type ScaleReading } from "@/lib/hardware/devices";
import type { DrawerKind } from "@/lib/hardware/drawer";
import { useConfigOverrides, usePosResolveTarget, useResolveTarget } from "@/modules/config/hooks";
import { posApi } from "@/modules/pos/api";
import { SupervisorCancelled, withSupervisor } from "@/modules/security/supervisor";
import { hardwareApi, type DrawerOpenResult } from "./api";

// =============================================================================
// Balanza y cajón (ADR-063): datos por caja, política efectiva de la
// sucursal, apertura del cajón y lectura del peso en vivo.
// =============================================================================

export function useRegisterHardwareList() {
  return useQuery({ queryKey: ["register-hardware"], queryFn: hardwareApi.list, staleTime: 60_000 });
}

/** Equipos de una caja (o los de una caja sin configurar). */
export function useRegisterHardware(registerId: string | null, storeId: string | null): RegisterHardware | null {
  const { data } = useRegisterHardwareList();
  return useMemo(() => {
    if (!registerId || !storeId) return null;
    return data?.find((h) => h.registerId === registerId) ?? emptyRegisterHardware(registerId, storeId);
  }, [data, registerId, storeId]);
}

export function useRegisterHardwareMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: hardwareApi.set,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["register-hardware"] }),
  });
}

/** Reglas de balanza y cajón efectivas para un lugar (negocio ← grupo ← sucursal). */
export function useStoreHardware(storeId: string | null, registerId: string | null = null): StoreHardware {
  const raw = useQuery({ queryKey: ["pos", "settings"], queryFn: () => posApi.posSettingsRaw() });
  const { data: overrides } = useConfigOverrides();
  const target = useResolveTarget(storeId, registerId);
  return useMemo(() => {
    const eff = resolveEffective("pos_settings", "", raw.data ?? {}, overrides ?? [], target).value;
    return parseStoreHardware(eff);
  }, [raw.data, overrides, target]);
}

/** Lo mismo, para la sucursal y caja del POS de este dispositivo. */
export function usePosStoreHardware(): StoreHardware {
  const raw = useQuery({ queryKey: ["pos", "settings"], queryFn: () => posApi.posSettingsRaw() });
  const { data: overrides } = useConfigOverrides();
  const target = usePosResolveTarget();
  return useMemo(() => {
    const eff = resolveEffective("pos_settings", "", raw.data ?? {}, overrides ?? [], target).value;
    return parseStoreHardware(eff);
  }, [raw.data, overrides, target]);
}

// ── Cajón ────────────────────────────────────────────────────────────────────

export type DrawerOutcome =
  | { status: "opened"; result: DrawerOpenResult; pulse: "sent" | "failed"; error?: string }
  | { status: "denied"; result: DrawerOpenResult }
  | { status: "cancelled" }
  | { status: "error"; error: unknown };

/**
 * Abre el cajón de una caja: pide la apertura al servidor (que decide con la
 * política, pide el PIN de supervisor si hace falta y registra) y, sólo si la
 * permite, manda el pulso por la impresora de la caja.
 */
export function useDrawerOpener() {
  const qc = useQueryClient();
  return useCallback(
    async (
      hw: RegisterHardware,
      kind: DrawerKind,
      opts: { reason?: string | null; saleId?: string | null } = {},
    ): Promise<DrawerOutcome> => {
      let result: DrawerOpenResult;
      try {
        result = await withSupervisor(
          () => hardwareApi.openDrawer({ registerId: hw.registerId, kind, reason: opts.reason, saleId: opts.saleId }),
          {},
          { context: opts.reason ? `Abrir el cajón: ${opts.reason}` : "Abrir el cajón" },
        );
      } catch (e) {
        if (e instanceof SupervisorCancelled) return { status: "cancelled" };
        return { status: "error", error: e };
      } finally {
        void qc.invalidateQueries({ queryKey: ["drawer-events", hw.registerId] });
      }
      if (!result.allowed) return { status: "denied", result };
      try {
        const t = drawerTransport(
          hw.drawer,
          loadHardwarePairing(hw.registerId, "drawer"),
          loadBridgeAuth(),
        );
        await kickDrawer(hw.drawer, t);
        return { status: "opened", result, pulse: "sent" };
      } catch (e) {
        // Autorizado y registrado, pero la impresora no respondió: se avisa
        // (queda la llave) sin trabar la venta.
        return { status: "opened", result, pulse: "failed", error: e instanceof Error ? e.message : String(e) };
      }
    },
    [qc],
  );
}

export function useDrawerEvents(registerId: string | null) {
  return useQuery({
    queryKey: ["drawer-events", registerId],
    queryFn: () => hardwareApi.events(registerId!),
    enabled: Boolean(registerId),
    staleTime: 15_000,
  });
}

// ── Balanza ──────────────────────────────────────────────────────────────────

export interface ScaleState {
  status: "idle" | "connecting" | "reading" | "error";
  reading: ScaleReading | null;
  error: string | null;
  /** Peso en kg con la tara aplicada, o null sin lectura. */
  tareNow: () => void;
  clearTare: () => void;
  /** Sólo con el simulador: apoya un peso. */
  simulate: ((kg: number) => void) | null;
  /** Milisegundos sin tramas (balanza que no responde). */
  silent: boolean;
}

/**
 * Lee la balanza de una caja mientras `enabled` (p. ej. con el diálogo de
 * peso abierto o la prueba de hardware). Cierra el puerto al terminar.
 */
export function useScaleReader(device: ScaleDevice | null, registerId: string | null, enabled: boolean): ScaleState {
  const [status, setStatus] = useState<ScaleState["status"]>("idle");
  const [reading, setReading] = useState<ScaleReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [silent, setSilent] = useState(false);
  const readerRef = useRef<ScaleReader | null>(null);
  const key = device ? JSON.stringify(device) : "";

  useEffect(() => {
    if (!enabled || !device?.enabled || !registerId) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    let reader: ScaleReader;
    try {
      reader = new ScaleReader(
        scaleTransport(device, loadHardwarePairing(registerId, "scale"), loadBridgeAuth()),
        device.transport === "simulator" ? { ...device.protocol, protocol: "generic", regex: "", unit: "kg" } : device.protocol,
      );
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "No se pudo conectar la balanza");
      return;
    }
    readerRef.current = reader;
    setStatus("connecting");
    setError(null);
    setReading(null);
    const offR = reader.onReading((r) => {
      if (cancelled) return;
      setReading(r);
      setStatus("reading");
    });
    const offE = reader.onError((e) => {
      if (cancelled) return;
      setError(e === "overload" ? "Sobrecarga: sacá peso de la balanza." : e === "bad_regex" ? "La expresión de la balanza no es válida." : "La balanza no respondió.");
    });
    reader.start().catch((e: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "No se pudo abrir la balanza");
    });
    const watch = setInterval(() => setSilent(reader.silenceMs() > 3000), 1000);
    return () => {
      cancelled = true;
      clearInterval(watch);
      offR();
      offE();
      readerRef.current = null;
      void reader.stop();
    };
  }, [enabled, registerId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const tareNow = useCallback(() => {
    readerRef.current?.tareNow();
  }, []);
  const clearTare = useCallback(() => {
    readerRef.current?.setTare(0);
  }, []);
  const sim = readerRef.current?.transport instanceof ScaleSimulatorTransport ? readerRef.current.transport : null;
  const simulate = useMemo(() => (sim ? (kg: number) => sim.place(kg) : null), [sim]);
  return { status, reading, error, tareNow, clearTare, simulate, silent };
}
