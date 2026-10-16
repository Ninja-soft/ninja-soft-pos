// Documentación de la API v1 en un HTML autocontenido (ADR-163, H68b),
// generada desde lib/api/spec.ts igual que el portal, el OpenAPI y Postman.
// Sin recursos externos (ni fuentes, ni scripts, ni imágenes): se abre sin
// conexión, se adjunta o se reenvía. Trae hoja de estilos de impresión para
// guardarla como PDF desde el navegador (Imprimir > Guardar como PDF).

import { snippet } from "./snippets";
import { DEMO_CLIENT_ID, DEMO_CLIENT_SECRET, DEVELOPERS_PATH, DOCS_HTML_PATH, SANDBOX_BASE_PATH } from "./sandboxConstants";
import {
  API_BASE_PATH,
  API_DESCRIPTION,
  API_TITLE,
  API_VERSION,
  AUTH_DOC,
  ENDPOINTS,
  ERRORS,
  MODELS,
  OPENAPI_PATH,
  RATE_LIMIT_DOC,
  RESOURCES,
  RESPONSE_FORMAT_DOC,
  SANDBOX_DOC,
  errorSpec,
  scopeList,
  type EndpointSpec,
  type FieldSpec,
  type ParamSpec,
} from "./spec";

export { DOCS_HTML_PATH, DEVELOPERS_PATH };
export const DOCS_FILE_NAME = "ninjasoft-api-v1.html";

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const e = escapeHtml;

function typeLabel(f: FieldSpec): string {
  let t: string = f.type;
  if (f.format) t += ` (${f.format})`;
  if (f.nullable) t += " | null";
  return t;
}

function constraints(f: FieldSpec): string {
  const out: string[] = [];
  if (f.enum) out.push(`Valores: ${f.enum.join(", ")}`);
  if (f.minLength !== undefined || f.maxLength !== undefined) out.push(`Largo ${f.minLength ?? 0} a ${f.maxLength ?? "sin tope"}`);
  if (f.minimum !== undefined || f.maximum !== undefined) out.push(`Rango ${f.minimum ?? "sin piso"} a ${f.maximum ?? "sin tope"}`);
  if (f.default !== undefined) out.push(`Por defecto ${String(f.default)}`);
  return out.join(" · ");
}

function fieldRows(fields: (FieldSpec | ParamSpec)[], showRequired: boolean, prefix = ""): string {
  return fields
    .map((f) => {
      const name = prefix ? `${prefix}.${f.name}` : f.name;
      const req = showRequired ? (f.required ? "obligatorio" : "opcional") : "";
      const extra = constraints(f);
      const row = `<tr><td><code>${e(name)}</code>${"in" in f && f.in === "header" ? ' <span class="tag">header</span>' : ""}</td><td><code>${e(typeLabel(f))}</code></td>${
        showRequired ? `<td>${e(req)}</td>` : ""
      }<td>${e(f.description)}${extra ? `<br><small>${e(extra)}</small>` : ""}</td></tr>`;
      const nested = f.fields?.length ? fieldRows(f.fields, showRequired, f.type === "array" ? `${name}[]` : name) : "";
      return row + nested;
    })
    .join("");
}

function fieldTable(fields: (FieldSpec | ParamSpec)[], showRequired = true): string {
  if (!fields.length) return "";
  return `<table><thead><tr><th>Campo</th><th>Tipo</th>${showRequired ? "<th>Uso</th>" : ""}<th>Descripción</th></tr></thead><tbody>${fieldRows(
    fields,
    showRequired,
  )}</tbody></table>`;
}

function code(v: unknown): string {
  return `<pre><code>${e(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</code></pre>`;
}

const SHAPE_TEXT: Record<EndpointSpec["response"]["shape"], string> = {
  token: "El cuerpo es el token.",
  page: "{ data: [...], next_cursor }. Cada elemento de data:",
  data: "{ data: [...] }. Cada elemento de data:",
  batch: "{ summary, results: [...] }. Cada elemento de results:",
};

function endpointSection(ep: EndpointSpec, origin: string): string {
  const query = ep.params.filter((p) => p.in === "query");
  const headers = ep.params.filter((p) => p.in === "header");
  const errs = ep.errors.map((c) => errorSpec(c)).filter((x): x is NonNullable<typeof x> => Boolean(x));
  return `<section class="endpoint" id="${e(ep.id)}">
<h3><span class="method">${e(ep.method)}</span> ${e(ep.title)}</h3>
<p class="path"><code>${e(API_BASE_PATH + ep.path)}</code></p>
<p>${e(ep.description)}</p>
<p><small>${ep.scope ? `Alcance: <code>${e(ep.scope)}</code>` : "Credenciales: client_id y client_secret"} · ${
    ep.auth === "bearer" ? "Authorization: Bearer" : "Basic o en el cuerpo"
  }</small></p>
${(ep.notes ?? []).map((n) => `<p>${e(n)}</p>`).join("")}
${query.length ? `<h4>Parámetros de la URL</h4>${fieldTable(query)}` : ""}
${headers.length ? `<h4>Headers</h4>${fieldTable(headers)}` : ""}
${
  ep.body
    ? `<h4>Cuerpo (${e(ep.body.contentType)})</h4><p>${e(ep.body.description)}</p>${
        ep.body.itemFields ? fieldTable(ep.body.itemFields) : ""
      }${ep.body.fields ? fieldTable(ep.body.fields) : ""}<p><small>Ejemplo de cuerpo</small></p>${code(ep.body.example)}`
    : ""
}
<h4>Respuesta ${e(ep.response.status)}</h4>
<p>${e(ep.response.description)} ${e(SHAPE_TEXT[ep.response.shape])}</p>
${fieldTable(MODELS[ep.response.model].fields, false)}
<p><small>Ejemplo de respuesta</small></p>${code(ep.response.example)}
${
  ep.itemErrors?.length
    ? `<h4>Errores por ítem (en results[], el pedido responde 200)</h4><table><tbody>${ep.itemErrors
        .map((x) => `<tr><td><code>${e(x.code)}</code></td><td>${e(x.description)}</td></tr>`)
        .join("")}</tbody></table>`
    : ""
}
<h4>Errores posibles</h4>
<table><tbody>${errs.map((x) => `<tr><td>${e(x.status)}</td><td><code>${e(x.code)}</code></td><td>${e(x.description)}</td></tr>`).join("")}</tbody></table>
<p><strong>Con una credencial de prueba:</strong> ${e(ep.sandbox)}</p>
<h4>Ejemplo (curl)</h4>${code(snippet("curl", ep, origin))}
</section>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#14121f;--muted:#5d5a6e;--soft:#f3f2f7;--line:#e2e0ea;--accent:#4b3fd1}
@media (prefers-color-scheme:dark){:root{--bg:#09051c;--fg:#ecebf3;--muted:#a6a3b8;--soft:#16122b;--line:#2a2545;--accent:#a99fff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:21px;margin:40px 0 10px;padding-top:8px}h3{font-size:17px;margin:28px 0 6px}h4{font-size:14px;margin:18px 0 6px}
p,li{color:var(--fg)}small,.muted{color:var(--muted)}
a{color:var(--accent)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{background:var(--soft);border-radius:8px;padding:10px 12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
table{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
.method{display:inline-block;min-width:46px;text-align:center;font:600 12px ui-monospace,Menlo,Consolas,monospace;background:var(--soft);border-radius:6px;padding:2px 6px}
.tag{font-size:11px;background:var(--soft);border-radius:6px;padding:1px 6px;color:var(--muted)}
.path code{font-size:14px}
nav ol{columns:2;column-gap:32px;padding-left:20px}
.meta{color:var(--muted);font-size:13px}
@media (max-width:640px){nav ol{columns:1}}
@media print{
  :root{--bg:#fff;--fg:#000;--muted:#444;--soft:#f2f2f2;--line:#ccc;--accent:#000}
  @page{margin:16mm 14mm}
  body{font-size:11pt}
  main{max-width:none;padding:0}
  h2{break-before:page}
  .endpoint{break-inside:auto}
  pre,table,h3,h4{break-inside:avoid}
  a{text-decoration:none}
  .noprint{display:none}
}`;

export interface DocsHtmlOptions {
  /** https://dominio sin barra final. */
  origin: string;
  /** Agrega un script que abre el diálogo de impresión (Guardar como PDF). */
  autoPrint?: boolean;
  /** Fecha de generación (tests). */
  generatedAt?: Date;
}

export function buildDocsHtml(opts: DocsHtmlOptions): string {
  const origin = opts.origin.replace(/\/+$/, "");
  const date = (opts.generatedAt ?? new Date()).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const toc = [
    `<li><a href="#intro">Introducción</a></li>`,
    `<li><a href="#auth">Autenticación y alcances</a></li>`,
    `<li><a href="#sandbox">Sandbox y pruebas</a></li>`,
    `<li><a href="#limits">Límites</a></li>`,
    `<li><a href="#errors">Errores</a></li>`,
    ...RESOURCES.map(
      (r) =>
        `<li><a href="#res-${e(r.id)}">${e(r.title)}</a><ul>${ENDPOINTS.filter((x) => x.resource === r.id)
          .map((x) => `<li><a href="#${e(x.id)}">${e(x.method)} ${e(x.title)}</a></li>`)
          .join("")}</ul></li>`,
    ),
  ].join("");

  const body = `<main>
<header>
<h1>${e(API_TITLE)}</h1>
<p class="meta">Versión ${e(API_VERSION)} · Generada el ${e(date)} desde la misma definición que el portal, el OpenAPI y la colección de Postman.</p>
<p class="meta noprint">Para guardarla como PDF: Imprimir y elegí Guardar como PDF. Versión en línea: <a href="${e(origin + DEVELOPERS_PATH)}">${e(
    origin + DEVELOPERS_PATH,
  )}</a></p>
</header>
<nav aria-label="Índice"><h2 style="break-before:auto">Índice</h2><ol>${toc}</ol></nav>

<h2 id="intro">Introducción</h2>
<p>${e(API_DESCRIPTION)}</p>
<p>URL base: <code>${e(origin + API_BASE_PATH)}</code></p>
<p>Especificación OpenAPI 3.1: <code>${e(origin + OPENAPI_PATH)}</code></p>
<ul>
<li>JSON en UTF-8. Fechas en ISO 8601 con zona. Montos en pesos con decimales.</li>
<li>Listas paginadas con cursor: { data, next_cursor }. Seguí next_cursor hasta que venga null.</li>
<li>Lotes: { items: [...] } y respuesta { summary, results } con el resultado de cada ítem en el mismo orden.</li>
<li>Los campos desconocidos dan 422: la API nunca ignora un campo en silencio.</li>
<li>Webhooks: todavía no existen. Para enterarte de cambios, consultá con updated_since.</li>
</ul>

<h2 id="auth">Autenticación y alcances</h2>
<ol>${AUTH_DOC.steps.map((s) => `<li>${e(s)}</li>`).join("")}</ol>
<h4>Alcances</h4>
<table><tbody>${scopeList()
    .map((s) => `<tr><td><code>${e(s.scope)}</code></td><td>${e(s.label)}</td><td>${e(s.desc)}</td></tr>`)
    .join("")}</tbody></table>
<h4>Seguridad</h4>
<ul>${AUTH_DOC.security.map((s) => `<li>${e(s)}</li>`).join("")}</ul>

<h2 id="sandbox">Sandbox y pruebas</h2>
<p>${e(SANDBOX_DOC.summary)}</p>
<ul>${SANDBOX_DOC.rules.map((s) => `<li>${e(s)}</li>`).join("")}</ul>
<h4>Sandbox público con datos ficticios</h4>
<p>Para probar sin cuenta: base <code>${e(origin + SANDBOX_BASE_PATH)}</code> con las credenciales de ejemplo <code>${e(
    DEMO_CLIENT_ID,
  )}</code> / <code>${e(
    DEMO_CLIENT_SECRET,
  )}</code>. Responde los mismos endpoints con un negocio inventado; las escrituras se simulan y no se guardan. Límite por IP.</p>

<h2 id="limits">Límites</h2>
<p>${e(RATE_LIMIT_DOC.summary)}</p>
<table><tbody>${RATE_LIMIT_DOC.headers.map((h) => `<tr><td><code>${e(h.name)}</code></td><td>${e(h.description)}</td></tr>`).join("")}</tbody></table>
<ul>${RATE_LIMIT_DOC.limits.map((s) => `<li>${e(s)}</li>`).join("")}</ul>

<h2 id="errors">Errores</h2>
<p>Todos los errores tienen el mismo formato: un code estable para tu código y un message en español. El pedido de token usa el formato de OAuth ({error, error_description}).</p>
${code(RESPONSE_FORMAT_DOC.errorExample)}
<table><thead><tr><th>HTTP</th><th>code</th><th>Cuándo</th></tr></thead><tbody>${ERRORS.map(
    (x) => `<tr><td>${e(x.status)}</td><td><code>${e(x.code)}</code></td><td>${e(x.description)}</td></tr>`,
  ).join("")}</tbody></table>
<h4>Headers de cada respuesta</h4>
<table><tbody>${RESPONSE_FORMAT_DOC.headers.map((h) => `<tr><td><code>${e(h.name)}</code></td><td>${e(h.description)}</td></tr>`).join("")}</tbody></table>

${RESOURCES.map(
  (r) =>
    `<h2 id="res-${e(r.id)}">${e(r.title)}</h2><p>${e(r.description)}</p>${ENDPOINTS.filter((x) => x.resource === r.id)
      .map((x) => endpointSection(x, origin))
      .join("")}`,
).join("\n")}
</main>`;

  const script = opts.autoPrint ? `<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)});</script>` : "";
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(API_TITLE)} ${e(API_VERSION)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
${script}
</body>
</html>
`;
}
