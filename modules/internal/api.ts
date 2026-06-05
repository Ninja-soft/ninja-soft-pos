import { createClient } from "@/lib/supabase/client";

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
  subStatus: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  logoUrl: string | null;
  cuit: string | null;
  phone: string | null;
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

export const internalApi = {
  listTenants: async (): Promise<InternalTenant[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id, name, slug, status, industry, created_at, trial_ends_at, subscriptions(status, plans(key, name)), tenant_users(role, users(full_name, email)), tenant_branding(logo_url, cuit, phone)",
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
      subscriptions: {
        status: string;
        plans: { key: string; name: string } | null;
      }[];
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
      const sub = t.subscriptions?.[0];
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
        subStatus: sub?.status ?? null,
        ownerName: owner?.users?.full_name ?? null,
        ownerEmail: owner?.users?.email ?? null,
        logoUrl: brand?.logo_url ?? null,
        cuit: brand?.cuit ?? null,
        phone: brand?.phone ?? null,
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
      .limit(200);
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

  generateImpersonateLink: async (
    tenantId: string,
  ): Promise<{ actionLink: string; ownerEmail: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke(
      "internal_impersonate",
      { body: { tenant_id: tenantId } },
    );
    if (error) throw error;
    const res = data as {
      ok?: boolean;
      action_link?: string;
      owner_email?: string;
      error?: string;
    };
    if (!res?.ok || !res.action_link)
      throw new Error(res?.error ?? "link_failed");
    return { actionLink: res.action_link, ownerEmail: res.owner_email ?? "" };
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
      .select("key, monthly_price_ars");
    if (error) throw error;
    const map = new Map<string, number>();
    for (const p of data ?? []) {
      map.set(p.key, Number(p.monthly_price_ars ?? 0));
    }
    return map;
  },
};
