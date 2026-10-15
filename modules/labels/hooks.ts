"use client";

// Etiquetas PRO (H24 · ADR-148). Lecturas por RPC (label_catalog) y tabla con
// RLS (label_templates). Las plantillas se escriben directo a la tabla: la
// policy exige products.edit + etiquetas_pro (server-side) y el trigger
// write_audit_log() deja la auditoría. La tabla y la RPC no están en los
// tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useMyTenant } from "@/modules/tenants/hooks";
import { normalizeDesign, type LabelDesign } from "@/lib/labels/designs";
import { DEFAULT_MEDIA, normalizeMedia, type MediaConfig } from "@/lib/labels/media";
import type { LabelCatalogRow } from "@/lib/labels/items";

export interface LabelCatalogParams {
  storeId: string | null;
  warehouseId: string | null;
  categoryIds: string[];
  brandIds: string[];
  search: string;
  onlyStock: boolean;
  includeVariants: boolean;
  productIds: string[] | null;
}

export interface LabelTemplate {
  id: string;
  name: string;
  design: LabelDesign;
  media: MediaConfig;
  is_default: boolean;
  updated_at: string;
}

const from = (table: string) => createClient().from(table as never);

export const labelsApi = {
  catalog: async (p: LabelCatalogParams): Promise<LabelCatalogRow[]> => {
    const { data, error } = await createClient().rpc("label_catalog" as never, {
      p_store_id: p.storeId,
      p_warehouse_id: p.warehouseId,
      p_category_ids: p.categoryIds.length ? p.categoryIds : null,
      p_brand_ids: p.brandIds.length ? p.brandIds : null,
      p_search: p.search.trim() || null,
      p_only_stock: p.onlyStock,
      p_include_variants: p.includeVariants,
      p_product_ids: p.productIds && p.productIds.length ? p.productIds : null,
      p_limit: 3000,
    } as never);
    if (error) throw error;
    return ((data ?? []) as LabelCatalogRow[]).map((r) => ({
      ...r,
      price: Number(r.price ?? 0),
      stock: r.stock == null ? null : Number(r.stock),
      net_content: r.net_content == null ? null : Number(r.net_content),
    }));
  },

  templates: async (): Promise<LabelTemplate[]> => {
    const { data, error } = await from("label_templates")
      .select("id, name, design, media, is_default, updated_at")
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .order("name");
    if (error) throw error;
    return ((data ?? []) as unknown as (Omit<LabelTemplate, "design" | "media"> & { design: unknown; media: unknown })[]).map((t) => ({
      ...t,
      design: normalizeDesign(t.design),
      media: normalizeMedia({ ...DEFAULT_MEDIA, ...((t.media ?? {}) as Partial<MediaConfig>) }),
    }));
  },

  saveTemplate: async (t: { id?: string; name: string; design: LabelDesign; media: MediaConfig; is_default?: boolean }) => {
    const row = { name: t.name.trim().slice(0, 60), design: t.design, media: t.media, is_default: Boolean(t.is_default) };
    const q = t.id
      ? from("label_templates").update(row as never).eq("id", t.id).select("id").single()
      : from("label_templates").insert(row as never).select("id").single();
    const { data, error } = await q;
    if (error) throw error;
    return (data as unknown as { id: string }).id;
  },

  removeTemplate: async (id: string) => {
    const { error } = await from("label_templates")
      .update({ deleted_at: new Date().toISOString(), is_default: false } as never)
      .eq("id", id);
    if (error) throw error;
  },

  setNetContent: async (productId: string, qty: number | null, unit: string | null) => {
    const { error } = await from("products")
      .update({ net_content: qty, net_content_unit: qty ? unit : null } as never)
      .eq("id", productId);
    if (error) throw error;
  },

  tenantSlug: async (tenantId: string): Promise<string | null> => {
    const { data, error } = await from("tenants").select("slug").eq("id", tenantId).maybeSingle();
    if (error) throw error;
    return ((data as unknown as { slug?: string } | null)?.slug ?? null) || null;
  },
};

export function useLabelCatalog(p: LabelCatalogParams, enabled = true) {
  return useQuery({
    queryKey: ["label-catalog", p],
    queryFn: () => labelsApi.catalog(p),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useLabelTemplates(enabled = true) {
  return useQuery({ queryKey: ["label-templates"], queryFn: labelsApi.templates, enabled, staleTime: 60_000 });
}

export function useLabelTemplateMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["label-templates"] });
  return {
    save: useMutation({ mutationFn: labelsApi.saveTemplate, onSuccess: done }),
    remove: useMutation({ mutationFn: labelsApi.removeTemplate, onSuccess: done }),
  };
}

export function useSetNetContent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { productId: string; qty: number | null; unit: string | null }) => labelsApi.setNetContent(a.productId, a.qty, a.unit),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["label-catalog"] }),
  });
}

/** Slug público del negocio (para el link de la ficha del QR). */
export function useTenantSlug() {
  const { data: me } = useMyTenant();
  return useQuery({
    queryKey: ["tenant-slug", me?.tenantId],
    queryFn: () => labelsApi.tenantSlug(me!.tenantId),
    enabled: Boolean(me?.tenantId),
    staleTime: 10 * 60_000,
  });
}
