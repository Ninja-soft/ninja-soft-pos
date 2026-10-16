"use client";

// Seguimiento desde la app del repartidor (ADR-164 · H146, doc 45 §11). Con
// la hoja en curso y el permiso aceptado, watchPosition con alta precisión:
// guarda una posición cada `interval_s` si se movió (quieto, cada 2 minutos),
// la deja en IndexedDB y manda el lote a route_positions_push cada
// `interval_s` si hay señal. Sin señal se acumula (hasta 1000) y se manda al
// volver; el servidor descarta duplicados por id. Pide Wake Lock para que la
// pantalla no se apague (con la pantalla apagada el navegador deja de dar la
// ubicación: límite honesto de una PWA).

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { repartoKv } from "@/lib/logistics/idb";
import {
  BATCH_SIZE,
  DEFAULT_TRACKING,
  bufferAck,
  bufferAdd,
  isPermanentPushError,
  shouldRecord,
  toQueued,
  trackingSettings,
  type Fix,
  type QueuedPosition,
  type TrackingSettings,
} from "@/lib/logistics/tracking";
import { deviceId, newId, useOnline } from "@/modules/logistics/reparto";

export type TrackingStatus = "off" | "needs_consent" | "waiting" | "on" | "denied" | "unsupported" | "disabled";

const CONSENT_KEY = "ninja-reparto-ubicacion-ok";

export function hasTrackingConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTrackingConsent(ok: boolean): void {
  try {
    if (ok) localStorage.setItem(CONSENT_KEY, "1");
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* sin almacenamiento: se vuelve a preguntar */
  }
}

async function loadSettings(): Promise<TrackingSettings> {
  try {
    const { data, error } = await createClient().rpc("route_tracking_settings_get" as never);
    if (error) throw error;
    const s = trackingSettings(data);
    await repartoKv.set("tracking-settings", s);
    return s;
  } catch {
    return (await repartoKv.get<TrackingSettings>("tracking-settings")) ?? DEFAULT_TRACKING;
  }
}

interface BatteryLike {
  level: number;
  charging: boolean;
}

interface WakeLockLike {
  release(): Promise<void>;
}

export function useRouteTracking(routeId: string | null, active: boolean) {
  const online = useOnline();
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<TrackingStatus>("off");
  const [pending, setPending] = useState(0);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [wakeLock, setWakeLock] = useState(false);
  const cfg = useRef<TrackingSettings>(DEFAULT_TRACKING);
  const buffer = useRef<QueuedPosition[]>([]);
  const last = useRef<Fix | null>(null);
  const battery = useRef<BatteryLike | null>(null);
  const sending = useRef(false);
  const key = routeId ? `positions:${routeId}` : null;

  useEffect(() => setConsent(hasTrackingConsent()), []);

  // Lo que quedó sin mandar de una vez anterior.
  useEffect(() => {
    if (!key) return;
    void repartoKv.get<QueuedPosition[]>(key).then((saved) => {
      if (saved?.length) {
        buffer.current = saved;
        setPending(saved.length);
      }
    });
  }, [key]);

  const persist = useCallback(async () => {
    if (key) await repartoKv.set(key, buffer.current);
    setPending(buffer.current.length);
  }, [key]);

  const flush = useCallback(async () => {
    if (!routeId || sending.current || !buffer.current.length) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    sending.current = true;
    try {
      while (buffer.current.length) {
        const batch = buffer.current.slice(0, BATCH_SIZE);
        const { error } = await createClient().rpc("route_positions_push" as never, { p_route: routeId, p_points: batch } as never);
        if (error) {
          if (isPermanentPushError(error)) {
            buffer.current = bufferAck(buffer.current, batch);
            await persist();
            continue;
          }
          break;
        }
        buffer.current = bufferAck(buffer.current, batch);
        setLastSentAt(Date.now());
        await persist();
      }
    } catch {
      /* sin señal: queda en el teléfono */
    } finally {
      sending.current = false;
    }
  }, [routeId, persist]);

  // Seguimiento con la hoja en curso.
  useEffect(() => {
    if (!active || !routeId) {
      setStatus("off");
      return;
    }
    if (!consent) {
      setStatus("needs_consent");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unsupported");
      return;
    }
    let watch: number | null = null;
    let cancelled = false;
    setStatus("waiting");
    void loadSettings().then((s) => {
      if (cancelled) return;
      cfg.current = s;
      if (!s.enabled) {
        setStatus("disabled");
        return;
      }
      watch = navigator.geolocation.watchPosition(
        (p) => {
          const fix: Fix = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
            speed: p.coords.speed ?? null,
            heading: p.coords.heading ?? null,
            at: p.timestamp || Date.now(),
          };
          setStatus("on");
          setAccuracy(fix.accuracy === null ? null : Math.round(fix.accuracy));
          if (!shouldRecord(last.current, fix, cfg.current)) return;
          last.current = fix;
          buffer.current = bufferAdd(buffer.current, toQueued(fix, newId(), battery.current, deviceId()));
          void persist();
        },
        (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "waiting"),
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
      );
    });
    return () => {
      cancelled = true;
      if (watch !== null) navigator.geolocation.clearWatch(watch);
    };
  }, [active, routeId, consent, persist]);

  // Batería, si el navegador la da.
  useEffect(() => {
    if (!active) return;
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike & EventTarget> };
    if (!nav.getBattery) return;
    let b: (BatteryLike & EventTarget) | null = null;
    const read = () => {
      if (b) battery.current = { level: b.level, charging: b.charging };
    };
    void nav.getBattery().then((x) => {
      b = x;
      read();
      x.addEventListener("levelchange", read);
      x.addEventListener("chargingchange", read);
    }).catch(() => undefined);
    return () => {
      b?.removeEventListener("levelchange", read);
      b?.removeEventListener("chargingchange", read);
    };
  }, [active]);

  // Pantalla encendida mientras se reparte.
  useEffect(() => {
    if (!active || !consent) return;
    const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<WakeLockLike> } };
    if (!nav.wakeLock) return;
    let lock: WakeLockLike | null = null;
    const ask = async () => {
      try {
        lock = await nav.wakeLock!.request("screen");
        setWakeLock(true);
      } catch {
        setWakeLock(false);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    void ask();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
      setWakeLock(false);
    };
  }, [active, consent]);

  // Mandar el lote cada interval_s (y al volver la señal). También después de
  // cerrar la hoja, para lo que quedó en el teléfono.
  useEffect(() => {
    if (!routeId) return;
    if (online) void flush();
    const t = setInterval(() => void flush(), Math.max(10, cfg.current.interval_s) * 1000);
    return () => clearInterval(t);
  }, [routeId, online, flush, active]);

  const accept = useCallback(() => {
    setTrackingConsent(true);
    setConsent(true);
  }, []);

  return { status, pending, lastSentAt, accuracy, wakeLock, online, accept, flush };
}
