// Lista de espera del salón (F13 · H51). Helpers puros: orden de atención,
// minutos esperados, demora contra lo prometido y link de WhatsApp manual.

export type WaitlistStatus = "esperando" | "avisado" | "sentado" | "cancelado" | "se_fue";

export interface WaitlistEntryLike {
  id: string;
  status: WaitlistStatus;
  priority: number;
  created_at: string;
  quoted_minutes: number | null;
  party_size: number;
}

export const WAITLIST_ACTIVE: WaitlistStatus[] = ["esperando", "avisado"];

export function isWaitlistActive(status: WaitlistStatus): boolean {
  return WAITLIST_ACTIVE.includes(status);
}

// Orden de atención: activos primero, prioridad arriba, después por llegada.
export function sortWaitlist<T extends WaitlistEntryLike>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const aa = isWaitlistActive(a.status) ? 0 : 1;
    const ba = isWaitlistActive(b.status) ? 0 : 1;
    if (aa !== ba) return aa - ba;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

// Posición (1-based) de cada entrada activa en la fila. Las no activas no tienen.
export function waitlistPositions<T extends WaitlistEntryLike>(entries: T[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const e of sortWaitlist(entries)) {
    if (!isWaitlistActive(e.status)) continue;
    n += 1;
    out.set(e.id, n);
  }
  return out;
}

export function waitedMinutes(createdAt: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60_000));
}

// ¿Ya superó la espera prometida? Sin promesa nunca está demorado.
export function isOverQuoted(entry: Pick<WaitlistEntryLike, "created_at" | "quoted_minutes">, now: number): boolean {
  if (!entry.quoted_minutes) return false;
  return waitedMinutes(entry.created_at, now) > entry.quoted_minutes;
}

// Mesas donde entra el grupo: libres con capacidad suficiente primero (la más
// chica que alcance), después el resto de las libres por si se juntan sillas.
export function suggestTables<T extends { id: string; status: string; capacity: number; label: string }>(
  tables: T[],
  partySize: number,
): T[] {
  const free = tables.filter((t) => t.status === "libre");
  const fits = free.filter((t) => t.capacity >= partySize).sort((a, b) => a.capacity - b.capacity);
  const rest = free.filter((t) => t.capacity < partySize).sort((a, b) => b.capacity - a.capacity);
  return [...fits, ...rest];
}

// Normaliza un teléfono argentino a formato wa.me (549 + área + número, sin 0
// ni 15). Devuelve null si no hay dígitos suficientes.
export function normalizeArPhone(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("549")) return d;
  if (d.startsWith("54")) return `549${d.slice(2)}`;
  if (d.startsWith("0")) d = d.slice(1);
  // 11 15 1234 5678 → 11 1234 5678 (el 15 después del código de área).
  const m = d.match(/^(\d{2,4})15(\d{6,8})$/);
  if (m) {
    const joined = `${m[1] ?? ""}${m[2] ?? ""}`;
    if (joined.length === 10) d = joined;
  }
  if (d.length !== 10) return d.length > 10 ? d : null;
  return `549${d}`;
}

export function waitlistWhatsappLink(phone: string | null | undefined, message: string): string | null {
  const n = normalizeArPhone(phone);
  if (!n) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(message)}`;
}

export function waitlistReadyMessage(name: string, businessName?: string | null): string {
  const local = businessName ? ` en ${businessName}` : "";
  return `Hola ${name}, tu mesa${local} ya está lista. Te esperamos.`;
}
