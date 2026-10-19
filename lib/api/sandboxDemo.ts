// Sandbox público de la API (ADR-163, H68b). Responde los 10 endpoints de la
// API v1 con el dataset ficticio de sandboxDataset.ts, sin base de datos ni
// negocio real: valida con los mismos esquemas Zod que /api/v1, devuelve las
// mismas formas (página con cursor, lote con resultado por ítem, errores) y
// las escrituras se simulan (dry_run) sin guardar nada, ni siquiera en
// memoria. Determinístico: el mismo pedido da siempre la misma respuesta.
//
// Las credenciales de ejemplo son públicas a propósito (se muestran en
// /developers). El token de ejemplo lleva los alcances en sus dos últimos
// dígitos hexa, así que insufficient_scope se puede probar igual que en
// producción.

import { createHash } from "node:crypto";
import type { z } from "zod";
import { decodeIdCursor, decodeKeyset, encodeIdCursor, encodeKeyset } from "@/lib/api-publica/cursor";
import { parseBasic } from "@/lib/api-publica/hashing";
import { API_SCOPES, isApiScope, type ApiScope } from "@/lib/api-publica/scopes";
import {
  MAX_BODY_BYTES,
  customersQuerySchema,
  customersUpsertSchema,
  pricesUpdateSchema,
  productsQuerySchema,
  productsUpsertSchema,
  salesQuerySchema,
  type ProductInclude,
  stockAdjustSchema,
  stockQuerySchema,
  tokenRequestSchema,
  zodDetails,
} from "@/lib/api-publica/schemas";
import { DEMO_CLIENT_ID, DEMO_CLIENT_SECRET, SANDBOX_BASE_PATH, isDemoClient } from "./sandboxConstants";
import { ENDPOINTS, TOKEN_TTL_SECONDS, type EndpointSpec } from "./spec";
import {
  DEMO_CUSTOMERS,
  DEMO_PRICE_LISTS,
  DEMO_PRODUCT_EXTRAS,
  DEMO_PRODUCTS,
  DEMO_SALES,
  DEMO_STOCK,
  DEMO_STORES,
  DEMO_VARIANTS,
  type DemoCustomer,
  type DemoProduct,
} from "./sandboxDataset";

export { SANDBOX_BASE_PATH, DEMO_CLIENT_ID, DEMO_CLIENT_SECRET, isDemoClient };

const DEMO_TOKEN_PREFIX = `nsat_test_${"0".repeat(62)}`;
const DEMO_TOKEN_RE = /^nsat_test_0{62}([0-9a-f]{2})$/;

export function isDemoToken(token: string | null | undefined): boolean {
  return Boolean(token && DEMO_TOKEN_RE.test(token));
}

/** Token de ejemplo con los alcances codificados (bit i = API_SCOPES[i]). */
export function demoToken(scopes: readonly ApiScope[]): string {
  let mask = 0;
  for (const s of scopes) mask |= 1 << API_SCOPES.indexOf(s);
  return DEMO_TOKEN_PREFIX + mask.toString(16).padStart(2, "0");
}

export function demoTokenScopes(token: string): ApiScope[] {
  const m = DEMO_TOKEN_RE.exec(token);
  if (!m || !m[1]) return [];
  const mask = parseInt(m[1], 16);
  return API_SCOPES.filter((_, i) => (mask & (1 << i)) !== 0);
}

export type DemoRequest = {
  method: string;
  /** Ruta relativa a la base, con barra inicial: /products/batch. */
  path: string;
  query: URLSearchParams;
  headers: { get(name: string): string | null };
  body: string;
};

export type DemoResponse = { status: number; headers: Record<string, string>; body: unknown };

const JSON_HEADERS = { "X-Ninja-Environment": "test", "X-Ninja-Dataset": "demo" };

function err(status: number, code: string, message: string, details?: unknown): DemoResponse {
  return {
    status,
    headers: { ...JSON_HEADERS, ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="ninjasoft-api"' } : {}) },
    body: { error: details === undefined ? { code, message } : { code, message, details } },
  };
}

function ok(body: unknown): DemoResponse {
  return { status: 200, headers: { ...JSON_HEADERS }, body };
}

function oauthErr(status: number, error: string, description: string): DemoResponse {
  return { status, headers: { ...JSON_HEADERS, "Cache-Control": "no-store" }, body: { error, error_description: description } };
}

/** Id simulado y estable para un alta (como los de la base en sandbox: no existen). */
export function simulatedId(kind: string, key: string): string {
  const h = createHash("sha256").update(`ninjasoft-sandbox:${kind}:${key}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Endpoint del spec para un método y una ruta (o null). */
export function matchEndpoint(method: string, path: string): { endpoint: EndpointSpec | null; pathExists: boolean } {
  const clean = path.replace(/\/+$/, "") || "/";
  const same = ENDPOINTS.filter((e) => e.path === clean);
  return { endpoint: same.find((e) => e.method === method.toUpperCase()) ?? null, pathExists: same.length > 0 };
}

// ── Token ───────────────────────────────────────────────────────────────────
function tokenFields(req: DemoRequest): Record<string, string> | null {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (/^application\/json\b/i.test(ct)) {
      const v = JSON.parse(req.body || "{}") as unknown;
      const out: Record<string, string> = {};
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string") out[k] = val;
      }
      return out;
    }
    return Object.fromEntries(new URLSearchParams(req.body));
  } catch {
    return null;
  }
}

/** client_id y secreto de un pedido de token (Basic o cuerpo). */
export function tokenCredentials(req: Pick<DemoRequest, "headers" | "body">): { clientId?: string; clientSecret?: string } {
  const basic = parseBasic(req.headers.get("authorization"));
  if (basic) return { clientId: basic.clientId, clientSecret: basic.clientSecret };
  const f = tokenFields({ method: "POST", path: "/oauth/token", query: new URLSearchParams(), ...req });
  return { clientId: f?.client_id, clientSecret: f?.client_secret };
}

function issueToken(req: DemoRequest): DemoResponse {
  if (req.body.length > 8192) return oauthErr(413, "invalid_request", "Cuerpo demasiado grande.");
  const fields = tokenFields(req);
  if (!fields) return oauthErr(400, "invalid_request", "Cuerpo inválido.");
  const parsed = tokenRequestSchema.safeParse(fields);
  if (!parsed.success) {
    return oauthErr(
      400,
      fields.grant_type && fields.grant_type !== "client_credentials" ? "unsupported_grant_type" : "invalid_request",
      "Se espera grant_type=client_credentials.",
    );
  }
  const { clientId, clientSecret } = tokenCredentials(req);
  if (!clientId || !clientSecret) return oauthErr(401, "invalid_client", "Faltan client_id y client_secret.");
  if (!isDemoClient(clientId, clientSecret)) {
    return oauthErr(401, "invalid_client", "client_id o client_secret incorrectos. Usá las credenciales de ejemplo.");
  }
  let scopes: ApiScope[] = [...API_SCOPES];
  const asked = parsed.data.scope?.trim();
  if (asked) {
    const list = Array.from(new Set(asked.split(/\s+/)));
    const bad = list.find((s) => !isApiScope(s));
    if (bad) return oauthErr(400, "invalid_scope", `El alcance ${bad} no existe o la credencial no lo tiene.`);
    scopes = API_SCOPES.filter((s) => list.includes(s));
  }
  return {
    status: 200,
    headers: { ...JSON_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" },
    body: {
      access_token: demoToken(scopes),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: scopes.join(" "),
      environment: "test",
    },
  };
}

// ── Utilidades de lectura ───────────────────────────────────────────────────
function queryObject(q: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  q.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): { ok: true; data: z.infer<S> } | { ok: false; res: DemoResponse } {
  const r = schema.safeParse(input);
  if (!r.success) return { ok: false, res: err(422, "validation_error", "Datos inválidos.", zodDetails(r.error)) };
  return { ok: true, data: r.data as z.infer<S> };
}

const ts = (s: string) => Date.parse(s);

type Keyed = { id: string };

/** Página por keyset (fecha, id) como las RPC api_v1_*_list. */
function keysetPage<T extends Keyed>(
  rows: T[],
  key: (r: T) => string,
  cursor: string | undefined,
  limit: number,
): { ok: true; body: unknown } | { ok: false; res: DemoResponse } {
  let list = [...rows].sort((a, b) => ts(key(a)) - ts(key(b)) || a.id.localeCompare(b.id));
  if (cursor) {
    const c = decodeKeyset(cursor);
    if (!c) return { ok: false, res: err(400, "invalid_cursor", "Cursor inválido.") };
    list = list.filter((r) => ts(key(r)) > ts(c.t) || (ts(key(r)) === ts(c.t) && r.id.localeCompare(c.id) > 0));
  }
  const page = list.slice(0, limit);
  const last = page[page.length - 1];
  const more = list.length > limit && last;
  return { ok: true, body: { data: page, next_cursor: more ? encodeKeyset(key(last), last.id) : null } };
}

function idPage<T extends Keyed>(rows: T[], cursor: string | undefined, limit: number) {
  let list = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  if (cursor) {
    const c = decodeIdCursor(cursor);
    if (!c) return { ok: false as const, res: err(400, "invalid_cursor", "Cursor inválido.") };
    list = list.filter((r) => r.id.localeCompare(c.id) > 0);
  }
  const page = list.slice(0, limit);
  const last = page[page.length - 1];
  return { ok: true as const, body: { data: page, next_cursor: list.length > limit && last ? encodeIdCursor(last.id) : null } };
}

const storeExists = (id: string) => DEMO_STORES.some((s) => s.id === id.toLowerCase());
const defaultStore = DEMO_STORES.find((s) => s.is_default)!;
const liveProducts = () => DEMO_PRODUCTS.filter((p) => !p.deleted_at);

// ── Lecturas ────────────────────────────────────────────────────────────────
function productsList(q: URLSearchParams): DemoResponse {
  const p = parse(productsQuerySchema, queryObject(q));
  if (!p.ok) return p.res;
  let rows = DEMO_PRODUCTS.filter((r) => p.data.include_deleted || !r.deleted_at);
  if (p.data.sku) rows = rows.filter((r) => r.sku === p.data.sku);
  if (p.data.ids) rows = rows.filter((r) => p.data.ids!.includes(r.id));
  if (p.data.updated_since) rows = rows.filter((r) => ts(r.updated_at) >= ts(p.data.updated_since!));
  const page = keysetPage(rows, (r) => r.updated_at, p.data.cursor, p.data.limit ?? 100);
  if (!page.ok) return page.res;
  const inc = p.data.include ?? [];
  if (!inc.length) return ok(page.body);
  const body = page.body as { data: DemoProduct[]; next_cursor: string | null };
  return ok({ ...body, data: body.data.map((r) => expandProduct(r, inc)) });
}

// Misma forma que _api_product_full_json (ADR-168), sobre el dataset ficticio.
function expandProduct(r: DemoProduct, inc: readonly ProductInclude[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r };
  const x = DEMO_PRODUCT_EXTRAS[r.id];
  const storeStock = inc.includes("stock");
  if (inc.includes("attributes")) {
    out.attributes = x?.attributes ?? [];
    out.category = x?.category ?? null;
    out.brand = x?.brand ?? null;
    out.tags = x?.tags ?? [];
    out.model = x?.model ?? null;
    out.season = x?.season ?? null;
    out.net_content = x?.net_content ?? null;
    out.net_content_unit = x?.net_content_unit ?? null;
  }
  if (inc.includes("images")) out.images = x?.images ?? [];
  if (inc.includes("price_lists")) {
    const now = Date.now();
    out.price_lists = DEMO_PRICE_LISTS.filter((l) => (!l.valid_from || ts(l.valid_from) <= now) && (!l.valid_to || now < ts(l.valid_to))).map((l) => ({
      id: l.id,
      name: l.name,
      channel: l.channel,
      kind: l.kind,
      price: Math.round(r.price * (1 + l.adjustment_pct / 100) * 100) / 100,
      prices_include_tax: l.prices_include_tax,
      valid_from: l.valid_from,
      valid_to: l.valid_to,
    }));
  }
  if (inc.includes("variants")) {
    out.variants = DEMO_VARIANTS.filter((v) => v.product_id === r.id).map(({ product_id: _p, stock_by_store, ...v }) => ({
      ...v,
      ...(storeStock ? { stock_by_store: stock_by_store.map((s) => ({ ...s, store_code: null })) } : {}),
    }));
  }
  if (storeStock) {
    out.stock_by_store = DEMO_STOCK.filter((s) => s.product_id === r.id).map((s) => ({
      store_id: s.store_id,
      store_code: null,
      store_name: DEMO_STORES.find((st) => st.id === s.store_id)?.name ?? null,
      qty: s.qty,
      min_qty: s.min_qty,
      max_qty: null,
      location: null,
    }));
  }
  return out;
}

function customersList(q: URLSearchParams): DemoResponse {
  const p = parse(customersQuerySchema, queryObject(q));
  if (!p.ok) return p.res;
  let rows = DEMO_CUSTOMERS.filter((r) => p.data.include_deleted || !r.deleted_at);
  if (p.data.external_id) rows = rows.filter((r) => r.external_id === p.data.external_id);
  if (p.data.updated_since) rows = rows.filter((r) => ts(r.updated_at) >= ts(p.data.updated_since!));
  const page = keysetPage(rows, (r) => r.updated_at, p.data.cursor, p.data.limit ?? 100);
  return page.ok ? ok(page.body) : page.res;
}

function storesList(): DemoResponse {
  return ok({ data: [...DEMO_STORES].sort((a, b) => Number(b.is_default) - Number(a.is_default)) });
}

function stockList(q: URLSearchParams): DemoResponse {
  const p = parse(stockQuerySchema, queryObject(q));
  if (!p.ok) return p.res;
  if (p.data.store_id && !storeExists(p.data.store_id)) return err(404, "store_not_found", "La sucursal no existe.");
  let rows = DEMO_STOCK;
  if (p.data.store_id) rows = rows.filter((r) => r.store_id === p.data.store_id!.toLowerCase());
  if (p.data.sku) rows = rows.filter((r) => r.sku != null && p.data.sku!.includes(r.sku));
  const page = idPage(rows, p.data.cursor, p.data.limit ?? 200);
  return page.ok ? ok(page.body) : page.res;
}

function salesList(q: URLSearchParams): DemoResponse {
  const p = parse(salesQuerySchema, queryObject(q));
  if (!p.ok) return p.res;
  if (p.data.store_id && !storeExists(p.data.store_id)) return err(404, "store_not_found", "La sucursal no existe.");
  const from = ts(p.data.from);
  const to = ts(p.data.to);
  let rows = DEMO_SALES.filter((s) => ts(s.created_at) >= from && ts(s.created_at) < to);
  if (p.data.store_id) rows = rows.filter((s) => s.store_id === p.data.store_id!.toLowerCase());
  const page = keysetPage(rows, (r) => r.created_at, p.data.cursor, p.data.limit ?? 50);
  return page.ok ? ok(page.body) : page.res;
}

// ── Escrituras simuladas ────────────────────────────────────────────────────
type Result = Record<string, unknown> & { index: number; status: string };

function batchBody(results: Result[], keys: readonly string[]): unknown {
  const summary: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of results) {
    const k = r.status === "error" ? "failed" : r.status;
    summary[k] = (summary[k] ?? 0) + 1;
  }
  return { summary, results, dry_run: true };
}

function readBatch<S extends z.ZodTypeAny>(req: DemoRequest, schema: S): { ok: true; data: z.infer<S> } | { ok: false; res: DemoResponse } {
  const k = req.headers.get("idempotency-key");
  if (k != null && k !== "" && !/^[A-Za-z0-9._:-]{8,128}$/.test(k)) {
    return { ok: false, res: err(400, "invalid_idempotency_key", "Idempotency-Key: de 8 a 128 caracteres (letras, números, . _ : -).") };
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return { ok: false, res: err(415, "unsupported_media_type", "Content-Type tiene que ser application/json.") };
  }
  if (Buffer.byteLength(req.body, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, res: err(413, "payload_too_large", `El cuerpo supera ${MAX_BODY_BYTES} bytes.`) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(req.body);
  } catch {
    return { ok: false, res: err(400, "invalid_json", "El cuerpo no es JSON válido.") };
  }
  return parse(schema, raw);
}

function changed<T extends object>(current: T, item: Record<string, unknown>, fields: (keyof T & string)[]): boolean {
  return fields.some((f) => item[f] !== undefined && item[f] !== (current as Record<string, unknown>)[f]);
}

const PRODUCT_FIELDS: (keyof DemoProduct & string)[] = [
  "name",
  "barcode",
  "description",
  "price",
  "cost",
  "unit",
  "is_active",
  "track_stock",
  "stock_min",
];

function productsBatch(req: DemoRequest): DemoResponse {
  const p = readBatch(req, productsUpsertSchema);
  if (!p.ok) return p.res;
  const results: Result[] = p.data.items.map((it, index) => {
    const current = liveProducts().find((x) => x.sku === it.sku);
    const base = { index, sku: it.sku };
    if (it.barcode) {
      const owner = liveProducts().find((x) => x.barcode === it.barcode);
      if (owner && owner.sku !== it.sku) return { ...base, status: "error", error: "barcode_in_use" };
    }
    if (!current) {
      if (!it.name) return { ...base, status: "error", error: "name_required" };
      return { ...base, id: simulatedId("product", it.sku), status: "created" };
    }
    return { ...base, id: current.id, status: changed(current, it, PRODUCT_FIELDS) ? "updated" : "unchanged" };
  });
  return ok(batchBody(results, ["created", "updated", "unchanged", "failed"]));
}

function pricesBatch(req: DemoRequest): DemoResponse {
  const p = readBatch(req, pricesUpdateSchema);
  if (!p.ok) return p.res;
  const results: Result[] = p.data.items.map((it, index) => {
    const current = liveProducts().find((x) => x.sku === it.sku && x.is_active);
    if (!current) return { index, sku: it.sku, status: "error", error: "product_not_found" };
    return { index, sku: it.sku, id: current.id, status: changed(current, it, ["price", "cost"]) ? "updated" : "unchanged" };
  });
  return ok(batchBody(results, ["updated", "unchanged", "failed"]));
}

function stockBatch(req: DemoRequest): DemoResponse {
  const p = readBatch(req, stockAdjustSchema);
  if (!p.ok) return p.res;
  const results: Result[] = p.data.items.map((it, index) => {
    const product = liveProducts().find((x) => x.sku === it.sku && x.is_active);
    if (!product) return { index, sku: it.sku, status: "error", error: "product_not_found" };
    if (product.has_variants) return { index, sku: it.sku, id: product.id, status: "error", error: "variants_not_supported" };
    const storeId = (it.store_id ?? defaultStore.id).toLowerCase();
    if (!storeExists(storeId)) return { index, sku: it.sku, id: product.id, status: "error", error: "store_not_found" };
    const current = DEMO_STOCK.find((r) => r.product_id === product.id && r.store_id === storeId)?.qty ?? 0;
    const qty = it.mode === "set" ? it.qty : Math.round((current + it.qty) * 1000) / 1000;
    const delta = Math.round((qty - current) * 1000) / 1000;
    return { index, sku: it.sku, id: product.id, store_id: storeId, status: delta === 0 ? "unchanged" : "adjusted", qty, delta };
  });
  return ok(batchBody(results, ["adjusted", "unchanged", "failed"]));
}

const CUSTOMER_FIELDS: (keyof DemoCustomer & string)[] = [
  "name",
  "email",
  "phone",
  "document_type",
  "document_number",
  "address",
  "iva_condition",
  "notes",
  "is_active",
];

function customersBatch(req: DemoRequest): DemoResponse {
  const p = readBatch(req, customersUpsertSchema);
  if (!p.ok) return p.res;
  const live = DEMO_CUSTOMERS.filter((c) => !c.deleted_at);
  const results: Result[] = p.data.items.map((it, index) => {
    const base: Result = { index, status: "error" };
    if (it.external_id) base.external_id = it.external_id;
    const byId = it.id ? live.find((c) => c.id === it.id!.toLowerCase()) : undefined;
    if (it.id && !byId) return { ...base, error: "customer_not_found" };
    const byExt = it.external_id ? live.find((c) => c.external_id === it.external_id) : undefined;
    if (byId && byExt && byExt.id !== byId.id) return { ...base, error: "external_id_in_use" };
    const current = byId ?? byExt;
    if (!current) {
      if (!it.name) return { ...base, error: "name_required" };
      return { ...base, id: simulatedId("customer", it.external_id ?? ""), status: "created" };
    }
    const ext = it.external_id !== undefined && it.external_id !== current.external_id;
    return { ...base, id: current.id, status: ext || changed(current, it, CUSTOMER_FIELDS) ? "updated" : "unchanged" };
  });
  return ok(batchBody(results, ["created", "updated", "unchanged", "failed"]));
}

// ── Entrada ─────────────────────────────────────────────────────────────────
const HANDLERS: Record<string, (req: DemoRequest) => DemoResponse> = {
  "oauth.token": issueToken,
  "products.list": (r) => productsList(r.query),
  "products.batch": productsBatch,
  "prices.batch": pricesBatch,
  "stores.list": () => storesList(),
  "stock.list": (r) => stockList(r.query),
  "stock.adjustments": stockBatch,
  "sales.list": (r) => salesList(r.query),
  "customers.list": (r) => customersList(r.query),
  "customers.batch": customersBatch,
};

/** Ids de endpoint que el sandbox público responde (test: todos los del spec). */
export const DEMO_ENDPOINT_IDS = Object.keys(HANDLERS);

export function handleDemo(req: DemoRequest): DemoResponse {
  const { endpoint, pathExists } = matchEndpoint(req.method, req.path);
  if (!endpoint) {
    return pathExists ? err(405, "method_not_allowed", "Método no soportado en esta ruta.") : err(404, "not_found", "La ruta no existe.");
  }
  const handler = HANDLERS[endpoint.id];
  if (!handler) return err(404, "not_found", "La ruta no existe.");
  if (endpoint.auth === "bearer") {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
    const token = m?.[1];
    if (!token || !isDemoToken(token)) return err(401, "invalid_token", "Falta el token Bearer o no es válido.");
    if (endpoint.scope && !demoTokenScopes(token).includes(endpoint.scope)) {
      return err(403, "insufficient_scope", `El token no tiene el alcance ${endpoint.scope}.`, { required: endpoint.scope });
    }
  }
  return handler(req);
}

// ── Qué hace la ruta pública con cada pedido ────────────────────────────────
export type SandboxDecision =
  | { kind: "demo" }
  | { kind: "forward" }
  | { kind: "reject"; status: number; body: unknown; headers?: Record<string, string> };

const LIVE_REJECT_MESSAGE =
  "La página pública sólo acepta credenciales de prueba (nsc_test_, nss_test_, nsat_test_). Las de producción se usan directo contra /api/v1.";

/**
 * Decide si un pedido al sandbox público se responde con el dataset ficticio,
 * se pasa a /api/v1 (credencial de prueba propia: la base hace dry_run) o se
 * rechaza (credencial de producción). El prefijo alcanza para decidir: la base
 * tiene un check que ata el prefijo al ambiente de la credencial (ADR-159).
 */
export function sandboxDecision(req: Pick<DemoRequest, "method" | "path" | "headers" | "body">): SandboxDecision {
  const { endpoint } = matchEndpoint(req.method, req.path);
  if (!endpoint) return { kind: "demo" };
  if (endpoint.auth === "client_credentials") {
    const { clientId, clientSecret } = tokenCredentials(req);
    if (!clientId || isDemoClient(clientId)) return { kind: "demo" };
    if (clientId.startsWith("nsc_test_") && (clientSecret ?? "").startsWith("nss_test_")) return { kind: "forward" };
    return {
      kind: "reject",
      status: 401,
      body: { error: "invalid_client", error_description: LIVE_REJECT_MESSAGE },
      headers: { "Cache-Control": "no-store" },
    };
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  const token = m?.[1];
  if (!token || isDemoToken(token)) return { kind: "demo" };
  if (token.startsWith("nsat_test_")) return { kind: "forward" };
  return {
    kind: "reject",
    status: 403,
    body: { error: { code: "sandbox_only", message: LIVE_REJECT_MESSAGE } },
  };
}
