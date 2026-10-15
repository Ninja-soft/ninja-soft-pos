// @vitest-environment node
// =============================================================================
// Marcas siempre en mayúsculas (migración 20261206100000):
//   · El trigger de brands normaliza al insertar y al renombrar
//     (upper + btrim + espacios colapsados, con acentos y ñ).
//   · El índice único (tenant_id, name) pasa a ser case-insensitive en la
//     práctica: "Epson" choca con "EPSON" en el mismo negocio, no en otro.
//   · _import_brand (importación Excel) reutiliza la marca existente aunque
//     venga con otra grafía o espacios de más.
//   · _brands_merge reasigna productos y promociones, da de baja lógica la
//     descartada y audita; no la puede llamar el navegador.
//   · Guardarraíles RLS en 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar a producción.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mar-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  userIds: string[];
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
  ctx.userIds.push(id);
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: e } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (e) throw e;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function brand(tenant: string, name: string): Promise<{ id: string; name: string }> {
  const { data, error } = await ctx.admin.from("brands").insert({ tenant_id: tenant, name }).select("id, name").single();
  if (error) throw error;
  return data as { id: string; name: string };
}

describe.skipIf(!enabled)("marcas siempre en mayúsculas", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Marcas A ${STAMP}`, slug: `ma-${STAMP}`, status: "active" },
        { name: `Marcas B ${STAMP}`, slug: `mb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenantA = rows.find((x) => x.slug === `ma-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `mb-${STAMP}`)!.id;
    ctx.owner = await makeUser(admin, `own-${STAMP}@test.local`, ctx.tenantA, "owner");
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("promotions").delete().eq("tenant_id", t);
      await admin.from("products").delete().eq("tenant_id", t);
      await admin.from("brands").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("normaliza al insertar: mayúsculas, acentos, ñ y espacios", async () => {
    expect((await brand(ctx.tenantA, "Ayudín")).name).toBe("AYUDÍN");
    expect((await brand(ctx.tenantA, "  coca   cola ")).name).toBe("COCA COLA");
    expect((await brand(ctx.tenantA, "ñandú")).name).toBe("ÑANDÚ");
  });

  it("normaliza al renombrar desde el navegador (dueño)", async () => {
    const b = await brand(ctx.tenantA, "Renombrar");
    const { error } = await ctx.owner.client.from("brands").update({ name: " Nueva  marca " }).eq("id", b.id);
    expect(error).toBeNull();
    const { data } = await ctx.admin.from("brands").select("name").eq("id", b.id).single();
    expect((data as { name: string }).name).toBe("NUEVA MARCA");
  });

  it("rechaza un nombre vacío", async () => {
    const { error } = await ctx.admin.from("brands").insert({ tenant_id: ctx.tenantA, name: "   " });
    expect(error).not.toBeNull();
  });

  it("'Epson' choca con 'EPSON' en el mismo negocio, no en otro", async () => {
    await brand(ctx.tenantA, "EPSON");
    const dup = await ctx.admin.from("brands").insert({ tenant_id: ctx.tenantA, name: "Epson" });
    expect(dup.error?.code).toBe("23505");
    expect((await brand(ctx.tenantB, "epson")).name).toBe("EPSON");
  });

  it("_import_brand reutiliza la existente con otra grafía", async () => {
    const { data: existing } = await ctx.admin
      .from("brands")
      .select("id")
      .eq("tenant_id", ctx.tenantA)
      .eq("name", "COCA COLA")
      .is("deleted_at", null)
      .single();
    const { data, error } = await ctx.admin.rpc("_import_brand", { p_tenant: ctx.tenantA, p_name: "coca    Cola" });
    expect(error).toBeNull();
    expect(data).toBe((existing as { id: string }).id);
  });

  it("_brands_merge reasigna productos y promociones, baja lógica y audita", async () => {
    const keep = await brand(ctx.tenantA, "Fusion Keep");
    const drop = await brand(ctx.tenantA, "Fusion Drop");
    const { data: prod, error: pErr } = await ctx.admin
      .from("products")
      .insert({ tenant_id: ctx.tenantA, name: `Prod ${STAMP}`, price: 10, brand_id: drop.id })
      .select("id")
      .single();
    expect(pErr).toBeNull();
    const { data: promo, error: prErr } = await ctx.admin
      .from("promotions")
      .insert({
        tenant_id: ctx.tenantA,
        name: `Promo ${STAMP}`,
        scope: "brand",
        scope_ids: [drop.id, keep.id],
        action_type: "percent",
        action_value: 10,
      })
      .select("id")
      .single();
    expect(prErr).toBeNull();

    const { error } = await ctx.admin.rpc("_brands_merge", { p_keep: keep.id, p_drop: drop.id, p_reason: "test" });
    expect(error).toBeNull();

    const { data: p } = await ctx.admin.from("products").select("brand_id").eq("id", (prod as { id: string }).id).single();
    expect((p as { brand_id: string }).brand_id).toBe(keep.id);
    const { data: pr } = await ctx.admin.from("promotions").select("scope_ids").eq("id", (promo as { id: string }).id).single();
    expect((pr as { scope_ids: string[] }).scope_ids).toEqual([keep.id]);
    const { data: d } = await ctx.admin.from("brands").select("deleted_at").eq("id", drop.id).single();
    expect((d as { deleted_at: string | null }).deleted_at).not.toBeNull();
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, after_data")
      .eq("entity_id", drop.id)
      .eq("action", "brand.merged");
    expect(logs ?? []).toHaveLength(1);
    expect((logs![0] as { after_data: { merged_into: string; products: number } }).after_data.merged_into).toBe(keep.id);
  });

  it("_brands_merge no cruza negocios ni se llama desde el navegador", async () => {
    const a = await brand(ctx.tenantA, "Cruce A");
    const b = await brand(ctx.tenantB, "Cruce B");
    const cross = await ctx.admin.rpc("_brands_merge", { p_keep: a.id, p_drop: b.id });
    expect(cross.error).not.toBeNull();
    const browser = await ctx.owner.client.rpc("_brands_merge", { p_keep: a.id, p_drop: a.id });
    expect(browser.error).not.toBeNull();
  });

  it("guardarraíles RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await ctx.admin.rpc(fn);
      expect(error, fn).toBeNull();
      expect(data ?? [], fn).toHaveLength(0);
    }
  });
});
