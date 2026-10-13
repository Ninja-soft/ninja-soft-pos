import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { parseBearer } from "./hashing";
import { MAX_BODY_BYTES, zodDetails } from "./schemas";

// Capa HTTP de /api/v1 (ADR-094). La ruta NO decide el negocio ni tiene
// service_role: valida forma y tamaño, y llama a la RPC pública con la anon
// key pasando el token tal cual. La RPC resuelve el negocio desde el token.

export type ApiEnvelope = {
  status: number;
  body: unknown;
  rate?: { limit: number; remaining: number; reset: number; retry_after?: number };
};

export const API_VERSION = "v1";

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders?: Record<string, string>,
): NextResponse {
  return respond({ status, body: { error: details === undefined ? { code, message } : { code, message, details } } }, extraHeaders);
}

export function respond(env: ApiEnvelope, extraHeaders?: Record<string, string>): NextResponse {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Api-Version": API_VERSION,
    "X-Request-Id": randomUUID(),
    ...extraHeaders,
  };
  if (env.rate) {
    headers["RateLimit-Limit"] = String(env.rate.limit);
    headers["RateLimit-Remaining"] = String(env.rate.remaining);
    headers["RateLimit-Reset"] = String(env.rate.reset);
    if (env.status === 429) headers["Retry-After"] = String(env.rate.retry_after ?? env.rate.reset);
  }
  if (env.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="ninjasoft-api"';
  return NextResponse.json(env.body ?? {}, { status: env.status, headers });
}

function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("supabase_env_missing");
  return createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Llama a una RPC pública de la API y devuelve su sobre. */
export async function callApiRpc(fn: string, args: Record<string, unknown>): Promise<ApiEnvelope> {
  try {
    const { data, error } = await supabase().rpc(fn as never, args as never);
    if (error) {
      return { status: 503, body: { error: { code: "unavailable", message: "Servicio no disponible. Reintentá." } } };
    }
    const env = data as ApiEnvelope | null;
    if (!env || typeof env.status !== "number") {
      return { status: 500, body: { error: { code: "internal_error", message: "Respuesta inválida." } } };
    }
    return env;
  } catch {
    return { status: 503, body: { error: { code: "unavailable", message: "Servicio no disponible. Reintentá." } } };
  }
}

/** Token del header Authorization o una respuesta 401. */
export function requireBearer(req: Request): string | NextResponse {
  const token = parseBearer(req.headers.get("authorization"));
  return token ?? apiError(401, "invalid_token", "Falta el token Bearer o no es válido.", undefined, {
    "WWW-Authenticate": 'Bearer realm="ninjasoft-api"',
  });
}

/** Idempotency-Key opcional (validada en la base). */
export function idempotencyKey(req: Request): string | null | NextResponse {
  const k = req.headers.get("idempotency-key");
  if (k == null || k === "") return null;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(k)) {
    return apiError(400, "invalid_idempotency_key", "Idempotency-Key: de 8 a 128 caracteres (letras, números, . _ : -).");
  }
  return k;
}

/** Cuerpo JSON con límite de tamaño. */
export async function readJson(req: Request): Promise<unknown | NextResponse> {
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(ct)) {
    return apiError(415, "unsupported_media_type", "Content-Type tiene que ser application/json.");
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return apiError(413, "payload_too_large", `El cuerpo supera ${MAX_BODY_BYTES} bytes.`);
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return apiError(413, "payload_too_large", `El cuerpo supera ${MAX_BODY_BYTES} bytes.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return apiError(400, "invalid_json", "El cuerpo no es JSON válido.");
  }
}

/** Valida con Zod o devuelve un 422 con los detalles. */
export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> | NextResponse {
  const r = schema.safeParse(input);
  if (!r.success) return apiError(422, "validation_error", "Datos inválidos.", zodDetails(r.error));
  return r.data as z.infer<S>;
}

/** Query string a objeto (la última aparición gana). */
export function queryObject(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}
