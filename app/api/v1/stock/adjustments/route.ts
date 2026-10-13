import { batchHandler } from "@/lib/api-publica/handlers";
import { stockAdjustSchema } from "@/lib/api-publica/schemas";

// POST /api/v1/stock/adjustments (scope stock:write): ajustes y conteos por
// sucursal con motivo. ADR-094.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return batchHandler(req, stockAdjustSchema, "api_v1_stock_adjust");
}
