import type { NextResponse } from "next/server";
import type { z } from "zod";
import { decodeIdCursor, decodeKeyset, nextCursor } from "./cursor";
import {
  apiError,
  callApiRpc,
  idempotencyKey,
  isResponse,
  queryObject,
  readJson,
  requireBearer,
  respond,
  validate,
} from "./http";

// Handlers genéricos de /api/v1 (ADR-094): lectura paginada por cursor y
// escritura en lote con Idempotency-Key. Cada ruta sólo declara su esquema y
// su RPC.

type Body = { data?: unknown; next?: unknown };

/** Lote: POST {items: [...]} -> RPC (p_token, p_items, p_idempotency_key). */
export async function batchHandler(req: Request, schema: z.ZodTypeAny, rpc: string): Promise<NextResponse> {
  const token = requireBearer(req);
  if (isResponse(token)) return token;
  const key = idempotencyKey(req);
  if (isResponse(key)) return key;
  const raw = await readJson(req);
  if (isResponse(raw)) return raw;
  const body = validate(schema, raw);
  if (isResponse(body)) return body;
  const env = await callApiRpc(rpc, {
    p_token: token,
    p_items: (body as { items: unknown[] }).items,
    p_idempotency_key: key,
  });
  const replayed = Boolean((env as { replayed?: boolean }).replayed);
  return respond(env, replayed ? { "Idempotent-Replayed": "true" } : undefined);
}

/**
 * Lectura paginada. `toArgs` arma los parámetros de la RPC desde la consulta
 * validada y el cursor decodificado; `timeKey` dice qué fecha lleva el cursor
 * (o ninguna si es sólo por id).
 */
export async function listHandler<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
  rpc: string,
  timeKey: "updated_at" | "created_at" | null,
  toArgs: (q: z.infer<S>, cursor: { t?: string; id?: string }) => Record<string, unknown>,
): Promise<NextResponse> {
  const token = requireBearer(req);
  if (isResponse(token)) return token;
  const q = validate(schema, queryObject(req));
  if (isResponse(q)) return q;
  const rawCursor = (q as { cursor?: string }).cursor;
  let cursor: { t?: string; id?: string } = {};
  if (rawCursor) {
    if (timeKey) {
      const c = decodeKeyset(rawCursor);
      if (!c) return apiError(400, "invalid_cursor", "Cursor inválido.");
      cursor = { t: c.t, id: c.id };
    } else {
      const c = decodeIdCursor(rawCursor);
      if (!c) return apiError(400, "invalid_cursor", "Cursor inválido.");
      cursor = { id: c.id };
    }
  }
  const env = await callApiRpc(rpc, { p_token: token, ...toArgs(q, cursor) });
  if (env.status === 200 && env.body && typeof env.body === "object") {
    const b = env.body as Body;
    env.body = { data: b.data ?? [], next_cursor: nextCursor(b.next, timeKey ?? undefined) };
  }
  return respond(env);
}

/** Respuesta 405 con Allow. */
export function methodNotAllowed(allow: string): NextResponse {
  return apiError(405, "method_not_allowed", "Método no permitido.", undefined, { Allow: allow });
}
