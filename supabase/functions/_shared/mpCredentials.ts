// =============================================================================
// _shared/mpCredentials.ts (F20-0b · H126)
//
// Validación de formato de las credenciales de Mercado Pago de la plataforma.
// La usan la Edge set_platform_secret (el servidor es la barrera real) y la
// pantalla "Pagos de plataforma" (aviso inmediato). Puro, sin dependencias.
// =============================================================================

export type MpEnvironment = "production" | "test";
export type MpCredentialField =
  | "client_id"
  | "client_secret"
  | "access_token"
  | "public_key"
  | "redirect_uri"
  | "webhook_secret"
  | "environment";

/** Mensaje de error legible, o null si el valor tiene formato válido. */
export function validateMpCredential(field: MpCredentialField, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (field) {
    case "client_id":
      if (v.includes("@")) return "Cargaste un email. El Client ID de Mercado Pago es un número (lo ves en Tus integraciones > tu app > Credenciales).";
      return /^\d{6,20}$/.test(v) ? null : "El Client ID tiene que ser sólo números.";
    case "client_secret":
      return /^[A-Za-z0-9_-]{16,128}$/.test(v) ? null : "El Client Secret tiene letras y números, sin espacios.";
    case "access_token":
      return /^(APP_USR|TEST)-[A-Za-z0-9_-]{10,}$/.test(v)
        ? null
        : "El Access Token empieza con APP_USR- (producción) o TEST- (prueba).";
    case "public_key":
      return /^(APP_USR|TEST)-[A-Za-z0-9_-]{8,}$/.test(v)
        ? null
        : "La Public Key empieza con APP_USR- (producción) o TEST- (prueba).";
    case "redirect_uri":
      try {
        const u = new URL(v);
        if (u.protocol !== "https:" && u.hostname !== "localhost") return "La Redirect URI tiene que ser https.";
        return null;
      } catch {
        return "La Redirect URI no es una URL válida.";
      }
    case "webhook_secret":
      return /^\S{16,256}$/.test(v) ? null : "La clave secreta del webhook tiene al menos 16 caracteres, sin espacios.";
    case "environment":
      return v === "production" || v === "test" ? null : "Ambiente inválido.";
  }
}

/** Ambiente que sugiere el prefijo de una credencial (null si no se sabe). */
export function credentialEnvironment(token: string | null | undefined): MpEnvironment | null {
  const v = (token ?? "").trim();
  if (v.startsWith("TEST-")) return "test";
  if (v.startsWith("APP_USR-")) return "production";
  return null;
}

/** Últimos 4 caracteres para mostrar un secreto sin exponerlo. */
export function secretHint(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length >= 8 ? `…${s.slice(-4)}` : null;
}
