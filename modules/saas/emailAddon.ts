import { createClient } from "@/lib/supabase/client";
import type { DnsRecord, EmailAddonQuote } from "@/lib/billing/emailAddon";

// =============================================================================
// Cliente del complemento "Email con dominio NinjaSoft" (ADR-156).
//   Dueño:  owner_email_addon_offer / _quote / _activate / _use, cancel_addon.
//   Staff:  internal_email_addon_* (RPC) y la Edge email_addon_admin (key de
//           Resend y dominio; la key nunca vuelve al navegador).
// =============================================================================

type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;

function rpc(): RpcFn {
  const supabase = createClient();
  return supabase.rpc as unknown as RpcFn;
}

/** Código estable de un error de RPC (la excepción de la función SQL). */
function rpcError(e: { message?: string } | null): Error {
  const msg = e?.message ?? "error";
  const code = msg.match(/[a-z_]+$/)?.[0] ?? msg;
  return new Error(code);
}

export interface EmailAddonTier {
  id: string;
  label: string;
  quota: number;
  price: number;
}

export interface EmailAddonOffer {
  allowed: boolean;
  is_owner?: boolean;
  available?: boolean;
  label?: string;
  description?: string | null;
  sender?: { domain: string; from_email: string; from_name: string; reply_to: string | null; domain_status: string | null };
  tiers?: EmailAddonTier[];
  overage?: { policy: string; block_size: number; block_price: number };
  addon?: {
    status: string;
    usable: boolean;
    source: string;
    tier_id: string | null;
    quota: number | null;
    price: number | null;
    cancel_at_period_end: boolean;
    current_period_end: string | null;
    pending_tier_id: string | null;
    pending_quota: number | null;
    pending_price: number | null;
    pending_from: string | null;
  } | null;
  usage?: { period: string; sent: number; quota: number; overage: number; blocked: number };
  using_ninjasoft?: boolean;
  billing?: {
    mode: string;
    status: string | null;
    cancel_at_period_end: boolean;
    trial_ends_at: string | null;
    has_preapproval: boolean;
    cycle: string | null;
    current_period_end: string | null;
  };
}

export async function fetchEmailAddonOffer(): Promise<EmailAddonOffer> {
  const { data, error } = await rpc()("owner_email_addon_offer");
  if (error) throw rpcError(error);
  return (data as EmailAddonOffer | null) ?? { allowed: false };
}

export async function quoteEmailAddon(tierId: string): Promise<EmailAddonQuote> {
  const { data, error } = await rpc()("owner_email_addon_quote", { p_tier: tierId });
  if (error) throw rpcError(error);
  return data as EmailAddonQuote;
}

export interface EmailAddonActivation {
  ok: boolean;
  kind: string;
  sender: { from_email: string; reply_to: string | null };
  expected: { applies: boolean; amount: number; next_charge_date: string | null };
}

export async function activateEmailAddon(tierId: string, expectedPrice: number): Promise<EmailAddonActivation> {
  const { data, error } = await rpc()("owner_email_addon_activate", { p_tier: tierId, p_expected_price: expectedPrice });
  if (error) throw rpcError(error);
  return data as EmailAddonActivation;
}

export async function setNinjaSender(on: boolean): Promise<void> {
  const { error } = await rpc()("owner_email_addon_use", { p_on: on });
  if (error) throw rpcError(error);
}

export async function cancelEmailAddon(): Promise<void> {
  const { error } = await rpc()("cancel_addon", { p_addon_key: "email_ninjasoft" });
  if (error) throw rpcError(error);
}

// ── Staff ───────────────────────────────────────────────────────────────────

export interface InternalEmailAddonTier extends EmailAddonTier {
  sort: number;
  is_active: boolean;
  tenants: number;
}

export interface InternalEmailAddonState {
  settings: {
    domain: string;
    sender_mode: "business" | "fixed";
    fixed_local: string;
    overage_policy: "block" | "warn" | "charge";
    overage_block_size: number;
    overage_block_price: number;
    key_source: "own" | "system" | null;
    key_hint: string | null;
    key_checked_at: string | null;
    domain_id: string | null;
    domain_status: string | null;
    domain_region: string | null;
    dns_records: DnsRecord[];
    domain_checked_at: string | null;
  };
  is_active: boolean;
  ready: boolean;
  tiers: InternalEmailAddonTier[];
  usage: { tenant_id: string; tenant_name: string; sent: number; quota: number; overage: number; blocked: number }[];
  period: string;
}

export interface EmailAdminResponse {
  ok?: boolean;
  error?: string;
  detail?: string;
  state?: InternalEmailAddonState;
  system_key_available?: boolean;
  found?: boolean;
  created?: boolean;
}

export async function emailAddonAdmin(body: Record<string, unknown>): Promise<EmailAdminResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("email_addon_admin", { body });
  if (error) {
    const ctx = (error as { context?: Response } | null)?.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        return (await ctx.json()) as EmailAdminResponse;
      } catch {
        /* cuerpo no JSON */
      }
    }
    return { error: "network" };
  }
  return data as EmailAdminResponse;
}

export async function saveEmailAddonSettings(p: Record<string, unknown>): Promise<InternalEmailAddonState> {
  const { data, error } = await rpc()("internal_email_addon_save_settings", { p });
  if (error) throw rpcError(error);
  return data as InternalEmailAddonState;
}

export async function saveEmailAddonTier(t: {
  id: string | null;
  label: string;
  quota: number;
  price: number;
  sort: number;
  active: boolean;
}): Promise<string> {
  const { data, error } = await rpc()("internal_email_addon_save_tier", {
    p_id: t.id,
    p_label: t.label,
    p_quota: t.quota,
    p_price: t.price,
    p_sort: t.sort,
    p_active: t.active,
  });
  if (error) throw rpcError(error);
  return data as string;
}

export async function deleteEmailAddonTier(id: string): Promise<void> {
  const { error } = await rpc()("internal_email_addon_delete_tier", { p_id: id });
  if (error) throw rpcError(error);
}

export const EMAIL_ADMIN_ERROR: Record<string, string> = {
  missing_key: "Pegá la API key de Resend.",
  invalid_key_format: "La API key de Resend empieza con re_ y no lleva espacios.",
  invalid_key: "Resend rechazó la API key. Revisá que esté activa.",
  restricted_key:
    "Esa API key es de sólo envío. Para verificar el dominio hace falta una key con acceso completo (Full access).",
  resend_error: "Resend respondió con un error. Probá de nuevo en un rato.",
  resend_unreachable: "No pudimos conectar con Resend. Probá de nuevo.",
  no_system_key: "No hay un proveedor Resend activo en los emails del sistema.",
  no_key: "Primero guardá la API key de Resend.",
  invalid_domain: "El dominio no es válido (por ejemplo soft.ninja).",
  domain_not_verified: "El dominio todavía no está verificado en Resend.",
  invalid_to: "El email de prueba no es válido.",
  send_failed: "No se pudo enviar el email de prueba.",
  forbidden: "Sólo admin o super admin pueden configurar este complemento.",
  addon_not_ready: "Para venderlo hacen falta la API key, el dominio verificado y al menos un escalón activo.",
  overage_price_required: "Para cobrar el excedente cargá el precio del bloque.",
  invalid_label: "Poné un nombre al escalón.",
  invalid_quota: "La cantidad de emails tiene que ser mayor a cero.",
  invalid_price: "El precio tiene que ser mayor a cero.",
  tier_not_found: "Ese escalón ya no existe.",
  network: "No pudimos conectar. Revisá tu conexión.",
};
