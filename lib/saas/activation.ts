// Métricas de activación de un negocio (F12 · H42, ADR-082). Lógica pura sobre
// la respuesta de la RPC internal_tenant_activation (panel interno).

export interface TenantActivation {
  tenant_created_at: string;
  first_sale_at: string | null;
  minutes_to_first_sale: number | null;
  sales_count: number;
  first_appointment_at: string | null;
  appointments_count: number;
  first_recurring_customer_at: string | null;
  first_pack_sold_at: string | null;
  favorites_count: number;
  favorite_lines_share_30d: number | null;
}

export interface ActivationMilestone {
  key: "first_sale" | "first_appointment" | "first_recurring_customer" | "first_pack" | "favorites";
  label: string;
  done: boolean;
  at: string | null;
  detail: string | null;
}

// Duración legible en minutos: "45 min", "3 h 5 min", "2 d 4 h".
export function formatMinutes(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min) || min < 0) return null;
  const m = Math.floor(min);
  if (m < 60) return `${m} min`;
  if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  const d = Math.floor(m / (60 * 24));
  const h = Math.floor((m % (60 * 24)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

export function parseActivation(raw: unknown): TenantActivation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  if (!str(r.tenant_created_at)) return null;
  return {
    tenant_created_at: str(r.tenant_created_at)!,
    first_sale_at: str(r.first_sale_at),
    minutes_to_first_sale: num(r.minutes_to_first_sale),
    sales_count: num(r.sales_count) ?? 0,
    first_appointment_at: str(r.first_appointment_at),
    appointments_count: num(r.appointments_count) ?? 0,
    first_recurring_customer_at: str(r.first_recurring_customer_at),
    first_pack_sold_at: str(r.first_pack_sold_at),
    favorites_count: num(r.favorites_count) ?? 0,
    favorite_lines_share_30d: num(r.favorite_lines_share_30d),
  };
}

export function activationMilestones(a: TenantActivation): ActivationMilestone[] {
  const toFirst = formatMinutes(a.minutes_to_first_sale);
  const share = a.favorite_lines_share_30d;
  return [
    {
      key: "first_sale",
      label: "Primer cobro real",
      done: Boolean(a.first_sale_at),
      at: a.first_sale_at,
      detail: a.first_sale_at
        ? `${toFirst ? `A ${toFirst} del alta` : "Hecho"} · ${a.sales_count} ventas`
        : null,
    },
    {
      key: "first_appointment",
      label: "Primer turno agendado",
      done: Boolean(a.first_appointment_at),
      at: a.first_appointment_at,
      detail: a.first_appointment_at ? `${a.appointments_count} turnos` : null,
    },
    {
      key: "first_recurring_customer",
      label: "Primer cliente recurrente",
      done: Boolean(a.first_recurring_customer_at),
      at: a.first_recurring_customer_at,
      detail: null,
    },
    {
      key: "first_pack",
      label: "Primer pack vendido",
      done: Boolean(a.first_pack_sold_at),
      at: a.first_pack_sold_at,
      detail: null,
    },
    {
      key: "favorites",
      label: "Botones favoritos en uso",
      done: a.favorites_count > 0 && (share ?? 0) > 0,
      at: null,
      detail: `${a.favorites_count} favoritos${share != null ? ` · ${Math.round(share * 100)}% de las líneas (30 días)` : ""}`,
    },
  ];
}

// Activado = primer cobro real y al menos otro hito de recurrencia o servicio.
export function isActivated(a: TenantActivation): boolean {
  if (!a.first_sale_at) return false;
  return Boolean(a.first_appointment_at || a.first_recurring_customer_at || a.first_pack_sold_at);
}

// Puntaje 0 a 100: proporción de hitos cumplidos.
export function activationScore(a: TenantActivation): number {
  const ms = activationMilestones(a);
  return Math.round((ms.filter((m) => m.done).length / ms.length) * 100);
}
