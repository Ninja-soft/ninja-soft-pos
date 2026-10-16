// =============================================================================
// Envío de la documentación de la API por email con credenciales (ADR-163).
// Lógica pura (sin Deno ni red) de la Edge send_api_docs_email: validación
// del pedido, control de que los adjuntos no lleven un secreto que no
// corresponde y armado del cuerpo. La importan también los tests de Vitest.
//
// El secreto en claro sólo vive en memoria del pedido: nunca se guarda en la
// base (system_emails, audit_logs) ni se loguea.
// =============================================================================

export const CLIENT_ID_RE = /^nsc_(test_)?[0-9a-f]{24}$/;
export const CLIENT_SECRET_RE = /^nss_(test_)?[0-9a-f]{64}$/;
/** Cualquier secreto de la API dentro de un texto. */
export const SECRET_ANYWHERE_RE = /nss_(?:test_)?[0-9a-f]{64}/g;
/** Secreto de ejemplo del sandbox público (ADR-163): público, aparece en la documentación. */
export const DEMO_CLIENT_SECRET = `nss_test_${"0".repeat(64)}`;
export const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export const MAX_POSTMAN_B64 = 1_000_000;
export const MAX_DOCS_B64 = 2_000_000;
export const NOTE_MAX = 500;

export type AttachmentKind = "postman" | "docs_html";

export interface ApiDocsEmailRequest {
  to: string;
  note: string | null;
  clientId: string | null;
  clientSecret: string | null;
  ackSecret: boolean;
  postmanB64: string | null;
  docsHtmlB64: string | null;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Valida forma del pedido (la base vuelve a validar dueño, credencial y tope). */
export function checkApiDocsRequest(raw: unknown): Checked<ApiDocsEmailRequest> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_json" };
  const b = raw as Record<string, unknown>;
  const to = String(b.to ?? "").trim().toLowerCase();
  if (!to || to.length > 254 || !EMAIL_RE.test(to)) return { ok: false, error: "invalid_email" };
  const note = String(b.note ?? "").trim();
  if (note.length > NOTE_MAX) return { ok: false, error: "note_too_long" };
  const clientId = b.client_id == null || b.client_id === "" ? null : String(b.client_id).trim();
  if (clientId !== null && !CLIENT_ID_RE.test(clientId)) return { ok: false, error: "client_not_found" };
  const clientSecret = b.client_secret == null || b.client_secret === "" ? null : String(b.client_secret).trim();
  if (clientSecret !== null) {
    if (!clientId || !CLIENT_SECRET_RE.test(clientSecret)) return { ok: false, error: "secret_mismatch" };
    // Prefijos coherentes: prueba con prueba, producción con producción.
    if (clientId.startsWith("nsc_test_") !== clientSecret.startsWith("nss_test_")) return { ok: false, error: "secret_mismatch" };
    if (b.ack_secret !== true) return { ok: false, error: "secret_ack_required" };
  }
  const postmanB64 = b.postman == null || b.postman === "" ? null : String(b.postman);
  const docsHtmlB64 = b.docs_html == null || b.docs_html === "" ? null : String(b.docs_html);
  if (postmanB64 !== null && (postmanB64.length > MAX_POSTMAN_B64 || !BASE64_RE.test(postmanB64))) {
    return { ok: false, error: "invalid_attachment" };
  }
  if (docsHtmlB64 !== null && (docsHtmlB64.length > MAX_DOCS_B64 || !BASE64_RE.test(docsHtmlB64))) {
    return { ok: false, error: "invalid_attachment" };
  }
  return {
    ok: true,
    value: { to, note: note || null, clientId, clientSecret, ackSecret: b.ack_secret === true, postmanB64, docsHtmlB64 },
  };
}

/**
 * Los adjuntos son lo que dicen ser y no llevan un secreto ajeno: la colección
 * es Postman v2.1 y sólo puede traer el secreto que se está mandando (y sólo
 * si se manda); el HTML de la documentación nunca trae secretos.
 */
export function checkAttachments(
  postman: string | null,
  docsHtml: string | null,
  secret: string | null,
): string | null {
  if (postman !== null) {
    let parsed: { info?: { schema?: unknown } } | null = null;
    try {
      parsed = JSON.parse(postman) as { info?: { schema?: unknown } };
    } catch {
      return "invalid_attachment";
    }
    if (!parsed || parsed.info?.schema !== POSTMAN_SCHEMA) return "invalid_attachment";
    const found = postman.match(SECRET_ANYWHERE_RE) ?? [];
    if (found.some((s) => s !== secret && s !== DEMO_CLIENT_SECRET)) return "attachment_secret_mismatch";
  }
  if (docsHtml !== null) {
    if (!/^<!doctype html>/i.test(docsHtml.trimStart())) return "invalid_attachment";
    if ((docsHtml.match(SECRET_ANYWHERE_RE) ?? []).some((s) => s !== DEMO_CLIENT_SECRET)) return "attachment_secret_mismatch";
  }
  return null;
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailClient {
  name: string;
  client_id: string;
  environment: "live" | "test";
  scopes: string[];
  rate_limit_per_min: number;
}

export interface ApiDocsEmailContent {
  businessName: string;
  note: string | null;
  client: EmailClient | null;
  secret: string | null;
  appUrl: string;
  attachments: AttachmentKind[];
}

export const API_DOCS_SUBJECT = "Documentación de la API de NinjaSoft POS";

function row(label: string, value: string, mono = false): string {
  return `<tr><td style="padding:6px 0;font-size:13px;color:#6b7280;vertical-align:top;width:120px">${esc(label)}</td><td style="padding:6px 0;font-size:13px;word-break:break-all;${
    mono ? "font-family:Consolas,Menlo,monospace" : ""
  }">${value}</td></tr>`;
}

export function buildApiDocsEmail(c: ApiDocsEmailContent): { subject: string; html: string; text: string } {
  const app = c.appUrl.replace(/\/+$/, "");
  const base = `${app}/api/v1`;
  const portal = `${app}/developers`;
  const envLabel = c.client?.environment === "test" ? "Prueba (sandbox: las escrituras no se guardan)" : "Producción";
  const attachText = c.attachments.length
    ? `<p style="margin:12px 0 0;font-size:13px">Adjuntos: ${c.attachments
        .map((a) => (a === "postman" ? "colección de Postman con las variables cargadas" : "documentación completa en HTML"))
        .join(" y ")}.</p>`
    : "";
  const credBlock = c.client
    ? `<h2 style="margin:20px 0 8px;font-size:16px">Credencial: ${esc(c.client.name)}</h2>
<table style="width:100%;border-collapse:collapse">${row("Ambiente", esc(envLabel))}${row("URL base", esc(base), true)}${row(
        "client_id",
        esc(c.client.client_id),
        true,
      )}${c.secret ? row("client_secret", esc(c.secret), true) : ""}${row("Alcances", esc(c.client.scopes.join(" ")), true)}${row(
        "Límite",
        `${esc(c.client.rate_limit_per_min)} pedidos por minuto`,
      )}</table>
${
  c.secret
    ? `<p style="margin:12px 0 0;font-size:13px;background:#fff4e5;border-radius:8px;padding:10px 12px">El client_secret es una clave: con él se puede leer y escribir en el negocio${
        c.client.environment === "test" ? " (en prueba, sin guardar)" : ""
      }. Guardalo en el servidor de la integración, nunca en un navegador ni en un repositorio, y borrá este email. Si se filtra, el dueño lo rota o revoca.</p>`
    : `<p style="margin:12px 0 0;font-size:13px;color:#6b7280">El client_secret no va en este email: lo tiene el dueño del negocio o lo puede rotar en Configuración, Integraciones, API.</p>`
}`
    : "";

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f5fa;padding:24px">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;color:#09051C">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280">${esc(c.businessName)}</p>
<h1 style="margin:0 0 12px;font-size:20px">${esc(API_DOCS_SUBJECT)}</h1>
<p style="margin:0 0 16px;font-size:14px">Te compartieron la documentación de la API pública v1: autenticación, endpoints con ejemplos, errores, límites y un sandbox para probar.</p>
${c.note ? `<p style="margin:0 0 16px;font-size:14px;white-space:pre-wrap;background:#f6f5fa;border-radius:8px;padding:12px">${esc(c.note)}</p>` : ""}
${credBlock}
<p style="margin:20px 0 8px"><a href="${esc(portal)}" style="display:inline-block;background:#09051C;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Abrir el portal de desarrolladores</a></p>
${attachText}
<p style="margin:16px 0 0;font-size:12px;color:#6b7280">Para pedir un token: POST ${esc(base)}/oauth/token con grant_type=client_credentials y la credencial por Basic auth.</p>
</div></div>`;

  const text = [
    API_DOCS_SUBJECT,
    c.businessName,
    c.note ?? "",
    c.client
      ? [
          `Credencial: ${c.client.name}`,
          `Ambiente: ${envLabel}`,
          `URL base: ${base}`,
          `client_id: ${c.client.client_id}`,
          c.secret ? `client_secret: ${c.secret}` : "client_secret: no incluido",
          `Alcances: ${c.client.scopes.join(" ")}`,
        ].join("\n")
      : "",
    `Portal: ${portal}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { subject: API_DOCS_SUBJECT, html, text };
}

/** Mensaje de error seguro para auditar (sin el secreto, aunque el proveedor lo repita). */
export function safeError(e: unknown, secret: string | null): string {
  let m = (e instanceof Error ? e.message : String(e ?? "")).slice(0, 300);
  if (secret) m = m.split(secret).join("[secreto]");
  return m.replace(SECRET_ANYWHERE_RE, "[secreto]").slice(0, 200);
}
