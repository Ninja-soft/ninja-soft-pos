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
}

export interface TenantFlag {
  key: string;
  description: string | null;
  defaultEnabled: boolean;
  enabled: boolean | null; // override por tenant (null = sin override)
}

export const internalApi = {
  listTenants: async (): Promise<InternalTenant[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tenants")
      .select(
        "id, name, slug, status, industry, created_at, subscriptions(status, plans(key, name)), tenant_users(role, users(full_name, email))",
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
    };
    return ((data ?? []) as unknown as Row[]).map((t) => {
      const sub = t.subscriptions?.[0];
      const owner =
        t.tenant_users?.find((x) => x.role === "owner") ?? t.tenant_users?.[0];
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
};
