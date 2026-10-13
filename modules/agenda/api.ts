"use client";

// Agenda y servicios para peluquería/estética (F12 · H38).
//
// - Servicios = productos con track_stock=false + service_duration_min/commission_pct
//   (campos nuevos en products). Se listan con productsApi; acá sólo helpers.
// - Profesionales = tabla professionals (nombre, color, comisión por defecto).
// - Turnos = tabla appointments (snapshot del servicio + estado + sale_id).
//
// types/database.ts no se regenera en este PR: las tablas professionals /
// appointments y las columnas de servicio aún no están tipadas. Tipamos explícito
// acá y casteamos el nombre de tabla / payload (mismo enfoque que modules/products/
// modifiers.ts y modules/sales/api.ts). La DB + RLS validan.

import { createClient } from "@/lib/supabase/client";
import type { WaitlistEntry, WaitlistSlot } from "./waitlist";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface Professional {
  id: string;
  name: string;
  color: string;
  commission_pct: number | null;
  user_id: string | null;
  is_active: boolean;
  sort: number;
  notes: string | null;
}

export type AppointmentStatus =
  | "reservado"
  | "confirmado"
  | "en_curso"
  | "realizado"
  | "cancelado"
  | "no_show";

export interface Appointment {
  id: string;
  professional_id: string | null;
  customer_id: string | null;
  service_product_id: string | null;
  service_name: string;
  service_price: number;
  commission_pct: number | null;
  starts_at: string; // ISO
  duration_min: number;
  status: AppointmentStatus;
  notes: string | null;
  is_walk_in: boolean;
  sale_id: string | null;
  cancel_reason: string | null;
  created_at: string;
  // Silla, cabina o equipo (feature agenda_recursos, ADR-082).
  resource_id: string | null;
  // joins (best-effort): nombre del cliente y nº de venta enlazada.
  customers?: { name: string } | null;
  sales?: { number: number } | null;
}

export interface ProfessionalInput {
  name: string;
  color: string;
  commission_pct: number | null;
  is_active: boolean;
  notes: string | null;
}

export interface AppointmentInput {
  professional_id: string | null;
  customer_id: string | null;
  service_product_id: string | null;
  service_name: string;
  service_price: number;
  commission_pct: number | null;
  starts_at: string; // ISO
  duration_min: number;
  status?: AppointmentStatus;
  notes: string | null;
  is_walk_in?: boolean;
  resource_id?: string | null;
}

// ── Profesionales ─────────────────────────────────────────────────────────────

export const professionalsApi = {
  list: async (activeOnly = false): Promise<Professional[]> => {
    const supabase = createClient();
    let q = supabase
      .from("professionals" as never)
      .select("id, name, color, commission_pct, user_id, is_active, sort, notes")
      .is("deleted_at", null)
      .order("sort")
      .order("name");
    if (activeOnly) q = (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq("is_active", true);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as Professional[];
  },

  create: async (input: ProfessionalInput): Promise<Professional> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("professionals" as never)
      .insert({
        name: input.name,
        color: input.color,
        commission_pct: input.commission_pct,
        is_active: input.is_active,
        notes: input.notes,
      } as never)
      .select("id, name, color, commission_pct, user_id, is_active, sort, notes")
      .single();
    if (error) throw error;
    return data as unknown as Professional;
  },

  update: async (id: string, input: Partial<ProfessionalInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("professionals" as never)
      .update(input as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica (deleted_at). No borra físico: los turnos pasados conservan su
  // professional_id (la FK es on delete set null sólo en borrado físico).
  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("professionals" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },
};

// ── Turnos ────────────────────────────────────────────────────────────────────

export const appointmentsApi = {
  // Turnos en un rango [from, to). Trae nombre del cliente y nº de venta (join).
  listRange: async (from: Date, to: Date): Promise<Appointment[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("appointments" as never)
      .select(
        "id, professional_id, customer_id, service_product_id, service_name, service_price, commission_pct, starts_at, duration_min, status, notes, is_walk_in, sale_id, cancel_reason, created_at, resource_id, customers(name), sales(number)",
      )
      .gte("starts_at", from.toISOString())
      .lt("starts_at", to.toISOString())
      .order("starts_at");
    if (error) throw error;
    return (data ?? []) as unknown as Appointment[];
  },

  // Un turno por id (para cobrar desde el POS: carga el servicio + cliente).
  getById: async (id: string): Promise<Appointment | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("appointments" as never)
      .select(
        "id, professional_id, customer_id, service_product_id, service_name, service_price, commission_pct, starts_at, duration_min, status, notes, is_walk_in, sale_id, cancel_reason, created_at, resource_id, customers(name), sales(number)",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as unknown as Appointment | null;
  },

  create: async (input: AppointmentInput): Promise<Appointment> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("appointments" as never)
      .insert({
        professional_id: input.professional_id,
        customer_id: input.customer_id,
        service_product_id: input.service_product_id,
        service_name: input.service_name,
        service_price: input.service_price,
        commission_pct: input.commission_pct,
        starts_at: input.starts_at,
        duration_min: input.duration_min,
        status: input.status ?? "reservado",
        notes: input.notes,
        is_walk_in: input.is_walk_in ?? false,
        ...(input.resource_id ? { resource_id: input.resource_id } : {}),
      } as never)
      .select(
        "id, professional_id, customer_id, service_product_id, service_name, service_price, commission_pct, starts_at, duration_min, status, notes, is_walk_in, sale_id, cancel_reason, created_at, resource_id",
      )
      .single();
    if (error) throw error;
    return data as unknown as Appointment;
  },

  update: async (
    id: string,
    patch: Partial<
      Pick<
        Appointment,
        | "professional_id"
        | "customer_id"
        | "service_product_id"
        | "service_name"
        | "service_price"
        | "commission_pct"
        | "starts_at"
        | "duration_min"
        | "notes"
        | "resource_id"
      >
    >,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("appointments" as never)
      .update(patch as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Cambio de estado (confirmar / iniciar / realizado / no_show / cancelar). El
  // motivo sólo aplica a 'cancelado'.
  setStatus: async (
    id: string,
    status: AppointmentStatus,
    cancelReason?: string | null,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("appointments" as never)
      .update({
        status,
        ...(status === "cancelado" ? { cancel_reason: cancelReason ?? null } : {}),
      } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Enlaza el turno con la venta cobrada y lo marca 'realizado' (RPC server-side,
  // tenant-scoped). Lo llama el POS al confirmar el cobro de un turno.
  linkSale: async (appointmentId: string, saleId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("link_appointment_sale" as never, {
      p_appointment_id: appointmentId,
      p_sale_id: saleId,
    } as never);
    if (error) throw error;
  },
};

// ── Recursos (silla, cabina, box, equipo · ADR-082) ──────────────────────────

export type ResourceKind = "silla" | "cabina" | "box" | "equipo" | "otro";

export interface AgendaResource {
  id: string;
  name: string;
  kind: ResourceKind;
  color: string;
  is_active: boolean;
  sort: number;
}

export interface AgendaResourceInput {
  name: string;
  kind: ResourceKind;
  color: string;
  is_active: boolean;
}

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  silla: "Silla",
  cabina: "Cabina",
  box: "Box",
  equipo: "Equipo",
  otro: "Otro",
};

const RESOURCE_COLS = "id, name, kind, color, is_active, sort";

export const resourcesApi = {
  list: async (activeOnly = false): Promise<AgendaResource[]> => {
    const supabase = createClient();
    let q = supabase
      .from("agenda_resources" as never)
      .select(RESOURCE_COLS)
      .is("deleted_at", null)
      .order("sort")
      .order("name");
    if (activeOnly) q = (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq("is_active", true);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as AgendaResource[];
  },

  create: async (input: AgendaResourceInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("agenda_resources" as never).insert(input as never);
    if (error) throw error;
  },

  update: async (id: string, patch: Partial<AgendaResourceInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("agenda_resources" as never).update(patch as never).eq("id", id);
    if (error) throw error;
  },

  // Baja lógica: los turnos pasados conservan el recurso.
  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("agenda_resources" as never)
      .update({ deleted_at: new Date().toISOString(), is_active: false } as never)
      .eq("id", id);
    if (error) throw error;
  },
};

// ── Lista de espera (ADR-082) ─────────────────────────────────────────────────

export interface WaitlistInput {
  customer_id: string | null;
  customer_name: string | null;
  phone: string | null;
  service_product_id: string | null;
  service_name: string | null;
  professional_id: string | null;
  preferred_date: string | null;
  preferred_slot: WaitlistSlot;
  notes: string | null;
}

const WAITLIST_COLS =
  "id, customer_id, customer_name, phone, service_product_id, service_name, professional_id, preferred_date, preferred_slot, notes, status, appointment_id, created_at, customers(name, phone)";

export const waitlistApi = {
  listOpen: async (): Promise<WaitlistEntry[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("agenda_waitlist" as never)
      .select(WAITLIST_COLS)
      .eq("status", "esperando")
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as unknown as WaitlistEntry[];
  },

  create: async (input: WaitlistInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("agenda_waitlist" as never).insert(input as never);
    if (error) throw error;
  },

  cancel: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("agenda_waitlist" as never)
      .update({ status: "cancelado" } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Pasa la entrada a turno (RPC atómica: crea el turno y la marca agendada).
  schedule: async (v: {
    entryId: string;
    startsAt: string;
    professionalId: string | null;
    resourceId: string | null;
    durationMin: number | null;
  }): Promise<{ appointment_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("agenda_waitlist_schedule" as never, {
      p_entry_id: v.entryId,
      p_starts_at: v.startsAt,
      p_professional_id: v.professionalId,
      p_resource_id: v.resourceId,
      p_duration_min: v.durationMin,
    } as never);
    if (error) throw error;
    return data as unknown as { appointment_id: string };
  },
};

// ── Datos de ejemplo de la agenda (H42 · ADR-082) ─────────────────────────────

export const agendaDemoApi = {
  // ¿El negocio tiene datos de ejemplo cargados?
  hasDemo: async (): Promise<boolean> => {
    const supabase = createClient();
    const { count, error } = await supabase
      .from("agenda_demo_rows" as never)
      .select("id", { count: "exact", head: true });
    if (error) throw error;
    return (count ?? 0) > 0;
  },
  seed: async (): Promise<{ seeded: boolean; already: boolean; appointments?: number }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("agenda_demo_seed" as never);
    if (error) throw error;
    return data as unknown as { seeded: boolean; already: boolean; appointments?: number };
  },
  clear: async (): Promise<{ appointments_deleted: number; appointments_kept: number }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("agenda_demo_clear" as never);
    if (error) throw error;
    return data as unknown as { appointments_deleted: number; appointments_kept: number };
  },
};

// ── Helpers de estado (UI) ────────────────────────────────────────────────────

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  reservado: "Reservado",
  confirmado: "Confirmado",
  en_curso: "En curso",
  realizado: "Realizado",
  cancelado: "Cancelado",
  no_show: "No vino",
};

// Clase de color por estado (chips/badges). Tonos sobrios del tema ninja.
export const STATUS_BADGE: Record<AppointmentStatus, string> = {
  reservado: "bg-muted text-muted-foreground border-border",
  confirmado: "bg-sky-400/15 text-sky-300 border-sky-400/30",
  en_curso: "bg-ninja-flame/15 text-ninja-flameSoft border-ninja-flame/30",
  realizado: "bg-emerald-400/15 text-emerald-300 border-emerald-400/30",
  cancelado: "bg-red-400/10 text-red-300 border-red-400/30",
  no_show: "bg-amber-400/15 text-amber-300 border-amber-400/30",
};

// Un turno "cobrable" desde el POS: en curso o realizado y sin venta enlazada.
export function isChargeable(a: Appointment): boolean {
  return (a.status === "en_curso" || a.status === "realizado") && !a.sale_id;
}
