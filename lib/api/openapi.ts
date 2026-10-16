// OpenAPI 3.1 de la API pública v1, generado desde lib/api/spec.ts (ADR-159).
// Puro: sin dependencias de Next ni del navegador (lo usan la ruta
// /api/openapi.json, el botón de descarga del portal y los tests).

import { SCOPE_INFO } from "@/lib/api-publica/scopes";
import {
  API_BASE_PATH,
  API_DESCRIPTION,
  API_TITLE,
  ENDPOINTS,
  ERRORS,
  MODELS,
  RESOURCES,
  SANDBOX_DOC,
  type EndpointSpec,
  type FieldSpec,
  type ModelId,
} from "./spec";

type Json = Record<string, unknown>;

export const OPENAPI_VERSION = "3.1.0";
export const API_DOC_VERSION = "1.0.0";

/** FieldSpec a JSON Schema (2020-12, el de OpenAPI 3.1). */
export function fieldSchema(f: FieldSpec): Json {
  const s: Json = {};
  const base = f.type;
  s.type = f.nullable ? [base, "null"] : base;
  if (f.format) s.format = f.format;
  if (f.enum) s.enum = f.nullable ? [...f.enum, null] : [...f.enum];
  if (f.items) s.items = { type: f.items };
  if (f.fields && base === "array") s.items = objectSchema(f.fields, false);
  if (f.fields && base === "object") Object.assign(s, objectSchema(f.fields, false));
  if (f.minimum !== undefined) s.minimum = f.minimum;
  if (f.maximum !== undefined) s.maximum = f.maximum;
  if (f.minLength !== undefined) s.minLength = f.minLength;
  if (f.maxLength !== undefined) s.maxLength = f.maxLength;
  if (f.default !== undefined) s.default = f.default;
  if (f.example !== undefined) s.examples = [f.example];
  s.description = f.description;
  return s;
}

function objectSchema(fields: FieldSpec[], strict: boolean): Json {
  const properties: Json = {};
  for (const f of fields) properties[f.name] = fieldSchema(f);
  const required = fields.filter((f) => f.required).map((f) => f.name);
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    ...(strict ? { additionalProperties: false } : {}),
  };
}

const modelRef = (m: ModelId) => ({ $ref: `#/components/schemas/${m}` });

/** Esquema del cuerpo de la respuesta exitosa según su forma. */
export function responseSchema(e: EndpointSpec): Json {
  const r = e.response;
  if (r.shape === "token") return modelRef(r.model);
  if (r.shape === "page") {
    return {
      type: "object",
      required: ["data", "next_cursor"],
      properties: { data: { type: "array", items: modelRef(r.model) }, next_cursor: { type: ["string", "null"] } },
    };
  }
  if (r.shape === "data") {
    return { type: "object", required: ["data"], properties: { data: { type: "array", items: modelRef(r.model) } } };
  }
  const summary: Json = {};
  for (const k of r.summary ?? []) summary[k] = { type: "integer" };
  return {
    type: "object",
    required: ["summary", "results"],
    properties: {
      summary: { type: "object", properties: summary },
      results: { type: "array", items: modelRef(r.model) },
      dry_run: { type: "boolean", description: "Sólo con credencial de prueba: nada se guardó." },
    },
  };
}

const RATE_HEADERS = {
  "RateLimit-Limit": { schema: { type: "integer" }, description: "Pedidos por minuto de la credencial." },
  "RateLimit-Remaining": { schema: { type: "integer" }, description: "Pedidos que quedan en la ventana." },
  "RateLimit-Reset": { schema: { type: "integer" }, description: "Segundos hasta que se libera la ventana." },
  "X-Ninja-Environment": { schema: { type: "string", enum: ["live", "test"] }, description: "Ambiente de la credencial." },
};

function requestBody(e: EndpointSpec): Json | undefined {
  if (!e.body) return undefined;
  const b = e.body;
  let schema: Json;
  if (b.itemFields) {
    schema = {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", minItems: 1, maxItems: 500, items: objectSchema(b.itemFields, true) } },
    };
  } else {
    schema = objectSchema(b.fields ?? [], false);
  }
  const content: Json = { [b.contentType]: { schema, example: b.example } };
  if (b.contentType === "application/x-www-form-urlencoded") {
    content["application/json"] = { schema, example: b.example };
  }
  return { required: true, description: b.description, content };
}

function statusesOf(e: EndpointSpec): number[] {
  const set = new Set<number>();
  for (const code of e.errors) {
    const spec = ERRORS.find((x) => x.code === code);
    if (spec) set.add(spec.status);
  }
  return [...set].sort((a, b) => a - b);
}

function operation(e: EndpointSpec): Json {
  const responses: Json = {
    [String(e.response.status)]: {
      description: e.response.description,
      headers: RATE_HEADERS,
      content: { "application/json": { schema: responseSchema(e), example: e.response.example } },
    },
  };
  for (const st of statusesOf(e)) {
    const codes = e.errors.filter((c) => ERRORS.find((x) => x.code === c)?.status === st);
    responses[String(st)] = {
      description: codes.join(", "),
      content: {
        "application/json": {
          schema: e.auth === "client_credentials" ? { $ref: "#/components/schemas/OAuthError" } : { $ref: "#/components/schemas/Error" },
        },
      },
    };
  }
  const op: Json = {
    operationId: e.id.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase()),
    tags: [RESOURCES.find((r) => r.id === e.resource)?.title ?? e.resource],
    summary: e.title,
    description: [e.description, ...(e.notes ?? [])].join("\n\n"),
    parameters: e.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: Boolean(p.required),
      description: p.description,
      schema: fieldSchema({ ...p, description: p.description }),
    })),
    responses,
    security: e.auth === "client_credentials" ? [{ basicAuth: [] }, {}] : [{ oauth2: e.scope ? [e.scope] : [] }],
    "x-ninja-sandbox": e.sandbox,
  };
  if (e.itemErrors?.length) op["x-ninja-item-errors"] = e.itemErrors;
  const body = requestBody(e);
  if (body) op.requestBody = body;
  return op;
}

/** Documento OpenAPI 3.1. `origin` = https://dominio (sin /api/v1). */
export function buildOpenApi(origin: string): Json {
  const base = origin.replace(/\/+$/, "") + API_BASE_PATH;
  const paths: Json = {};
  for (const e of ENDPOINTS) {
    const item = (paths[e.path] as Json | undefined) ?? {};
    item[e.method.toLowerCase()] = operation(e);
    paths[e.path] = item;
  }
  const scopes: Json = {};
  for (const [k, v] of Object.entries(SCOPE_INFO)) scopes[k] = `${v.label}. ${v.desc}`;
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: API_TITLE,
      version: API_DOC_VERSION,
      description: `${API_DESCRIPTION}\n\nSandbox: ${SANDBOX_DOC.summary}`,
    },
    servers: [{ url: base, description: "Producción y sandbox (el ambiente lo define la credencial)" }],
    tags: RESOURCES.map((r) => ({ name: r.title, description: r.description })),
    paths,
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          description: "Token Bearer de 1 hora obtenido con client_credentials.",
          flows: { clientCredentials: { tokenUrl: `${base}/oauth/token`, scopes } },
        },
        basicAuth: { type: "http", scheme: "basic", description: "client_id:client_secret, sólo en /oauth/token." },
      },
      schemas: {
        ...Object.fromEntries(
          Object.values(MODELS).map((m) => [m.id, { title: m.title, ...objectSchema(m.fields, false) }]),
        ),
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: ERRORS.map((x) => x.code) },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
        OAuthError: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" }, error_description: { type: "string" } },
        },
      },
    },
    "x-ninja-errors": ERRORS,
  };
}
