import { createClient } from "@/lib/supabase/client";
import type { BillingSource, CompanyFiscal, HolderType, Verification } from "@/lib/billing/fiscalProfile";
import type { PlatformLetterStatus } from "@/lib/billing/letter";

// Datos fiscales del negocio para la facturación de NinjaSoft (F20-3 ·
// ADR-110 / ADR-117). Las RPC nuevas no están en types/database.ts (no se
// regenera en este PR): cliente suelto, como modules/arca/api.ts. La base y
// la Edge `platform_billing` validan todo (RLS, rol, nivel del staff).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Loose {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await loose().rpc<T>(fn, args);
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

/** Edge platform_billing: devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("platform_billing", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: Record<string, unknown> | null = null;
    try {
      detail = ctx ? ((await ctx.json()) as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    if (detail && typeof detail === "object") return detail as T;
    throw new Error(error.message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export interface EffectiveProfile {
  tenant_id: string;
  source: BillingSource;
  use_company_data: boolean;
  has_profile: boolean;
  profile_id: string | null;
  valid_from: string | null;
  holder_type: HolderType | null;
  doc_tipo: number;
  doc_nro: string | null;
  razon_social: string | null;
  iva_condition: string | null;
  iva_condition_arca_id: number | null;
  domicilio: string | null;
  email: string | null;
  email_is_default: boolean;
  verification: Verification;
  verified: boolean;
  verified_at: string | null;
  padron_checked_at: string | null;
  letter: string | null;
  letter_status: PlatformLetterStatus;
  blocked_a_unverified: boolean;
  issuer: { environment: string | null; iva_condition: string | null; configured: boolean };
}

export interface ProfileRow {
  id: string;
  use_company_data: boolean;
  holder_type: HolderType | null;
  doc_tipo: number | null;
  doc_nro: string | null;
  razon_social: string | null;
  iva_condition: string | null;
  domicilio: string | null;
  email_facturacion: string | null;
  verification: Verification;
  verified_at: string | null;
  padron_checked_at: string | null;
  source: "owner" | "internal" | "system";
  valid_from: string;
  valid_to: string | null;
}

export interface PadronAvailability {
  available: boolean;
  reason: "issuer_missing" | "disabled" | "certificate_missing" | null;
  environment: string | null;
}

export interface MyBillingProfile {
  tenant_id: string;
  effective: EffectiveProfile;
  company: CompanyFiscal | null;
  current: ProfileRow | null;
  owner_email: string | null;
  padron: PadronAvailability;
}

export interface HistoryRow extends ProfileRow {
  created_by_email: string | null;
  reason: string | null;
  deleted_at: string | null;
}

export interface LookupRow {
  id: string;
  cuit: string;
  environment: string;
  status: "ok" | "no_encontrado" | "error";
  result: PadronPersona | null;
  error: string | null;
  fetched_at: string;
}

export interface InternalBillingProfile {
  effective: EffectiveProfile;
  company: CompanyFiscal | null;
  padron: PadronAvailability;
  history: HistoryRow[];
  lookups: LookupRow[];
}

export interface OverviewRow {
  tenant_id: string;
  source: BillingSource;
  razon_social: string | null;
  doc_nro: string | null;
  verification: Verification;
  verified: boolean;
  letter: string | null;
  letter_status: PlatformLetterStatus;
  has_profile: boolean;
}

export interface IssuerProfile {
  environment: "homologacion" | "produccion";
  is_active: boolean;
  cuit: string | null;
  razon_social: string | null;
  iva_condition: string | null;
  domicilio_comercial: string | null;
  padron_enabled: boolean;
  certificate_ready: boolean;
  updated_at: string;
}

export interface IssuerConfig {
  profiles: IssuerProfile[];
  padron: PadronAvailability;
}

export interface PadronPersona {
  cuit: string;
  tipo_persona: "FISICA" | "JURIDICA" | null;
  razon_social: string;
  estado_clave: string | null;
  activa: boolean;
  domicilio: string | null;
  provincia: string | null;
  iva_condition: string;
  iva_source: "monotributo" | "regimen_general" | "sin_iva";
  impuestos: number[];
  monotributo_categoria: string | null;
  avisos: string[];
}

export type PadronLookupResult =
  | { ok: true; cached: boolean; status: "ok"; persona: PadronPersona; fetched_at: string | null }
  | { ok: true; cached: boolean; status: "no_encontrado"; message: string | null }
  | { ok: false; error: string; reason?: string; message?: string; code?: string };

/** Lo que se manda al guardar (la base valida y decide la verificación). */
export interface ProfileInput {
  use_company_data: boolean;
  holder_type?: HolderType | null;
  doc_tipo?: number | null;
  doc_nro?: string | null;
  razon_social?: string | null;
  iva_condition?: string | null;
  domicilio?: string | null;
  email_facturacion?: string | null;
  use_padron?: boolean;
  /** Sólo staff. */
  staff_verified?: boolean;
}

export const fiscalProfileApi = {
  mine: () => rpc<MyBillingProfile>("my_billing_profile"),
  saveMine: (p: ProfileInput) => rpc<EffectiveProfile>("owner_set_billing_profile", { p }),
  lookup: (cuit: string, opts: { tenantId?: string; refresh?: boolean } = {}) =>
    edge<PadronLookupResult>({
      action: "padron_lookup",
      cuit,
      ...(opts.tenantId ? { tenant_id: opts.tenantId } : {}),
      ...(opts.refresh ? { refresh: true } : {}),
    }),
  internalGet: (tenantId: string) => rpc<InternalBillingProfile>("internal_billing_profile_get", { p_tenant: tenantId }),
  internalSave: (tenantId: string, p: ProfileInput, reason: string) =>
    rpc<EffectiveProfile>("internal_set_billing_profile", { p_tenant: tenantId, p, p_reason: reason }),
  overview: () => rpc<OverviewRow[]>("internal_billing_profiles_overview"),
  issuerGet: () => rpc<IssuerConfig>("internal_platform_issuer_get"),
  issuerSave: (env: string, p: Record<string, unknown>, reason: string) =>
    rpc<IssuerConfig>("internal_set_platform_issuer", { p_env: env, p, p_reason: reason }),
};
