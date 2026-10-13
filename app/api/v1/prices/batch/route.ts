import { batchHandler } from "@/lib/api-publica/handlers";
import { pricesUpdateSchema } from "@/lib/api-publica/schemas";

// POST /api/v1/prices/batch (scope prices:write): precio y costo por SKU. ADR-094.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return batchHandler(req, pricesUpdateSchema, "api_v1_prices_update");
}
