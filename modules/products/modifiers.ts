"use client";

// Modificadores de producto (F12 · H37 — heladería/cafetería).
// Un producto puede tener GRUPOS (Tamaño, Sabores, Toppings) y cada grupo sus
// OPCIONES con un ajuste de precio. Se configuran en la ficha del producto y se
// eligen al agregar el producto al carrito en el POS.
//
// types/database.ts no se regenera en este PR: las tablas product_modifier_*
// aún no están tipadas. Tipamos explícito acá y usamos un cliente "loose" para
// las llamadas puntuales (mismo enfoque que modules/sales/api.ts). La DB valida.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface ModifierOption {
  id: string;
  group_id: string;
  name: string;
  price_delta: number;
  sort: number;
  is_active: boolean;
}

export interface ModifierGroup {
  id: string;
  product_id: string;
  name: string;
  min_select: number;
  max_select: number | null;
  required: boolean;
  sort: number;
}

// Grupo con sus opciones (lo que consume el POS y el editor).
export interface ModifierGroupWithOptions extends ModifierGroup {
  options: ModifierOption[];
}

// Snapshot que se persiste en sale_items.modifiers (1 elemento por grupo elegido).
export interface SaleLineModifierGroup {
  group: string;
  options: { name: string; price_delta: number }[];
}

interface LooseClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        order: (col: string, opts?: { ascending?: boolean }) => {
          order: (col: string) => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
    insert: (rows: unknown) => {
      select: (cols: string) => Promise<{ data: unknown; error: unknown }>;
    };
    delete: () => { eq: (col: string, val: unknown) => Promise<{ error: unknown }> };
  };
}
function loose(): LooseClient {
  return createClient() as unknown as LooseClient;
}

export const modifiersApi = {
  // IDs de productos del tenant que tienen al menos un grupo de modificadores.
  // El POS lo usa para rutear al picker sin un fetch por producto (la RLS acota
  // por tenant). Set para lookup O(1) en la grilla.
  productIdsWithModifiers: async (): Promise<Set<string>> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_modifier_groups" as never)
      .select("product_id");
    if (error) throw error;
    const out = new Set<string>();
    for (const r of (data ?? []) as unknown as { product_id: string }[]) {
      out.add(r.product_id);
    }
    return out;
  },

  // Grupos + opciones de un producto, ordenados por sort. Reusado por el editor
  // (todas las opciones) y por el POS (filtra opciones activas en el caller).
  listForProduct: async (productId: string): Promise<ModifierGroupWithOptions[]> => {
    const c = loose();
    const { data: groups, error: gErr } = await c
      .from("product_modifier_groups")
      .select("id, product_id, name, min_select, max_select, required, sort")
      .eq("product_id", productId)
      .order("sort", { ascending: true })
      .order("name");
    if (gErr) throw gErr;
    const g = (groups ?? []) as ModifierGroup[];
    if (g.length === 0) return [];

    // Opciones de todos los grupos del producto en una sola consulta.
    const supabase = createClient();
    const { data: opts, error: oErr } = await supabase
      .from("product_modifier_options" as never)
      .select("id, group_id, name, price_delta, sort, is_active")
      .in("group_id", g.map((x) => x.id) as never)
      .order("sort")
      .order("name");
    if (oErr) throw oErr;
    const byGroup = new Map<string, ModifierOption[]>();
    for (const o of (opts ?? []) as unknown as ModifierOption[]) {
      const arr = byGroup.get(o.group_id) ?? [];
      arr.push(o);
      byGroup.set(o.group_id, arr);
    }
    return g.map((grp) => ({ ...grp, options: byGroup.get(grp.id) ?? [] }));
  },

  // Reemplaza grupos + opciones de un producto (borra y re-inserta). Simple y
  // robusto para un set chico por producto (mismo criterio que kit components).
  // La baja en cascada de la DB limpia las opciones al borrar el grupo.
  saveForProduct: async (
    productId: string,
    groups: {
      name: string;
      min_select: number;
      max_select: number | null;
      required: boolean;
      sort: number;
      options: { name: string; price_delta: number; sort: number; is_active: boolean }[];
    }[],
  ): Promise<void> => {
    const supabase = createClient();
    // Borra los grupos del producto (cascade borra sus opciones).
    const del = await supabase
      .from("product_modifier_groups" as never)
      .delete()
      .eq("product_id", productId);
    if (del.error) throw del.error;
    if (groups.length === 0) return;

    for (const grp of groups) {
      const { data: created, error: gErr } = await supabase
        .from("product_modifier_groups" as never)
        .insert({
          product_id: productId,
          name: grp.name,
          min_select: grp.min_select,
          max_select: grp.max_select,
          required: grp.required,
          sort: grp.sort,
        } as never)
        .select("id")
        .single();
      if (gErr) throw gErr;
      const groupId = (created as { id: string }).id;
      if (grp.options.length > 0) {
        const { error: oErr } = await supabase
          .from("product_modifier_options" as never)
          .insert(
            grp.options.map((o) => ({
              group_id: groupId,
              name: o.name,
              price_delta: o.price_delta,
              sort: o.sort,
              is_active: o.is_active,
            })) as never,
          );
        if (oErr) throw oErr;
      }
    }
  },
};

// Grupos + opciones del producto (editor: todas las opciones). enabled evita el
// fetch hasta que el producto exista (modo edición).
export function useProductModifiers(productId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["products", "modifiers", productId],
    queryFn: () => modifiersApi.listForProduct(productId!),
    enabled: enabled && Boolean(productId),
  });
}

// Set de IDs de productos con modificadores (POS): rutea el tap al picker.
export function useProductsWithModifiers(enabled = true) {
  return useQuery({
    queryKey: ["products", "modifiers", "with-mods"],
    queryFn: () => modifiersApi.productIdsWithModifiers(),
    enabled,
    staleTime: 60_000,
  });
}

export function useSaveProductModifiers(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      groups: Parameters<typeof modifiersApi.saveForProduct>[1],
    ) => modifiersApi.saveForProduct(productId, groups),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["products", "modifiers", productId] }),
  });
}

// ── Helpers puros (compartidos POS / ticket) ─────────────────────────────────

// Suma de price_delta de las opciones elegidas (lo que se suma al precio base).
export function modifiersDelta(groups: SaleLineModifierGroup[]): number {
  return groups.reduce(
    (acc, g) => acc + g.options.reduce((a, o) => a + (o.price_delta || 0), 0),
    0,
  );
}

// Etiqueta corta para el carrito/ticket: "Frutilla, Crema (+200), Dulce de leche".
// Une todas las opciones de todos los grupos; muestra el delta sólo si ≠ 0.
export function modifiersSummary(groups: SaleLineModifierGroup[]): string {
  const parts: string[] = [];
  for (const g of groups) {
    for (const o of g.options) {
      parts.push(o.price_delta ? `${o.name} (+${o.price_delta})` : o.name);
    }
  }
  return parts.join(", ");
}
