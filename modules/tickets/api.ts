import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { TemplateContent } from "@/lib/tickets/blocks";

export type TicketTemplate = Tables<"ticket_templates">;
export type TemplateKind = "sale" | "promo" | "gift";
export type TemplateMode = "blocks" | "canvas" | "html";
export type TemplateDestination = "print" | "email";

// ¿La plantilla de email difiere de la de impresión? Cuando es true, el email
// debe exportar su PNG desde un nodo propio (oculto); cuando es false reutiliza
// el ticket visible. Pura: testeable sin DOM.
export function emailTemplateDiffers(
  printTpl: Pick<TicketTemplate, "id"> | null | undefined,
  emailTpl: Pick<TicketTemplate, "id"> | null | undefined,
): boolean {
  if (!emailTpl) return false;
  return emailTpl.id !== printTpl?.id;
}

export interface TemplateInput {
  name: string;
  kind: TemplateKind;
  mode: TemplateMode;
  paper: "58" | "80" | "a4";
  content: TemplateContent;
  show_ninjasoft_logo: boolean;
}

export const ticketTemplatesApi = {
  list: async (): Promise<TicketTemplate[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("ticket_templates")
      .select("*")
      .is("deleted_at", null)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as TicketTemplate[];
  },

  // Modelo activo para un destino (impresión o email). Reemplaza a getDefault:
  // la UI ya no usa `is_default`, sino los flags `print_active` / `email_active`
  // (un único activo por tenant/destino vía índice parcial único).
  getActive: async (
    destination: TemplateDestination,
  ): Promise<TicketTemplate | null> => {
    const supabase = createClient();
    const col = destination === "print" ? "print_active" : "email_active";
    const { data, error } = await supabase
      .from("ticket_templates")
      .select("*")
      .eq(col, true)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    return (data as TicketTemplate | null) ?? null;
  },

  create: async (tenantId: string, input: TemplateInput): Promise<TicketTemplate> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("ticket_templates")
      .insert({ tenant_id: tenantId, ...input, content: input.content as never })
      .select("*")
      .single();
    if (error) throw error;
    return data as TicketTemplate;
  },

  update: async (id: string, input: Partial<TemplateInput>): Promise<void> => {
    const supabase = createClient();
    const patch: Record<string, unknown> = { ...input };
    const { error } = await supabase
      .from("ticket_templates")
      .update(patch as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Activa un modelo para un destino (impresión o email). Como el índice único
  // parcial sólo admite uno activo por tenant/destino, primero desactiva el
  // actual y luego activa el nuevo.
  setActive: async (id: string, destination: TemplateDestination): Promise<void> => {
    const supabase = createClient();
    const col = destination === "print" ? "print_active" : "email_active";
    const off =
      destination === "print" ? { print_active: false } : { email_active: false };
    const on =
      destination === "print" ? { print_active: true } : { email_active: true };
    const { error: e1 } = await supabase
      .from("ticket_templates")
      .update(off)
      .eq(col, true);
    if (e1) throw e1;
    const { error: e2 } = await supabase
      .from("ticket_templates")
      .update(on)
      .eq("id", id);
    if (e2) throw e2;
  },

  // Desactiva cualquier modelo activo del destino (fallback al ticket clásico).
  clearActive: async (destination: TemplateDestination): Promise<void> => {
    const supabase = createClient();
    const col = destination === "print" ? "print_active" : "email_active";
    const off =
      destination === "print" ? { print_active: false } : { email_active: false };
    const { error } = await supabase
      .from("ticket_templates")
      .update(off)
      .eq(col, true);
    if (error) throw error;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("ticket_templates")
      .update({ deleted_at: new Date().toISOString(), is_default: false })
      .eq("id", id);
    if (error) throw error;
  },
};
