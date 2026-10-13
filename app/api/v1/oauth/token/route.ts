import { NextResponse } from "next/server";
import { callApiRpc } from "@/lib/api-publica/http";
import { parseBasic } from "@/lib/api-publica/hashing";
import { MAX_BODY_BYTES, tokenRequestSchema } from "@/lib/api-publica/schemas";

// POST /api/v1/oauth/token (ADR-094): OAuth2 client_credentials (RFC 6749
// §4.4). Credenciales por Basic o en el cuerpo (form o JSON). La base valida
// el secreto contra su hash, el plan (`api_publica`) y el límite por cliente.
// Los errores siguen el formato de OAuth: {error, error_description}.
export const dynamic = "force-dynamic";

function oauthError(status: number, error: string, description: string, extra?: Record<string, string>) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...extra } },
  );
}

export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return oauthError(413, "invalid_request", "Cuerpo demasiado grande.");

  const ct = req.headers.get("content-type") ?? "";
  let fields: Record<string, string> = {};
  try {
    const text = await req.text();
    if (text.length > 8192) return oauthError(413, "invalid_request", "Cuerpo demasiado grande.");
    if (/^application\/json\b/i.test(ct)) {
      const v = JSON.parse(text || "{}") as unknown;
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (typeof val === "string") fields[k] = val;
        }
      }
    } else {
      fields = Object.fromEntries(new URLSearchParams(text));
    }
  } catch {
    return oauthError(400, "invalid_request", "Cuerpo inválido.");
  }

  const parsed = tokenRequestSchema.safeParse(fields);
  if (!parsed.success) {
    return oauthError(400, fields.grant_type && fields.grant_type !== "client_credentials" ? "unsupported_grant_type" : "invalid_request",
      "Se espera grant_type=client_credentials.");
  }
  const basic = parseBasic(req.headers.get("authorization"));
  const clientId = basic?.clientId ?? parsed.data.client_id;
  const clientSecret = basic?.clientSecret ?? parsed.data.client_secret;
  if (!clientId || !clientSecret) return oauthError(401, "invalid_client", "Faltan client_id y client_secret.");

  const env = await callApiRpc("api_token_issue", {
    p_client_id: clientId,
    p_client_secret: clientSecret,
    p_scope: parsed.data.scope ?? null,
  });
  const headers: Record<string, string> = {};
  if (env.rate) {
    headers["RateLimit-Limit"] = String(env.rate.limit);
    headers["RateLimit-Remaining"] = String(env.rate.remaining);
    headers["RateLimit-Reset"] = String(env.rate.reset);
  }
  if (env.status === 200) {
    return NextResponse.json(env.body, { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...headers } });
  }
  const err = (env.body as { error?: { code?: string; message?: string } } | null)?.error;
  if (env.status === 429) headers["Retry-After"] = String(env.rate?.retry_after ?? env.rate?.reset ?? 60);
  if (env.status === 401) headers["WWW-Authenticate"] = 'Basic realm="ninjasoft-api"';
  return oauthError(env.status, err?.code ?? "server_error", err?.message ?? "Error.", headers);
}
