// SEC-62: orígenes permitidos para el link de recuperación de contraseña.
// Sólo orígenes EXACTOS: antes se aceptaba cualquier `ninja-soft-pos-*.vercel.app`
// (un tercero puede crear ese subdominio en su propia cuenta de Vercel y recibir
// el token_hash de la víctima) y `localhost:*`. Extra (previews propios, local)
// sólo por env: RECOVERY_EXTRA_ORIGINS="https://a.example,http://localhost:3005".
export const DEFAULT_RECOVERY_ORIGIN = "https://pos.soft.ninja";

const normalize = (o: string) => o.trim().replace(/\/+$/, "").toLowerCase();

export function allowedRecoveryOrigins(extra: string | undefined): Set<string> {
  const out = new Set<string>([DEFAULT_RECOVERY_ORIGIN]);
  for (const raw of (extra ?? "").split(",")) {
    const o = normalize(raw);
    if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(o)) out.add(o);
  }
  return out;
}

/** Origen a usar en el link: el pedido si está permitido, si no el de prod. */
export function pickRecoveryOrigin(asked: unknown, allowed: Set<string>): string {
  const o = normalize(String(asked ?? ""));
  return allowed.has(o) ? o : DEFAULT_RECOVERY_ORIGIN;
}
