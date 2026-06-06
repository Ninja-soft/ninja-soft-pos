import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { BlocksContent } from "@/lib/tickets/blocks";

export type TicketTemplate = Tables<"ticket_templates">;
export type TemplateKind = "sale" | "promo" | "gift";

export interface TemplateInput {
  name: string;
  kind: TemplateKind;
  mode: "blocks";
  paper: "58" | "80" | "a4";
  content: BlocksContent;
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

  getDefault: async (kind: TemplateKind): Promise<TicketTemplate | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("ticket_templates")
      .select("*")
      .eq("kind", kind)
      .eq("is_default", true)
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

  // Marca default: primero desmarca el actual del mismo kind (índice único parcial).
  setDefault: async (id: string, kind: TemplateKind): Promise<void> => {
    const supabase = createClient();
    const { error: e1 } = await supabase
      .from("ticket_templates")
      .update({ is_default: false })
      .eq("kind", kind)
      .eq("is_default", true);
    if (e1) throw e1;
    const { error: e2 } = await supabase
      .from("ticket_templates")
      .update({ is_default: true })
      .eq("id", id);
    if (e2) throw e2;
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
