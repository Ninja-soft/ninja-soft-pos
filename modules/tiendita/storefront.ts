// Tiendita — storefront del CLIENTE (sección /tiendita del POS).
// Capa de datos del lado tenant: catálogos disponibles con su estado de acceso,
// buscador (catalog_search), agregar a mis productos (add_catalog_product_to_tenant)
// y el checkout de compra (pago único MP de NinjaSoft).
//
// Las tablas catalog_* y las RPC no están en types/database.ts (el proyecto no
// regenera los tipos): accedemos vía un cliente "destipado" (cast) SÓLO para
// estas tablas/funciones. Las funciones públicas de este módulo siguen tipadas.
import { createClient } from "@/lib/supabase/client";

// Catálogo tal como lo ve el cliente en el storefront.
export interface StorefrontCatalog {
  id: string;
  name: string;
  description: string | null;
  coverUrl: string | null;
  priceArs: number;
  // true si el tenant ya lo compró o lo recibió bonificado (paid | granted).
  owned: boolean;
  // Cómo lo obtuvo (si owned). Útil para el badge.
  source: "paid" | "granted" | null;
}

// Producto del catálogo (resultado del buscador). Mapea 1:1 con catalog_search.
export interface CatalogSearchResult {
  catalogProductId: number;
  storeKey: string;
  ean: string;
  titulo: string;
  precio: number | null;
  precioLista: number | null;
  marca: string | null;
  categoriaPath: string | null;
  fotoUrl: string | null;
  disponible: boolean;
}

// Cliente "destipado" para tablas/RPC de Tiendita ausentes en database.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): AnyDb {
  return createClient() as AnyDb;
}

export const storefrontApi = {
  // Catálogos activos + estado de acceso del tenant (una consulta a catalogs por
  // RLS — sólo ve los activos — y otra a sus compras/grants).
  listCatalogs: async (): Promise<StorefrontCatalog[]> => {
    const supabase = db();
    const [{ data: cats, error }, { data: purchases }] = await Promise.all([
      supabase
        .from("catalogs")
        .select("id, name, description, cover_url, price_ars")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("tenant_catalog_purchases")
        .select("catalog_id, source"),
    ]);
    if (error) throw error;

    const ownedBy = new Map<string, "paid" | "granted">();
    for (const p of (purchases ?? []) as Record<string, unknown>[]) {
      ownedBy.set(p.catalog_id as string, (p.source as "paid" | "granted") ?? "granted");
    }

    return ((cats ?? []) as Record<string, unknown>[]).map((c) => {
      const id = c.id as string;
      const source = ownedBy.get(id) ?? null;
      return {
        id,
        name: c.name as string,
        description: (c.description as string) ?? null,
        coverUrl: (c.cover_url as string) ?? null,
        priceArs: Number(c.price_ars ?? 0),
        owned: source != null,
        source,
      };
    });
  },

  // Buscar productos dentro de un catálogo (gateado por RLS/RPC a que el tenant
  // lo compró). Vacío = primeros productos del catálogo.
  search: async (
    catalogId: string,
    query: string,
    limit = 30,
    offset = 0,
  ): Promise<CatalogSearchResult[]> => {
    const { data, error } = await db().rpc("catalog_search", {
      p_catalog_id: catalogId,
      p_query: query,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      catalogProductId: Number(r.catalog_product_id),
      storeKey: r.store_key as string,
      ean: r.ean as string,
      titulo: r.titulo as string,
      precio: r.precio != null ? Number(r.precio) : null,
      precioLista: r.precio_lista != null ? Number(r.precio_lista) : null,
      marca: (r.marca as string) ?? null,
      categoriaPath: (r.categoria_path as string) ?? null,
      fotoUrl: (r.foto_url as string) ?? null,
      disponible: Boolean(r.disponible),
    }));
  },

  // Agregar un producto del catálogo a los products del tenant. Idempotente por
  // EAN (si ya lo tiene, devuelve el product existente). Devuelve el product id.
  addProduct: async (
    catalogId: string,
    catalogProductId: number,
  ): Promise<string> => {
    const { data, error } = await db().rpc("add_catalog_product_to_tenant", {
      p_catalog_id: catalogId,
      p_catalog_product_id: catalogProductId,
    });
    if (error) throw error;
    return data as string;
  },
};

// Inicia el checkout de compra de un catálogo (pago único). Devuelve el
// init_point de Mercado Pago al que redirigir. backUrl: a dónde vuelve MP.
// Errores honestos: si NinjaSoft no tiene su MP configurado, la Edge devuelve
// "platform_not_configured" y lo propagamos para mostrar un aviso claro.
export async function startCatalogCheckout(
  catalogId: string,
  backUrl: string,
): Promise<string> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(
    "catalog_purchase_checkout",
    { body: { catalog_id: catalogId, back_url: backUrl } },
  );
  // supabase-js mete el body de error en error.context; intentamos leer el
  // `error` estable que devuelve la función para dar un mensaje útil.
  if (error) {
    let code = "checkout_failed";
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) code = ((await ctx.json()) as { error?: string })?.error ?? code;
    } catch {
      /* sin cuerpo legible */
    }
    throw new Error(code);
  }
  const res = data as { init_point?: string; error?: string };
  if (res?.error || !res?.init_point) {
    throw new Error(res?.error ?? "no_init_point");
  }
  return res.init_point;
}
