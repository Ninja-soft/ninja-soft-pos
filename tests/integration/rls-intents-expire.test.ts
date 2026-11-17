// @vitest-environment node
// =============================================================================
// PAY-01 · payment_intents_expire_sweep(): vence los intents 'pending' viejos
// sin cobro en espera vivo. Migración 20270119100200_intents_expire_sweep.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
// El barrido es GLOBAL (vence intents de todos los negocios): sólo contra local.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(URL_ ?? "");
const enabled = Boolean(URL_ && ANON && SERVICE && isLocal);

const STAMP = `pie-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

describe.skipIf(!enabled)("PAY-01 · vencimiento de intents pendientes", () => {
  const ctx = {} as {
    admin: SupabaseClient;
    tenant: string;
    store: string;
    userId: string;
    owner: SupabaseClient;
    ids: Record<string, string>;
  };

  async function intent(key: string, status: string, ageHours: number, provider = "mercadopago") {
    const { data, error } = await ctx.admin
      .from("mp_payment_intents")
      .insert({ tenant_id: ctx.tenant, amount: 100, provider_key: provider, status, created_at: hoursAgo(ageHours) })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("intent");
    ctx.ids[key] = (data as { id: string }).id;
  }

  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.ids = {};
    const { data: t, error: tErr } = await ctx.admin
      .from("tenants")
      .insert({ name: `Intents ${STAMP}`, slug: STAMP, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = (t as { id: string }).id;
    const { data: st, error: sErr } = await ctx.admin
      .from("stores")
      .insert({ tenant_id: ctx.tenant, name: `Local ${STAMP}`, is_default: true })
      .select("id")
      .single();
    if (sErr || !st) throw sErr ?? new Error("store");
    ctx.store = (st as { id: string }).id;

    const email = `owner-${STAMP}@test.local`;
    const { data: u, error: uErr } = await ctx.admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { current_tenant_id: ctx.tenant },
    });
    if (uErr) throw uErr;
    ctx.userId = u.user!.id;
    await ctx.admin.from("users").upsert({ id: ctx.userId, email, full_name: "owner" });
    await ctx.admin.from("tenant_users").insert({ tenant_id: ctx.tenant, user_id: ctx.userId, role: "owner", status: "active" });
    ctx.owner = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    const { error: siErr } = await ctx.owner.auth.signInWithPassword({ email, password: PASSWORD });
    if (siErr) throw siErr;

    await intent("old", "pending", 100);
    await intent("fresh", "pending", 2);
    await intent("approved", "approved", 100);
    await intent("withCharge", "pending", 100);
    await intent("cupon3d", "pending", 80, "mp_cupon");
    await intent("cupon5d", "pending", 120, "mp_cupon");
    // Proveedores cuyo webhook sólo acredita sobre 'pending': no se vencen.
    await intent("talo", "pending", 200, "talo");
    await intent("getnet", "pending", 200, "getnet");

    const { error: pcErr } = await ctx.admin.from("pending_charges").insert({
      tenant_id: ctx.tenant,
      store_id: ctx.store,
      sale_args: {},
      amount: 100,
      provider_key: "mercadopago",
      intent_id: ctx.ids.withCharge,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (pcErr) throw pcErr;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("pending_charges").delete().eq("tenant_id", ctx.tenant);
    await admin.from("mp_payment_intents").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenant_users").delete().eq("tenant_id", ctx.tenant);
    await admin.from("stores").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    if (ctx.userId) {
      await admin.from("users").delete().eq("id", ctx.userId);
      await admin.auth.admin.deleteUser(ctx.userId);
    }
  });

  it("anon y authenticated no ejecutan el barrido", async () => {
    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    for (const c of [anon, ctx.owner]) {
      const { error } = await rpc(c, "payment_intents_expire_sweep");
      expect(error?.message).toMatch(/permission denied/);
    }
  });

  it("vence el viejo sin cobro en espera y respeta el resto", async () => {
    const { data, error } = await rpc(ctx.admin, "payment_intents_expire_sweep");
    expect(error).toBeNull();
    expect((data as { total: number }).total).toBeGreaterThanOrEqual(2);

    const { data: rows } = await ctx.admin
      .from("mp_payment_intents")
      .select("id, status")
      .eq("tenant_id", ctx.tenant);
    const byId = new Map((rows ?? []).map((r) => [(r as { id: string }).id, (r as { status: string }).status]));
    expect(byId.get(ctx.ids.old!)).toBe("expired");
    expect(byId.get(ctx.ids.fresh!)).toBe("pending");
    expect(byId.get(ctx.ids.approved!)).toBe("approved");
    expect(byId.get(ctx.ids.withCharge!)).toBe("pending");
    // Cupón de efectivo: ventana de 4 días.
    expect(byId.get(ctx.ids.cupon3d!)).toBe("pending");
    expect(byId.get(ctx.ids.cupon5d!)).toBe("expired");
    expect(byId.get(ctx.ids.talo!)).toBe("pending");
    expect(byId.get(ctx.ids.getnet!)).toBe("pending");

    const { data: pc } = await ctx.admin.from("pending_charges").select("status").eq("intent_id", ctx.ids.withCharge!).single();
    expect((pc as { status: string }).status).toBe("waiting");
  });

  it("deja un resumen por proveedor en audit_logs", async () => {
    const { data } = await ctx.admin
      .from("audit_logs")
      .select("after_data")
      .eq("action", "payment_intents_expired")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    const after = (data as { after_data: { by_provider: Record<string, number> } }).after_data;
    expect(after.by_provider.mercadopago).toBeGreaterThanOrEqual(1);
    expect(after.by_provider.mp_cupon).toBeGreaterThanOrEqual(1);
  });

  it("un vencido se puede pasar a approved (mismo filtro neq approved que usan mp_webhook y la Orders API)", async () => {
    const { error } = await ctx.admin
      .from("mp_payment_intents")
      .update({ status: "approved" })
      .eq("id", ctx.ids.old!)
      .neq("status", "approved");
    expect(error).toBeNull();
    const { data } = await ctx.admin.from("mp_payment_intents").select("status").eq("id", ctx.ids.old!).single();
    expect((data as { status: string }).status).toBe("approved");
  });
});
