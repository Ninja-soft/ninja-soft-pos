"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { IDLE_COOKIE, INACTIVITY_MS, parseIdle } from "@/lib/auth/idle";

// =============================================================================
// Auto-logout por inactividad. Si no hay USO real durante INACTIVITY_MS (8 h),
// cierra la sesión (supabase.auth.signOut) y redirige a /login con un aviso.
//
// • Escucha actividad real: mousedown / keydown / click / touchstart / scroll.
//   (Deliberadamente NO mousemove: lo dispara cualquier roce; usamos eventos de
//   intención.)
// • Persiste el último timestamp de actividad en la cookie IDLE_COOKIE: cerrar y
//   reabrir dentro de las 8 h mantiene la sesión; pasadas las 8 h el MIDDLEWARE
//   corta antes de renderizar (lib/supabase/middleware.ts) y este guard cubre la
//   pestaña que queda abierta.
// • El timer se resetea en cada actividad. La escritura va con debounce
//   (no en cada evento) para no castigar el scroll.
//
// Solo se monta en el shell de la app (no en /login): ver dónde se instancia.
// =============================================================================

// Cada cuánto, como mucho, reescribimos la cookie de última actividad.
const WRITE_DEBOUNCE_MS = 30 * 1000;

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

// La marca vive en una cookie (no en localStorage) para que el middleware la
// lea y corte una sesión vencida ANTES de renderizar el panel. Es compartida
// entre pestañas por naturaleza. Sólo adelanta el logout, nunca concede acceso.
function readLastActivity(): number | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${IDLE_COOKIE}=([^;]*)`));
  return parseIdle(m?.[1]);
}

function writeLastActivity(ts: number) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${IDLE_COOKIE}=${ts}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
}

function clearLastActivity() {
  document.cookie = `${IDLE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
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
      clearLastActivity();
      try {
        await createClient().auth.signOut();
      } catch {
        /* aunque falle el signOut remoto, igual mandamos a login */
      }
      const login = location.pathname.startsWith("/internal") ? "/login-internal" : "/login";
      router.push(`${login}?reason=inactivity`);
      router.refresh();
    }

    function scheduleFrom(last: number) {
      if (timerRef.current) clearTimeout(timerRef.current);
      const remaining = last + INACTIVITY_MS - now();
      if (remaining <= 0) {
        void logout();
        return;
      }
      // Al vencer el timer, otra pestaña pudo haber marcado actividad: releer.
      timerRef.current = setTimeout(() => evaluate(), remaining);
    }

    // Marca actividad: actualiza el timer siempre; persiste con debounce.
    function markActivity() {
      const ts = now();
      scheduleFrom(ts);
      if (ts - lastWriteRef.current >= WRITE_DEBOUNCE_MS) {
        lastWriteRef.current = ts;
        writeLastActivity(ts);
      }
    }

    // Al montar o al volver a la pestaña: si ya pasó el umbral (contemplando el
    // tiempo con la pestaña cerrada vía cookie), desloguear; si no, reprogramar.
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
        writeLastActivity(ts);
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
