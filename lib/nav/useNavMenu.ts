"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { loadNavMenuPref, saveNavMenuPref } from "@/lib/theme/preferences";
import { sanitizeLayout, type MenuLayout } from "@/lib/nav/menuLayout";

// Orden del menú lateral del usuario (ADR-134). Persistencia en
// users.settings.nav_menu[tenantId] (RLS: cada usuario lee y edita sólo su
// fila) con caché en localStorage para que el menú no parpadee al cargar.

const CACHE_KEY = "ninja-nav-menu";
const SAVE_DELAY_MS = 700;
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface Cached {
  uid: string;
  tid: string;
  layout: MenuLayout | null;
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { uid?: unknown; tid?: unknown; layout?: unknown };
    if (typeof c.uid !== "string" || typeof c.tid !== "string") return null;
    return { uid: c.uid, tid: c.tid, layout: sanitizeLayout(c.layout) };
  } catch {
    return null;
  }
}

function writeCache(c: Cached) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // modo privado / sin espacio
  }
}

export function useNavMenu() {
  const qc = useQueryClient();
  // Lo guardado según la caché local: se lee antes del primer pintado.
  const [cached, setCached] = useState<Cached | null>(null);
  useIsoLayoutEffect(() => {
    setCached(readCache());
  }, []);

  const { data: remote } = useQuery({
    queryKey: ["nav-menu-layout"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Cached | null> => {
      const user = await getCurrentUser();
      if (!user) return null;
      const tid =
        (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id ?? "default";
      const layout = sanitizeLayout(await loadNavMenuPref(tid));
      return { uid: user.id, tid, layout };
    },
  });

  // Lo del servidor manda: actualiza la caché (otro usuario u otro negocio en
  // este navegador, o cambios hechos en otro dispositivo).
  useEffect(() => {
    if (!remote) return;
    writeCache(remote);
    setCached(remote);
  }, [remote]);

  const current = remote ?? cached;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ tid: string; layout: MenuLayout | null } | null>(null);

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) void saveNavMenuPref(p.tid, p.layout);
  }, []);

  // Guardar pendiente al desmontar (cambio de página completa o cierre).
  useEffect(() => flush, [flush]);

  const commit = useCallback(
    (layout: MenuLayout | null, immediate = false) => {
      const base = current ?? { uid: "", tid: "default", layout: null };
      const next = { ...base, layout };
      setCached(next);
      writeCache(next);
      if (remote) qc.setQueryData(["nav-menu-layout"], next);
      pending.current = { tid: base.tid, layout };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (immediate) flush();
      else saveTimer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [current, remote, qc, flush],
  );

  return {
    /** Orden guardado (sin mezclar con el menú por defecto) o null. */
    saved: current?.layout ?? null,
    setLayout: (l: MenuLayout) => commit(l),
    reset: () => commit(null, true),
    flush,
  };
}
