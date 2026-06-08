"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { SampleBrand } from "@/lib/tickets/sample";
import {
  normalizePrintProfiles,
  type PrintProfiles,
} from "@/lib/print/profiles";
import {
  ticketTemplatesApi,
  type TemplateDestination,
  type TemplateInput,
} from "./api";

const KEY = ["ticket-templates"];

// Perfiles de impresión por tipo de documento (H22). Lee
// pos_settings.print_profiles (jsonb, no tipado en los types generados: cast +
// normalización) y siempre devuelve los 5 perfiles válidos. Lo consumen el POS
// (ticket de venta), Caja (cierre Z) y Devoluciones para elegir formato/copias y
// respetar impresión auto/manual. queryKey propia para invalidarla al guardar.
export function usePrintProfiles(enabled = true) {
  const supabase = createClient();
  return useQuery({
    queryKey: ["print-profiles"],
    enabled,
    queryFn: async (): Promise<PrintProfiles> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("print_profiles")
        .maybeSingle();
      const raw = (data as { print_profiles?: unknown } | null)?.print_profiles;
      return normalizePrintProfiles(raw);
    },
  });
}

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
          "logo_url, legal_name, accent, cuit, phone, address, ticket_footer, ticket_width, ticket_title, ticket_legend, ticket_show_qr, ticket_show_logo, iva_condition",
        )
        .maybeSingle();
      return (data as SampleBrand | null) ?? null;
    },
  });
}

export function useTicketTemplates() {
  return useQuery({ queryKey: KEY, queryFn: ticketTemplatesApi.list });
}

// Estado del SMTP del negocio. La RPC get_tenant_smtp SOLO responde a
// owner/manager: `allowed:false` significa "no sos dueño" (cajero o sin
// permiso). Para owners devuelve además `configured` y los campos del SMTP.
//
// Cajeros reciben `allowed:false` AUNQUE el negocio TENGA SMTP configurado
// (la tabla tenant_email_smtp es deny-all RLS, no se puede leer desde el
// cliente). Por eso `configured` solo es confiable cuando `allowed:true`. Los
// consumidores que deshabilitan acciones deben gatear únicamente con
// `allowed === true && configured === false` y dejar que el server rechace
// con error amable cuando un cajero envía sin SMTP configurado.
export interface TenantSmtpStatus {
  allowed: boolean;
  configured: boolean;
  // Proveedor de envío del negocio: 'smtp' (default) o 'resend'.
  provider?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  from_name?: string;
  from_email?: string;
  body_text?: string | null;
  body_template?: string | null;
  has_password?: boolean;
  // ¿Hay una API key de Resend guardada? La clave NUNCA viaja al frontend.
  has_resend_key?: boolean;
}

export function useTenantSmtpStatus(enabled = true) {
  const supabase = createClient();
  return useQuery({
    queryKey: ["tenant-smtp-status"],
    enabled,
    queryFn: async (): Promise<TenantSmtpStatus> => {
      const { data } = await supabase.rpc("get_tenant_smtp");
      // Compat legacy: la RPC vieja devolvía null cuando no era owner.
      if (data == null) return { allowed: false, configured: false };
      const d = data as Partial<TenantSmtpStatus>;
      return {
        allowed: Boolean(d.allowed),
        configured: Boolean(d.configured),
        provider: d.provider,
        host: d.host,
        port: d.port,
        secure: d.secure,
        username: d.username,
        from_name: d.from_name,
        from_email: d.from_email,
        body_text: d.body_text,
        body_template: d.body_template,
        has_password: d.has_password,
        has_resend_key: d.has_resend_key,
      };
    },
  });
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
