// Lista de espera de la agenda (F12 · H38, ADR-082). Tipos y lógica pura.

export type WaitlistStatus = "esperando" | "agendado" | "cancelado";
export type WaitlistSlot = "cualquiera" | "manana" | "tarde" | "noche";

export interface WaitlistEntry {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  phone: string | null;
  service_product_id: string | null;
  service_name: string | null;
  professional_id: string | null;
  preferred_date: string | null; // YYYY-MM-DD
  preferred_slot: WaitlistSlot;
  notes: string | null;
  status: WaitlistStatus;
  appointment_id: string | null;
  created_at: string;
  customers?: { name: string; phone: string | null } | null;
}

export const SLOT_LABELS: Record<WaitlistSlot, string> = {
  cualquiera: "Cualquier horario",
  manana: "Mañana",
  tarde: "Tarde",
  noche: "Noche",
};

// Franja de una hora local: mañana hasta las 13, tarde hasta las 19, noche
// después.
export function slotOfHour(hour: number): Exclude<WaitlistSlot, "cualquiera"> {
  if (hour < 13) return "manana";
  if (hour < 19) return "tarde";
  return "noche";
}

function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ¿Un hueco (inicio + profesional) le sirve a la entrada? Respeta la fecha
// preferida, la franja y el profesional preferido cuando están cargados.
export function entryFitsSlot(
  entry: Pick<WaitlistEntry, "status" | "preferred_date" | "preferred_slot" | "professional_id">,
  startsAt: Date,
  professionalId: string | null,
): boolean {
  if (entry.status !== "esperando") return false;
  if (entry.preferred_date && entry.preferred_date !== localDateKey(startsAt)) return false;
  if (entry.preferred_slot !== "cualquiera" && entry.preferred_slot !== slotOfHour(startsAt.getHours())) return false;
  if (entry.professional_id && professionalId && entry.professional_id !== professionalId) return false;
  return true;
}

// Orden de atención: primero los que tienen fecha preferida (la más cercana),
// después el resto; a igualdad, quien se anotó antes.
export function sortWaitlist<T extends Pick<WaitlistEntry, "preferred_date" | "created_at">>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.preferred_date && !b.preferred_date) return -1;
    if (!a.preferred_date && b.preferred_date) return 1;
    if (a.preferred_date && b.preferred_date && a.preferred_date !== b.preferred_date) {
      return a.preferred_date < b.preferred_date ? -1 : 1;
    }
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

// Nombre visible de quien espera (cliente de la base o nombre suelto).
export function waitlistWho(e: Pick<WaitlistEntry, "customer_name" | "customers">): string {
  return e.customers?.name ?? e.customer_name ?? "Sin nombre";
}

export function waitlistPhone(e: Pick<WaitlistEntry, "phone" | "customers">): string | null {
  return e.phone ?? e.customers?.phone ?? null;
}

// Validación del alta (espejo del check agenda_waitlist_who del servidor).
export function validateWaitlistInput(input: {
  customer_id: string | null;
  customer_name: string | null;
  service_name: string | null;
  service_product_id: string | null;
}): string | null {
  if (!input.customer_id && !(input.customer_name ?? "").trim()) return "Elegí un cliente o escribí un nombre.";
  if (!input.service_product_id && !(input.service_name ?? "").trim()) return "Elegí o escribí el servicio.";
  return null;
}
