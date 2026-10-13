// @vitest-environment node
// =============================================================================
// Contracargos, reclamos y devoluciones (ADR-064, migración 20261027100000):
// RLS de payment_disputes, _payment_disputes_upsert (service_role: vínculo con
// la venta, origen de la devolución, avisos, auditoría, gating) y
// payment_dispute_ack.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A (sin plan: la feature es BASE) con dueño y cajero;
// negocio B con su dueño y la feature apagada por override del negocio.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `disp-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  saleA: string;
  saleVoided: string;
  payA: string;
  disputeB: string;
  createdFlag: string | null;
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function storeOf(admin: SupabaseClient, tenantId: string, name: string): Promise<string> {
  const { data: existing } = await admin.from("stores").select("id").eq("tenant_id", tenantId).is("deleted_at", null).limit(1).maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await admin.from("stores").insert({ tenant_id: tenantId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("store");
  return data.id as string;
}

const item = (over: Record<string, unknown>) => ({
  provider_key: "mercadopago",
  kind: "chargeback",
  dispute_key: "mp_cb:9001",
  provider_payment_id: "9001",
  provider_case_id: null,
  external_reference: null,
  amount: 1000,
  currency: "ARS",
  status: "open",
  provider_status: "charged_back",
  provider_status_detail: "in_process",
  reason: "unauthorized",
  refund_source: null,
  documentation_status: "pending",
  documentation_deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  coverage_applied: null,
  coverage_eligible: true,
  occurred_at: new Date().toISOString(),
  resolved: false,
  raw: { test: true },
  ...over,
});

describe.skipIf(!enabled)("contracargos y devoluciones · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.createdFlag = null;
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Disp A ${STAMP}`, slug: `da-${STAMP}`, status: "active" },
        { name: `Disp B ${STAMP}`, slug: `db-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, ownerB: ownerB.client });
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const storeA = await storeOf(admin, ctx.tenantA, `Local A ${STAMP}`);
    const { data: sales, error: sErr } = await admin
      .from("sales")
      .insert([
        { tenant_id: ctx.tenantA, store_id: storeA, number: 993001, subtotal: 1000, total: 1000 },
        { tenant_id: ctx.tenantA, store_id: storeA, number: 993002, subtotal: 500, total: 500, status: "voided" },
      ])
      .select("id, number");
    if (sErr || !sales) throw sErr ?? new Error("sales");
    ctx.saleA = sales.find((s) => Number(s.number) === 993001)!.id;
    ctx.saleVoided = sales.find((s) => Number(s.number) === 993002)!.id;
    const { data: pays, error: pErr } = await admin
      .from("payments")
      .insert([
        { tenant_id: ctx.tenantA, sale_id: ctx.saleA, method: "qr", amount: 1000, reference: "9001" },
        { tenant_id: ctx.tenantA, sale_id: ctx.saleVoided, method: "qr", amount: 500, reference: "9002" },
      ] as never)
      .select("id, reference");
    if (pErr || !pays) throw pErr ?? new Error("payments");
    ctx.payA = (pays as unknown as { id: string; reference: string }[]).find((p) => p.reference === "9001")!.id;

    // Negocio B: una disputa cargada a mano y la feature apagada por override.
    const { data: dB, error: dErr } = await admin
      .from("payment_disputes" as never)
      .insert({
        tenant_id: ctx.tenantB,
        provider_key: "mercadopago",
        kind: "refund",
        dispute_key: `mp_refund:b-${STAMP}`,
        provider_payment_id: "8001",
        amount: 50,
        status: "refunded",
      } as never)
      .select("id")
      .single();
    if (dErr || !dB) throw dErr ?? new Error("dispute B");
    ctx.disputeB = (dB as unknown as { id: string }).id;

    let { data: flag } = await admin.from("feature_flags").select("id").eq("key", "alertas_contracargos").maybeSingle();
    if (!flag) {
      const ins = await admin.from("feature_flags").insert({ key: "alertas_contracargos", default_enabled: true }).select("id").single();
      if (ins.error) throw ins.error;
      flag = ins.data;
      ctx.createdFlag = flag!.id as string;
    }
    const { error: tffErr } = await admin
      .from("tenant_feature_flags")
      .insert({ tenant_id: ctx.tenantB, feature_flag_id: flag!.id, enabled: false });
    if (tffErr) throw tffErr;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("payment_disputes" as never).delete().eq("tenant_id", t);
      await admin.from("notifications").delete().eq("target_tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("payments").delete().eq("tenant_id", t);
      await admin.from("sales").delete().eq("tenant_id", t);
      await admin.from("tenant_feature_flags").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    if (ctx.createdFlag) await admin.from("feature_flags").delete().eq("id", ctx.createdFlag);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el upsert es sólo del servidor; vincula con la venta, audita y avisa", async () => {
    const byUser = await rpc(ctx.owner, "_payment_disputes_upsert", { p_tenant: ctx.tenantA, p_items: [] });
    expect(byUser.error).not.toBeNull();

    const r = await rpc(ctx.admin, "_payment_disputes_upsert", {
      p_tenant: ctx.tenantA,
      p_items: [
        item({}),
        // Devolución de una venta anulada en el POS: origen pos, sin aviso.
        item({ kind: "refund", dispute_key: "mp_refund:1", provider_payment_id: "9002", status: "refunded", resolved: true, amount: 500 }),
        // Inválidos: se ignoran.
        item({ kind: "otro", dispute_key: "x" }),
        item({ dispute_key: "" }),
      ],
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ inserted: 2, updated: 0, notified: 1 });

    const { data: rows } = await ctx.admin
      .from("payment_disputes" as never)
      .select("dispute_key, payment_id, sale_id, origin, notified_at")
      .eq("tenant_id", ctx.tenantA)
      .order("dispute_key");
    const list = rows as unknown as { dispute_key: string; payment_id: string | null; sale_id: string | null; origin: string; notified_at: string | null }[];
    expect(list.find((d) => d.dispute_key === "mp_cb:9001")).toMatchObject({ payment_id: ctx.payA, sale_id: ctx.saleA, origin: "provider" });
    expect(list.find((d) => d.dispute_key === "mp_cb:9001")!.notified_at).not.toBeNull();
    expect(list.find((d) => d.dispute_key === "mp_refund:1")).toMatchObject({ sale_id: ctx.saleVoided, origin: "pos", notified_at: null });

    const { data: notes } = await ctx.admin
      .from("notifications")
      .select("type, target_role, severity, action_url")
      .eq("target_tenant_id", ctx.tenantA);
    expect((notes ?? []).map((n) => n.target_role).sort()).toEqual(["manager", "owner"]);
    expect(notes![0]).toMatchObject({ type: "disputas", severity: "critical", action_url: `/ventas?venta=${ctx.saleA}&tab=cobros` });

    const { data: logs } = await ctx.admin.from("audit_logs").select("action").eq("tenant_id", ctx.tenantA).eq("action", "payment_dispute_detected");
    expect((logs ?? []).length).toBe(2);

    // Idempotente; un cambio de estado audita y el resultado avisa.
    const again = await rpc(ctx.admin, "_payment_disputes_upsert", {
      p_tenant: ctx.tenantA,
      p_items: [item({ status: "lost", resolved: true, coverage_applied: false })],
    });
    expect(again.data).toMatchObject({ inserted: 0, updated: 1, notified: 1 });
    const { data: upd } = await ctx.admin
      .from("payment_disputes" as never)
      .select("status, resolved_at")
      .eq("tenant_id", ctx.tenantA)
      .eq("dispute_key", "mp_cb:9001")
      .single();
    expect(upd).toMatchObject({ status: "lost" });
    expect((upd as unknown as { resolved_at: string | null }).resolved_at).not.toBeNull();
  });

  it("gating: con la feature apagada, el servidor no guarda", async () => {
    const r = await rpc(ctx.admin, "_payment_disputes_upsert", { p_tenant: ctx.tenantB, p_items: [item({})] });
    expect(r.error?.message).toContain("feature_not_in_plan");
  });

  it("cada dueño ve sólo lo suyo; el cajero no ve disputas", async () => {
    const a = await ctx.owner.from("payment_disputes" as never).select("dispute_key");
    expect((a.data ?? []).length).toBe(2);
    const b = await ctx.ownerB.from("payment_disputes" as never).select("id");
    expect((b.data ?? []).map((r: { id: string }) => r.id)).toEqual([ctx.disputeB]);
    const c = await ctx.cashier.from("payment_disputes" as never).select("id");
    expect(c.data ?? []).toEqual([]);
  });

  it("nadie escribe la tabla por PostgREST", async () => {
    const ins = await ctx.owner
      .from("payment_disputes" as never)
      .insert({ tenant_id: ctx.tenantA, provider_key: "mercadopago", kind: "refund", dispute_key: "hack", provider_payment_id: "1" } as never);
    expect(ins.error).not.toBeNull();
    await ctx.owner.from("payment_disputes" as never).update({ status: "won" } as never).eq("tenant_id", ctx.tenantA);
    const { data } = await ctx.admin.from("payment_disputes" as never).select("status").eq("dispute_key", "mp_cb:9001").single();
    expect((data as unknown as { status: string }).status).toBe("lost");
  });

  it("marcar como visto: dueño sí (auditado), ajeno no, cajero no", async () => {
    const { data: row } = await ctx.admin.from("payment_disputes" as never).select("id").eq("dispute_key", "mp_cb:9001").single();
    const id = (row as unknown as { id: string }).id;
    const cashier = await rpc(ctx.cashier, "payment_dispute_ack", { p_id: id });
    expect(cashier.error?.message).toContain("forbidden");
    const foreign = await rpc(ctx.owner, "payment_dispute_ack", { p_id: ctx.disputeB });
    expect(foreign.error).toBeNull();
    const { data: b } = await ctx.admin.from("payment_disputes" as never).select("acknowledged_at").eq("id", ctx.disputeB).single();
    expect((b as unknown as { acknowledged_at: string | null }).acknowledged_at).toBeNull();
    const ok = await rpc(ctx.owner, "payment_dispute_ack", { p_id: id });
    expect(ok.error).toBeNull();
    const { data: a } = await ctx.admin.from("payment_disputes" as never).select("acknowledged_at").eq("id", id).single();
    expect((a as unknown as { acknowledged_at: string | null }).acknowledged_at).not.toBeNull();
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantA)
      .eq("action", "payment_dispute_acknowledged");
    expect((logs ?? []).length).toBe(1);
  });

  it("sin políticas que abran negocios ajenos al staff interno", async () => {
    const { data, error } = await rpc(ctx.admin, "rls_internal_scope_leaks", {});
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
