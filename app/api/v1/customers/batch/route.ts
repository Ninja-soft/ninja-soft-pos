import { batchHandler } from "@/lib/api-publica/handlers";
import { customersUpsertSchema } from "@/lib/api-publica/schemas";

// POST /api/v1/customers/batch (scope customers:write): alta y edición por id
// o external_id, hasta 500 por pedido. ADR-094.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return batchHandler(req, customersUpsertSchema, "api_v1_customers_upsert");
}
