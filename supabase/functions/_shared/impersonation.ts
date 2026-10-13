// =============================================================================
// Acceso como el negocio con duración limitada (F7 · H11c, ADR-084).
// Lógica pura: la usan la Edge internal_impersonate (Deno), el diálogo del
// panel interno, la página /auth/impersonate y el banner. Sin imports de Deno
// ni de Node.
// =============================================================================

export const IMPERSONATION_DURATIONS = [15, 30, 60, 120, 240] as const;
export const DEFAULT_IMPERSONATION_MINUTES = 30;
export const MIN_IMPERSONATION_MINUTES = 5;
export const MAX_IMPERSONATION_MINUTES = 240;

// Duración pedida → minutos válidos. undefined/null usa el default; un valor
// fuera de rango o no entero es inválido (null) en vez de recortarse en
// silencio: el staff tiene que saber cuánto dura el acceso que abre.
export function parseImpersonationMinutes(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_IMPERSONATION_MINUTES;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  if (n < MIN_IMPERSONATION_MINUTES || n > MAX_IMPERSONATION_MINUTES) return null;
  return n;
}

export function impersonationExpiresAt(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

// Link que abre el staff en una ventana de incógnito. Todo viaja en el
// fragmento (#): no llega a ningún servidor ni queda en logs de acceso.
export function buildImpersonationUrl(origin: string, tokenHash: string, nonce: string): string {
  const base = origin.replace(/\/+$/, "");
  const frag = new URLSearchParams({ th: tokenHash, n: nonce });
  return `${base}/auth/impersonate#${frag.toString()}`;
}

export function parseImpersonationFragment(hash: string): { tokenHash: string; nonce: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const tokenHash = p.get("th") ?? "";
  const nonce = p.get("n") ?? "";
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(tokenHash)) return null;
  if (!/^[0-9a-f]{64}$/.test(nonce)) return null;
  return { tokenHash, nonce };
}

// Segundos restantes (nunca negativo).
export function remainingSeconds(expiresAt: string | Date, now: Date): number {
  const end = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const ms = end.getTime() - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

// "1 h 05 min", "12:04" para el último tramo.
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h} h ${String(m).padStart(2, "0")} min`;
  }
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function impersonationErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "link_used":
      return "Este link ya se usó. Generá uno nuevo desde el panel interno.";
    case "link_expired":
      return "El acceso venció. Generá uno nuevo desde el panel interno.";
    case "invalid_link":
      return "El link no es válido o no corresponde a esta cuenta.";
    case "invalid_duration":
      return "Elegí una duración entre 5 y 240 minutos.";
    case "reason_required":
      return "Escribí un motivo de al menos 5 caracteres.";
    case "forbidden_support_level":
      return "Soporte no puede acceder como el negocio.";
    default:
      return "No se pudo abrir el acceso como el negocio.";
  }
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutos`;
  const h = minutes / 60;
  return h === 1 ? "1 hora" : `${h} horas`;
}
