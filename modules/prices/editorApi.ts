"use client";

// Editor rápido de precios (ADR-151): lectura paginada y guardado en lote.
// Las RPC no están en los tipos generados (no se regeneran): se castean.

import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { withPriceSource } from "@/lib/prices/priceSource";
import { normalizeEditorPage, type EditorChange, type EditorFilter, type EditorPage } from "@/lib/prices/editor";

// eslint-disable-next-line
type Any = any;
const db = () => createClient() as unknown as Any;

export interface EditorQuery {
  search?: string;
  categoryIds?: string[];
  brandIds?: string[];
  supplierIds?: string[];
  filter?: EditorFilter;
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

export interface EditorSaveResult {
  id: string;
  status: "applied" | "pending_approval" | "scheduled";
  count: number;
}

export const priceEditorApi = {
  rows: async (q: EditorQuery): Promise<EditorPage> => {
    const { data, error } = await db().rpc("price_editor_rows", {
      p: {
        search: q.search?.trim() || null,
        category_ids: q.categoryIds ?? [],
        brand_ids: q.brandIds ?? [],
        supplier_ids: q.supplierIds ?? [],
        filter: q.filter ?? "all",
        include_inactive: q.includeInactive ?? false,
        limit: q.limit,
        offset: q.offset,
      },
    });
    if (error) throw error;
    return normalizeEditorPage(data);
  },
  save: (changes: EditorChange[], reason?: string | null) =>
    withPriceSource("bulk", async () => {
      const { data, error } = await db().rpc("price_editor_save", { p: { changes, reason: reason?.trim() || null } });
      if (error) throw error;
      return data as EditorSaveResult;
    }),
};

export function usePriceEditorRows(q: EditorQuery, enabled = true) {
  return useQuery({
    queryKey: ["price-editor", q],
    queryFn: () => priceEditorApi.rows(q),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function usePriceEditorSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { changes: EditorChange[]; reason?: string | null }) => priceEditorApi.save(v.changes, v.reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["price-editor"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["price-lists"] });
      void qc.invalidateQueries({ queryKey: ["price-list-items"] });
      void qc.invalidateQueries({ queryKey: ["price-pro"] });
    },
  });
}
