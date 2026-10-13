"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SW_SCOPE, SW_URL, shouldRegisterSw } from "@/lib/pwa/update";

// Registro del service worker del POS (H65, ADR-087) y detección de versión
// nueva. Nunca recarga sola: sólo cuando el cajero lo pide (applyUpdate), así
// otra pestaña que actualiza no corta un cobro en esta.

const CHECK_EVERY_MS = 30 * 60_000;

export function useServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    const optOut = process.env.NEXT_PUBLIC_DISABLE_SW === "1";

    // Interruptor de emergencia: con NEXT_PUBLIC_DISABLE_SW=1 se desinstala.
    if (optOut) {
      void sw
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => undefined);
      return;
    }
    if (
      !shouldRegisterSw({
        nodeEnv: process.env.NODE_ENV,
        hasSw: true,
        secure: window.isSecureContext,
        optOut,
      })
    )
      return;

    let alive = true;
    const watch = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && sw.controller) setUpdateReady(true);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          // Con controller = ya había una versión: ésta es una actualización.
          if (next.state === "installed" && sw.controller && alive) setUpdateReady(true);
        });
      });
    };

    const onControllerChange = () => {
      if (requestedRef.current) window.location.reload();
    };
    sw.addEventListener("controllerchange", onControllerChange);

    void sw
      .register(SW_URL, { scope: SW_SCOPE, updateViaCache: "none" })
      .then((reg) => {
        if (!alive) return;
        regRef.current = reg;
        watch(reg);
      })
      .catch(() => undefined);

    const check = () => void regRef.current?.update().catch(() => undefined);
    const t = setInterval(check, CHECK_EVERY_MS);
    window.addEventListener("online", check);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("online", check);
      sw.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const waiting = regRef.current?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    requestedRef.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
  }, []);

  return { updateReady, applyUpdate };
}
