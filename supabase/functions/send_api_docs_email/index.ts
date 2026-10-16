// =============================================================================
// Edge Function: send_api_docs_email (ADR-163, H68b): manda la documentación
// de la API por email, opcionalmente con una credencial (client_id, ambiente,
// alcances, URL base y, sólo si el dueño lo acaba de crear o rotar, el
// client_secret), la colección de Postman con las variables cargadas y el
// HTML de la documentación como adjuntos.
//
// El secreto NUNCA se persiste: no pasa por la cola (system_emails guarda el
// HTML) sino que se envía directo con la cadena de proveedores de la
// plataforma; a la base sólo llega sha256(secreto) para comprobar que es el de
// esa credencial (api_clients.secret_hash ya es ese hash). No se loguea.
//
// Guard: api_docs_email_prepare corre con el JWT del usuario (dueño del
// negocio activo, credencial del negocio y activa, tope de 20 por día,
// confirmación del secreto) y audita api_docs_emailed (with_secret, client_id
// acortado, destinatario; nunca el secreto). Si el envío falla,
// api_docs_email_finish (service_role) deja api_docs_email_failed.
//
// Deploy: verify_jwt=true.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { sendWithChain, type SendAttachment } from "../_shared/mailer.ts";
import { readJsonLimited } from "../_shared/requestGuard.ts";
import {
  buildApiDocsEmail,
  checkApiDocsRequest,
  checkAttachments,
  safeError,
  type AttachmentKind,
  type EmailClient,
} from "../_shared/apiDocsEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const APP_URL = (Deno.env.get("APP_URL") || "https://pos.soft.ninja").replace(/\/$/, "");
const MAX_BODY = 3_200_000;

// Errores de la RPC que se devuelven tal cual (el cliente los traduce).
const KNOWN = [
  "forbidden",
  "invalid_email",
  "note_too_long",
  "too_many_emails",
  "client_not_found",
  "secret_mismatch",
  "secret_ack_required",
  "invalid_attachments",
];

function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // El secreto puede estar en el cuerpo: ningún log de este pedido lo incluye.
  let secret: string | null = null;
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    let raw: unknown;
    try {
      raw = await readJsonLimited(req, MAX_BODY);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const checked = checkApiDocsRequest(raw);
    if (!checked.ok) return json({ error: checked.error }, 400);
    const r = checked.value;
    secret = r.clientSecret;

    let postman: string | null = null;
    let docsHtml: string | null = null;
    try {
      postman = r.postmanB64 ? decodeB64(r.postmanB64) : null;
      docsHtml = r.docsHtmlB64 ? decodeB64(r.docsHtmlB64) : null;
    } catch {
      return json({ error: "invalid_attachment" }, 400);
    }
    const attErr = checkAttachments(postman, docsHtml, secret);
    if (attErr) return json({ error: attErr }, 400);

    const kinds: AttachmentKind[] = [];
    if (postman !== null) kinds.push("postman");
    if (docsHtml !== null) kinds.push("docs_html");

    const { data: prep, error: prepErr } = await userClient.rpc("api_docs_email_prepare", {
      p_recipient: r.to,
      p_note: r.note,
      p_client_id: r.clientId,
      p_secret_sha256: secret ? await sha256Hex(secret) : null,
      p_ack_secret: r.ackSecret,
      p_attachments: kinds,
    });
    if (prepErr) {
      const code = KNOWN.find((k) => prepErr.message.includes(k)) ?? "prepare_failed";
      return json({ error: code }, code === "forbidden" ? 403 : 400);
    }
    const p = prep as { audit_id: string; tenant_name: string; with_secret: boolean; client: EmailClient | null };

    const mail = buildApiDocsEmail({
      businessName: p.tenant_name,
      note: r.note,
      client: p.client,
      secret: p.with_secret ? secret : null,
      appUrl: APP_URL,
      attachments: kinds,
    });
    const attachments: SendAttachment[] = [];
    if (r.postmanB64) {
      attachments.push({
        filename: `ninjasoft-api-v1${p.client?.environment === "test" ? "-prueba" : ""}.postman_collection.json`,
        content: r.postmanB64,
        contentType: "application/json",
      });
    }
    if (r.docsHtmlB64) {
      attachments.push({ filename: "ninjasoft-api-v1.html", content: r.docsHtmlB64, contentType: "text/html" });
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    let ok = false;
    let provider = "";
    let error = "";
    try {
      const res = await sendWithChain(admin, {
        to: r.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        fromName: p.tenant_name,
        attachments,
      });
      ok = Boolean(res.providerUsed);
      provider = res.providerUsed ?? "";
      if (!ok) error = res.noProvider ? "no_provider" : safeError(res.lastError, secret);
    } catch (e) {
      error = safeError(e, secret);
    }

    const { error: finErr } = await admin.rpc("api_docs_email_finish", {
      p_audit_id: p.audit_id,
      p_ok: ok,
      p_error: error || null,
      p_provider: provider || null,
    });
    if (finErr) console.error("api_docs_email_finish:", finErr.message);

    return ok ? json({ ok: true, with_secret: p.with_secret }) : json({ ok: false, error: "send_failed" }, 502);
  } catch (e) {
    console.error("send_api_docs_email:", safeError(e, secret));
    return json({ error: "internal" }, 500);
  } finally {
    secret = null;
  }
});
