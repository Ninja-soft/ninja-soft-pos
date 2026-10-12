// @vitest-environment node
// =============================================================================
// F17 · H91 (ADR-049): sucursal en audit_logs e invitación con sucursales.
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

const STAMP = `pers-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  ownerId: string;
  cashier: SupabaseClient;
  cashierId: string;
  userIds: string[];
  centro: string;
  norte: string;
};
const ctx = {} as Ctx;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

describe.skipIf(!enabled)("F17 · auditoría por sucursal e invitación con sucursales", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Pers ${STAMP}`, slug: `p-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id;
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_sucursal", "multi_caja"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;
    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.owner = owner.client;
    ctx.ownerId = owner.id;
    ctx.cashier = cashier.client;
    ctx.cashierId = cashier.id;
    ctx.userIds.push(owner.id, cashier.id);
  }, 90_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("staff_branch_assignments").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("audit_logs.store_id se completa en sucursales y cajas", async () => {
    const { data: c, error: e1 } = await ctx.owner
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    expect(e1).toBeNull();
    ctx.centro = (c as unknown as { id: string }).id;
    const { data: n, error: e2 } = await ctx.owner
      .from("stores")
      .insert({ name: "Norte" } as never)
      .select("id")
      .single();
    expect(e2).toBeNull();
    ctx.norte = (n as unknown as { id: string }).id;
    const { data: reg, error: e3 } = await ctx.owner
      .from("cash_registers")
      .insert({ store_id: ctx.norte, name: "Caja N1" } as never)
      .select("id")
      .single();
    expect(e3).toBeNull();
    const regId = (reg as unknown as { id: string }).id;

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("entity_type, entity_id, store_id")
      .eq("tenant_id", ctx.tenant);
    const rows = (logs ?? []) as { entity_type: string; entity_id: string; store_id: string | null }[];
    expect(rows.find((r) => r.entity_type === "stores" && r.entity_id === ctx.centro)?.store_id).toBe(ctx.centro);
    expect(rows.find((r) => r.entity_type === "cash_registers" && r.entity_id === regId)?.store_id).toBe(ctx.norte);
  });

  it("un store_id que no es uuid en el jsonb no rompe la auditoría", async () => {
    const { error } = await ctx.admin.from("audit_logs").insert({
      tenant_id: ctx.tenant,
      entity_type: "tenant_payment_methods",
      action: "mp_qr_pos_setup",
      after_data: { store_id: "123456789" },
    });
    expect(error).toBeNull();
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("store_id")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "mp_qr_pos_setup")
      .single();
    expect((data as { store_id: string | null }).store_id).toBeNull();
  });

  it("staff_assign_on_invite: sólo service_role", async () => {
    const r = await rpc(ctx.owner, "staff_assign_on_invite", {
      p_tenant: ctx.tenant,
      p_actor: ctx.ownerId,
      p_user: ctx.cashierId,
      p_store_ids: [ctx.norte],
      p_role: null,
    });
    expect(r.error).not.toBeNull();
  });

  it("staff_assign_on_invite: base + adicional, sin duplicar, auditado por sucursal", async () => {
    const r = await rpc(ctx.admin, "staff_assign_on_invite", {
      p_tenant: ctx.tenant,
      p_actor: ctx.ownerId,
      p_user: ctx.cashierId,
      p_store_ids: [ctx.norte, ctx.centro, ctx.norte],
      p_role: null,
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(2);

    const again = await rpc(ctx.admin, "staff_assign_on_invite", {
      p_tenant: ctx.tenant,
      p_actor: ctx.ownerId,
      p_user: ctx.cashierId,
      p_store_ids: [ctx.norte],
      p_role: null,
    });
    expect(again.data).toBe(0);

    const { data: rows } = await ctx.admin
      .from("staff_branch_assignments")
      .select("store_id, kind")
      .eq("tenant_id", ctx.tenant)
      .eq("user_id", ctx.cashierId)
      .is("deleted_at", null);
    const list = (rows ?? []) as { store_id: string; kind: string }[];
    expect(list.find((x) => x.store_id === ctx.norte)?.kind).toBe("home");
    expect(list.find((x) => x.store_id === ctx.centro)?.kind).toBe("extra");

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("store_id")
      .eq("tenant_id", ctx.tenant)
      .eq("entity_type", "staff_branch_assignments");
    const stores = ((logs ?? []) as { store_id: string | null }[]).map((l) => l.store_id).sort();
    expect(stores).toEqual([ctx.centro, ctx.norte].sort());

    // El cajero ahora ve las dos sucursales (base Norte + adicional Centro).
    const allowed = await rpc(ctx.cashier, "user_allowed_store_ids", {});
    expect(((allowed.data ?? []) as string[]).sort()).toEqual([ctx.centro, ctx.norte].sort());
  });

  it("staff_assign_on_invite: rechaza actor sin permiso y sucursal ajena", async () => {
    const forbidden = await rpc(ctx.admin, "staff_assign_on_invite", {
      p_tenant: ctx.tenant,
      p_actor: ctx.cashierId,
      p_user: ctx.cashierId,
      p_store_ids: [ctx.norte],
      p_role: null,
    });
    expect(forbidden.error?.message).toMatch(/forbidden/);
    const foreign = await rpc(ctx.admin, "staff_assign_on_invite", {
      p_tenant: ctx.tenant,
      p_actor: ctx.ownerId,
      p_user: ctx.cashierId,
      p_store_ids: ["00000000-0000-4000-8000-000000000001"],
      p_role: null,
    });
    expect(foreign.error?.message).toMatch(/store_not_found/);
  });
});
