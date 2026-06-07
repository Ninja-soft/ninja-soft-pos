"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { SampleBrand } from "@/lib/tickets/sample";
import {
  ticketTemplatesApi,
  type TemplateDestination,
  type TemplateInput,
} from "./api";

const KEY = ["ticket-templates"];

// Branding del negocio para el preview/render de tickets. Movido desde
// TicketModal (H9b) para compartirlo con el editor de plantillas.
export function useTicketBranding(enabled = true) {
  const supabase = createClient();
  return useQuery({
    queryKey: ["ticket-branding"],
    enabled,
    queryFn: async (): Promise<SampleBrand | null> => {
      const { data } = await supabase
        .from("tenant_branding")
        .select(
          "logo_url, legal_name, cuit, phone, address, ticket_footer, ticket_width, ticket_title, ticket_legend, ticket_show_qr, ticket_show_logo",
        )
        .maybeSingle();
      return (data as SampleBrand | null) ?? null;
    },
  });
}

export function useTicketTemplates() {
  return useQuery({ queryKey: KEY, queryFn: ticketTemplatesApi.list });
}

// Modelo activo por destino (impresión/email). queryKey bajo el prefijo KEY,
// así las mutaciones de activación (useSetActiveTemplate / useClearActiveTemplate)
// que invalidan KEY refrescan también este cache.
export function useActiveTemplate(destination: TemplateDestination, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "active", destination],
    enabled,
    queryFn: () => ticketTemplatesApi.getActive(destination),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ tenantId, input }: { tenantId: string; input: TemplateInput }) =>
      ticketTemplatesApi.create(tenantId, input),
    onSuccess: inv,
  });
}

export function useUpdateTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<TemplateInput> }) =>
      ticketTemplatesApi.update(id, input),
    onSuccess: inv,
  });
}

export function useSetActiveTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, destination }: { id: string; destination: TemplateDestination }) =>
      ticketTemplatesApi.setActive(id, destination),
    onSuccess: inv,
  });
}

export function useClearActiveTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (destination: TemplateDestination) =>
      ticketTemplatesApi.clearActive(destination),
    onSuccess: inv,
  });
}

export function useRemoveTemplate() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: ticketTemplatesApi.remove, onSuccess: inv });
}
