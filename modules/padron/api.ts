import { createClient } from "@/lib/supabase/client";
import type { PadronPersona } from "@/lib/customers/padron";

// Padrón de ARCA para los clientes de los negocios (ADR-133). Edge
// `arca_padron` (consulta con el certificado de NinjaSoft, cache y cupos) y
// RPC nuevas que no están en types/database.ts (no se regenera): cliente
// suelto, como modules/fiscalProfile/api.ts.
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

/** Edge arca_padron: devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("arca_padron", { body });
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

export interface PadronStatus {
  ok?: boolean;
  available: boolean;
  reason: "feature_not_in_plan" | "disabled" | "certificate_missing" | null;
  environment: "homologacion" | "produccion" | null;
  cache_days: number | null;
  error?: string;
}

export type PadronLookup =
  | {
      ok: true;
      cached: boolean;
      status: "ok";
      persona: PadronPersona;
      fetched_at: string | null;
      environment: string;
    }
  | {
      ok: true;
      cached: boolean;
      status: "no_encontrado";
      persona: null;
      message: string | null;
      fetched_at: string | null;
      environment: string;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      message?: string;
      scope?: string;
      reason?: string;
      transient?: boolean;
    };

export interface PadronInternal {
  config: {
    enabled: boolean;
    environment: "homologacion" | "produccion";
    cache_days: number;
    tenant_per_hour: number;
    tenant_per_day: number;
    global_per_hour: number;
    last_test_at: string | null;
    last_test_ok: boolean | null;
    last_test_cuit: string | null;
    last_test_message: string | null;
    updated_at: string | null;
  };
  certificates: Partial<
    Record<
      "homologacion" | "produccion",
      { cuit: string | null; has_cert: boolean; has_key: boolean; subject: string | null; not_after: string | null; ready: boolean }
    >
  >;
  usage: {
    arca_hour: number;
    arca_day: number;
    cache_day: number;
    errors_day: number;
    tenants_day: number;
    cache_entries: number;
    day_start: string;
  };
  recent: {
    created_at: string;
    cuit: string;
    source: "arca" | "cache";
    status: "ok" | "no_encontrado" | "error";
    error_code: string | null;
    environment: string;
    tenant_name: string | null;
    tenant_id: string;
  }[];
}

export type PadronConfigInput = Partial<
  Pick<PadronInternal["config"], "enabled" | "environment" | "cache_days" | "tenant_per_hour" | "tenant_per_day" | "global_per_hour">
>;

export interface LetterOverrideResult {
  ok: boolean;
  forced: boolean;
  letter: string | null;
  suggested: string | null;
  id?: string;
}

export const padronApi = {
  status: () => edge<PadronStatus>({ action: "status" }),
  lookup: (cuit: string, opts: { refresh?: boolean } = {}) =>
    edge<PadronLookup>({ action: "lookup", cuit: cuit.replace(/\D/g, ""), ...(opts.refresh ? { refresh: true } : {}) }),
  // Staff interno (el header x-ninja-scope lo pone el cliente en /internal).
  internalGet: () => rpc<PadronInternal>("internal_arca_padron_get"),
  internalSave: (p: PadronConfigInput, reason: string) => rpc<PadronInternal>("internal_arca_padron_save", { p, p_reason: reason }),
  internalTest: (cuit: string) => edge<PadronLookup>({ action: "internal_test", cuit: cuit.replace(/\D/g, "") }),
  // Tipo de comprobante elegido a mano en la hoja de cobro.
  setLetterOverride: (customerId: string | null, letter: string, reason?: string | null) =>
    rpc<LetterOverrideResult>("sale_letter_override_set", { p_customer: customerId, p_letter: letter, p_reason: reason ?? null }),
  clearLetterOverride: () => rpc<void>("sale_letter_override_clear"),
};
