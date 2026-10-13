import { callApiRpc, isResponse, requireBearer, respond } from "@/lib/api-publica/http";

// GET /api/v1/stores (scope stock:read): sucursales del negocio. ADR-094.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = requireBearer(req);
  if (isResponse(token)) return token;
  return respond(await callApiRpc("api_v1_stores_list", { p_token: token }));
}
