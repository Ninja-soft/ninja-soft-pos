"use client";

// Gestión de credenciales de la API pública (ADR-094): sólo el dueño, todo por
// RPC SECURITY DEFINER auditada. El secreto llega una sola vez en la respuesta
// de crear o rotar; la base guarda sólo su hash. RPC fuera de los tipos
// generados: se castean.

import { createClient } from "@/lib/supabase/client";
import type { ApiScope } from "@/lib/api-publica/scopes";

export type ApiEnvironment = "live" | "test";

export interface ApiClientView {
  id: string;
  name: string;
  client_id: string;
  secret_hint: string;
  scopes: ApiScope[];
  rate_limit_per_min: number;
  /** live = producción; test = sandbox (ADR-159). Sin la migración, ausente (= live). */
  environment?: ApiEnvironment;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  status: "active" | "revoked";
}

export interface ApiClientsState {
  feature: boolean;
  scopes: ApiScope[];
  clients: ApiClientView[];
}

export type ApiClientWithSecret = ApiClientView & { client_secret: string };

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (fn: string, args: Record<string, unknown> = {}) =>
  createClient().rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

/** UTF-8 a base64 (adjuntos del email). */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface SendDocsEmailInput {
  email: string;
  note: string | null;
  /** Credencial cuyos datos van en el email (client_id, ambiente, alcances, URL base). */
  client: Pick<ApiClientView, "client_id" | "environment"> | null;
  /** Sólo el secreto recién creado o rotado (en memoria de la página). */
  clientSecret: string | null;
  /** El dueño confirmó que manda una clave por email. */
  ackSecret: boolean;
  includePostman: boolean;
  includeHtml: boolean;
}

/** Código de error de una Edge (cuerpo {error}) o el mensaje del cliente. */
async function edgeErrorCode(error: unknown, data: unknown): Promise<string> {
  const fromData = (data as { error?: string } | null)?.error;
  if (fromData) return fromData;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const b = (await ctx.json()) as { error?: string };
      if (b.error) return b.error;
    } catch {
      /* cuerpo no JSON */
    }
    if (ctx.status === 404) return "edge_not_deployed";
  }
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "FunctionsFetchError" || name === "FunctionsRelayError") return "edge_not_deployed";
  return (error as Error | null)?.message ?? "send_failed";
}

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const apiPublicaApi = {
  list: () => call<ApiClientsState>("api_clients_list"),
  // p_environment sólo viaja en prueba: así el alta de producción sigue
  // andando aunque la migración de ADR-159 no esté aplicada.
  create: (name: string, scopes: ApiScope[], rateLimit: number, environment: ApiEnvironment = "live") =>
    call<ApiClientWithSecret>("api_client_create", {
      p_name: name,
      p_scopes: scopes,
      p_rate_limit: rateLimit,
      ...(environment === "test" ? { p_environment: "test" } : {}),
    }),
  update: (id: string, v: { name?: string; scopes?: ApiScope[]; rateLimit?: number }) =>
    call<ApiClientView>("api_client_update", {
      p_id: id,
      p_name: v.name ?? null,
      p_scopes: v.scopes ?? null,
      p_rate_limit: v.rateLimit ?? null,
    }),
  rotate: (id: string) => call<ApiClientWithSecret>("api_client_rotate", { p_id: id }),
  revoke: (id: string, reason: string) => call<ApiClientView>("api_client_revoke", { p_id: id, p_reason: reason }),
  // ADR-163: link a la documentación pública por el sistema de emails, auditado.
  sendDocs: (email: string, note: string | null) =>
    call<{ ok: true; email: string }>("api_docs_send_email", { p_recipient: email, p_note: note }),
  /**
   * Documentación por email con adjuntos y, opcional, una credencial (Edge
   * send_api_docs_email, envío directo sin cola: el secreto no se persiste).
   * La colección de Postman y el HTML se arman acá, en el navegador, con el
   * secreto que sólo está en memoria. Sin credencial y sin la Edge
   * desplegada, cae al envío de links por la cola (api_docs_send_email).
   */
  sendDocsEmail: async (v: SendDocsEmailInput): Promise<{ ok: true; with_secret: boolean; fallback?: boolean }> => {
    const origin = window.location.origin;
    const [{ buildPostmanCollection }, { buildDocsHtml }] = await Promise.all([
      import("@/lib/api/postman"),
      import("@/lib/api/docsHtml"),
    ]);
    const env: ApiEnvironment = v.client?.environment ?? (v.client?.client_id.startsWith("nsc_test_") ? "test" : "live");
    const postman = v.includePostman
      ? utf8ToBase64(
          JSON.stringify(
            buildPostmanCollection({ origin, clientId: v.client?.client_id ?? null, clientSecret: v.clientSecret, environment: env }),
            null,
            2,
          ),
        )
      : null;
    const docs = v.includeHtml ? utf8ToBase64(buildDocsHtml({ origin })) : null;
    const { data, error } = await createClient().functions.invoke("send_api_docs_email", {
      body: {
        to: v.email,
        note: v.note,
        client_id: v.client?.client_id ?? null,
        client_secret: v.clientSecret,
        ack_secret: v.ackSecret,
        postman,
        docs_html: docs,
      },
    });
    if (!error && (data as { ok?: boolean } | null)?.ok) return data as { ok: true; with_secret: boolean };
    const code = await edgeErrorCode(error, data);
    if (code === "edge_not_deployed" && !v.client) {
      await apiPublicaApi.sendDocs(v.email, v.note);
      return { ok: true, with_secret: false, fallback: true };
    }
    throw new Error(code);
  },
};

export function apiPublicaErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/forbidden|42501/.test(msg)) return "Sólo el dueño del negocio gestiona las credenciales de la API.";
  if (/invalid_email/.test(msg)) return "Revisá el email: no parece válido.";
  if (/note_too_long/.test(msg)) return "La nota puede tener hasta 500 caracteres.";
  if (/too_many_emails/.test(msg)) return "Llegaste al máximo de 20 envíos de la documentación por día. Probá mañana o mandá el link.";
  if (/secret_mismatch|attachment_secret_mismatch/.test(msg)) return "El secreto no coincide con el de la credencial. Rotala y volvé a intentar.";
  if (/secret_ack_required/.test(msg)) return "Confirmá que querés mandar la clave secreta por email.";
  if (/invalid_attachment/.test(msg)) return "No se pudieron armar los adjuntos. Probá de nuevo.";
  if (/edge_not_deployed/.test(msg)) return "El envío con credenciales y adjuntos todavía no está activo (falta desplegar send_api_docs_email).";
  if (/send_failed|no_provider/.test(msg)) return "El proveedor de email no pudo enviar el mensaje. Probá de nuevo en unos minutos.";
  if (/feature_not_in_plan/.test(msg)) return "Tu plan no incluye la API pública. Está en el plan Enterprise.";
  if (/invalid_environment/.test(msg)) return "Elegí producción o prueba.";
  if (/p_environment/.test(msg)) return "Falta aplicar la migración del sandbox de la API (credenciales de prueba).";
  if (/too_many_clients/.test(msg)) return "Llegaste al máximo de 10 credenciales activas. Revocá una que no uses.";
  if (/scopes_required|invalid_scope/.test(msg)) return "Elegí al menos un permiso válido.";
  if (/name_required/.test(msg)) return "Poné un nombre para reconocer la integración.";
  if (/client_revoked/.test(msg)) return "La credencial está revocada.";
  if (/client_not_found/.test(msg)) return "La credencial no existe.";
  if (/rate_limit_per_min|check constraint/.test(msg)) return "El límite por minuto va de 10 a 10.000.";
  if (/Could not find the function|does not exist/.test(msg)) return "Falta aplicar la migración de la API pública en la base.";
  return "No se pudo completar la operación. Probá de nuevo.";
}
