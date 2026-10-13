import { apiError } from "@/lib/api-publica/http";

// Cualquier otra ruta de /api/v1: 404 JSON consistente. ADR-094.
export const dynamic = "force-dynamic";

const notFound = () => apiError(404, "not_found", "Ruta inexistente. Ver /api/openapi.json.");
export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
