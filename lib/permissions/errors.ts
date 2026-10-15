// =============================================================================
// Traducción de los rechazos por rol de la base (ADR-071) a mensajes humanos.
// Los códigos los levantan role_write_guard y void_sale (errcode 42501).
// =============================================================================

import { CAPABILITY_BY_KEY } from "./capabilities";

export const ROLE_ERROR_MESSAGES: Record<string, string> = {
  forbidden_read_only: "Tu usuario es de solo lectura: no puede modificar datos.",
  forbidden_role: "Esta acción requiere un encargado o el dueño del negocio.",
  forbidden_void_past_day:
    "Como cajero sólo podés anular ventas del día. Para una venta anterior pedile a un encargado o al dueño.",
  use_void_sale: "El estado de una venta no se cambia a mano: usá Anular venta.",
  forbidden_capability: "Tu rol no tiene permiso para esta acción.",
};

function rawMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown };
    return [o.message, o.details, o.hint].filter((v) => typeof v === "string").join(" ");
  }
  return "";
}

/** Mensaje humano si el error es un rechazo por rol; null si es otro error. */
export function roleErrorMessage(e: unknown): string | null {
  const msg = rawMessage(e);
  if (!msg) return null;
  // ADR-138: el rechazo trae la capacidad que falta (detail "capability:<clave>").
  const cap = /\bcapability:([a-z_.]+)/.exec(msg)?.[1];
  if (cap && /\bforbidden_(role|capability)\b/.test(msg)) {
    const label = CAPABILITY_BY_KEY.get(cap)?.label;
    if (label) return `Tu rol no tiene el permiso "${label}". Pedíselo al dueño.`;
  }
  for (const [code, text] of Object.entries(ROLE_ERROR_MESSAGES)) {
    if (new RegExp(`\\b${code}\\b`).test(msg)) return text;
  }
  return null;
}

/**
 * Descripción para un toast de error: el rechazo por rol traducido o, si no,
 * el mensaje original del error (o undefined).
 */
export function errorDescription(e: unknown): string | undefined {
  return roleErrorMessage(e) ?? (rawMessage(e) || undefined);
}
