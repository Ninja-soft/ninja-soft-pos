// @vitest-environment node
// =============================================================================
// Editor de roles (ADR-138, migración 20261204100200): crear, asignar, rol por
// sucursal, permisos puntuales y borrar con reasignación, todo por RPC y
// auditado. Supabase LOCAL (mismas variables que rls.test.ts); sin ellas se
// salta. NUNCA apuntar a producción.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `roles-ed-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const SYS = { owner: "00000000-0000-4000-8000-0000000000a1", cashier: "00000000-0000-4000-8000-0000000000a3", auditor: "00000000-0000-4000-8000-0000000000a6" };

type User = { id: string; client: SupabaseClient };
type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const ctx = {} as { admin: SupabaseClient; tenant: string; other: string; owner: User; manager: User; cashier: User; stranger: User; ids: string[]; role: string };

async function makeUser(email: string, tenant: string, role: string): Promise<User> {
  const { data, error } = await ctx.admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, app_metadata: { current_tenant_id: tenant } });
  if (error) throw error;
  const id = data.user!.id;
  ctx.ids.push(id);
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: e2 } = await ctx.admin.from("tenant_users").insert({ tenant_id: tenant, user_id: id, role, status: "active" });
  if (e2) throw e2;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  return { id, client };
}

describe.skipIf(!enabled)("editor de roles y permisos (ADR-138)", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.ids = [];
    const { data: t } = await ctx.admin.from("tenants").insert({ name: `Ed ${STAMP}`, slug: `ed-${STAMP}`, status: "active" }).select("id").single();
    ctx.tenant = (t as { id: string }).id;
    const { data: o } = await ctx.admin.from("tenants").insert({ name: `Otro ${STAMP}`, slug: `ot-${STAMP}`, status: "active" }).select("id").single();
    ctx.other = (o as { id: string }).id;
    await ctx.admin.from("subscription_addons").insert({ tenant_id: ctx.tenant, addon_key: "roles_permisos", status: "active", source: "granted" });
    ctx.owner = await makeUser(`o-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(`m-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(`c-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.stranger = await makeUser(`x-${STAMP}@test.local`, ctx.other, "owner");
  }, 120_000);

  afterAll(async () => {
    if (!ctx.admin) return;
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    for (const t of [ctx.tenant, ctx.other]) await ctx.admin.from("tenants").delete().eq("id", t);
    for (const id of ctx.ids) {
      await ctx.admin.from("users").delete().eq("id", id);
      await ctx.admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño crea un rol; se normaliza con dependencias y nivel", async () => {
    const r = await rpc(ctx.owner.client, "permission_role_save", {
      p_role_id: null, p_name: `Cajero plus`, p_description: null, p_color: "teal", p_icon: "store",
      p_base: "cashier", p_capabilities: ["sales.void.past_days", "config.edit"], p_template: "cashier",
    });
    expect(r.error).toBeNull();
    ctx.role = r.data as string;
    const { data } = await ctx.admin.from("permission_role_capabilities").select("capability").eq("role_id", ctx.role);
    const caps = (data as { capability: string }[]).map((x) => x.capability);
    expect(caps).toEqual(expect.arrayContaining(["sales.void", "sales.view", "sales.void.past_days"]));
    expect(caps).not.toContain("config.edit");
  });

  it("un encargado no crea roles ni da permisos puntuales", async () => {
    const r = await rpc(ctx.manager.client, "permission_role_save", {
      p_role_id: null, p_name: "Otro", p_description: null, p_color: "teal", p_icon: "store", p_base: "cashier", p_capabilities: [], p_template: null,
    });
    expect(r.error?.message).toMatch(/forbidden/);
    const o = await rpc(ctx.manager.client, "permission_override_set", { p_user: ctx.cashier.id, p_capability: "customers.delete", p_effect: "grant", p_reason: null });
    expect(o.error?.message).toMatch(/forbidden/);
  });

  it("asignar: el encargado da Auditor; el rol propio lo da el dueño; quedan auditados", async () => {
    const a = await rpc(ctx.manager.client, "permission_assign_role", { p_user: ctx.cashier.id, p_role_id: SYS.auditor });
    expect(a.error).toBeNull();
    const own = await rpc(ctx.owner.client, "permission_assign_role", { p_user: ctx.cashier.id, p_role_id: ctx.role });
    expect(own.error).toBeNull();
    const mine = await rpc(ctx.cashier.client, "my_capabilities");
    expect((mine.data as { capabilities: string[]; role_id: string }).capabilities).toContain("sales.void.past_days");
    const { data: logs } = await ctx.admin.from("audit_logs").select("action").eq("tenant_id", ctx.tenant).eq("action", "permission_role_assigned");
    expect((logs as unknown[]).length).toBe(2);
    const dueño = await rpc(ctx.owner.client, "permission_assign_role", { p_user: ctx.cashier.id, p_role_id: SYS.owner });
    expect(dueño.error?.message).toMatch(/cannot_assign_owner/);
  });

  it("permiso puntual del dueño y vista de qué puede hacer", async () => {
    const o = await rpc(ctx.owner.client, "permission_override_set", { p_user: ctx.manager.id, p_capability: "sales.void", p_effect: "revoke", p_reason: "Prueba" });
    expect(o.error).toBeNull();
    const ov = await rpc(ctx.owner.client, "permission_overview");
    const mgr = (ov.data as { people: { user_id: string; effective: string[] }[] }).people.find((p) => p.user_id === ctx.manager.id)!;
    expect(mgr.effective).not.toContain("sales.void");
    expect(mgr.effective).not.toContain("sales.void.past_days");
    await rpc(ctx.owner.client, "permission_override_set", { p_user: ctx.manager.id, p_capability: "sales.void", p_effect: null, p_reason: null });
  });

  it("otro negocio no ve ni toca los roles", async () => {
    const { data } = await ctx.stranger.client.from("permission_roles").select("id").eq("id", ctx.role);
    expect(data).toEqual([]);
    const a = await rpc(ctx.stranger.client, "permission_assign_role", { p_user: ctx.cashier.id, p_role_id: ctx.role });
    expect(a.error).not.toBeNull();
  });

  it("borrar reasigna a quienes lo tienen", async () => {
    const d = await rpc(ctx.owner.client, "permission_role_delete", { p_role_id: ctx.role, p_reassign_to: SYS.cashier });
    expect(d.error).toBeNull();
    expect(d.data).toBe(1);
    const { data } = await ctx.admin.from("tenant_users").select("role, role_id").eq("tenant_id", ctx.tenant).eq("user_id", ctx.cashier.id).single();
    expect(data).toEqual({ role: "cashier", role_id: null });
  });
});
