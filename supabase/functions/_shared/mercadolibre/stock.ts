// =============================================================================
// _shared/mercadolibre/stock.ts (H87 · ADR-104). PURO (cliente inyectado).
//
// Stock POS -> ML, siempre VALOR ABSOLUTO (nunca deltas), calculado al
// momento de enviar (ml_stock_snapshot) y con coalescing en la cola: el
// último valor gana.
//
// Cómo se escribe según la cuenta y la publicación (doc "Stock distribuido",
// "Convivencia Full/Flex", 2026):
//   • item            PUT /items/{id} {available_quantity}. Caso típico de
//                     pyme (sin multi-origen ni Full). En User Products ML
//                     replica a los demás ítems del mismo UP.
//   • item_variations Clásico con variaciones: PUT /items/{id} {variations}
//                     con TODAS las variaciones (las que no van se borran).
//   • selling_address Full + Flex (MLA): stock propio del UP en
//                     PUT /user-products/{id}/stock/type/selling_address con el
//                     header x-version del último GET; 409 = versión vieja:
//                     re-GET y reintento. El de Full lo maneja ML.
//   • seller_warehouse Multi-origen: v2 (mapeo de depósitos, ml_location_map).
//   • full_only       Sólo Full: ML es la fuente de verdad, no se empuja.
// Límite del recurso de stock de UP: 100 RPM (familia "stock" del gate).
// =============================================================================
import { MlApiError, type MlClient } from "./client.ts";
import type { MlItem, MlUserProductStock } from "./types.ts";

export type StockMode = "item" | "item_variations" | "selling_address" | "seller_warehouse" | "full_only";

export function stockModeFrom(
  item: Pick<MlItem, "variations" | "user_product_id" | "shipping">,
  upStock: MlUserProductStock | null,
): StockMode {
  const types = new Set((upStock?.locations ?? []).map((l) => l.type));
  if (types.has("seller_warehouse")) return "seller_warehouse";
  if (types.has("selling_address")) return "selling_address";
  if (item.shipping?.logistic_type === "fulfillment" && (types.size === 0 || [...types].every((t) => t === "meli_facility"))) {
    return "full_only";
  }
  return (item.variations ?? []).length > 0 && !item.user_product_id ? "item_variations" : "item";
}

/** Cantidad publicable: entero >= 0 (ML no acepta decimales ni negativos). */
export function publishableQty(qty: number | null | undefined): number {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 99_999);
}

export interface StockPushResult {
  mode: StockMode;
  attempts: number;
  version: string | null;
}

/** selling_address con x-version y reintento ante 409. */
export async function pushSellingAddress(
  client: MlClient,
  userProductId: string,
  qty: number,
  maxAttempts = 3,
): Promise<StockPushResult> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const got = await client.request<MlUserProductStock>("GET", `/user-products/${encodeURIComponent(userProductId)}/stock`);
    const version = got.headers.get("x-version");
    if (!version) throw new MlApiError("bad_request", "Mercado Libre no devolvió la versión del stock (x-version).", 400, false);
    try {
      await client.request("PUT", `/user-products/${encodeURIComponent(userProductId)}/stock/type/selling_address`, {
        body: { quantity: publishableQty(qty) },
        headers: { "x-version": version },
      });
      return { mode: "selling_address", attempts: attempt, version };
    } catch (e) {
      if (e instanceof MlApiError && e.code === "conflict") {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof MlApiError
    ? lastErr
    : new MlApiError("conflict", "El stock cambió en Mercado Libre varias veces seguidas; se reintenta.", 409, true, 2_000);
}

export async function pushItemQuantity(client: MlClient, itemId: string, qty: number): Promise<StockPushResult> {
  await client.request("PUT", `/items/${encodeURIComponent(itemId)}`, { body: { available_quantity: publishableQty(qty) } });
  return { mode: "item", attempts: 1, version: null };
}

/** Clásico con variaciones: manda todas, con la cantidad nueva en las vinculadas. */
export async function pushVariationQuantities(
  client: MlClient,
  itemId: string,
  updates: Map<string, number>,
): Promise<StockPushResult> {
  const item = await client.get<MlItem>(`/items/${encodeURIComponent(itemId)}`, { attributes: "id,variations" });
  const variations = (item.variations ?? []).map((v) => ({
    id: v.id,
    available_quantity: updates.has(String(v.id)) ? publishableQty(updates.get(String(v.id))) : (v.available_quantity ?? 0),
  }));
  if (variations.length === 0) return pushItemQuantity(client, itemId, [...updates.values()][0] ?? 0);
  await client.request("PUT", `/items/${encodeURIComponent(itemId)}`, { body: { variations } });
  return { mode: "item_variations", attempts: 1, version: null };
}
