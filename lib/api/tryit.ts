// Lógica pura del "Probar" del portal (ADR-159). El portal sólo acepta
// credenciales de prueba (nsc_test_): las escrituras hacen dry_run en la base.
// Las credenciales y el token viven en memoria (estado de React), nunca en
// localStorage ni en la URL.

import { isSandboxClientId, SANDBOX_SECRET_PREFIX } from "@/lib/api-publica/formats";
import { API_BASE_PATH, type EndpointSpec } from "./spec";

export type SandboxCredsCheck = { ok: true } | { ok: false; message: string };

export function checkSandboxCreds(clientId: string, clientSecret: string): SandboxCredsCheck {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id || !secret) return { ok: false, message: "Completá el client_id y el client_secret de una credencial de prueba." };
  if (!isSandboxClientId(id)) {
    return {
      ok: false,
      message: "El sandbox sólo acepta credenciales de prueba (client_id nsc_test_). Creá una eligiendo el ambiente Prueba.",
    };
  }
  if (!secret.startsWith(SANDBOX_SECRET_PREFIX)) {
    return { ok: false, message: "El secreto de una credencial de prueba empieza con nss_test_." };
  }
  return { ok: true };
}

/** Valores iniciales de la query: los obligatorios con su ejemplo. */
export function initialQuery(e: EndpointSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of e.params) {
    if (p.in !== "query") continue;
    out[p.name] = p.required && p.example !== undefined ? String(p.example) : "";
  }
  return out;
}

/** URL relativa al mismo origen, sin parámetros vacíos. */
export function tryUrl(e: EndpointSpec, query: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const p of e.params) {
    if (p.in !== "query") continue;
    const v = (query[p.name] ?? "").trim();
    if (v) qs.set(p.name, v);
  }
  const s = qs.toString();
  return `${API_BASE_PATH}${e.path}${s ? `?${s}` : ""}`;
}

export type BodyCheck = { ok: true; text: string } | { ok: false; message: string };

/** Valida que el cuerpo sea JSON y lo normaliza. */
export function checkBody(raw: string): BodyCheck {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, message: "El cuerpo tiene que ser un objeto JSON." };
    return { ok: true, text: JSON.stringify(v) };
  } catch {
    return { ok: false, message: "El cuerpo no es JSON válido." };
  }
}

/** Token visible acortado (no hace falta mostrarlo entero). */
export function maskToken(token: string): string {
  if (token.length <= 18) return token;
  return `${token.slice(0, 14)}…${token.slice(-4)}`;
}

/** Headers de la respuesta que vale la pena mostrar. */
export const SHOWN_RESPONSE_HEADERS = [
  "x-ninja-environment",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "retry-after",
  "idempotent-replayed",
  "x-request-id",
] as const;
