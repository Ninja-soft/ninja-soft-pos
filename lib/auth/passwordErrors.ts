import { PASSWORD_MIN_LENGTH } from "@/modules/auth/password";

// Traduce los errores de contraseña de Supabase Auth (signUp / updateUser) a
// mensajes en español (SEC-22). El error `weak_password` trae `reasons`:
// "length" | "characters" | "pwned" (contraseña filtrada, HaveIBeenPwned).
// Se tipa estructuralmente para no acoplarse a la clase de auth-js.

export const PASSWORD_ERROR_MESSAGES = {
  pwned: "Esta contraseña apareció en filtraciones de datos; elegí otra.",
  length: `La contraseña es muy corta: usá al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  characters: "La contraseña tiene que incluir mayúsculas, minúsculas y números.",
  weak: "La contraseña es muy débil; elegí otra más segura.",
  same: "La nueva contraseña tiene que ser distinta de la actual.",
} as const;

type AuthErrorLike = {
  message?: string;
  code?: string;
  name?: string;
  reasons?: unknown;
};

function asAuthError(err: unknown): AuthErrorLike | null {
  return err && typeof err === "object" ? (err as AuthErrorLike) : null;
}

/**
 * Mensaje en español si `err` es un error de contraseña de Supabase
 * (`weak_password` / `same_password`); null si es otro error.
 */
export function passwordErrorMessage(err: unknown): string | null {
  const e = asAuthError(err);
  if (!e) return null;
  if (e.code === "same_password") return PASSWORD_ERROR_MESSAGES.same;

  const isWeak = e.code === "weak_password" || e.name === "AuthWeakPasswordError";
  if (!isWeak) return null;

  const reasons = Array.isArray(e.reasons) ? e.reasons.map(String) : [];
  // Prioridad: filtrada > longitud > caracteres (la filtrada no se arregla
  // agregando caracteres; hay que elegir otra).
  if (reasons.includes("pwned")) return PASSWORD_ERROR_MESSAGES.pwned;
  if (reasons.includes("length")) return PASSWORD_ERROR_MESSAGES.length;
  if (reasons.includes("characters")) return PASSWORD_ERROR_MESSAGES.characters;
  return PASSWORD_ERROR_MESSAGES.weak;
}

/** Igual que passwordErrorMessage, pero cae al mensaje original o al fallback. */
export function authPasswordErrorMessage(err: unknown, fallback = "No se pudo guardar la contraseña."): string {
  return passwordErrorMessage(err) ?? (asAuthError(err)?.message || fallback);
}
