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
};

export function apiPublicaErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/forbidden|42501/.test(msg)) return "Sólo el dueño del negocio gestiona las credenciales de la API.";
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
