"use client";

// Ficha del cliente 360 (H31b · ADR-067): customer_360_summary,
// customer_360_timeline (paginado por cursor) y notas internas. Las RPC no
// están en types/database.ts: se castean. La seguridad (negocio, sucursales,
// rol, feature clientes_360) la aplica el servidor.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  normalizeSummary,
  type C360Summary,
  type TimelineKind,
  type TimelinePage,
} from "@/lib/customers/c360";

type Loose = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};
const loose = () => createClient() as unknown as Loose;

export interface TimelineFilters {
  kinds: TimelineKind[] | null;
  from: string | null;
  to: string | null;
  storeId: string | null;
}

export const PAGE_SIZE = 40;

export async function fetchSummary(customerId: string, storeId: string | null): Promise<C360Summary> {
  const { data, error } = await loose().rpc("customer_360_summary", {
    p_customer: customerId,
    ...(storeId ? { p_store: storeId } : {}),
  });
  if (error) throw new Error(error.message);
  return normalizeSummary(data as C360Summary);
}

export async function fetchTimeline(
  customerId: string,
  f: TimelineFilters,
  cursor: { at: string; id: string } | null,
  limit = PAGE_SIZE,
): Promise<TimelinePage> {
  const { data, error } = await loose().rpc("customer_360_timeline", {
    p_customer: customerId,
    p_kinds: f.kinds && f.kinds.length > 0 ? f.kinds : null,
    p_from: f.from,
    p_to: f.to,
    p_store: f.storeId,
    p_limit: limit,
    p_before_at: cursor?.at ?? null,
    p_before_id: cursor?.id ?? null,
  });
  if (error) throw new Error(error.message);
  const page = data as TimelinePage;
  return { items: page?.items ?? [], next_cursor: page?.next_cursor ?? null };
}

export function useCustomer360Summary(customerId: string | null, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["customers", "c360", "summary", customerId, storeId],
    enabled: enabled && Boolean(customerId),
    staleTime: 30_000,
    retry: false,
    queryFn: () => fetchSummary(customerId!, storeId),
  });
}

export function useCustomer360Timeline(customerId: string | null, f: TimelineFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["customers", "c360", "timeline", customerId, f],
    enabled: enabled && Boolean(customerId),
    staleTime: 30_000,
    retry: false,
    initialPageParam: null as { at: string; id: string } | null,
    queryFn: ({ pageParam }) => fetchTimeline(customerId!, f, pageParam),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useCustomerNotes(customerId: string | null) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["customers", "c360"] });
  const add = useMutation({
    mutationFn: async (v: { body: string; pinned: boolean }) => {
      const { error } = await loose().rpc("customer_note_add", {
        p_customer: customerId,
        p_body: v.body,
        p_pinned: v.pinned,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await loose().rpc("customer_note_delete", { p_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
  });
  return { add, remove };
}

/** Línea de tiempo completa (todas las páginas) para exportar, con tope. */
export async function fetchAllTimeline(customerId: string, f: TimelineFilters, max = 5000): Promise<TimelinePage["items"]> {
  const out: TimelinePage["items"] = [];
  let cursor: { at: string; id: string } | null = null;
  for (;;) {
    const page: TimelinePage = await fetchTimeline(customerId, f, cursor, 200);
    out.push(...page.items);
    if (!page.next_cursor || out.length >= max) break;
    cursor = page.next_cursor;
  }
  return out;
}
