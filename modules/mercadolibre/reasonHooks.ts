"use client";

// Maestro de motivos de reclamo de Mercado Libre (ADR-147). Lectura de la
// tabla de plataforma `ml_claim_reasons`; los códigos que falten se completan
// con la Edge ml_api (acción `reasons_fill`, sólo GET a ML, escribe el servidor).

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { indexReasons, missingReasons, type ClaimReason, type ReasonIndex } from "@/lib/mercadolibre/claimReasons";
import { mlEdge } from "@/modules/mercadolibre/hooks";

export const CLAIM_REASONS_KEY = ["ml", "claim-reasons"] as const;

export function useMlClaimReasons() {
  const q = useQuery({
    queryKey: CLAIM_REASONS_KEY,
    staleTime: 6 * 3600_000,
    queryFn: async (): Promise<ClaimReason[]> => {
      const { data, error } = await createClient()
        .from("ml_claim_reasons" as never)
        .select("id, family, title, description, flow, alias_of, excludable, recommended, active")
        .order("id")
        .range(0, 1999);
      if (error) throw error;
      return (data ?? []) as unknown as ClaimReason[];
    },
  });
  const index = useMemo<ReasonIndex | undefined>(() => (q.data ? indexReasons(q.data) : undefined), [q.data]);
  return { ...q, index };
}

// Un mismo código se intenta completar una sola vez por sesión del navegador.
const attempted = new Set<string>();

/** Para tests. */
export function resetReasonAttempts() {
  attempted.clear();
}

/**
 * Completa desde la API los códigos que no estén en el maestro. Devuelve los
 * que se están buscando (para mostrar "buscando descripción").
 */
export function useEnsureClaimReasons(index: ReasonIndex | undefined, ids: Array<string | null | undefined>) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState<string[]>([]);
  const key = ids.filter(Boolean).join(",");
  useEffect(() => {
    const todo = missingReasons(index, ids).filter((id) => !attempted.has(id)).slice(0, 20);
    if (todo.length === 0) return;
    todo.forEach((id) => attempted.add(id));
    setLoading((prev) => [...prev, ...todo]);
    mlEdge<{ filled: string[] }>("ml_api", { action: "reasons_fill", ids: todo })
      .then((r) => {
        if ((r?.filled ?? []).length) void qc.invalidateQueries({ queryKey: CLAIM_REASONS_KEY });
      })
      .catch(() => {
        // Sin cuenta conectada o ML no responde: queda "sin descripción".
      })
      .finally(() => setLoading((prev) => prev.filter((x) => !todo.includes(x))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, key, qc]);
  return loading;
}
