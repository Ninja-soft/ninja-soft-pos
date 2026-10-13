"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  buildHeartbeatInfo,
  DISPLAY_PRESENCE_CHANNEL,
  DISPLAY_PRESENCE_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "@/lib/branches/heartbeat";

// =============================================================================
// Heartbeat de la caja (F17 · H99 · ADR-080).
//
// useRegisterHeartbeat: el POS manda register_heartbeat al montar, cada minuto
// y al volver a la pestaña. Silencioso: contra una base sin la migración o sin
// permiso no hace nada (el POS nunca se rompe por el monitor).
// useDisplayPresenceBeacon: la pantalla del cliente avisa que está viva por
// BroadcastChannel (mismo equipo, sin servidor); el POS lo informa en la señal.
// =============================================================================

type LooseRpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
};

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? null;

let displaySeenAt: number | null = null;
let presenceChannel: BroadcastChannel | null = null;

function listenDisplayPresence() {
  if (presenceChannel || typeof BroadcastChannel === "undefined") return;
  try {
    presenceChannel = new BroadcastChannel(DISPLAY_PRESENCE_CHANNEL);
    presenceChannel.onmessage = (e) => {
      if ((e.data as { kind?: string } | null)?.kind === "display") displaySeenAt = Date.now();
    };
  } catch {
    presenceChannel = null;
  }
}

export function useRegisterHeartbeat(registerId: string | null | undefined, shiftId?: string | null) {
  const disabled = useRef(false);

  useEffect(() => {
    if (!registerId || disabled.current) return;
    listenDisplayPresence();
    let cancelled = false;

    const beat = async () => {
      if (cancelled || disabled.current) return;
      const info = buildHeartbeatInfo({
        online: typeof navigator === "undefined" ? true : navigator.onLine,
        visible: typeof document === "undefined" ? true : document.visibilityState === "visible",
        userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
        platform:
          typeof navigator === "undefined"
            ? null
            : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
              navigator.platform ??
              null),
        displaySeenAt,
        now: Date.now(),
      });
      try {
        const sb = createClient() as unknown as LooseRpc;
        const { error } = await sb.rpc("register_heartbeat", {
          p_register_id: registerId,
          p_info: info,
          p_app_version: APP_VERSION,
        });
        // Base vieja (sin la RPC): no insistir en esta sesión.
        if (error && /Could not find the function|PGRST202|does not exist/i.test(error.message)) {
          disabled.current = true;
        }
      } catch {
        // Sin red: la próxima señal lo intenta de nuevo.
      }
    };

    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
    // shiftId: abrir o cerrar caja manda una señal nueva en el momento.
  }, [registerId, shiftId]);
}

/** Pantalla del cliente: "estoy viva" para el POS del mismo equipo. */
export function useDisplayPresenceBeacon() {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(DISPLAY_PRESENCE_CHANNEL);
    } catch {
      return;
    }
    const send = () => ch?.postMessage({ kind: "display", at: Date.now() });
    send();
    const timer = setInterval(send, DISPLAY_PRESENCE_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      ch?.close();
    };
  }, []);
}
