"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// =============================================================================
// Auto-logout por inactividad. Si no hay USO real durante INACTIVITY_MS (8 h),
// cierra la sesión (supabase.auth.signOut) y redirige a /login con un aviso.
//
// • Escucha actividad real: mousedown / keydown / click / touchstart / scroll.
//   (Deliberadamente NO mousemove: lo dispara cualquier roce; usamos eventos de
//   intención. La escritura a localStorage va con debounce igual.)
// • Persiste el último timestamp de actividad en localStorage para que cerrar y
//   reabrir la pestaña dentro de las 8 h mantenga la sesión; pero si pasaron más
//   de 8 h (incluso con la pestaña cerrada), al volver se deslogea de una.
// • El timer se resetea en cada actividad. La escritura a storage va con debounce
//   (no en cada evento) para no castigar el scroll.
//
// Solo se monta en el shell de la app (no en /login): ver dónde se instancia.
// =============================================================================

// 8 horas. Configurable por constante (única fuente de verdad del umbral).
export const INACTIVITY_MS = 8 * 60 * 60 * 1000;

// Cada cuánto, como mucho, persistimos el "última actividad" a localStorage.
const STORAGE_DEBOUNCE_MS = 30 * 1000;

// Clave de storage. Por-usuario no hace falta: al desloguear se limpia y el
// próximo login arranca fresco; además el valor solo adelanta el logout, nunca
// concede acceso.
const STORAGE_KEY = "ninja:last-activity";

const ACTIVITY_EVENTS = [
  "mousedown",
  "keydown",
  "click",
  "touchstart",
  "scroll",
] as const;

function now(): number {
  return Date.now();
}

function readLastActivity(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function InactivityGuard() {
  const router = useRouter();
  // Refs para no recrear listeners/timer en cada render.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWriteRef = useRef(0);
  const loggingOutRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    async function logout() {
      if (loggingOutRef.current) return;
      loggingOutRef.current = true;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage no disponible: seguimos con el signOut igual */
      }
      try {
        await createClient().auth.signOut();
      } catch {
        /* aunque falle el signOut remoto, igual mandamos a login */
      }
      router.push("/login?reason=inactivity");
      router.refresh();
    }

    function scheduleFrom(last: number) {
      if (timerRef.current) clearTimeout(timerRef.current);
      const remaining = last + INACTIVITY_MS - now();
      if (remaining <= 0) {
        void logout();
        return;
      }
      timerRef.current = setTimeout(() => void logout(), remaining);
    }

    // Marca actividad: actualiza el timer siempre; persiste con debounce.
    function markActivity() {
      const ts = now();
      scheduleFrom(ts);
      if (ts - lastWriteRef.current >= STORAGE_DEBOUNCE_MS) {
        lastWriteRef.current = ts;
        try {
          localStorage.setItem(STORAGE_KEY, String(ts));
        } catch {
          /* sin storage: el timer en memoria sigue funcionando */
        }
      }
    }

    // Al montar o al volver a la pestaña: si ya pasó el umbral (contemplando el
    // tiempo con la pestaña cerrada vía storage), desloguear; si no, reprogramar.
    function evaluate() {
      const last = readLastActivity();
      if (last != null && now() - last >= INACTIVITY_MS) {
        void logout();
        return;
      }
      // Sin marca previa (primer ingreso): la sembramos ahora.
      scheduleFrom(last ?? now());
      if (last == null) {
        const ts = now();
        lastWriteRef.current = ts;
        try {
          localStorage.setItem(STORAGE_KEY, String(ts));
        } catch {
          /* sin storage */
        }
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") evaluate();
    }

    evaluate();

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, markActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    // Otra pestaña con actividad → respetamos su marca más reciente.
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        const n = Number(e.newValue);
        if (Number.isFinite(n)) scheduleFrom(n);
      }
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, markActivity);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Sin deps: se arma una sola vez por sesión del shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
