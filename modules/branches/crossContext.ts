"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { branchTabTitle, crossContextNotice, type CrossContextNotice } from "@/lib/branches/crossContext";
import { useBranchContext, useBranchScope } from "./hooks";

// =============================================================================
// "¿Dónde vendo?" fuera del POS (F17 · H90 · ADR-080): aviso de contexto
// cruzado para el acceso Vender y sucursal en el título de la pestaña.
// =============================================================================

// Turno abierto por el usuario en este negocio (cualquier caja). Cuelga de
// ["pos","open-shift"] para que abrir o cerrar caja lo refresque.
export function useMyOpenShiftStore(enabled = true) {
  const scope = useBranchScope();
  const userId = scope.data?.userId ?? null;
  const tenantId = scope.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["pos", "open-shift", "mine", tenantId, userId],
    enabled: enabled && Boolean(userId),
    staleTime: 30_000,
    queryFn: async (): Promise<string | null> => {
      let q = createClient()
        .from("cash_shifts")
        .select("store_id")
        .eq("opened_by", userId!)
        .eq("status", "open");
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data, error } = await q.order("opened_at", { ascending: false }).limit(1).maybeSingle();
      if (error) return null;
      return ((data as { store_id: string | null } | null)?.store_id ?? null) as string | null;
    },
  });
}

export function useCrossContextNotice(): CrossContextNotice | null {
  const ctx = useBranchContext();
  const active = ctx.ready && ctx.isMulti && Boolean(ctx.filterStoreId);
  const mine = useMyOpenShiftStore(active);
  return useMemo(
    () =>
      active
        ? crossContextNotice({
            filterStoreId: ctx.filterStoreId,
            posStoreId: ctx.posStoreId,
            myShiftStoreId: mine.data ?? null,
            branchName: ctx.branchName,
          })
        : null,
    [active, ctx.filterStoreId, ctx.posStoreId, ctx.branchName, mine.data],
  );
}

// Sucursal del chip adelante en el título de la pestaña ("Norte · Ventas").
// Next reescribe el título al navegar: un observer lo vuelve a prefijar.
export function useBranchTabTitle() {
  const ctx = useBranchContext();
  const label = ctx.ready && ctx.isMulti && ctx.filterStore ? ctx.branchName(ctx.filterStore.id) : null;
  const prev = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => {
      const next = branchTabTitle(document.title, label, prev.current);
      prev.current = label;
      if (next !== document.title) document.title = next;
    };
    apply();
    if (!label) return;
    const obs = new MutationObserver(apply);
    obs.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, [label]);
}
