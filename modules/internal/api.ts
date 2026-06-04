import { createClient } from "@/lib/supabase/client";

export interface InternalTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  industry: string | null;
  created_at: string;
  planKey: string | null;
  planName: string | null;
  subStatus: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  logoUrl: string | null;
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
        "id, name, slug, status, industry, created_at, subscriptions(status, plans(key, name)), tenant_users(role, users(full_name, email)), tenant_branding(logo_url)",
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
      subscriptions: {
        status: string;
        plans: { key: string; name: string } | null;
      }[];
      tenant_users: {
        role: string;
        users: { full_name: string | null; email: string } | null;
      }[];
      tenant_branding: { logo_url: string | null } | { logo_url: string | null }[] | null;
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
        planKey: sub?.plans?.key ?? null,
        planName: sub?.plans?.name ?? null,
        subStatus: sub?.status ?? null,
        ownerName: owner?.users?.full_name ?? null,
        ownerEmail: owner?.users?.email ?? null,
        logoUrl: brand?.logo_url ?? null,
      };
    });
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
};
