import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type {
  CategoryInput,
  ProductOutput,
  StockAdjustInput,
} from "./schemas";
import { StockAdjustSchema } from "./schemas";

export type Product = Tables<"products"> & {
  categories?: { name: string } | null;
};
export type Category = Tables<"categories">;
export type StockMovement = Tables<"stock_movements">;

export const productsApi = {
  list: async (search?: string): Promise<Product[]> => {
    const supabase = createClient();
    let q = supabase
      .from("products")
      .select("*, categories(name)")
      .is("deleted_at", null)
      .order("name")
      .limit(200);
    if (search && search.trim()) {
      const s = search.trim();
      q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,barcode.ilike.%${s}%`);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as Product[];
  },

  create: async (input: ProductOutput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("products").insert({
      name: input.name,
      sku: input.sku,
      barcode: input.barcode,
      category_id: input.category_id ?? null,
      price: input.price,
      cost: input.cost ?? null,
      stock: input.stock,
      stock_min: input.stock_min,
      unit: input.unit,
      description: input.description,
      is_active: input.is_active,
    });
    if (error) throw error;
  },

  update: async (id: string, input: ProductOutput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("products")
      .update({
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        category_id: input.category_id ?? null,
        price: input.price,
        cost: input.cost ?? null,
        stock_min: input.stock_min,
        unit: input.unit,
        description: input.description,
        is_active: input.is_active,
      })
      .eq("id", id);
    if (error) throw error;
  },

  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("products")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },

  adjustStock: async (
    productId: string,
    input: StockAdjustInput,
  ): Promise<number> => {
    const supabase = createClient();
    const parsed = StockAdjustSchema.parse(input);
    const { data, error } = await supabase.rpc("adjust_product_stock", {
      p_product_id: productId,
      p_delta: parsed.delta,
      p_reason: parsed.reason,
      p_notes: parsed.notes ?? undefined,
    });
    if (error) throw error;
    return data as number;
  },

  movements: async (productId: string): Promise<StockMovement[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("stock_movements")
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data ?? []) as StockMovement[];
  },
};

export const productsImportApi = {
  bulkImport: async (
    rows: import("./import").ParsedProduct[],
  ): Promise<number> => {
    const supabase = createClient();

    // Resolver categorías por nombre (crear las faltantes).
    const names = Array.from(
      new Set(rows.map((r) => r.category).filter((c): c is string => !!c)),
    );
    const map = new Map<string, string>();
    if (names.length) {
      const { data: existing } = await supabase
        .from("categories")
        .select("id, name")
        .is("deleted_at", null);
      for (const c of existing ?? []) map.set(c.name.toLowerCase(), c.id);

      const missing = names.filter((n) => !map.has(n.toLowerCase()));
      if (missing.length) {
        const { data: created, error } = await supabase
          .from("categories")
          .insert(missing.map((name) => ({ name })))
          .select("id, name");
        if (error) throw error;
        for (const c of created ?? []) map.set(c.name.toLowerCase(), c.id);
      }
    }

    const payload = rows.map((r) => ({
      name: r.name,
      sku: r.sku,
      barcode: r.barcode,
      price: r.price,
      cost: r.cost,
      stock: r.stock,
      stock_min: r.stock_min,
      unit: r.unit,
      category_id: r.category ? (map.get(r.category.toLowerCase()) ?? null) : null,
    }));

    const { error } = await supabase.from("products").insert(payload);
    if (error) throw error;
    return payload.length;
  },
};

export const categoriesApi = {
  list: async (): Promise<Category[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .is("deleted_at", null)
      .order("name");
    if (error) throw error;
    return (data ?? []) as Category[];
  },

  create: async (input: CategoryInput): Promise<Category> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("categories")
      .insert({ name: input.name })
      .select("*")
      .single();
    if (error) throw error;
    return data as Category;
  },
};
