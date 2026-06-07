import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { Paged } from "@/lib/utils/pagination";
import { sanitizeIlike } from "@/lib/utils/search";
import type {
  CategoryInput,
  ProductOutput,
  StockAdjustInput,
} from "./schemas";
import { StockAdjustSchema } from "./schemas";

export interface ProductsPageParams {
  page: number; // 1-based
  pageSize: number;
  search?: string;
  categoryId?: string | null;
  brandId?: string | null;
}

export type Product = Tables<"products"> & {
  categories?: { name: string } | null;
};
export type Category = Tables<"categories">;
export type Brand = Tables<"brands">;
export type StockMovement = Tables<"stock_movements">;
export interface KitComponent {
  id: string;
  componentProductId: string;
  name: string;
  quantity: number;
}

// "oferta, premium" -> ["oferta","premium"]; null/"" -> [].
function toTags(v: string | null | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export const productsApi = {
  list: async (
    search?: string,
    categoryId?: string | null,
    brandId?: string | null,
  ): Promise<Product[]> => {
    const supabase = createClient();
    let q = supabase
      .from("products")
      .select("*, categories(name)")
      .is("deleted_at", null)
      .order("name")
      .limit(200);
    const s = sanitizeIlike(search);
    if (s) {
      q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,barcode.ilike.%${s}%`);
    }
    if (categoryId) q = q.eq("category_id", categoryId);
    if (brandId) q = q.eq("brand_id", brandId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as Product[];
  },

  // Listado paginado server-side (.range + count exact). Búsqueda server-side por
  // nombre/SKU/código (ilike, saneada para no romper el filtro). Cargar bajo
  // demanda: trae solo la página pedida.
  listPaged: async (params: ProductsPageParams): Promise<Paged<Product>> => {
    const supabase = createClient();
    const { page, pageSize, search, categoryId, brandId } = params;
    const start = Math.max(0, (page - 1) * pageSize);
    const end = start + pageSize - 1;

    let q = supabase
      .from("products")
      .select("*, categories(name)", { count: "exact" })
      .is("deleted_at", null)
      .order("name");
    const s = sanitizeIlike(search);
    if (s) q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,barcode.ilike.%${s}%`);
    if (categoryId) q = q.eq("category_id", categoryId);
    if (brandId) q = q.eq("brand_id", brandId);

    const { data, error, count } = await q.range(start, end);
    if (error) throw error;
    return { rows: (data ?? []) as unknown as Product[], total: count ?? 0 };
  },

  // Busca por código de barras o SKU exacto (para escaneo). Matchea primero
  // contra variantes (barcode/sku propios) y, si no, contra productos. Cuando
  // matchea una variante devuelve el producto padre + la variante.
  findByCode: async (
    code: string,
  ): Promise<{ product: Product; variant?: ProductVariant } | null> => {
    const c = code.trim();
    // Solo códigos simples: evita romper el filtro .or() y inyección.
    if (!/^[A-Za-z0-9._\-]+$/.test(c)) return null;
    const supabase = createClient();

    // 1) Variante por barcode/sku (activa) → trae el producto padre.
    const { data: variant, error: vErr } = await supabase
      .from("product_variants")
      .select("*")
      .is("deleted_at", null)
      .or(`barcode.eq.${c},sku.eq.${c}`)
      .limit(1)
      .maybeSingle();
    if (vErr) throw vErr;
    if (variant) {
      const { data: parent, error: pErr } = await supabase
        .from("products")
        .select("*, categories(name)")
        .eq("id", (variant as ProductVariant).product_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (pErr) throw pErr;
      if (parent) {
        return {
          product: parent as unknown as Product,
          variant: variant as unknown as ProductVariant,
        };
      }
    }

    // 2) Producto por barcode/sku.
    const { data, error } = await supabase
      .from("products")
      .select("*, categories(name)")
      .is("deleted_at", null)
      .or(`barcode.eq.${c},sku.eq.${c}`)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { product: data as unknown as Product };
  },

  // Productos más vendidos (frecuentes) para la venta rápida del kiosco.
  top: async (limit = 12): Promise<Product[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("top_products", {
      p_limit: limit,
    });
    if (error) throw error;
    return (data ?? []) as unknown as Product[];
  },

  create: async (input: ProductOutput): Promise<Product> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("products")
      .insert({
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        category_id: input.category_id ?? null,
        brand_id: input.brand_id ?? null,
        price: input.price,
        cost: input.cost ?? null,
        stock: input.stock,
        stock_min: input.stock_min,
        unit: input.unit,
        tax_rate: input.tax_rate,
        season: input.season,
        tags: toTags(input.tags),
        image_url: input.image_url,
        description: input.description,
        is_active: input.is_active,
        is_kit: input.is_kit,
        is_serialized: input.is_serialized,
        has_variants: input.has_variants,
        track_stock: input.track_stock,
        allow_negative:
          input.allow_negative === "inherit"
            ? null
            : input.allow_negative === "yes",
        warranty_months: input.warranty_months,
      })
      .select("*")
      .single();
    if (error) throw error;
    return data as unknown as Product;
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
        brand_id: input.brand_id ?? null,
        price: input.price,
        cost: input.cost ?? null,
        stock_min: input.stock_min,
        unit: input.unit,
        tax_rate: input.tax_rate,
        season: input.season,
        tags: toTags(input.tags),
        description: input.description,
        is_active: input.is_active,
        is_kit: input.is_kit,
        is_serialized: input.is_serialized,
        has_variants: input.has_variants,
        track_stock: input.track_stock,
        allow_negative:
          input.allow_negative === "inherit"
            ? null
            : input.allow_negative === "yes",
        warranty_months: input.warranty_months,
        // image_url no se toca en update: en edición la maneja la galería
        // (ProductImages). El campo URL del form aplica al crear.
      })
      .eq("id", id);
    if (error) throw error;
  },

  // Componentes de un kit/combo.
  kitComponents: async (kitId: string): Promise<KitComponent[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_kit_components")
      .select("id, component_product_id, quantity, products!product_kit_components_component_product_id_fkey(name)")
      .eq("kit_product_id", kitId);
    if (error) throw error;
    type Row = {
      id: string;
      component_product_id: string;
      quantity: number;
      products: { name: string } | { name: string }[] | null;
    };
    return ((data ?? []) as unknown as Row[]).map((r) => {
      const p = Array.isArray(r.products) ? r.products[0] : r.products;
      return {
        id: r.id,
        componentProductId: r.component_product_id,
        name: p?.name ?? "—",
        quantity: r.quantity,
      };
    });
  },

  // Reemplaza la lista de componentes del kit (borra y vuelve a insertar).
  saveKitComponents: async (
    kitId: string,
    components: { componentProductId: string; quantity: number }[],
  ): Promise<void> => {
    const supabase = createClient();
    const del = await supabase
      .from("product_kit_components")
      .delete()
      .eq("kit_product_id", kitId);
    if (del.error) throw del.error;
    if (components.length === 0) return;
    const ins = await supabase.from("product_kit_components").insert(
      components.map((c) => ({
        kit_product_id: kitId,
        component_product_id: c.componentProductId,
        quantity: c.quantity,
      })),
    );
    if (ins.error) throw ins.error;
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

    // H34: auditoría del import (cantidad creada/errores) — best effort, no bloquea.
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await supabase.from("audit_logs").insert({
        actor_user_id: user?.id ?? null,
        entity_type: "products",
        entity_id: null,
        action: "imported",
        after_data: { total: payload.length, created: payload.length },
      });
    } catch (e) {
      console.warn("H34 audit (products import) falló:", e);
    }

    return payload.length;
  },
};

// Aplana el árbol de categorías (por parent_id) a una lista en orden de árbol
// con la profundidad de cada una (0 = nivel 1). Reusado en el form y el modal.
export function flattenCategories(
  list: Category[],
): { cat: Category; depth: number }[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of list) {
    const k = c.parent_id ?? null;
    const arr = byParent.get(k) ?? [];
    arr.push(c);
    byParent.set(k, arr);
  }
  const out: { cat: Category; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const c of kids) {
      out.push({ cat: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// Máxima profundidad permitida (4 niveles: depth 0..3).
export const CATEGORY_MAX_DEPTH = 3;

export type WarrantyPlan = Tables<"warranty_plans">;

export const warrantyPlansApi = {
  list: async (activeOnly = false): Promise<WarrantyPlan[]> => {
    const supabase = createClient();
    let q = supabase.from("warranty_plans").select("*").order("sort").order("label");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as WarrantyPlan[];
  },
  create: async (v: {
    label: string;
    months: number;
    price: number;
    price_pct: number;
    commission_pct: number;
    description: string | null;
  }): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("warranty_plans").insert(v);
    if (error) throw error;
  },
  setActive: async (id: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("warranty_plans").update({ is_active }).eq("id", id);
    if (error) throw error;
  },
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("warranty_plans").delete().eq("id", id);
    if (error) throw error;
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
      .insert({ name: input.name, parent_id: input.parent_id ?? null })
      .select("*")
      .single();
    if (error) throw error;
    return data as Category;
  },

  rename: async (id: string, name: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("categories")
      .update({ name })
      .eq("id", id);
    if (error) throw error;
  },

  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const now = new Date().toISOString();
    // Baja lógica recursiva: la categoría y TODOS sus descendientes (hasta 4
    // niveles). El .or de hijos directos dejaba nietos/bisnietos huérfanos.
    const { data: all } = await supabase
      .from("categories")
      .select("id, parent_id")
      .is("deleted_at", null);
    const childrenOf = new Map<string, string[]>();
    for (const c of all ?? []) {
      const p = (c as { parent_id: string | null }).parent_id;
      if (!p) continue;
      const arr = childrenOf.get(p) ?? [];
      arr.push((c as { id: string }).id);
      childrenOf.set(p, arr);
    }
    const ids: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      ids.push(cur);
      for (const child of childrenOf.get(cur) ?? []) stack.push(child);
    }
    const { error } = await supabase
      .from("categories")
      .update({ deleted_at: now })
      .in("id", ids);
    if (error) throw error;
  },
};

export type ProductVariant = Tables<"product_variants">;

// Etiqueta corta de la variante para el carrito/ticket: "M / Rojo" (o solo "M").
export function variantLabel(v: Pick<ProductVariant, "option1" | "option2">): string {
  return v.option2 ? `${v.option1} / ${v.option2}` : v.option1;
}

// Precio efectivo de una variante: override propio o precio base del padre.
export function variantPrice(
  v: Pick<ProductVariant, "price_override">,
  basePrice: number,
): number {
  return v.price_override ?? basePrice;
}

// Fila editable de variante en el form. id ausente = alta nueva.
export interface VariantRow {
  id?: string;
  option1: string;
  option2: string | null;
  sku: string | null;
  barcode: string | null;
  price_override: number | null;
  stock: number;
}

export const variantsApi = {
  // Variantes activas de un producto, ordenadas por eje 1 / eje 2.
  list: async (productId: string): Promise<ProductVariant[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", productId)
      .is("deleted_at", null)
      .order("option1")
      .order("option2", { nullsFirst: true });
    if (error) throw error;
    return (data ?? []) as ProductVariant[];
  },

  // Upsert masivo: filas con id se actualizan, sin id se insertan. No borra
  // (la baja se hace explícita con remove). Persiste también variant_axes y
  // marca has_variants en el producto padre.
  bulkUpsert: async (
    productId: string,
    tenantId: string,
    rows: VariantRow[],
    axes: string[],
  ): Promise<void> => {
    const supabase = createClient();

    // Pre-check de gating (Fase D): variantes es feature gateada. Cortesía
    // client-side — corta antes de tocar la DB con un error amigable. El
    // enforcement server-side estricto para variantes llegará con RLS más fina
    // (policy sobre product_variants que invoque tenant_has_feature) en una
    // iteración posterior; por ahora la barrera dura es a nivel UI + esta RPC.
    const { data: allowed, error: gateErr } = await supabase.rpc(
      "tenant_has_feature",
      { p_key: "variantes" },
    );
    if (gateErr) throw gateErr;
    if (!allowed) {
      throw new Error(
        "Las variantes no están incluidas en tu plan. Mejorá tu plan para usarlas.",
      );
    }

    const toInsert = rows.filter((r) => !r.id);
    const toUpdate = rows.filter((r) => r.id);

    if (toInsert.length) {
      const { error } = await supabase.from("product_variants").insert(
        toInsert.map((r) => ({
          tenant_id: tenantId,
          product_id: productId,
          option1: r.option1,
          option2: r.option2,
          sku: r.sku,
          barcode: r.barcode,
          price_override: r.price_override,
          stock: r.stock,
        })),
      );
      if (error) throw error;
    }

    for (const r of toUpdate) {
      const { error } = await supabase
        .from("product_variants")
        .update({
          option1: r.option1,
          option2: r.option2,
          sku: r.sku,
          barcode: r.barcode,
          price_override: r.price_override,
          stock: r.stock,
        })
        .eq("id", r.id!)
        .eq("tenant_id", tenantId);
      if (error) throw error;
    }

    const { error: prodErr } = await supabase
      .from("products")
      .update({ has_variants: true, variant_axes: axes })
      .eq("id", productId);
    if (prodErr) throw prodErr;
  },

  // Baja lógica de una variante.
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("product_variants")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },
};

export type ProductSerial = Tables<"product_serials">;

export const serialsApi = {
  list: async (productId: string): Promise<ProductSerial[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_serials")
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as ProductSerial[];
  },

  add: async (productId: string, serials: string[]): Promise<void> => {
    const clean = Array.from(
      new Set(serials.map((s) => s.trim()).filter(Boolean)),
    );
    if (clean.length === 0) return;
    const supabase = createClient();
    // Ignora duplicados existentes (unique product_id+serial).
    const { error } = await supabase
      .from("product_serials")
      .upsert(
        clean.map((serial) => ({ product_id: productId, serial })),
        { onConflict: "product_id,serial", ignoreDuplicates: true },
      );
    if (error) throw error;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    // Solo se borran los disponibles; los vendidos quedan como histórico.
    const { error } = await supabase
      .from("product_serials")
      .delete()
      .eq("id", id)
      .eq("status", "in_stock");
    if (error) throw error;
  },
};

export const brandsApi = {
  list: async (): Promise<Brand[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("brands")
      .select("*")
      .is("deleted_at", null)
      .order("name");
    if (error) throw error;
    return (data ?? []) as Brand[];
  },

  create: async (name: string): Promise<Brand> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("brands")
      .insert({ name })
      .select("*")
      .single();
    if (error) throw error;
    return data as Brand;
  },

  update: async (id: string, name: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("brands").update({ name }).eq("id", id);
    if (error) throw error;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("brands")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },
};
