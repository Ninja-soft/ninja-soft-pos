import { listHandler } from "@/lib/api-publica/handlers";
import { customersQuerySchema } from "@/lib/api-publica/schemas";

// GET /api/v1/customers (scope customers:read). ADR-094.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listHandler(req, customersQuerySchema, "api_v1_customers_list", "updated_at", (q, c) => ({
    p_limit: q.limit ?? null,
    p_after_updated: c.t ?? null,
    p_after_id: c.id ?? null,
    p_updated_since: q.updated_since ?? null,
    p_external_id: q.external_id ?? null,
    p_include_deleted: q.include_deleted ?? false,
  }));
}
