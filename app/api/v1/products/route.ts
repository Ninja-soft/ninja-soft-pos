import { listHandler } from "@/lib/api-publica/handlers";
import { productsQuerySchema } from "@/lib/api-publica/schemas";

// GET /api/v1/products (scope products:read). ADR-094.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listHandler(req, productsQuerySchema, "api_v1_products_list", "updated_at", (q, c) => ({
    p_limit: q.limit ?? null,
    p_after_updated: c.t ?? null,
    p_after_id: c.id ?? null,
    p_updated_since: q.updated_since ?? null,
    p_sku: q.sku ?? null,
    p_include_deleted: q.include_deleted ?? false,
  }));
}
