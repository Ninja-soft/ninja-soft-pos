"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { SampleBrand } from "@/lib/tickets/sample";
import {
  normalizePrintProfiles,
  type PrintDocType,
  type PrintProfiles,
} from "@/lib/print/profiles";
import { resolvePrintTarget, type PrintTarget } from "@/lib/print/printers";
import { resolveEffective } from "@/lib/config/inheritance";
import { effectiveTicketBrand } from "@/lib/tickets/branchBrand";
import { useBranchContext, useCurrentRegister } from "@/modules/branches/hooks";
import {
  useConfigOverrides,
  usePosResolveTarget,
  usePrinters,
  useResolveTarget,
  useStoreLogo,
} from "@/modules/config/hooks";
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
  const raw = useQuery({
    queryKey: ["print-profiles"],
    enabled,
    queryFn: async (): Promise<unknown> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("print_profiles")
        .maybeSingle();
      return (data as { print_profiles?: unknown } | null)?.print_profiles ?? null;
    },
  });
  // F17 · ADR-049: perfiles efectivos de la sucursal y la caja de este
  // dispositivo (negocio ← grupo ← sucursal ← caja, mezcla por documento).
  const { data: overrides } = useConfigOverrides();
  const target = usePosResolveTarget();
  const data = useMemo(() => {
    if (raw.data === undefined) return undefined;
    const base = { print_profiles: normalizePrintProfiles(raw.data) as unknown as Record<string, unknown> };
    const eff = resolveEffective("pos_settings", "", base, overrides ?? [], target).value;
    return normalizePrintProfiles(eff.print_profiles);
  }, [raw.data, overrides, target]);
  return { data: data as PrintProfiles | undefined, isFetched: raw.isFetched, isLoading: raw.isLoading };
}

// Dónde sale un documento en este dispositivo: perfil efectivo + impresora
// registrada (asignada, de respaldo o automática por tipo) o la del equipo.
export function usePrintTarget(doc: PrintDocType, enabled = true): PrintTarget | null {
  const { data: profiles } = usePrintProfiles(enabled);
  const { data: printers } = usePrinters();
  const ctx = useBranchContext();
  const register = useCurrentRegister();
  return useMemo(() => {
    if (!profiles) return null;
    return resolvePrintTarget(doc, profiles[doc], printers ?? [], {
      storeId: ctx.posStoreId,
      registerId: register.data?.id ?? null,
    });
  }, [doc, profiles, printers, ctx.posStoreId, register.data?.id]);
}

// Branding del negocio para el preview/render de tickets. Movido desde
// TicketModal (H9b) para compartirlo con el editor de plantillas.
export function useTenantTicketBranding(enabled = true) {
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

// Branding efectivo de una sucursal (F17 · ADR-049): datos del ticket pisados
// por grupo o sucursal, dirección y teléfono de la sucursal si así se eligió y
// logo propio (si no, el del negocio). Sin storeId: la sucursal del POS.
export function useTicketBranding(enabled = true, storeId?: string | null) {
  const q = useTenantTicketBranding(enabled);
  const ctx = useBranchContext();
  const sid = storeId ?? ctx.posStoreId;
  const { data: overrides } = useConfigOverrides();
  const target = useResolveTarget(sid, null);
  const logo = useStoreLogo(sid);
  const store = useMemo(() => {
    const b = ctx.all.find((x) => x.id === sid);
    return b ? { address: b.address, city: b.city, province: b.province, phone: b.phone, logo_url: logo } : null;
  }, [ctx.all, sid, logo]);
  const data = useMemo(
    () => (q.data === undefined ? undefined : effectiveTicketBrand(q.data, overrides ?? [], target, store)),
    [q.data, overrides, target, store],
  );
  return { data, isFetched: q.isFetched, isLoading: q.isLoading };
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
