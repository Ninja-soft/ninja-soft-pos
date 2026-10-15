import { createClient } from "@/lib/supabase/client";
import type { ArcaEnv, AuthMode, FiscalStatus } from "@/lib/arca/labels";

// Facturación electrónica ARCA (F3 · ADR-072). Las tablas y RPC nuevas no
// están en types/database.ts (no se regenera en este PR): cliente suelto,
// mismo enfoque que modules/tax/api.ts. La base y la Edge `arca_wsfe` validan
// todo (RLS, rol, feature del plan).
type Res<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  update: (row: Record<string, unknown>) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  neq: (col: string, v: unknown) => Q<T>;
  in: (col: string, v: unknown[]) => Q<T>;
  not: (col: string, op: string, v: unknown) => Q<T>;
  gte: (col: string, v: unknown) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
  limit: (n: number) => Q<T>;
  maybeSingle: () => Q<T>;
}
interface Loose {
  from: <T = unknown>(table: string) => Q<T>;
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return check(await loose().rpc<T>(fn, args));
}

/** Llama a la Edge y devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("arca_wsfe", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error(detail?.message ?? detail?.error ?? error.message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export interface ArcaSettings {
  tenant_id: string;
  enabled: boolean;
  auth_mode: AuthMode;
  environment: ArcaEnv;
  start_at: string | null;
  max_attempts: number;
  homo_min_approved: number;
  last_connection_at: string | null;
  last_connection_env: ArcaEnv | null;
  last_connection_ok: boolean | null;
  last_connection_message: string | null;
  prod_test_ok_at: string | null;
  prod_pos_verified: number[] | null;
  prod_pos_verified_at: string | null;
  last_worker_at: string | null;
  caea_enabled: boolean;
  caea_pto_vta: number | null;
  caea_timeout_seconds: number;
  caea_next_check_at: string | null;
  caea_last_message: string | null;
  contingency_since: string | null;
}

export interface ArcaCertificate {
  id: string;
  environment: ArcaEnv;
  status: "active" | "pending_csr";
  cuit: string | null;
  subject: string | null;
  issuer: string | null;
  serial: string | null;
  not_before: string | null;
  not_after: string | null;
  fingerprint_sha256: string | null;
  created_at: string;
  csr_pem: string | null;
}

export interface ChecklistItem {
  key: string;
  ok: boolean;
  count?: number;
  min?: number;
  required?: boolean;
  at?: string | null;
  pos?: number[];
  verified?: number[];
  mode?: AuthMode;
}

export interface ArcaStoreRow {
  id: string;
  name: string;
  afip_pos_number: number | null;
  is_default: boolean;
  registers: { id: string; name: string; afip_pos_number: number | null }[];
}

export interface CaeaRow {
  id: string;
  environment: ArcaEnv;
  periodo: number;
  orden: number;
  caea: string;
  fch_vig_desde: string;
  fch_vig_hasta: string;
  fch_tope_inf: string;
  sin_movimiento_at: string | null;
  sin_movimiento_error: string | null;
  used: number;
  to_inform: number;
  rejected: number;
}

export interface ArcaConfig {
  settings: ArcaSettings | null;
  feature: boolean;
  can_owner: boolean;
  platform: Partial<Record<ArcaEnv, { cuit: string | null; ready: boolean }>>;
  emitter: { cuit: string | null; iva_condition: string | null };
  certificates: ArcaCertificate[];
  checklist: { mode: AuthMode; ready: boolean; items: ChecklistItem[] };
  stores: ArcaStoreRow[];
  counts: Partial<Record<FiscalStatus, number>>;
  caea: CaeaRow[];
  dead_letter: number;
}

export interface FiscalDocument {
  id: string;
  sale_id: string;
  return_id: string | null;
  origin: "sale" | "return" | "void";
  environment: ArcaEnv;
  store_id: string | null;
  cbte_letter: string | null;
  cbte_tipo: number | null;
  pto_vta: number | null;
  cbte_nro: number | null;
  cbte_fch: string | null;
  imp_total: number | null;
  status: FiscalStatus;
  attempts: number;
  next_attempt_at: string | null;
  dead_letter_at: string | null;
  cae: string | null;
  cae_vto: string | null;
  qr_url: string | null;
  last_error_code: string | null;
  last_error_msg: string | null;
  observations: { code: string; msg: string }[] | null;
  emission_type: "CAE" | "CAEA";
  /** ADR-112: receptor y concepto, para la factura impresa. */
  doc_tipo?: number | null;
  doc_nro?: string | null;
  concepto?: number | null;
  inform_status: "pendiente" | "informado" | "rechazado" | null;
  informed_at: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface FiscalEvent {
  id: string;
  document_id: string | null;
  environment: ArcaEnv | null;
  action: string;
  outcome: string;
  attempt: number | null;
  error_code: string | null;
  error_msg: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ArcaStatus {
  enabled: boolean;
  environment: ArcaEnv;
  contingency: boolean;
  contingency_since: string | null;
  pending: number;
  needs_action: number;
}

export interface TestStep {
  key: "certificado" | "wsaa" | "dummy" | "ultimo" | "ptos_venta" | string;
  ok: boolean;
  code?: string | null;
  message?: string | null;
  title?: string | null;
  action?: string | null;
}

export interface TestResult {
  ok: boolean;
  cuit?: string | null;
  steps: TestStep[];
  pos?: { nro: number; emisionTipo: string }[];
  error?: string;
  message?: string;
}

export interface CertUploadResult {
  ok: boolean;
  certificate?: Partial<ArcaCertificate>;
  error?: string;
  problems?: string[];
  messages?: { code: string; title: string; action: string }[];
}

export interface CsrResult {
  ok: boolean;
  csr_pem: string;
  alias: string;
  cuit: string;
  organization: string;
  certificate_id?: string;
}

export interface PlatformEnvInfo {
  cuit: string | null;
  has_cert: boolean;
  has_key: boolean;
  pending_csr: boolean;
  csr_pem: string | null;
  subject: string | null;
  issuer: string | null;
  serial: string | null;
  not_after: string | null;
  fingerprint_sha256: string | null;
  ready: boolean;
  updated_at: string | null;
}

export type DocFilter = "pendientes" | "errores" | "aprobados" | "contingencia" | "todos";

const DOC_COLS =
  "id, sale_id, return_id, origin, environment, store_id, cbte_letter, cbte_tipo, pto_vta, cbte_nro, cbte_fch, imp_total, status, attempts, next_attempt_at, dead_letter_at, cae, cae_vto, qr_url, last_error_code, last_error_msg, observations, emission_type, inform_status, informed_at, approved_at, created_at, doc_tipo, doc_nro, concepto";

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export const arcaApi = {
  config: () => rpc<ArcaConfig>("arca_config_get"),
  status: () => rpc<ArcaStatus>("arca_status"),
  saveSettings: (p: Partial<Pick<ArcaSettings, "enabled" | "auth_mode" | "max_attempts" | "homo_min_approved" | "caea_enabled" | "caea_pto_vta" | "caea_timeout_seconds">>) =>
    rpc<ArcaSettings>("arca_settings_save", { p }),
  setEnvironment: (env: ArcaEnv, reason?: string) =>
    rpc<{ ok: boolean }>("arca_set_environment", { p_environment: env, p_reason: reason ?? null }),
  retryDocument: (id: string) => rpc<{ ok: boolean; status: string; blocker: string | null }>("arca_document_retry", { p_id: id }),
  enqueueSale: (saleId: string) => rpc<{ ok: boolean; id: string }>("arca_enqueue_sale_manual", { p_sale_id: saleId }),
  deleteCertificate: (id: string) => rpc<{ ok: boolean }>("arca_certificate_delete", { p_id: id }),

  documents: async (filter: DocFilter, limit = 50): Promise<FiscalDocument[]> => {
    let q = loose().from<FiscalDocument[]>("fiscal_documents").select(DOC_COLS);
    if (filter === "pendientes") q = q.in("status", ["pendiente", "enviando"]);
    if (filter === "errores") q = q.in("status", ["rechazado", "requiere_accion"]);
    if (filter === "aprobados") q = q.eq("status", "aprobado");
    if (filter === "contingencia") q = q.eq("emission_type", "CAEA");
    return check(await q.order("created_at", { ascending: false }).limit(limit)) ?? [];
  },
  saleDocuments: async (saleId: string): Promise<FiscalDocument[]> =>
    check(
      await loose()
        .from<FiscalDocument[]>("fiscal_documents")
        .select(DOC_COLS)
        .eq("sale_id", saleId)
        .neq("status", "cancelado")
        .order("created_at", { ascending: false }),
    ) ?? [],
  events: async (limit = 30): Promise<FiscalEvent[]> =>
    check(
      await loose()
        .from<FiscalEvent[]>("fiscal_document_events")
        .select("id, document_id, environment, action, outcome, attempt, error_code, error_msg, duration_ms, created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
    ) ?? [],

  setStorePos: async (storeId: string, n: number | null) => {
    check(await loose().from("stores").update({ afip_pos_number: n }).eq("id", storeId));
  },
  setRegisterPos: async (registerId: string, n: number | null) => {
    check(await loose().from("cash_registers").update({ afip_pos_number: n }).eq("id", registerId));
  },

  // Edge
  /** Después de cada venta: nunca bloquea ni muestra errores al cajero. */
  emitirVenta: (saleId: string) =>
    edge<{ ok: boolean; outcome?: string; status?: string; emission_type?: string }>({ action: "emitir_venta", sale_id: saleId }),
  emitir: (documentId?: string) =>
    edge<{ ok: boolean; processed: { id: string; outcome: string }[] }>({ action: "emitir", document_id: documentId ?? null }),
  reintentar: (documentId: string) => edge<{ ok: boolean; outcome: string }>({ action: "reintentar", document_id: documentId }),
  testConexion: (environment: ArcaEnv) => edge<TestResult>({ action: "test_conexion", environment }),
  puntosDeVenta: (environment: ArcaEnv) =>
    edge<{ ok: boolean; items?: unknown[]; pos?: { nro: number; emisionTipo: string }[]; error?: string; message?: string }>({
      action: "param",
      environment,
      table: "ptos_venta",
    }),
  generarCsr: (environment: ArcaEnv, alias?: string, organization?: string) =>
    edge<CsrResult>({ action: "generar_csr", environment, alias: alias || null, organization: organization || null }),
  subirCertificado: (environment: ArcaEnv, certPem: string) =>
    edge<CertUploadResult>({ action: "subir_certificado", environment, cert_pem: certPem }),
  caeaTareas: () =>
    edge<{ ok: boolean; run?: { obtained: number; informed: number; rejected: number; sinMovimiento: number; errors: string[] } }>({
      action: "caea_tareas",
    }),

  // Plataforma (staff interno)
  platformGet: () => rpc<Partial<Record<ArcaEnv, PlatformEnvInfo>>>("arca_platform_get"),
  platformSetCuit: (environment: ArcaEnv, cuit: string) => edge<{ ok: boolean }>({ action: "platform_set_cuit", environment, cuit }),
  platformGenerarCsr: (environment: ArcaEnv, alias?: string, organization?: string) =>
    edge<{ ok: boolean; csr_pem: string }>({ action: "platform_generar_csr", environment, alias: alias || null, organization: organization || null }),
  platformSubirCertificado: (environment: ArcaEnv, certPem: string) =>
    edge<CertUploadResult>({ action: "platform_subir_certificado", environment, cert_pem: certPem }),
  // ADR-133: certificado + clave que ya tiene NinjaSoft (la clave se cifra en el
  // servidor y nunca vuelve). `cuit`: empresa titular; tiene que coincidir con la
  // del certificado y queda como CUIT de la plataforma del ambiente.
  platformSubirPar: (environment: ArcaEnv, certPem: string, keyPem: string, cuit?: string) =>
    edge<CertUploadResult>({
      action: "platform_subir_par",
      environment,
      cert_pem: certPem,
      key_pem: keyPem,
      ...(cuit ? { cuit: cuit.replace(/\D/g, "") } : {}),
    }),
};

/** Fire-and-forget después de una venta: jamás frena ni avisa al cajero. */
// Si el negocio no factura con ARCA no se llama a la Edge en cada venta: se
// mira arca_status() (consulta barata) y se recuerda 5 minutos.
let enabledCache: { value: boolean; at: number } | null = null;
async function billingEnabled(): Promise<boolean> {
  if (enabledCache && Date.now() - enabledCache.at < 5 * 60_000) return enabledCache.value;
  const s = await arcaApi.status();
  enabledCache = { value: Boolean(s?.enabled), at: Date.now() };
  return enabledCache.value;
}

export function emitirVentaEnSegundoPlano(saleId: string | null | undefined): void {
  if (!saleId) return;
  try {
    void billingEnabled()
      .then((on) => (on ? arcaApi.emitirVenta(saleId) : undefined))
      .catch(() => undefined);
  } catch {
    // nada: la cola fiscal la toma igual con el cron.
  }
}
