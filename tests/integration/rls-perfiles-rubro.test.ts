// @vitest-environment node
// =============================================================================
// Perfiles por rubro (F5 · ADR-075, migración 20261102200000_perfiles_rubro):
// RPC apply_business_profile (sólo dueño, sólo prende, idempotente, audita) y
// RLS de business_profiles (catálogo de plataforma) y tenant_business_profiles
// (por negocio, sin escritura directa).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `perf-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  manager: User;
  ownerB: User;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

type Applied = {
  profile: string;
  activated: string[];
  already_on: string[];
  locked: string[];
  categories_created: string[];
  layout_applied: boolean;
  industry: string;
};

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

describe.skipIf(!enabled)("perfiles por rubro · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    // Insert multi-fila: todas las claves en cada fila (PostgREST).
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Perf A ${STAMP}`, slug: `perfa-${STAMP}`, status: "active", industry: "otro" },
        { name: `Perf B ${STAMP}`, slug: `perfb-${STAMP}`, status: "active", industry: "otro" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `perfa-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `perfb-${STAMP}`)!.id;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.manager = await makeUser(admin, `mgr-${STAMP}@test.local`, ctx.tenantA, "manager");
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.ownerB.id);

    // Una categoría previa con otra capitalización: no se duplica.
    const { error: cErr } = await admin.from("categories").insert({ tenant_id: ctx.tenantA, name: "FRUTAS" });
    if (cErr) throw cErr;
  }, 60_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("tenant_business_profiles" as never).delete().eq("tenant_id", t);
      await admin.from("categories").delete().eq("tenant_id", t);
      await admin.from("pos_settings").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el catálogo de perfiles se lee y no se escribe", async () => {
    const { data, error } = await ctx.owner.client.from("business_profiles" as never).select("key");
    expect(error).toBeNull();
    expect((data as unknown as { key: string }[]).length).toBe(11);
    const ins = await ctx.owner.client.from("business_profiles" as never).insert([
      { key: "hackeo", version: 1, label: "X", definition: {}, is_active: true, sort: 99 },
      { key: "hackeo2", version: 1, label: "Y", definition: {}, is_active: true, sort: 100 },
    ] as never);
    expect(ins.error).not.toBeNull();
  });

  it("sólo el dueño aplica un perfil", async () => {
    const r = await rpc(ctx.manager.client, "apply_business_profile", { p_key: "kiosco" });
    expect(r.error?.message).toMatch(/forbidden/);
    const bad = await rpc(ctx.owner.client, "apply_business_profile", { p_key: "no_existe" });
    expect(bad.error?.message).toMatch(/invalid_profile/);
  });

  it("aplica verdulería: prende flags, crea lo que falta, cambia el rubro y audita", async () => {
    const r = await rpc(ctx.owner.client, "apply_business_profile", { p_key: "verduleria", p_create_categories: true });
    expect(r.error).toBeNull();
    const res = r.data as Applied;
    expect(res.profile).toBe("verduleria");
    expect(res.activated).toEqual(expect.arrayContaining(["plu_enabled", "allow_free_sale"]));
    // balanza: activada si el plan la incluye, si no queda bloqueada (nunca se fuerza).
    expect([...res.activated, ...res.locked]).toContain("scale_enabled");
    expect(res.categories_created).not.toContain("Frutas");
    expect(res.categories_created).toEqual(expect.arrayContaining(["Verduras", "Carnes"]));
    expect(res.layout_applied).toBe(true);
    expect(res.industry).toBe("kiosco");

    const { data: s } = await ctx.admin
      .from("pos_settings")
      .select("plu_enabled, allow_free_sale, scale_enabled, pos_layout" as never)
      .eq("tenant_id", ctx.tenantA)
      .single();
    const row = s as unknown as { plu_enabled: boolean; allow_free_sale: boolean; scale_enabled: boolean; pos_layout: { preset?: string } };
    expect(row.plu_enabled).toBe(true);
    expect(row.allow_free_sale).toBe(true);
    expect(row.scale_enabled).toBe(res.activated.includes("scale_enabled"));
    expect(row.pos_layout.preset).toBe("caja_rapida");

    const { data: t } = await ctx.admin.from("tenants").select("industry").eq("id", ctx.tenantA).single();
    expect(t?.industry).toBe("kiosco");

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, actor_user_id")
      .eq("tenant_id", ctx.tenantA)
      .eq("action", "business_profile_applied");
    expect(logs?.length).toBe(1);
    expect(logs?.[0]?.actor_user_id).toBe(ctx.owner.id);
  });

  it("re-aplicar es idempotente: no duplica categorías ni cambia el diseño", async () => {
    const r = await rpc(ctx.owner.client, "apply_business_profile", { p_key: "verduleria" });
    expect(r.error).toBeNull();
    const res = r.data as Applied;
    expect(res.activated).toEqual([]);
    expect(res.categories_created).toEqual([]);
    expect(res.layout_applied).toBe(false);
    const { data: cats } = await ctx.admin
      .from("categories")
      .select("name")
      .eq("tenant_id", ctx.tenantA)
      .is("deleted_at", null);
    const lower = (cats ?? []).map((c) => c.name.toLowerCase());
    expect(lower.filter((n) => n === "frutas").length).toBe(1);
  });

  it("cambiar a un rubro sin mesas no apaga mesas ni delivery", async () => {
    const g = await rpc(ctx.ownerB.client, "apply_business_profile", { p_key: "gastronomia", p_create_categories: false });
    expect(g.error).toBeNull();
    const t = await rpc(ctx.ownerB.client, "apply_business_profile", { p_key: "textil", p_create_categories: false });
    expect(t.error).toBeNull();
    const { data: s } = await ctx.admin
      .from("pos_settings")
      .select("dining_enabled, delivery_enabled" as never)
      .eq("tenant_id", ctx.tenantB)
      .single();
    const row = s as unknown as { dining_enabled: boolean; delivery_enabled: boolean };
    expect(row.dining_enabled).toBe(true);
    expect(row.delivery_enabled).toBe(true);
    const { data: cats } = await ctx.admin.from("categories").select("id").eq("tenant_id", ctx.tenantB);
    expect(cats?.length).toBe(0);
    const { data: prof } = await ctx.ownerB.client
      .from("tenant_business_profiles" as never)
      .select("profile_key, previous_key")
      .eq("tenant_id", ctx.tenantB)
      .single();
    expect(prof).toEqual({ profile_key: "textil", previous_key: "gastronomia" });
  });

  it("RLS: cada negocio ve sólo su perfil y nadie lo escribe directo", async () => {
    const own = await ctx.owner.client.from("tenant_business_profiles" as never).select("tenant_id, profile_key");
    expect((own.data as unknown as { tenant_id: string }[]).map((r) => r.tenant_id)).toEqual([ctx.tenantA]);

    const cross = await ctx.ownerB.client
      .from("tenant_business_profiles" as never)
      .select("tenant_id")
      .eq("tenant_id", ctx.tenantA);
    expect(cross.data).toEqual([]);

    // Insert multi-fila con todas las claves en cada fila: denegado.
    const ins = await ctx.owner.client.from("tenant_business_profiles" as never).insert([
      { tenant_id: ctx.tenantA, profile_key: "kiosco", profile_version: 1, previous_key: null },
      { tenant_id: ctx.tenantB, profile_key: "kiosco", profile_version: 1, previous_key: null },
    ] as never);
    expect(ins.error).not.toBeNull();

    const upd = await ctx.owner.client
      .from("tenant_business_profiles" as never)
      .update({ profile_key: "otro" } as never)
      .eq("tenant_id", ctx.tenantA)
      .select("profile_key");
    expect(upd.error !== null || (upd.data as unknown[] | null)?.length === 0).toBe(true);
    const { data: still } = await ctx.admin
      .from("tenant_business_profiles" as never)
      .select("profile_key")
      .eq("tenant_id", ctx.tenantA)
      .single();
    expect(still).toEqual({ profile_key: "verduleria" });
  });
});
