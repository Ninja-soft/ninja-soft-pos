import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { Paged } from "@/lib/utils/pagination";
import { sanitizeIlike } from "@/lib/utils/search";
import type {
  CategoryInput,
  ProductOutput,
  StockAdjustInput,
} from "./schemas";
import {
  StockAdjustSchema,
  MermaSchema,
  type MermaInput,
  ProductionSchema,
  type ProductionInput,
} from "./schemas";

export interface ProductsPageParams {
  page: number; // 1-based
  pageSize: number;
  search?: string;
  categoryId?: string | null;
  brandId?: string | null;
}

// `plu` (código corto de 6 dígitos) e `is_favorite`/`favorite_order` (botón
// rápido del POS · H36) aún no viven en los tipos generados (no se regeneran).
// Se exponen por intersección para tiparlos en toda la app.
export type Product = Tables<"products"> & {
  plu: string | null;
  is_favorite: boolean;
  favorite_order: number;
  // Servicio (F12 · H38): duración por defecto del turno (min) y % de comisión.
  service_duration_min: number | null;
  commission_pct: number | null;
  // Estación de preparación (F13 · H45): a qué pantalla del KDS rutea. null = sin estación.
  station: string | null;
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
      // Matchea también por PLU (código corto de 6 dígitos) para tipearlo en el POS.
      q = q.or(
        `name.ilike.%${s}%,sku.ilike.%${s}%,barcode.ilike.%${s}%,plu.ilike.%${s}%`,
      );
    }
    if (categoryId) q = q.eq("category_id", categoryId);
    if (brandId) q = q.eq("brand_id", brandId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as Product[];
  },

  // Productos ACTIVOS por una lista de ids (H40 — recompra rápida). Filtra los
  // dados de baja (deleted_at) e inactivos: el POS usa esto para resolver el
  // precio actual al "repetir última venta" y omitir lo que ya no se vende.
  getByIds: async (ids: string[]): Promise<Product[]> => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    const supabase = createClient();
    const { data, error } = await supabase
      .from("products")
      .select("*, categories(name)")
      .is("deleted_at", null)
      .eq("is_active", true)
      .in("id", unique);
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
    if (s)
      q = q.or(
        `name.ilike.%${s}%,sku.ilike.%${s}%,barcode.ilike.%${s}%,plu.ilike.%${s}%`,
      );
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

    // 2) Producto por barcode/sku/PLU (exacto). El PLU corto también resuelve acá.
    const { data, error } = await supabase
      .from("products")
      .select("*, categories(name)")
      .is("deleted_at", null)
      .or(`barcode.eq.${c},sku.eq.${c},plu.eq.${c}`)
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

  // Favoritos del POS (H36): productos/servicios marcados como botón rápido.
  // Orden por favorite_order y luego nombre. La RLS filtra por tenant.
  // `is_favorite`/`favorite_order` aún no están en los tipos generados: se
  // castea el nombre de tabla para poder filtrar/ordenar por esas columnas.
  favorites: async (): Promise<Product[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("products" as never)
      .select("*, categories(name)")
      .is("deleted_at", null)
      .eq("is_favorite", true)
      .order("favorite_order")
      .order("name")
      .limit(60);
    if (error) throw error;
    return (data ?? []) as unknown as Product[];
  },

  // Toggle del favorito desde el listado de productos (un toque, sin abrir el
  // form). `is_favorite` aún no está en los tipos generados: cast del payload.
  setFavorite: async (id: string, is_favorite: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("products")
      .update({ is_favorite } as never)
      .eq("id", id);
    if (error) throw error;
  },

  create: async (input: ProductOutput): Promise<Product> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("products")
      .insert({
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        // PLU vacío (null) → lo genera el trigger si el tenant lo tiene activo.
        plu: input.plu ?? null,
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
        // Botón rápido del POS (H36): favorito + orden.
        is_favorite: input.is_favorite,
        favorite_order: input.favorite_order,
        // Servicio (H38): duración del turno + comisión (null = producto normal).
        service_duration_min: input.service_duration_min ?? null,
        commission_pct: input.commission_pct ?? null,
        // Estación de preparación (F13 · H45): ruteo al KDS (null = sin estación).
        station: input.station ?? null,
        // `plu`/`is_favorite` aún no están en los tipos generados: casteamos el payload.
      } as never)
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
        // PLU editable a mano (6 dígitos) o vacío para quitarlo.
        plu: input.plu ?? null,
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
        // Botón rápido del POS (H36): favorito + orden.
        is_favorite: input.is_favorite,
        favorite_order: input.favorite_order,
        // Servicio (H38): duración del turno + comisión (null = producto normal).
        service_duration_min: input.service_duration_min ?? null,
        commission_pct: input.commission_pct ?? null,
        // Estación de preparación (F13 · H45): ruteo al KDS (null = sin estación).
        station: input.station ?? null,
        // image_url no se toca en update: en edición la maneja la galería
        // (ProductImages). El campo URL del form aplica al crear.
      } as never)
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

  // Registra una merma tipada (F13 · H50): descuenta `qty` del stock con el
  // sub-motivo (vencido/roto/preparación fallida/devolución/otro) vía
  // register_stock_waste. Devuelve el nuevo stock. La RPC no está en los tipos
  // generados → cast (la DB + RLS validan).
  registerWaste: async (
    productId: string,
    input: MermaInput,
  ): Promise<number> => {
    const supabase = createClient();
    const parsed = MermaSchema.parse(input);
    const { data, error } = await supabase.rpc("register_stock_waste" as never, {
      p_product_id: productId,
      p_qty: parsed.qty,
      p_loss_reason: parsed.reason,
      p_notes: parsed.notes ?? undefined,
    } as never);
    if (error) throw error;
    return data as number;
  },

  // Registra una producción / batch (F13 · H50): SUMA `qty` al stock del producto
  // preparado vía register_production. Devuelve el nuevo stock. RPC no tipada → cast.
  registerProduction: async (
    productId: string,
    input: ProductionInput,
  ): Promise<number> => {
    const supabase = createClient();
    const parsed = ProductionSchema.parse(input);
    const { data, error } = await supabase.rpc("register_production" as never, {
      p_product_id: productId,
      p_qty: parsed.qty,
      p_notes: parsed.notes ?? undefined,
    } as never);
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

// Estado del PLU del tenant (para el form de producto y el prompt del primer
// producto). `decided` indica si ya se le preguntó al tenant si quiere PLU.
export interface PluSettings {
  enabled: boolean;
  mode: "random" | "incremental";
  decided: boolean;
}

export const pluSettingsApi = {
  get: async (): Promise<PluSettings> => {
    const supabase = createClient();
    // plu_* y plu_prompted aún no están en los tipos generados: select("*") + cast.
    const { data } = await supabase.from("pos_settings").select("*").maybeSingle();
    const row =
      (data as unknown as {
        plu_enabled?: boolean;
        plu_mode?: string;
        plu_prompted?: boolean;
      } | null) ?? null;
    return {
      enabled: row?.plu_enabled ?? false,
      mode: row?.plu_mode === "incremental" ? "incremental" : "random",
      decided: row?.plu_prompted ?? false,
    };
  },

  // Resuelve el prompt del primer producto: marca que ya se preguntó y, si el
  // dueño aceptó, habilita el PLU con el modo elegido. Upsert por tenant_id.
  decide: async (accept: boolean, mode: "random" | "incremental"): Promise<void> => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("no_user");
    const { data: mem } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    const tenantId = (mem as { tenant_id?: string } | null)?.tenant_id;
    if (!tenantId) throw new Error("no_tenant");
    const { error } = await supabase.from("pos_settings").upsert(
      {
        tenant_id: tenantId,
        plu_prompted: true,
        ...(accept ? { plu_enabled: true, plu_mode: mode } : {}),
      } as never,
      { onConflict: "tenant_id" },
    );
    if (error) throw error;
  },
};

// Resuelve nombres → id contra una tabla con baja lógica (categories/brands),
// creando los faltantes. Devuelve un mapa case-insensitive nombre→id. Reusado
// para categoría y marca en el import. El tenant_id lo pone el default de la DB
// (la RLS ya filtra por tenant en el select).
async function resolveByName(
  supabase: ReturnType<typeof createClient>,
  table: "categories" | "brands",
  names: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(
    new Set(names.map((n) => n.trim()).filter((n) => n !== "")),
  );
  if (unique.length === 0) return map;

  const { data: existing } = await supabase
    .from(table)
    .select("id, name")
    .is("deleted_at", null);
  for (const c of (existing ?? []) as { id: string; name: string }[]) {
    map.set(c.name.toLowerCase(), c.id);
  }

  const missing = unique.filter((n) => !map.has(n.toLowerCase()));
  if (missing.length) {
    const { data: created, error } = await supabase
      .from(table)
      .insert(missing.map((name) => ({ name })))
      .select("id, name");
    if (error) throw error;
    for (const c of (created ?? []) as { id: string; name: string }[]) {
      map.set(c.name.toLowerCase(), c.id);
    }
  }
  return map;
}

// Inserta en lotes para no mandar un único INSERT gigantesco con archivos
// grandes (mantiene cada request acotado). Devuelve el total insertado.
async function insertChunked(
  supabase: ReturnType<typeof createClient>,
  table: "products" | "customers",
  payload: Record<string, unknown>[],
  size = 500,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < payload.length; i += size) {
    const chunk = payload.slice(i, i + size);
    const { error } = await supabase.from(table).insert(chunk as never);
    if (error) throw error;
    inserted += chunk.length;
  }
  return inserted;
}

export const productsImportApi = {
  bulkImport: async (
    rows: import("./import").ParsedProduct[],
  ): Promise<number> => {
    if (rows.length === 0) return 0;
    const supabase = createClient();

    // Resolver categoría y marca por nombre (crear las faltantes).
    const catMap = await resolveByName(
      supabase,
      "categories",
      rows.map((r) => r.category ?? "").filter(Boolean),
    );
    const brandMap = await resolveByName(
      supabase,
      "brands",
      rows.map((r) => r.brand ?? "").filter(Boolean),
    );

    const payload = rows.map((r) => ({
      name: r.name,
      // SKU vacío → null (queda a cargo de la DB / sin código interno).
      sku: r.sku,
      barcode: r.barcode,
      price: r.price,
      cost: r.cost,
      stock: r.stock,
      stock_min: r.stock_min,
      unit: r.unit,
      tax_rate: r.tax_rate,
      track_stock: r.track_stock,
      category_id: r.category
        ? (catMap.get(r.category.toLowerCase()) ?? null)
        : null,
      brand_id: r.brand ? (brandMap.get(r.brand.toLowerCase()) ?? null) : null,
    }));

    const created = await insertChunked(supabase, "products", payload);

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
        after_data: { total: created, created },
      });
    } catch (e) {
      console.warn("H34 audit (products import) falló:", e);
    }

    return created;
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

// Nodo del árbol de categorías: la categoría + sus hijos (recursivo) + la
// profundidad (0 = nivel 1) y el total de descendientes (para los contadores).
export interface CategoryTreeNode {
  cat: Category;
  depth: number;
  children: CategoryTreeNode[];
  descendantCount: number;
}

// Arma el árbol anidado de categorías a partir de la lista plana (parent_id).
// Cada nivel se ordena alfabéticamente. Reusado por el modal de categorías para
// el listado desglosable.
export function buildCategoryTree(list: Category[]): CategoryTreeNode[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of list) {
    const k = c.parent_id ?? null;
    const arr = byParent.get(k) ?? [];
    arr.push(c);
    byParent.set(k, arr);
  }
  const build = (parent: string | null, depth: number): CategoryTreeNode[] => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return kids.map((cat) => {
      const children = build(cat.id, depth + 1);
      const descendantCount = children.reduce(
        (acc, n) => acc + 1 + n.descendantCount,
        0,
      );
      return { cat, depth, children, descendantCount };
    });
  };
  return build(null, 0);
}

// Máxima profundidad permitida (10 niveles: depth 0..9).
// Es un tope de producto, no de base: en la DB `parent_id` es un self-FK sin
// límite de profundidad, así que el control vive acá y en la UI.
export const CATEGORY_MAX_DEPTH = 9;

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
    // Baja lógica recursiva: la categoría y TODOS sus descendientes (a cualquier
    // profundidad). El .or de hijos directos dejaba nietos/bisnietos huérfanos.
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
