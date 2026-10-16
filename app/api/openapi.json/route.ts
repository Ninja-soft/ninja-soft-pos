import { NextResponse } from "next/server";
import { buildOpenApi } from "@/lib/api/openapi";

// GET /api/openapi.json (ADR-159): especificación OpenAPI 3.1 de la API
// pública v1, generada desde lib/api/spec.ts. Pública (sin sesión, ver
// lib/api-publica/paths.ts): no tiene datos de ningún negocio.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  return NextResponse.json(buildOpenApi(origin), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
