// Tiendita — capa de datos del addon "Catálogos precargados" (panel interno).
// Las tablas catalog_* y las RPC no están en types/database.ts (no se regenera
// por decisión del proyecto): accedemos vía un cliente "destipado" (cast a any)
// SÓLO para estas tablas/funciones nuevas. Las funciones públicas de este
// módulo siguen fuertemente tipadas.
import { createClient } from "@/lib/supabase/client";

export interface CatalogStore {
  key: string;
  name: string;
  logoUrl: string | null;
  productCount: number;
  lastImportAt: string | null;
}

export interface Catalog {
  id: string;
  key: string;
  name: string;
  description: string | null;
  coverUrl: string | null;
  priceArs: number;
  dedupeByEan: boolean;
  isActive: boolean;
  createdAt: string;
  storeKeys: string[];
  // Conteo de productos del catálogo (deduplicado si dedupe_by_ean).
  productCount: number;
  // Cuántos tenants lo compraron/recibieron.
  purchaseCount: number;
}

export interface CatalogInput {
  id: string | null;
  key: string | null;
  name: string;
  description: string;
  coverUrl: string;
  priceArs: number;
  dedupeByEan: boolean;
  isActive: boolean;
  storeKeys: string[];
}

export interface CatalogGrant {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  source: "paid" | "granted";
  pricePaid: number | null;
  purchasedAt: string;
}

export const CATALOG_ASSETS_BUCKET = "catalog-assets";

// Cliente "destipado" para tablas/RPC de Tiendita ausentes en database.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): AnyDb {
  return createClient() as AnyDb;
}

export const catalogsApi = {
  // Tiendas de origen con su conteo de productos.
  listStores: async (): Promise<CatalogStore[]> => {
    const { data, error } = await db()
      .from("catalog_stores")
      .select("key, name, logo_url, product_count, last_import_at")
      .order("name");
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((s) => ({
      key: s.key as string,
      name: s.name as string,
      logoUrl: (s.logo_url as string) ?? null,
      productCount: Number(s.product_count ?? 0),
      lastImportAt: (s.last_import_at as string) ?? null,
    }));
  },

  // Catálogos con composición de tiendas, conteo de productos (deduplicado) y
  // cantidad de compras. Se arma con varias consultas chicas (sin vistas).
  listCatalogs: async (): Promise<Catalog[]> => {
    const supabase = db();
    const { data: cats, error } = await supabase
      .from("catalogs")
      .select(
        "id, key, name, description, cover_url, price_ars, dedupe_by_ean, is_active, created_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw error;

    const catRows = (cats ?? []) as Record<string, unknown>[];
    const ids = catRows.map((c) => c.id as string);
    if (ids.length === 0) return [];

    const [{ data: maps }, { data: purchases }] = await Promise.all([
      supabase
        .from("catalog_store_map")
        .select("catalog_id, store_key")
        .in("catalog_id", ids),
      supabase
        .from("tenant_catalog_purchases")
        .select("catalog_id")
        .in("catalog_id", ids),
    ]);

    const storesByCatalog = new Map<string, string[]>();
    for (const m of (maps ?? []) as Record<string, unknown>[]) {
      const cid = m.catalog_id as string;
      const arr = storesByCatalog.get(cid) ?? [];
      arr.push(m.store_key as string);
      storesByCatalog.set(cid, arr);
    }
    const purchasesByCatalog = new Map<string, number>();
    for (const p of (purchases ?? []) as Record<string, unknown>[]) {
      const cid = p.catalog_id as string;
      purchasesByCatalog.set(cid, (purchasesByCatalog.get(cid) ?? 0) + 1);
    }

    // Conteo de productos por catálogo vía RPC (deduplicado si corresponde).
    const counts = await Promise.all(
      ids.map(async (cid) => {
        const { data } = await supabase.rpc("catalog_product_count", {
          p_catalog_id: cid,
        });
        return [cid, Number(data ?? 0)] as const;
      }),
    );
    const countByCatalog = new Map<string, number>(counts);

    return catRows.map((c) => ({
      id: c.id as string,
      key: c.key as string,
      name: c.name as string,
      description: (c.description as string) ?? null,
      coverUrl: (c.cover_url as string) ?? null,
      priceArs: Number(c.price_ars ?? 0),
      dedupeByEan: Boolean(c.dedupe_by_ean),
      isActive: Boolean(c.is_active),
      createdAt: c.created_at as string,
      storeKeys: (storesByCatalog.get(c.id as string) ?? []).sort(),
      productCount: countByCatalog.get(c.id as string) ?? 0,
      purchaseCount: purchasesByCatalog.get(c.id as string) ?? 0,
    }));
  },

  // Setear/cambiar el logo de una tienda de origen (catalog_stores.logo_url).
  // La imagen se sube antes al bucket catalog-assets; acá persistimos la URL.
  // Pasá null/"" para quitar el logo. Sólo staff interno (gateado server-side).
  setStoreLogo: async (
    storeKey: string,
    logoUrl: string | null,
  ): Promise<void> => {
    const { error } = await db().rpc("internal_set_store_logo", {
      p_store_key: storeKey,
      p_logo_url: logoUrl,
    });
    if (error) throw error;
  },

  // Crear/editar catálogo + sincronizar sus tiendas, vía RPC transaccional.
  saveCatalog: async (input: CatalogInput): Promise<string> => {
    const { data, error } = await db().rpc("internal_save_catalog", {
      p_id: input.id,
      p_key: input.key,
      p_name: input.name,
      p_description: input.description || null,
      p_cover_url: input.coverUrl || null,
      p_price_ars: input.priceArs,
      p_dedupe_by_ean: input.dedupeByEan,
      p_is_active: input.isActive,
      p_store_keys: input.storeKeys,
    });
    if (error) throw error;
    return data as string;
  },

  // Tenants que compraron/recibieron un catálogo (para la pantalla de bonificar).
  listGrants: async (catalogId: string): Promise<CatalogGrant[]> => {
    const { data, error } = await db()
      .from("tenant_catalog_purchases")
      .select("tenant_id, source, price_paid, purchased_at, tenants(name, slug)")
      .eq("catalog_id", catalogId)
      .order("purchased_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map((r) => {
      const t = (r.tenants as Record<string, unknown>) ?? {};
      return {
        tenantId: r.tenant_id as string,
        tenantName: (t.name as string) ?? "—",
        tenantSlug: (t.slug as string) ?? "",
        source: (r.source as "paid" | "granted") ?? "granted",
        pricePaid: r.price_paid != null ? Number(r.price_paid) : null,
        purchasedAt: r.purchased_at as string,
      };
    });
  },

  // Bonificar: dar acceso gratis a un tenant (source='granted').
  grantCatalog: async (tenantId: string, catalogId: string): Promise<void> => {
    const { error } = await db().rpc("internal_grant_catalog", {
      p_tenant_id: tenantId,
      p_catalog_id: catalogId,
    });
    if (error) throw error;
  },

  // Revocar una bonificación (sólo grants).
  revokeCatalog: async (tenantId: string, catalogId: string): Promise<void> => {
    const { error } = await db().rpc("internal_revoke_catalog", {
      p_tenant_id: tenantId,
      p_catalog_id: catalogId,
    });
    if (error) throw error;
  },
};
