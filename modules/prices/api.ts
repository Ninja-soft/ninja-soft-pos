import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";

export type PriceList = Tables<"price_lists">;
export type PriceListItem = Tables<"price_list_items">;

export type PriceChannel = "mostrador" | "catalogo" | "mayorista" | "custom";

export const PRICE_CHANNELS: { value: PriceChannel; label: string }[] = [
  { value: "mostrador", label: "Mostrador (POS)" },
  { value: "catalogo", label: "Catálogo público" },
  { value: "mayorista", label: "Mayorista" },
  { value: "custom", label: "Personalizada" },
];

export const pricesApi = {
  // Listas activas (no eliminadas) del tenant.
  listLists: async (): Promise<PriceList[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("price_lists")
      .select("*")
      .is("deleted_at", null)
      .order("channel")
      .order("name");
    if (error) throw error;
    return (data ?? []) as PriceList[];
  },

  createList: async (
    tenantId: string,
    input: { name: string; channel: PriceChannel; adjustment_pct: number | null },
  ): Promise<PriceList> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("price_lists")
      .insert({
        tenant_id: tenantId,
        name: input.name,
        channel: input.channel,
        adjustment_pct: input.adjustment_pct,
      })
      .select("*")
      .single();
    if (error) throw error;
    return data as PriceList;
  },

  updateList: async (
    id: string,
    patch: Partial<Pick<PriceList, "name" | "adjustment_pct" | "is_active">>,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("price_lists").update(patch).eq("id", id);
    if (error) throw error;
  },

  // Baja lógica.
  removeList: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("price_lists")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },

  listItems: async (listId: string): Promise<PriceListItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("price_list_items")
      .select("*")
      .eq("price_list_id", listId);
    if (error) throw error;
    return (data ?? []) as PriceListItem[];
  },

  // Precio puntual por (lista, producto, variante). Upsert sobre el índice único
  // (variante null = UUID cero en DB, pero acá basta onConflict de las 3 columnas
  // — Supabase lo resuelve contra el índice parcial).
  upsertItem: async (
    tenantId: string,
    listId: string,
    productId: string,
    variantId: string | null,
    price: number,
  ): Promise<void> => {
    const supabase = createClient();
    // Buscar el item existente para esa combinación (variant_id null no matchea
    // con .eq, hay que usar .is).
    let q = supabase
      .from("price_list_items")
      .select("id")
      .eq("price_list_id", listId)
      .eq("product_id", productId);
    q = variantId ? q.eq("variant_id", variantId) : q.is("variant_id", null);
    const { data: existing, error: selErr } = await q.maybeSingle();
    if (selErr) throw selErr;

    if (existing) {
      const { error } = await supabase
        .from("price_list_items")
        .update({ price })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("price_list_items").insert({
        tenant_id: tenantId,
        price_list_id: listId,
        product_id: productId,
        variant_id: variantId,
        price,
      });
      if (error) throw error;
    }
  },

  removeItem: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("price_list_items").delete().eq("id", id);
    if (error) throw error;
  },

  // Lista activa de un canal + todos sus items. Usada por el POS (mostrador) y
  // potencialmente otros canales del cliente. Devuelve null si no hay lista.
  channelPricing: async (
    channel: PriceChannel,
  ): Promise<{ list: PriceList; items: PriceListItem[] } | null> => {
    const supabase = createClient();
    const { data: list, error } = await supabase
      .from("price_lists")
      .select("*")
      .eq("channel", channel)
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!list) return null;
    const { data: items, error: itErr } = await supabase
      .from("price_list_items")
      .select("*")
      .eq("price_list_id", list.id);
    if (itErr) throw itErr;
    return { list: list as PriceList, items: (items ?? []) as PriceListItem[] };
  },
};
