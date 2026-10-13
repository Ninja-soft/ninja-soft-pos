import { listHandler } from "@/lib/api-publica/handlers";
import { stockQuerySchema } from "@/lib/api-publica/schemas";

// GET /api/v1/stock (scope stock:read): stock por sucursal. ADR-094.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listHandler(req, stockQuerySchema, "api_v1_stock_list", null, (q, c) => ({
    p_store_id: q.store_id ?? null,
    p_skus: q.sku ?? null,
    p_limit: q.limit ?? null,
    p_after_id: c.id ?? null,
  }));
}
