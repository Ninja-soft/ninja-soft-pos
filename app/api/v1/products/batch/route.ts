import { batchHandler } from "@/lib/api-publica/handlers";
import { productsUpsertSchema } from "@/lib/api-publica/schemas";

// POST /api/v1/products/batch (scope products:write): alta y edición por SKU,
// hasta 500 por pedido, con Idempotency-Key opcional. ADR-094.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return batchHandler(req, productsUpsertSchema, "api_v1_products_upsert");
}
