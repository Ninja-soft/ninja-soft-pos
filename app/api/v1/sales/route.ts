import { listHandler } from "@/lib/api-publica/handlers";
import { salesQuerySchema } from "@/lib/api-publica/schemas";

// GET /api/v1/sales (scope sales:read): ventas por rango, sólo lectura. ADR-094.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listHandler(req, salesQuerySchema, "api_v1_sales_list", "created_at", (q, c) => ({
    p_from: q.from,
    p_to: q.to,
    p_store_id: q.store_id ?? null,
    p_limit: q.limit ?? null,
    p_after_created: c.t ?? null,
    p_after_id: c.id ?? null,
  }));
}
