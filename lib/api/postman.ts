// Colección de Postman v2.1 de la API pública v1, generada desde
// lib/api/spec.ts (ADR-159). Se arma en el navegador del dueño: el secreto
// sólo entra si lo acaba de crear o rotar (se muestra una vez) y él decide
// incluirlo; nunca pasa por un servidor de NinjaSoft.

import { API_BASE_PATH, API_DESCRIPTION, API_TITLE, ENDPOINTS, RESOURCES, SANDBOX_DOC, type EndpointSpec } from "./spec";

export const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

export interface PostmanOptions {
  /** https://dominio (sin /api/v1). */
  origin: string;
  clientId?: string | null;
  /** Sólo si el dueño lo acaba de ver y eligió incluirlo. */
  clientSecret?: string | null;
  environment?: "live" | "test";
  /** Para tests: id fijo. */
  id?: string;
  /** Base de la API (por defecto /api/v1; el sandbox público usa /api/sandbox/v1, ADR-163). */
  basePath?: string;
  /** Colección del sandbox público: credenciales de ejemplo (públicas) y dataset ficticio. */
  demo?: boolean;
}

type Json = Record<string, unknown>;

// Pre-request de la colección: pide (o renueva) el token solo. Lee las
// variables con pm.variables (colección o entorno) y guarda el token en la
// colección. No corre en el propio pedido de token.
export const PREREQUEST_SCRIPT = [
  "if (!pm.request.url.getPath().endsWith('/oauth/token')) {",
  "  const exp = Number(pm.collectionVariables.get('access_token_expires_at') || 0);",
  "  if (!pm.collectionVariables.get('access_token') || Date.now() > exp - 60000) {",
  "    pm.sendRequest({",
  "      url: pm.variables.get('base_url') + '/oauth/token',",
  "      method: 'POST',",
  "      header: { 'Content-Type': 'application/x-www-form-urlencoded' },",
  "      body: { mode: 'urlencoded', urlencoded: [",
  "        { key: 'grant_type', value: 'client_credentials' },",
  "        { key: 'client_id', value: pm.variables.get('client_id') },",
  "        { key: 'client_secret', value: pm.variables.get('client_secret') }",
  "      ] }",
  "    }, (err, res) => {",
  "      if (err || res.code !== 200) { console.warn('No se pudo obtener el token', err || res.text()); return; }",
  "      const body = res.json();",
  "      pm.collectionVariables.set('access_token', body.access_token);",
  "      pm.collectionVariables.set('access_token_expires_at', String(Date.now() + body.expires_in * 1000));",
  "    });",
  "  }",
  "}",
];

const TOKEN_TEST_SCRIPT = [
  "if (pm.response.code === 200) {",
  "  const body = pm.response.json();",
  "  pm.collectionVariables.set('access_token', body.access_token);",
  "  pm.collectionVariables.set('access_token_expires_at', String(Date.now() + body.expires_in * 1000));",
  "}",
];

function requestDescription(e: EndpointSpec): string {
  const parts = [e.description];
  if (e.scope) parts.push(`**Alcance:** \`${e.scope}\``);
  if (e.body?.description) parts.push(e.body.description);
  if (e.itemErrors?.length) {
    parts.push("**Errores por ítem:**\n" + e.itemErrors.map((x) => `- \`${x.code}\`: ${x.description}`).join("\n"));
  }
  parts.push(`**Sandbox:** ${e.sandbox}`);
  for (const n of e.notes ?? []) parts.push(n);
  return parts.join("\n\n");
}

function postmanRequest(e: EndpointSpec): Json {
  const path = e.path.replace(/^\//, "").split("/");
  const query = e.params
    .filter((p) => p.in === "query")
    .map((p) => ({
      key: p.name,
      value: p.example !== undefined ? String(p.example) : p.default !== undefined ? String(p.default) : "",
      description: p.description,
      disabled: !p.required,
    }));
  const header: Json[] = [];
  const req: Json = {
    method: e.method,
    header,
    url: {
      raw: `{{base_url}}${e.path}`,
      host: ["{{base_url}}"],
      path,
      ...(query.length ? { query } : {}),
    },
    description: requestDescription(e),
  };

  if (e.auth === "client_credentials") {
    req.auth = { type: "noauth" };
    header.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
    req.body = {
      mode: "urlencoded",
      urlencoded: [
        { key: "grant_type", value: "client_credentials", type: "text" },
        { key: "client_id", value: "{{client_id}}", type: "text" },
        { key: "client_secret", value: "{{client_secret}}", type: "text" },
      ],
    };
  } else if (e.body) {
    header.push({ key: "Content-Type", value: "application/json" });
    for (const p of e.params.filter((x) => x.in === "header")) {
      header.push({ key: p.name, value: "{{$guid}}", description: p.description, disabled: false });
    }
    req.body = { mode: "raw", raw: JSON.stringify(e.body.example, null, 2), options: { raw: { language: "json" } } };
  }
  return req;
}

function item(e: EndpointSpec): Json {
  const it: Json = {
    name: e.title,
    request: postmanRequest(e),
    response: [
      {
        name: `Ejemplo ${e.response.status}`,
        originalRequest: postmanRequest(e),
        status: "OK",
        code: e.response.status,
        _postman_previewlanguage: "json",
        header: [{ key: "Content-Type", value: "application/json" }],
        body: JSON.stringify(e.response.example, null, 2),
      },
    ],
  };
  if (e.auth === "client_credentials") {
    it.event = [{ listen: "test", script: { type: "text/javascript", exec: TOKEN_TEST_SCRIPT } }];
  }
  return it;
}

function fallbackId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : "00000000-0000-4000-8000-000000000000";
}

export function buildPostmanCollection(opts: PostmanOptions): Json {
  const baseUrl = opts.origin.replace(/\/+$/, "") + (opts.basePath ?? API_BASE_PATH);
  const env = opts.environment ?? (opts.clientId?.startsWith("nsc_test_") ? "test" : "live");
  const hasSecret = Boolean(opts.clientSecret);
  const name = `${API_TITLE} v1${opts.demo ? " (sandbox público)" : env === "test" ? " (prueba)" : ""}`;
  const intro = [
    API_DESCRIPTION,
    "**Cómo se usa:** completá `client_id` y `client_secret` en las variables de la colección (o en un entorno). El primer pedido obtiene el token solo y lo renueva antes de que venza; también podés correr \"Obtener un token\" a mano.",
    opts.demo
      ? "**Sandbox público:** apunta a un negocio ficticio con las credenciales de ejemplo, que son públicas. Las escrituras se simulan y no se guardan. Para tu negocio, cambiá base_url a /api/v1 y cargá tu credencial."
      : hasSecret
      ? "**Atención:** esta colección incluye el client_secret. Tratala como una contraseña: no la compartas ni la subas a un repositorio."
      : "El client_secret no viene incluido: pegalo en la variable `client_secret`.",
    env === "test" ? `**Sandbox:** ${SANDBOX_DOC.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    info: {
      _postman_id: opts.id ?? fallbackId(),
      name,
      description: intro,
      schema: POSTMAN_SCHEMA,
    },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{access_token}}", type: "string" }] },
    event: [{ listen: "prerequest", script: { type: "text/javascript", exec: PREREQUEST_SCRIPT } }],
    variable: [
      { key: "base_url", value: baseUrl, type: "string" },
      { key: "client_id", value: opts.clientId ?? "", type: "string" },
      { key: "client_secret", value: hasSecret ? (opts.clientSecret as string) : "", type: "secret" },
      { key: "access_token", value: "", type: "secret" },
      { key: "access_token_expires_at", value: "", type: "string" },
    ],
    item: RESOURCES.map((r) => ({
      name: r.title,
      description: r.description,
      item: ENDPOINTS.filter((e) => e.resource === r.id).map(item),
    })).filter((f) => (f.item as unknown[]).length > 0),
  };
}

/** Nombre de archivo sugerido. */
export function postmanFileName(environment: "live" | "test"): string {
  return `ninjasoft-api-v1${environment === "test" ? "-prueba" : ""}.postman_collection.json`;
}
