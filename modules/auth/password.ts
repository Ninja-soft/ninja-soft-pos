import { z } from "zod";

// Política de contraseñas única (SEC-22, docs/05-security.md §3). La usan el
// registro, el recupero (reset) y el cambio de contraseña. Supabase Auth
// aplica la misma regla del lado servidor: `minimum_password_length` y
// `password_requirements` en supabase/config.toml (local) y en el dashboard
// de Auth (prod). Si cambia acá, cambia allá.
export const PASSWORD_MIN_LENGTH = 10;

export const PASSWORD_HINT = `Mínimo ${PASSWORD_MIN_LENGTH} caracteres, con mayúscula, minúscula y número.`;

export const PASSWORD_MESSAGES = {
  length: `Mínimo ${PASSWORD_MIN_LENGTH} caracteres.`,
  upper: "Debe incluir al menos una mayúscula.",
  lower: "Debe incluir al menos una minúscula.",
  digit: "Debe incluir al menos un número.",
} as const;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_MESSAGES.length)
  .regex(/[A-Z]/, PASSWORD_MESSAGES.upper)
  .regex(/[a-z]/, PASSWORD_MESSAGES.lower)
  .regex(/[0-9]/, PASSWORD_MESSAGES.digit);

/** Primer error de la política, o null si la contraseña la cumple. */
export function validatePassword(value: string): string | null {
  const r = passwordSchema.safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? PASSWORD_MESSAGES.length);
}
