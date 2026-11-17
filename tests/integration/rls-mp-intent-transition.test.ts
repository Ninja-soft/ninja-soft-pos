// @vitest-environment node
// =============================================================================
// PAY-28 · _mp_intent_transition: transición de mp_payment_intents + audit_logs
// en una transacción (ADR-191). Migración 20270127100000_pay28_mp_intent_transition.
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
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(URL_ ?? "");
const enabled = Boolean(URL_ && ANON && SERVICE && isLocal);

const STAMP = `pay28-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const FN = "_mp_intent_transition";

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

describe.skipIf(!enabled)("PAY-28 · transición atómica de intents de Mercado Pago", () => {
  const ctx = {} as {
    admin: SupabaseClient;
    tenant: string;
    userId: string;
    owner: SupabaseClient;
    ids: Record<string, string>;
  };

  async function intent(key: string, status: string) {
    const { data, error } = await ctx.admin
      .from("mp_payment_intents")
      .insert({ tenant_id: ctx.tenant, amount: 1500, provider_key: "mercadopago_qr", status })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("intent");
    ctx.ids[key] = (data as { id: string }).id;
  }

  const approveArgs = (id: string) => ({
    p_intent: id,
    p_status: "approved",
    p_mp_payment_id: "PAY-28-1",
    p_only_pending: false,
    p_audit_action: "mp_order_approved",
    p_actor: null,
    p_audit_after: { source: "webhook", amount: 1500, previous_status: "pending" },
  });

  async function audits(id: string) {
    const { data, error } = await ctx.admin
      .from("audit_logs")
      .select("tenant_id, action, entity_type, after_data")
      .eq("entity_id", id);
    if (error) throw error;
    return (data ?? []) as { tenant_id: string; action: string; entity_type: string; after_data: Record<string, unknown> }[];
  }

  async function statusOf(id: string) {
    const { data } = await ctx.admin.from("mp_payment_intents").select("status, mp_payment_id").eq("id", id).single();
    return data as { status: string; mp_payment_id: string | null };
  }

  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.ids = {};
    const { data: t, error: tErr } = await ctx.admin
      .from("tenants")
      .insert({ name: `PAY-28 ${STAMP}`, slug: STAMP, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = (t as { id: string }).id;

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

    await intent("pending", "pending");
    await intent("approved", "approved");
    await intent("mismatch", "pending");
    await intent("bad", "pending");
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("mp_payment_intents").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenant_users").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    if (ctx.userId) {
      await admin.from("users").delete().eq("id", ctx.userId);
      await admin.auth.admin.deleteUser(ctx.userId);
    }
  });

  it("anon y authenticated no tienen EXECUTE (sólo service_role)", async () => {
    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    for (const c of [anon, ctx.owner]) {
      const { error } = await rpc(c, FN, approveArgs(ctx.ids.pending!));
      expect(error?.message).toMatch(/permission denied/);
    }
    expect((await statusOf(ctx.ids.pending!)).status).toBe("pending");
    expect(await audits(ctx.ids.pending!)).toEqual([]);
  });

  it("acredita UNA sola vez y deja UN audit con el payload de la Edge", async () => {
    const first = await rpc(ctx.admin, FN, approveArgs(ctx.ids.pending!));
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);
    const again = await rpc(ctx.admin, FN, approveArgs(ctx.ids.pending!));
    expect(again.error).toBeNull();
    expect(again.data).toBe(false);

    expect(await statusOf(ctx.ids.pending!)).toEqual({ status: "approved", mp_payment_id: "PAY-28-1" });
    const rows = await audits(ctx.ids.pending!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: ctx.tenant,
      action: "mp_order_approved",
      entity_type: "mp_payment_intents",
      after_data: { source: "webhook", amount: 1500, previous_status: "pending" },
    });
  });

  it("un intent ya approved no se toca ni se audita (ni acreditando ni rechazando)", async () => {
    const id = ctx.ids.approved!;
    const a = await rpc(ctx.admin, FN, approveArgs(id));
    const r = await rpc(ctx.admin, FN, {
      p_intent: id,
      p_status: "rejected",
      p_mp_payment_id: null,
      p_only_pending: true,
      p_audit_action: null,
    });
    expect([a.data, r.data]).toEqual([false, false]);
    expect((await statusOf(id)).status).toBe("approved");
    expect(await audits(id)).toEqual([]);
  });

  it("rechazo por monto: sólo desde pending, con audit mp_order_amount_mismatch", async () => {
    const id = ctx.ids.mismatch!;
    const args = {
      p_intent: id,
      p_status: "rejected",
      p_mp_payment_id: null,
      p_only_pending: true,
      p_audit_action: "mp_order_amount_mismatch",
      p_actor: null,
      p_audit_after: { expected: 1500, order_total: "1499.99" },
    };
    expect((await rpc(ctx.admin, FN, args)).data).toBe(true);
    expect((await rpc(ctx.admin, FN, args)).data).toBe(false);
    expect((await statusOf(id)).status).toBe("rejected");
    expect((await audits(id)).map((a) => a.action)).toEqual(["mp_order_amount_mismatch"]);
  });

  it("estado o acción fuera de la lista: error y nada escrito", async () => {
    const id = ctx.ids.bad!;
    const badStatus = await rpc(ctx.admin, FN, { ...approveArgs(id), p_status: "pending" });
    const badAction = await rpc(ctx.admin, FN, { ...approveArgs(id), p_audit_action: "sale_voided" });
    expect(badStatus.error?.message).toMatch(/mp_intent_transition_invalid_status/);
    expect(badAction.error?.message).toMatch(/mp_intent_transition_invalid_action/);
    expect((await statusOf(id)).status).toBe("pending");
    expect(await audits(id)).toEqual([]);
  });
});
