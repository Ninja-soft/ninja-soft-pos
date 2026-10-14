import { createClient } from "@/lib/supabase/client";
import { appOrigin } from "@/lib/site";
import { buildImpersonationUrl } from "@/supabase/functions/_shared/impersonation";
import type {
  NotificationSeverity,
  NotificationType,
} from "@/modules/notifications/api";

export interface InternalTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  industry: string | null;
  created_at: string;
  trial_ends_at: string | null;
  planKey: string | null;
  planName: string | null;
  /** Familia del plan: el plan base para los planes a medida (ADR-084). */
  planFamily: string | null;
  subStatus: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  logoUrl: string | null;
  cuit: string | null;
  phone: string | null;
  /** Baja lógica desde el panel interno (ADR-073). */
  deletedAt: string | null;
}

export interface FeatureFlagCatalogItem {
  key: string;
  description: string | null;
  defaultEnabled: boolean;
}

export interface FlagOverrides {
  defaultEnabled: boolean;
  overrides: Map<string, boolean>; // tenant_id → enabled
}

export interface TenantFlag {
  key: string;
  description: string | null;
  defaultEnabled: boolean;
  enabled: boolean | null; // override por tenant (null = sin override)
}

export interface TenantHealth {
  tenant_id: string;
  active_users: number;
  last_login_at: string | null;
  last_sale_at: string | null;
  sales_7d_count: number;
  sales_7d_total: number;
}

export interface InternalUser {
  id: string;
  email: string;
  full_name: string | null;
  internal_level: string | null;
  suspended_at: string | null;
  created_at: string;
  memberships: { tenantName: string; role: string; status: string }[];
}

export interface TenantNote {
  id: string;
  tenant_id: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
  authorName: string | null;
  authorEmail: string | null;
}

export interface BillingRecord {
  id: string;
  tenant_id: string;
  amount: number;
  currency: string;
  medium: string;
  period_start: string | null;
  period_end: string | null;
  receipt_ref: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface BillingRecordInput {
  tenant_id: string;
  amount: number;
  medium: string;
  period_start?: string | null;
  period_end?: string | null;
  receipt_ref?: string | null;
  notes?: string | null;
}

export interface AuditFilters {
  tenantId?: string | null;
  entityType?: string | null;
  action?: string | null;
  from?: string | null; // ISO date
  to?: string | null; // ISO date
  limit?: number; // default 200
}

export interface CreateTenantPayload {
  name: string;
  industry: string;
  owner_email: string;
  owner_name?: string | null;
  plan_key: string;
  trial_days: number;
  reason?: string | null;
}

export interface AuditEntry {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  before_data: unknown;
  after_data: unknown;
  reason: string | null;
  created_at: string;
  actorName: string | null;
  actorEmail: string | null;
}

// ── H12b — Planes custom, overrides y descuentos ───────────────────────────

// Claves numéricas de límite que la UI edita.
export const LIMIT_KEYS = [
  "max_stores",
  "max_registers_per_store",
  "max_users",
  "max_products",
  "max_sales_per_month",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export type PlanLimitNumbers = Partial<Record<LimitKey, number>> &
  Record<string, number>;

// Forma de plans.limits: { limits: {...}, modules: {...}, support: {...} }.
export interface PlanLimits {
  limits?: PlanLimitNumbers;
  modules?: Record<string, unknown>;
  support?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface TenantPlanDetail {
  planId: string;
  planKey: string;
  name: string;
  monthlyPrice: number;
  limits: PlanLimits;
  isCustom: boolean;
  basePlanKey: string | null;
  overrides: PlanLimitNumbers;
  isLifetime: boolean;
}

// ── Fase C — Creador dinámico de planes ─────────────────────────────────────

// Catálogo de features (legible por cualquier autenticado).
export interface Feature {
  key: string;
  label: string;
  description: string | null;
  grupo: string;
  is_basic: boolean;
  sort: number;
}

// Plan global con su conteo de suscriptos activos (para la tabla).
export interface PlanWithCount {
  id: string;
  key: string;
  name: string;
  secondaryName: string | null;
  description: string | null;
  icon: string | null;
  imageUrl: string | null;
  isRecommended: boolean;
  monthlyPrice: number;
  trialDays: number;
  sort: number;
  isActive: boolean;
  limits: PlanLimits;
  subscriberCount: number;
}

// Payload para internal_save_plan (id null = crear).
export interface SavePlanInput {
  id: string | null;
  key: string | null;
  name: string;
  secondaryName: string;
  description: string;
  icon: string;
  imageUrl: string;
  isRecommended: boolean;
  monthlyPrice: number;
  trialDays: number;
  limits: PlanLimits;
  isActive: boolean;
}

// Addon contratable (catálogo global activo).
export interface PlanAddon {
  id: string;
  key: string;
  label: string;
  description: string | null;
  monthlyPrice: number;
  isActive: boolean;
}

export interface AddonCatalogItem extends PlanAddon {
  /** Negocios con el addon activo (pagos + bonificados). */
  activeTenants: number;
  /** De esos, cuántos lo tienen bonificado (source = 'granted'). */
  grantedTenants: number;
}

// Código de invitación.
export type InviteKind = "lifetime" | "trial_days" | "account";

export interface InviteCode {
  id: string;
  code: string;
  kind: InviteKind;
  plan_key: string;
  trial_days: number | null;
  max_uses: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
  /** Cuenta corriente (F20-8): plazo de pago, descuento y ciclo. */
  due_days: number | null;
  discount_percent: number | null;
  discount_months: number | null;
  billing_cycle: "monthly" | "yearly" | null;
  notes: string | null;
}

export interface InviteCodeInput {
  code: string;
  kind: InviteKind;
  plan_key: string;
  trial_days: number | null;
  max_uses: number | null;
  valid_from: string | null;
  valid_until: string | null;
  due_days?: number | null;
  discount_percent?: number | null;
  discount_months?: number | null;
  billing_cycle?: "monthly" | "yearly" | null;
  notes?: string | null;
}

export interface GrantAccessInput {
  planKey: string;
  lifetime: boolean;
  freeDays: number | null;
  reason: string;
}

export interface TenantDiscount {
  id: string;
  tenant_id: string;
  kind: "percent" | "fixed";
  value: number;
  reason: string | null;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface DiscountInput {
  kind: "percent" | "fixed";
  value: number;
  reason?: string | null;
  valid_from: string;
  valid_until?: string | null;
}

// Un descuento está vigente si valid_from <= hoy <= (valid_until ?? ∞).
export function isDiscountActive(
  d: Pick<TenantDiscount, "valid_from" | "valid_until">,
  today: Date = new Date(),
): boolean {
  // Fecha LOCAL (no UTC): los descuentos son fechas de calendario del negocio.
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (d.valid_from > t) return false;
  if (d.valid_until && d.valid_until < t) return false;
  return true;
}

// Precio mensual efectivo: se aplican primero los descuentos percent (sobre el
// precio), luego se restan los fixed. Se trunca en 0.
export function effectiveMonthlyPrice(
  basePrice: number,
  discounts: Pick<TenantDiscount, "kind" | "value" | "valid_from" | "valid_until">[],
  today: Date = new Date(),
): number {
  const active = discounts.filter((d) => isDiscountActive(d, today));
  let price = basePrice;
  for (const d of active) {
    if (d.kind === "percent") price -= price * (d.value / 100);
  }
  for (const d of active) {
    if (d.kind === "fixed") price -= d.value;
  }
  return Math.max(0, price);
}

// ── Bitácora de envíos de email (paridad Food) ──────────────────────────────

export type SystemEmailKind = "system" | "receipt" | "smtp_test";
export type SystemEmailStatus = "pending" | "sent" | "failed";

export interface SystemEmail {
  id: string;
  tenant_id: string | null;
  recipient: string;
  subject: string;
  kind: SystemEmailKind;
  status: SystemEmailStatus;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  tenantName: string | null;
}

// RPC que todavía no están en types/database.ts (migraciones sin aplicar).
function untypedRpc(fn: string, args: Record<string, unknown>) {
  const client = createClient() as unknown as {
    rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  return client.rpc(fn, args);
}

export const internalApi = {
  listTenants: async (): Promise<InternalTenant[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id, name, slug, status, industry, created_at, trial_ends_at, deleted_at, subscriptions(status, plans(key, name, base_plan_key)), tenant_users(role, users(full_name, email)), tenant_branding(logo_url, cuit, phone)",
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    type Row = {
      id: string;
      name: string;
      slug: string;
      status: string;
      industry: string | null;
      created_at: string;
      trial_ends_at: string | null;
      deleted_at: string | null;
      // subscriptions es 1:1 con tenants (tenant_id único): PostgREST la
      // devuelve como objeto, no como array. Se aceptan las dos formas.
      subscriptions:
        | {
            status: string;
            plans: { key: string; name: string; base_plan_key: string | null } | null;
          }
        | {
            status: string;
            plans: { key: string; name: string; base_plan_key: string | null } | null;
          }[]
        | null;
      tenant_users: {
        role: string;
        users: { full_name: string | null; email: string } | null;
      }[];
      tenant_branding:
        | { logo_url: string | null; cuit: string | null; phone: string | null }
        | { logo_url: string | null; cuit: string | null; phone: string | null }[]
        | null;
    };
    return ((data ?? []) as unknown as Row[]).map((t) => {
      const sub = Array.isArray(t.subscriptions)
        ? t.subscriptions[0]
        : t.subscriptions;
      const owner =
        t.tenant_users?.find((x) => x.role === "owner") ?? t.tenant_users?.[0];
      const brand = Array.isArray(t.tenant_branding)
        ? t.tenant_branding[0]
        : t.tenant_branding;
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        industry: t.industry,
        created_at: t.created_at,
        trial_ends_at: t.trial_ends_at ?? null,
        planKey: sub?.plans?.key ?? null,
        planName: sub?.plans?.name ?? null,
        planFamily: sub?.plans?.base_plan_key ?? sub?.plans?.key ?? null,
        subStatus: sub?.status ?? null,
        ownerName: owner?.users?.full_name ?? null,
        ownerEmail: owner?.users?.email ?? null,
        logoUrl: brand?.logo_url ?? null,
        cuit: brand?.cuit ?? null,
        phone: brand?.phone ?? null,
        deletedAt: t.deleted_at ?? null,
      };
    });
  },

  // Catálogo global de feature flags (para el filtro del buscador interno).
  featureFlagsCatalog: async (): Promise<FeatureFlagCatalogItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("feature_flags")
      .select("key, description, default_enabled")
      .order("key");
    if (error) throw error;
    return (data ?? []).map((f) => ({
      key: f.key,
      description: f.description,
      defaultEnabled: f.default_enabled,
    }));
  },

  // Overrides por tenant de un flag puntual: enabled efectivo =
  // overrides.get(tenant_id) ?? defaultEnabled.
  flagOverrides: async (flagKey: string): Promise<FlagOverrides> => {
    const supabase = createClient();
    const [flagRes, ovRes] = await Promise.all([
      supabase
        .from("feature_flags")
        .select("default_enabled")
        .eq("key", flagKey)
        .maybeSingle(),
      supabase
        .from("tenant_feature_flags")
        .select("tenant_id, enabled, feature_flags!inner(key)")
        .eq("feature_flags.key", flagKey),
    ]);
    if (flagRes.error) throw flagRes.error;
    if (ovRes.error) throw ovRes.error;
    const overrides = new Map<string, boolean>();
    type OvRow = { tenant_id: string; enabled: boolean };
    for (const o of (ovRes.data ?? []) as unknown as OvRow[]) {
      overrides.set(o.tenant_id, o.enabled);
    }
    return {
      defaultEnabled: flagRes.data?.default_enabled ?? false,
      overrides,
    };
  },

  tenantFlags: async (tenantId: string): Promise<TenantFlag[]> => {
    const supabase = createClient();
    const [flagsRes, overridesRes] = await Promise.all([
      supabase.from("feature_flags").select("key, description, default_enabled").order("key"),
      supabase
        .from("tenant_feature_flags")
        .select("enabled, feature_flags(key)")
        .eq("tenant_id", tenantId),
    ]);
    if (flagsRes.error) throw flagsRes.error;
    const overrides = new Map<string, boolean>();
    type OvRow = { enabled: boolean; feature_flags: { key: string } | null };
    for (const o of (overridesRes.data ?? []) as unknown as OvRow[]) {
      if (o.feature_flags?.key) overrides.set(o.feature_flags.key, o.enabled);
    }
    return (flagsRes.data ?? []).map((f) => ({
      key: f.key,
      description: f.description,
      defaultEnabled: f.default_enabled,
      enabled: overrides.has(f.key) ? overrides.get(f.key)! : null,
    }));
  },

  setPlan: async (tenantId: string, planKey: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_set_plan", {
      p_tenant_id: tenantId,
      p_plan_key: planKey,
    });
    if (error) throw error;
  },

  setStatus: async (tenantId: string, status: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_set_subscription_status", {
      p_tenant_id: tenantId,
      p_status: status,
    });
    if (error) throw error;
  },

  setFlag: async (
    tenantId: string,
    flagKey: string,
    enabled: boolean,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_set_flag", {
      p_tenant_id: tenantId,
      p_flag_key: flagKey,
      p_enabled: enabled,
    });
    if (error) throw error;
  },

  tenantHealth: async (): Promise<Map<string, TenantHealth>> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("internal_tenant_health");
    if (error) throw error;
    const map = new Map<string, TenantHealth>();
    for (const row of (data ?? []) as unknown as TenantHealth[]) {
      map.set(row.tenant_id, {
        ...row,
        sales_7d_total: Number(row.sales_7d_total ?? 0),
      });
    }
    return map;
  },

  listUsers: async (): Promise<InternalUser[]> => {
    const supabase = createClient();
    const [usersRes, memberRes] = await Promise.all([
      supabase
        .from("users")
        .select("id, email, full_name, internal_level, suspended_at, created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("tenant_users")
        .select("user_id, role, status, tenants(name)"),
    ]);
    if (usersRes.error) throw usersRes.error;
    type MemRow = {
      user_id: string;
      role: string;
      status: string;
      tenants: { name: string } | null;
    };
    const byUser = new Map<string, InternalUser["memberships"]>();
    for (const m of (memberRes.data ?? []) as unknown as MemRow[]) {
      if (!m.tenants?.name) continue;
      const list = byUser.get(m.user_id) ?? [];
      list.push({ tenantName: m.tenants.name, role: m.role, status: m.status });
      byUser.set(m.user_id, list);
    }
    return (usersRes.data ?? []).map((u) => ({
      ...u,
      memberships: byUser.get(u.id) ?? [],
    }));
  },

  setUserActive: async (userId: string, active: boolean): Promise<void> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("staff_admin", {
      body: { action: "set_active", user_id: userId, active },
    });
    if (error) throw error;
    const res = data as { ok?: boolean; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? "error");
  },

  listNotes: async (tenantId: string): Promise<TenantNote[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tenant_notes")
      .select("id, tenant_id, author_user_id, body, created_at")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = data ?? [];
    const authorIds = Array.from(
      new Set(rows.map((r) => r.author_user_id).filter(Boolean)),
    ) as string[];
    const authors = new Map<string, { name: string | null; email: string }>();
    if (authorIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, full_name, email")
        .in("id", authorIds);
      for (const u of users ?? []) {
        authors.set(u.id, { name: u.full_name, email: u.email });
      }
    }
    return rows.map((r) => ({
      ...r,
      authorName: r.author_user_id
        ? authors.get(r.author_user_id)?.name ?? null
        : null,
      authorEmail: r.author_user_id
        ? authors.get(r.author_user_id)?.email ?? null
        : null,
    }));
  },

  addNote: async (tenantId: string, body: string): Promise<void> => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("no_session");
    const { error } = await supabase.from("tenant_notes").insert({
      tenant_id: tenantId,
      author_user_id: user.id,
      body: body.trim(),
    });
    if (error) throw error;
  },

  deleteNote: async (noteId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("tenant_notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", noteId);
    if (error) throw error;
  },

  listAudit: async (filters: AuditFilters): Promise<AuditEntry[]> => {
    const supabase = createClient();
    let q = supabase
      .from("audit_logs")
      .select(
        "id, tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(filters.limit ?? 200);
    if (filters.tenantId) q = q.eq("tenant_id", filters.tenantId);
    if (filters.entityType) q = q.eq("entity_type", filters.entityType);
    if (filters.action) q = q.ilike("action", `%${filters.action}%`);
    if (filters.from) q = q.gte("created_at", filters.from);
    if (filters.to) q = q.lte("created_at", `${filters.to}T23:59:59.999Z`);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];

    // Resolver nombres de actores (sin FK dura en audit_logs).
    const actorIds = Array.from(
      new Set(rows.map((r) => r.actor_user_id).filter(Boolean)),
    ) as string[];
    const actors = new Map<string, { name: string | null; email: string }>();
    if (actorIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, full_name, email")
        .in("id", actorIds);
      for (const u of users ?? []) {
        actors.set(u.id, { name: u.full_name, email: u.email });
      }
    }
    return rows.map((r) => ({
      ...r,
      actorName: r.actor_user_id ? actors.get(r.actor_user_id)?.name ?? null : null,
      actorEmail: r.actor_user_id ? actors.get(r.actor_user_id)?.email ?? null : null,
    }));
  },

  auditEntityTypes: async (): Promise<string[]> => {
    const supabase = createClient();
    // Tipos de entidad presentes (sobre los últimos 1000 registros).
    const { data, error } = await supabase
      .from("audit_logs")
      .select("entity_type")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    return Array.from(new Set((data ?? []).map((r) => r.entity_type))).sort();
  },

  setIndustry: async (tenantId: string, industry: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_set_industry", {
      p_tenant_id: tenantId,
      p_industry: industry,
    });
    if (error) throw error;
  },

  // ── H12 — Billing records ─────────────────────────────────────────────────

  listBillingRecords: async (tenantId: string): Promise<BillingRecord[]> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("billing_records")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as BillingRecord[];
  },

  addBillingRecord: async (input: BillingRecordInput): Promise<void> => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("billing_records").insert({
      ...input,
      recorded_by: user?.id ?? null,
    });
    if (error) throw error;
  },

  extendTrial: async (tenantId: string, days: number): Promise<string> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("internal_extend_trial", {
      p_tenant_id: tenantId,
      p_days: days,
    });
    if (error) throw error;
    return data as string;
  },

  // ── H11c — Impersonation ──────────────────────────────────────────────────

  // ADR-084: duración elegida y link propio (/auth/impersonate#...), que ata
  // la sesión al registro y muestra el banner con la cuenta regresiva.
  generateImpersonateLink: async (
    tenantId: string,
    reason: string,
    durationMinutes: number,
  ): Promise<{ actionLink: string; ownerEmail: string; expiresAt: string; sessionId: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke(
      "internal_impersonate",
      { body: { tenant_id: tenantId, reason, duration_minutes: durationMinutes } },
    );
    const res = (data ?? null) as {
      ok?: boolean;
      token_hash?: string;
      nonce?: string;
      expires_at?: string;
      session_id?: string;
      owner_email?: string;
      error?: string;
    } | null;
    if (error || !res?.ok || !res.token_hash || !res.nonce) {
      let code = res?.error ?? null;
      const ctx = (error as { context?: Response } | null)?.context;
      if (!code && ctx && typeof ctx.json === "function") {
        try {
          code = ((await ctx.json()) as { error?: string }).error ?? null;
        } catch {
          /* cuerpo no JSON */
        }
      }
      throw new Error(code ?? error?.message ?? "link_failed");
    }
    return {
      actionLink: buildImpersonationUrl(appOrigin(), res.token_hash, res.nonce),
      ownerEmail: res.owner_email ?? "",
      expiresAt: res.expires_at ?? "",
      sessionId: res.session_id ?? "",
    };
  },

  // ── H11c: ciclo de vida y alta manual (ADR-073) ─────────────────────────

  // Suspender / reactivar / dar de baja (lógica) con motivo obligatorio.
  tenantLifecycle: async (
    tenantId: string,
    action: "suspend" | "reactivate" | "delete",
    reason: string,
  ): Promise<void> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("internal_tenant_lifecycle", {
      p_tenant_id: tenantId,
      p_action: action,
      p_reason: reason,
    });
    if (error) throw error;
  },

  // Alta manual: la Edge invita al dueño y crea todo en una transacción.
  createTenant: async (
    payload: CreateTenantPayload,
  ): Promise<{ tenantId: string; slug: string; ownerInvited: boolean }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("internal_create_tenant", {
      body: payload,
    });
    const res = (data ?? null) as {
      ok?: boolean;
      tenant_id?: string;
      slug?: string;
      owner_invited?: boolean;
      error?: string;
    } | null;
    if (error || !res?.ok || !res.tenant_id) {
      // FunctionsHttpError trae el cuerpo en context: se lee el código de error.
      let code = res?.error ?? null;
      const ctx = (error as { context?: Response } | null)?.context;
      if (!code && ctx && typeof ctx.json === "function") {
        try {
          code = ((await ctx.json()) as { error?: string }).error ?? null;
        } catch {
          /* cuerpo no JSON */
        }
      }
      throw new Error(code ?? error?.message ?? "tenant_create_failed");
    }
    return { tenantId: res.tenant_id, slug: res.slug ?? "", ownerInvited: Boolean(res.owner_invited) };
  },

  // Fija la fecha exacta de fin del trial (acortar / terminar ya / extender).
  setTrialEnd: async (
    tenantId: string,
    endsAt: string,
    reason?: string | null,
  ): Promise<string> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("internal_set_trial_end", {
      p_tenant_id: tenantId,
      p_ends_at: endsAt,
      p_reason: reason ?? null,
    });
    if (error) throw error;
    return data as string;
  },

  // Desenlace del trial: convertir a pago o marcar perdido, con motivo.
  trialOutcome: async (
    tenantId: string,
    outcome: "converted" | "lost",
    reason?: string | null,
  ): Promise<void> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("internal_trial_outcome", {
      p_tenant_id: tenantId,
      p_outcome: outcome,
      p_reason: reason ?? null,
    });
    if (error) throw error;
  },

  // Precio mensual por plan (para estimar deuda en la card de facturación).
  planPrices: async (): Promise<Map<string, number>> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("plans")
      .select("key, monthly_price_ars")
      .is("tenant_id", null);
    if (error) throw error;
    const map = new Map<string, number>();
    for (const p of data ?? []) {
      map.set(p.key, Number(p.monthly_price_ars ?? 0));
    }
    return map;
  },

  // ── H12b — Planes custom + overrides + descuentos ─────────────────────────

  // Catálogo de planes globales (tenant_id null) para el selector.
  // Orden jerárquico por `sort` (Start→Pro→Business→Enterprise), no por precio:
  // así el dropdown respeta la jerarquía aunque un plan caro tenga sort bajo.
  globalPlans: async (): Promise<{ key: string; name: string }[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("plans")
      .select("key, name")
      .is("tenant_id", null)
      .eq("is_active", true)
      .order("sort");
    if (error) throw error;
    return (data ?? []).map((p) => ({ key: p.key, name: p.name }));
  },

  // Detalle del plan actual del tenant + overrides de límites (de la sub).
  tenantPlanDetail: async (tenantId: string): Promise<TenantPlanDetail | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("subscriptions")
      .select(
        "limit_overrides, is_lifetime, plans(id, key, name, monthly_price_ars, limits, tenant_id, base_plan_key)",
      )
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    type Row = {
      limit_overrides: PlanLimitNumbers | null;
      is_lifetime: boolean | null;
      plans: {
        id: string;
        key: string;
        name: string;
        monthly_price_ars: number;
        limits: PlanLimits | null;
        tenant_id: string | null;
        base_plan_key: string | null;
      } | null;
    };
    const row = data as unknown as Row;
    if (!row.plans) return null;
    return {
      planId: row.plans.id,
      planKey: row.plans.key,
      name: row.plans.name,
      monthlyPrice: Number(row.plans.monthly_price_ars ?? 0),
      limits: row.plans.limits ?? {},
      isCustom: row.plans.tenant_id !== null,
      basePlanKey: row.plans.base_plan_key,
      overrides: (row.limit_overrides ?? {}) as PlanLimitNumbers,
      isLifetime: row.is_lifetime ?? false,
    };
  },

  clonePlan: async (
    tenantId: string,
    basePlanKey: string,
    name: string,
    monthlyPrice: number,
  ): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("internal_clone_plan", {
      p_tenant_id: tenantId,
      p_base_plan_key: basePlanKey,
      p_name: name,
      p_monthly_price: monthlyPrice,
    });
    if (error) throw error;
    return data as string;
  },

  updateCustomPlan: async (
    planId: string,
    name: string,
    monthlyPrice: number,
    limits: PlanLimits,
    reason?: string | null,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_update_custom_plan", {
      p_plan_id: planId,
      p_name: name,
      p_monthly_price: monthlyPrice,
      p_limits: limits as unknown as Record<string, never>,
      p_reason: reason ?? undefined,
    });
    if (error) throw error;
  },

  // value null → quita el override. Devuelve el objeto overrides actualizado.
  setLimitOverride: async (
    tenantId: string,
    key: string,
    value: number | null,
    reason?: string | null,
  ): Promise<PlanLimitNumbers> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("internal_set_limit_override", {
      p_tenant_id: tenantId,
      p_key: key,
      // El backend acepta null para quitar el override; los types lo tipan number.
      p_value: value as number,
      p_reason: reason ?? undefined,
    });
    if (error) throw error;
    return (data ?? {}) as PlanLimitNumbers;
  },

  // ── Fase C — Features, planes globales, addons, códigos, accesos ──────────

  // Catálogo de features agrupadas (legible por cualquier autenticado).
  features: async (): Promise<Feature[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("features")
      .select("key, label, description, grupo, is_basic, sort")
      .order("sort");
    if (error) throw error;
    return (data ?? []) as Feature[];
  },

  // Planes globales (tenant_id null) + conteo de suscriptos activos por plan.
  listPlansWithCounts: async (): Promise<PlanWithCount[]> => {
    const supabase = createClient();
    const [plansRes, subsRes] = await Promise.all([
      supabase
        .from("plans")
        // secondary_name/image_url/is_recommended no están aún en los types
        // generados (regen pendiente): el select string igual los trae.
        .select(
          "id, key, name, secondary_name, description, icon, image_url, is_recommended, monthly_price_ars, trial_days, sort, is_active, limits",
        )
        .is("tenant_id", null)
        .order("sort"),
      supabase
        .from("subscriptions")
        .select("plan_id, status")
        .in("status", ["trial", "active", "past_due"]),
    ]);
    if (plansRes.error) throw plansRes.error;
    if (subsRes.error) throw subsRes.error;
    const counts = new Map<string, number>();
    for (const s of subsRes.data ?? []) {
      counts.set(s.plan_id, (counts.get(s.plan_id) ?? 0) + 1);
    }
    type PlanRow = {
      id: string;
      key: string;
      name: string;
      secondary_name: string | null;
      description: string | null;
      icon: string | null;
      image_url: string | null;
      is_recommended: boolean | null;
      monthly_price_ars: number | null;
      trial_days: number | null;
      sort: number | null;
      is_active: boolean;
      limits: PlanLimits | null;
    };
    return ((plansRes.data ?? []) as unknown as PlanRow[]).map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      secondaryName: p.secondary_name ?? null,
      description: p.description,
      icon: p.icon,
      imageUrl: p.image_url ?? null,
      isRecommended: p.is_recommended ?? false,
      monthlyPrice: Number(p.monthly_price_ars ?? 0),
      trialDays: p.trial_days ?? 0,
      sort: p.sort ?? 0,
      isActive: p.is_active,
      limits: (p.limits ?? {}) as PlanLimits,
      subscriberCount: counts.get(p.id) ?? 0,
    }));
  },

  savePlan: async (input: SavePlanInput): Promise<string> => {
    const supabase = createClient();
    // Se pasan los 12 params nombrados para que PostgREST resuelva la sobrecarga
    // nueva (12 args) y no la antigua (9). secondary_name/image_url/is_recommended
    // aún no están en los types generados (regen pendiente): el objeto se arma
    // como Record y se castea a la firma esperada por rpc() (la vieja de 9 args).
    const args: Record<string, unknown> = {
      p_id: input.id,
      p_key: input.key,
      p_name: input.name,
      p_description: input.description,
      p_icon: input.icon,
      p_monthly_price: input.monthlyPrice,
      p_trial_days: input.trialDays,
      p_limits: input.limits,
      p_is_active: input.isActive,
      p_secondary_name: input.secondaryName || null,
      p_image_url: input.imageUrl || null,
      p_is_recommended: input.isRecommended,
    };
    const { data, error } = await supabase.rpc(
      "internal_save_plan",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args as any,
    );
    if (error) throw error;
    return data as string;
  },

  // Addons contratables (catálogo global activo).
  planAddons: async (): Promise<PlanAddon[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("plan_addons")
      .select("id, key, label, description, monthly_price_ars, is_active")
      .eq("is_active", true)
      .order("monthly_price_ars");
    if (error) throw error;
    return (data ?? []).map((a) => ({
      id: a.id,
      key: a.key,
      label: a.label,
      description: a.description,
      monthlyPrice: Number(a.monthly_price_ars ?? 0),
      isActive: a.is_active,
    }));
  },

  // Catálogo completo de addons (activos e inactivos) con cuántos negocios los
  // tienen activos, separando los bonificados. Sólo lectura (pantalla
  // Complementos del panel interno).
  addonCatalog: async (): Promise<AddonCatalogItem[]> => {
    const supabase = createClient();
    const [addons, subs] = await Promise.all([
      supabase
        .from("plan_addons")
        .select("id, key, label, description, monthly_price_ars, is_active")
        .order("is_active", { ascending: false })
        .order("label"),
      supabase.from("subscription_addons").select("addon_key, source").eq("status", "active"),
    ]);
    if (addons.error) throw addons.error;
    if (subs.error) throw subs.error;
    const counts = new Map<string, { total: number; granted: number }>();
    for (const s of subs.data ?? []) {
      const c = counts.get(s.addon_key) ?? { total: 0, granted: 0 };
      c.total += 1;
      if (s.source === "granted") c.granted += 1;
      counts.set(s.addon_key, c);
    }
    return (addons.data ?? []).map((a) => ({
      id: a.id,
      key: a.key,
      label: a.label,
      description: a.description,
      monthlyPrice: Number(a.monthly_price_ars ?? 0),
      isActive: a.is_active,
      activeTenants: counts.get(a.key)?.total ?? 0,
      grantedTenants: counts.get(a.key)?.granted ?? 0,
    }));
  },

  // Addons activos de un tenant (set de keys con status active).
  tenantAddons: async (tenantId: string): Promise<Set<string>> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("subscription_addons")
      .select("addon_key, status")
      .eq("tenant_id", tenantId)
      .eq("status", "active");
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.addon_key));
  },

  setAddon: async (
    tenantId: string,
    addonKey: string,
    active: boolean,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_set_addon", {
      p_tenant_id: tenantId,
      p_addon_key: addonKey,
      p_active: active,
    });
    if (error) throw error;
  },

  // Regalar (bonificar) un addon a un negocio: alta/activación con
  // source='granted', sin cobro, idempotente y auditada (RPC internal_grant_addon
  // de la migración 20260608440000). Aún sin types generados → cast del cliente.
  grantAddon: async (tenantId: string, addonKey: string): Promise<void> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("internal_grant_addon", {
      p_tenant: tenantId,
      p_addon_key: addonKey,
    });
    if (error) throw error;
  },

  // Quitar un addon BONIFICADO (cancela el grant; no toca un addon pago).
  revokeAddon: async (tenantId: string, addonKey: string): Promise<void> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("internal_revoke_addon", {
      p_tenant: tenantId,
      p_addon_key: addonKey,
    });
    if (error) throw error;
  },

  grantAccess: async (
    tenantId: string,
    input: GrantAccessInput,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("internal_grant_access", {
      p_tenant_id: tenantId,
      p_plan_key: input.planKey,
      p_lifetime: input.lifetime,
      p_free_days: (input.freeDays ?? undefined) as number | undefined,
      p_reason: input.reason || undefined,
    });
    if (error) throw error;
  },

  // ── Códigos de invitación: lectura con RLS internal, escritura por RPC
  //    auditada (F20-8 · ADR-120) ───────────────────────────────────────────

  listInviteCodes: async (): Promise<InviteCode[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("invite_codes")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as unknown as InviteCode[]).map((c) => ({
      ...c,
      kind: c.kind as InviteKind,
    }));
  },

  createInviteCode: async (input: InviteCodeInput): Promise<void> => {
    const { error } = await untypedRpc("internal_invite_code_create", { p_data: input });
    if (error) throw new Error(error.message);
  },

  setInviteCodeActive: async (id: string, active: boolean): Promise<void> => {
    const { error } = await untypedRpc("internal_invite_code_set_active", { p_id: id, p_active: active });
    if (error) throw new Error(error.message);
  },

  deleteInviteCode: async (id: string): Promise<void> => {
    const { error } = await untypedRpc("internal_invite_code_delete", { p_id: id });
    if (error) throw new Error(error.message);
  },

  listDiscounts: async (tenantId: string): Promise<TenantDiscount[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tenant_discounts")
      .select(
        "id, tenant_id, kind, value, reason, valid_from, valid_until, created_at, created_by, deleted_at",
      )
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("valid_from", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as TenantDiscount[]).map((d) => ({
      ...d,
      value: Number(d.value),
    }));
  },

  addDiscount: async (
    tenantId: string,
    input: DiscountInput,
  ): Promise<void> => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from("tenant_discounts").insert({
      tenant_id: tenantId,
      kind: input.kind,
      value: input.value,
      reason: input.reason ?? null,
      valid_from: input.valid_from,
      valid_until: input.valid_until ?? null,
      created_by: user?.id ?? null,
    });
    if (error) throw error;
  },

  removeDiscount: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("tenant_discounts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },

  // ── H13b — Composer de notificaciones ─────────────────────────────────────

  sendNotification: async (input: SendNotificationInput): Promise<string> => {
    const supabase = createClient();
    // p_display_until es el 12º arg (migración 20260608200000); aún no está en
    // los types generados (regen pendiente), por eso el cast del payload.
    const args: Record<string, unknown> = {
      // El backend acepta null para acotar/ampliar la audiencia; los types los
      // tipan como string requerido, por eso el cast.
      p_tenant_id: input.tenantId as unknown as string,
      p_role: input.role as unknown as string,
      p_user_id: input.userId as unknown as string,
      p_type: input.type,
      p_severity: input.severity,
      p_title: input.title,
      p_body: input.body || undefined,
      p_action_label: input.actionLabel || undefined,
      p_action_url: input.actionUrl || undefined,
      p_requires_ack: input.requiresAck,
      p_expires_at: input.expiresAt || undefined,
      p_display_until: input.displayUntil || undefined,
    };
    const { data, error } = await supabase.rpc(
      "internal_notify",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args as any,
    );
    if (error) throw error;
    return data as string;
  },

  // Baja lógica auditada de una notificación cargada (RPC internal, solo staff
  // no-support). RPC nuevo (migración 20260608200000) aún sin types generados.
  deleteNotification: async (id: string): Promise<void> => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("internal_delete_notification", {
      p_id: id,
    });
    if (error) throw error;
  },

  // Últimas 100 notificaciones (el staff las ve todas vía RLS), con una
  // descripción legible de la audiencia (negocio / rol / usuario / todos).
  listSentNotifications: async (): Promise<SentNotification[]> => {
    const supabase = createClient();
    const base =
      "id, type, severity, title, body, requires_ack, target_tenant_id, target_role, target_user_id, created_at, expires_at, display_until, tenants:target_tenant_id(name), users:target_user_id(full_name, email)";
    // ADR-084: los envíos por segmento traen lote y segmento (una fila por
    // negocio; el historial las agrupa). Sin la migración 20261107100300 se
    // cae a las columnas de siempre.
    const query = (cols: string) =>
      supabase
        .from("notifications")
        .select(cols)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(500);
    let { data, error } = await query(`${base}, segment_batch_id, segment`);
    if (error && /segment/.test(error.message)) ({ data, error } = await query(base));
    if (error) throw error;
    type Row = {
      id: string;
      type: string;
      severity: string;
      title: string;
      body: string | null;
      requires_ack: boolean;
      target_tenant_id: string | null;
      target_role: string | null;
      target_user_id: string | null;
      created_at: string;
      expires_at: string | null;
      display_until: string | null;
      tenants: { name: string } | null;
      users: { full_name: string | null; email: string } | null;
      segment_batch_id?: string | null;
      segment?: unknown;
    };
    return ((data ?? []) as unknown as Row[]).map((n) => ({
      id: n.id,
      segmentBatchId: n.segment_batch_id ?? null,
      segment: n.segment ?? null,
      type: n.type as NotificationType,
      severity: n.severity as NotificationSeverity,
      title: n.title,
      body: n.body,
      requiresAck: n.requires_ack,
      createdAt: n.created_at,
      expiresAt: n.expires_at,
      displayUntil: n.display_until,
      audience: describeAudience({
        tenantName: n.tenants?.name ?? null,
        role: n.target_role,
        userLabel: n.users?.full_name ?? n.users?.email ?? null,
        hasTenant: n.target_tenant_id !== null,
        hasUser: n.target_user_id !== null,
      }),
    }));
  },

  // Bitácora de envíos: últimos 200 emails salientes (sistema, comprobante,
  // prueba SMTP) con el negocio asociado. Solo staff los ve (RLS interna).
  listSystemEmails: async (): Promise<SystemEmail[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("system_emails")
      .select(
        "id, tenant_id, recipient, subject, kind, status, error_message, sent_at, created_at, tenants(name)",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    type Row = {
      id: string;
      tenant_id: string | null;
      recipient: string;
      subject: string;
      kind: string;
      status: string;
      error_message: string | null;
      sent_at: string | null;
      created_at: string;
      tenants: { name: string } | null;
    };
    return ((data ?? []) as unknown as Row[]).map((e) => ({
      id: e.id,
      tenant_id: e.tenant_id,
      recipient: e.recipient,
      subject: e.subject,
      kind: e.kind as SystemEmailKind,
      status: e.status as SystemEmailStatus,
      error_message: e.error_message,
      sent_at: e.sent_at,
      created_at: e.created_at,
      tenantName: e.tenants?.name ?? null,
    }));
  },
};

// ── H13b — Tipos del composer de notificaciones ─────────────────────────────

export interface SendNotificationInput {
  tenantId: string | null;
  role: string | null;
  userId: string | null;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
  requiresAck: boolean;
  expiresAt: string; // ISO o "" si no vence
  displayUntil: string; // ISO o "" si no hay corte de captación
}

export interface SentNotification {
  id: string;
  /** Lote de un envío por segmento (ADR-084); null en los envíos sueltos. */
  segmentBatchId: string | null;
  segment: unknown;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  requiresAck: boolean;
  createdAt: string;
  expiresAt: string | null;
  displayUntil: string | null;
  audience: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Dueños",
  manager: "Encargados",
  cashier: "Cajeros",
  viewer: "Solo lectura",
};

// Construye la descripción legible de a quién apunta una notificación.
function describeAudience(args: {
  tenantName: string | null;
  role: string | null;
  userLabel: string | null;
  hasTenant: boolean;
  hasUser: boolean;
}): string {
  if (args.hasUser) return args.userLabel ?? "Un usuario";
  const roleLabel = args.role ? ROLE_LABELS[args.role] ?? args.role : null;
  if (args.hasTenant) {
    const base = args.tenantName ?? "Un negocio";
    return roleLabel ? `${base} · ${roleLabel}` : base;
  }
  return roleLabel ? `Todos los negocios · ${roleLabel}` : "Todos los negocios";
}
