import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { MAX_BODY_BYTES } from "@/lib/api-publica/schemas";
import { clientIp, IpRateLimiter, rateHeaders } from "@/lib/api/ipRateLimit";
import { handleDemo, matchEndpoint, sandboxDecision, type DemoRequest } from "@/lib/api/sandboxDemo";
import { POST as tokenPost } from "@/app/api/v1/oauth/token/route";
import { GET as productsGet } from "@/app/api/v1/products/route";
import { POST as productsBatchPost } from "@/app/api/v1/products/batch/route";
import { POST as pricesBatchPost } from "@/app/api/v1/prices/batch/route";
import { GET as storesGet } from "@/app/api/v1/stores/route";
import { GET as stockGet } from "@/app/api/v1/stock/route";
import { POST as stockAdjustPost } from "@/app/api/v1/stock/adjustments/route";
import { GET as salesGet } from "@/app/api/v1/sales/route";
import { GET as customersGet } from "@/app/api/v1/customers/route";
import { POST as customersBatchPost } from "@/app/api/v1/customers/batch/route";

// Sandbox público de la API (ADR-163, H68b): /api/sandbox/v1/* sin login.
//   * Credenciales de ejemplo (públicas) -> dataset ficticio, sin base.
//   * Credencial de prueba propia (nsc_test_ / nsat_test_) -> la misma ruta
//     de /api/v1; la base hace dry_run por el ambiente de la credencial.
//   * Credencial de producción -> rechazada acá, nunca llega a la base.
// Límite por IP (además del límite por credencial de la base).
export const dynamic = "force-dynamic";

type Handler = (req: Request) => Response | Promise<Response>;

const FORWARD: Record<string, Handler> = {
  "oauth.token": tokenPost,
  "products.list": productsGet,
  "products.batch": productsBatchPost,
  "prices.batch": pricesBatchPost,
  "stores.list": storesGet,
  "stock.list": stockGet,
  "stock.adjustments": stockAdjustPost,
  "sales.list": salesGet,
  "customers.list": customersGet,
  "customers.batch": customersBatchPost,
};

const limiter = new IpRateLimiter();

function json(status: number, body: unknown, headers: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Api-Version": "v1", "X-Request-Id": randomUUID(), "X-Robots-Tag": "noindex", ...headers },
  });
}

async function handle(req: Request, ctx: { params: { path?: string[] } }) {
  const rate = limiter.hit(clientIp(req.headers));
  const rh = rateHeaders(rate);
  if (!rate.allowed) {
    return json(429, { error: { code: "rate_limited", message: "Demasiados pedidos al sandbox público. Esperá un minuto." } }, rh);
  }

  const path = `/${(ctx.params.path ?? []).join("/")}`;
  const url = new URL(req.url);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return json(413, { error: { code: "payload_too_large", message: `El cuerpo supera ${MAX_BODY_BYTES} bytes.` } }, rh);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return json(413, { error: { code: "payload_too_large", message: `El cuerpo supera ${MAX_BODY_BYTES} bytes.` } }, rh);
  }
  const demoReq: DemoRequest = { method: req.method, path, query: url.searchParams, headers: req.headers, body };

  const decision = sandboxDecision(demoReq);
  if (decision.kind === "reject") return json(decision.status, decision.body, { ...rh, ...decision.headers });

  if (decision.kind === "forward") {
    const { endpoint } = matchEndpoint(req.method, path);
    const fwd = endpoint ? FORWARD[endpoint.id] : undefined;
    if (!fwd) return json(404, { error: { code: "not_found", message: "La ruta no existe." } }, rh);
    const headers = new Headers();
    for (const k of ["authorization", "content-type", "idempotency-key"]) {
      const v = req.headers.get(k);
      if (v) headers.set(k, v);
    }
    const target = new URL(`/api/v1${path}${url.search}`, url.origin);
    return fwd(new Request(target, { method: req.method, headers, body: body || undefined }));
  }

  const res = handleDemo(demoReq);
  return json(res.status, res.body, { ...rh, ...res.headers });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
