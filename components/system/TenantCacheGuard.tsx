"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import type { QueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  cacheScopeOf,
  decideScopeChange,
  resetScopedCache,
  type CacheScope,
} from "@/lib/tenant/scope";

// Vacía la caché cuando cambia la cuenta dueña de los datos: otro usuario en
// el navegador o el mismo usuario con otro negocio activo (ADR-152). Escucha
// los eventos de Supabase Auth (login, logout, refresh del token con un claim
// nuevo, también los de otra pestaña) y limpia TODOS los QueryClient (panel y
// /internal). Si la pantalla es del panel, además recarga: el estado en
// memoria (carrito, formularios) era del negocio anterior.
export function TenantCacheGuard({ clients }: { clients: QueryClient[] }) {
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const clientsRef = useRef(clients);
  clientsRef.current = clients;

  useEffect(() => {
    const supabase = createClient();
    let prev: CacheScope | null = null;
    let alive = true;

    const apply = (next: CacheScope) => {
      const action = decideScopeChange(prev, next, pathRef.current);
      prev = next;
      if (action === "none") return;
      for (const qc of clientsRef.current) void resetScopedCache(qc);
      if (action === "reload") window.location.reload();
    };

    void supabase.auth.getSession().then(({ data }) => {
      if (!alive || prev) return;
      prev = cacheScopeOf(data.session?.user ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      apply(cacheScopeOf(session?.user ?? null));
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return null;
}
TenantCacheGuard.displayName = "TenantCacheGuard";
