// @vitest-environment node
// =============================================================================
// Conciliación de procesadores (ADR-061, migraciones 20261024100000 y
// 20261024100100): RLS de settlement_* y payment_provider_snapshots, y RPC
// settlement_import_lines / settlement_line_resolve / settlement_set_auto_sync
// / _settlement_apply_matches.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A (con conciliacion_procesadores por addon) con dueño y
// cajero; negocio B (sin la feature) con su dueño.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `settle-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  payA: string;
  payA2: string;
  payB: string;
  lineA: string;
  lineB: string;
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

const lineRow = (tenant: string, key: string, gross: number) => ({
  tenant_id: tenant,
  provider_key: "mercadopago",
  line_key: key,
  external_id: key,
  operation_at: new Date().toISOString(),
  gross,
  fee: 10,
  taxes: 2,
  net: gross - 12,
});

describe.skipIf(!enabled)("conciliación de procesadores · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Conc A ${STAMP}`, slug: `sa-${STAMP}`, status: "active" },
        { name: `Conc B ${STAMP}`, slug: `sb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;
    const { error: addErr } = await admin.from("subscription_addons").insert({
      tenant_id: ctx.tenantA,
      addon_key: "conciliacion_procesadores",
      status: "active",
      source: "granted",
    });
    if (addErr) throw addErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, ownerB: ownerB.client });
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const storeA = await storeOf(admin, ctx.tenantA, `Local A ${STAMP}`);
    const storeB = await storeOf(admin, ctx.tenantB, `Local B ${STAMP}`);
    const { data: sales, error: sErr } = await admin
      .from("sales")
      .insert([
        { tenant_id: ctx.tenantA, store_id: storeA, number: 992001, subtotal: 1000, total: 1000 },
        { tenant_id: ctx.tenantA, store_id: storeA, number: 992002, subtotal: 700, total: 700 },
        { tenant_id: ctx.tenantB, store_id: storeB, number: 992003, subtotal: 500, total: 500 },
      ])
      .select("id, number");
    if (sErr || !sales) throw sErr ?? new Error("sales");
    const saleOf = (n: number) => sales.find((s) => Number(s.number) === n)!.id;
    const { data: pays, error: pErr } = await admin
      .from("payments")
      .insert([
        { tenant_id: ctx.tenantA, sale_id: saleOf(992001), method: "qr", amount: 1000, reference: "111" },
        { tenant_id: ctx.tenantA, sale_id: saleOf(992002), method: "qr", amount: 700, reference: "222" },
        { tenant_id: ctx.tenantB, sale_id: saleOf(992003), method: "qr", amount: 500, reference: "333" },
      ] as never)
      .select("id, reference");
    if (pErr || !pays) throw pErr ?? new Error("payments");
    const list = pays as unknown as { id: string; reference: string }[];
    ctx.payA = list.find((p) => p.reference === "111")!.id;
    ctx.payA2 = list.find((p) => p.reference === "222")!.id;
    ctx.payB = list.find((p) => p.reference === "333")!.id;

    const { data: lines, error: lErr } = await admin
      .from("settlement_lines" as never)
      .insert([lineRow(ctx.tenantA, `mp:a-${STAMP}`, 1000), lineRow(ctx.tenantB, `mp:b-${STAMP}`, 500)] as never)
      .select("id, tenant_id");
    if (lErr || !lines) throw lErr ?? new Error("lines");
    const ls = lines as unknown as { id: string; tenant_id: string }[];
    ctx.lineA = ls.find((l) => l.tenant_id === ctx.tenantA)!.id;
    ctx.lineB = ls.find((l) => l.tenant_id === ctx.tenantB)!.id;
    await admin.from("payment_provider_snapshots" as never).insert({
      tenant_id: ctx.tenantA,
      payment_id: ctx.payA,
      provider_key: "mercadopago",
      external_id: `snap-${STAMP}`,
      normalized: { fee_total: 10 },
    } as never);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("payment_provider_snapshots" as never).delete().eq("tenant_id", t);
      await admin.from("settlement_lines" as never).delete().eq("tenant_id", t);
      await admin.from("settlement_imports" as never).delete().eq("tenant_id", t);
      await admin.from("settlement_sync_state" as never).delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("payments").delete().eq("tenant_id", t);
      await admin.from("sales").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("cada dueño ve sólo sus líneas; el cajero no ve liquidaciones ni fotos", async () => {
    const a = await ctx.owner.from("settlement_lines" as never).select("id");
    expect((a.data ?? []).map((r: { id: string }) => r.id)).toEqual([ctx.lineA]);
    const b = await ctx.ownerB.from("settlement_lines" as never).select("id");
    expect((b.data ?? []).map((r: { id: string }) => r.id)).toEqual([ctx.lineB]);
    const c = await ctx.cashier.from("settlement_lines" as never).select("id");
    expect(c.data ?? []).toEqual([]);
    const snapOwner = await ctx.owner.from("payment_provider_snapshots" as never).select("id");
    expect((snapOwner.data ?? []).length).toBe(1);
    const snapCashier = await ctx.cashier.from("payment_provider_snapshots" as never).select("id");
    expect(snapCashier.data ?? []).toEqual([]);
    const snapB = await ctx.ownerB.from("payment_provider_snapshots" as never).select("id");
    expect(snapB.data ?? []).toEqual([]);
  });

  it("nadie escribe las tablas por PostgREST", async () => {
    const ins = await ctx.owner.from("settlement_lines" as never).insert(lineRow(ctx.tenantA, `x-${STAMP}`, 1) as never);
    expect(ins.error).not.toBeNull();
    await ctx.owner.from("settlement_lines" as never).update({ match_status: "ignored" } as never).eq("id", ctx.lineA);
    const { data } = await ctx.admin.from("settlement_lines" as never).select("match_status").eq("id", ctx.lineA).single();
    expect((data as unknown as { match_status: string }).match_status).toBe("missing_in_pos");
    const snap = await ctx.owner
      .from("payment_provider_snapshots" as never)
      .insert({ tenant_id: ctx.tenantA, provider_key: "x", external_id: "y", normalized: {} } as never);
    expect(snap.error).not.toBeNull();
  });

  it("importar: dueño con plan sí; cajero y negocio sin plan no; reimportar no duplica", async () => {
    const lines = [{ operation_at: "2026-10-10T15:00:00Z", gross: 1500, fee: 30, lote: "15", cupon: "42" }];
    const ok = await rpc(ctx.owner, "settlement_import_lines", { p_provider: "payway", p_file_name: "liq.xlsx", p_lines: lines });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ inserted: 1, updated: 0, skipped: 0 });
    const again = await rpc(ctx.owner, "settlement_import_lines", { p_provider: "payway", p_file_name: "liq.xlsx", p_lines: lines });
    expect(again.data).toMatchObject({ inserted: 0, updated: 1 });
    const cashier = await rpc(ctx.cashier, "settlement_import_lines", { p_provider: "payway", p_file_name: "x", p_lines: lines });
    expect(cashier.error?.message).toContain("forbidden");
    const noPlan = await rpc(ctx.ownerB, "settlement_import_lines", { p_provider: "payway", p_file_name: "x", p_lines: lines });
    expect(noPlan.error?.message).toContain("feature_not_in_plan");
    const bad = await rpc(ctx.owner, "settlement_import_lines", { p_provider: "payway", p_file_name: "x", p_lines: [{ operation_at: "nope", gross: 1 }] });
    expect(bad.data).toMatchObject({ inserted: 0, skipped: 1 });
  });

  it("vincular marca conciliado con auditoría; desvincular lo desmarca; no se vincula un cobro ajeno", async () => {
    const foreign = await rpc(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.lineA, p_action: "link", p_payment_id: ctx.payB });
    expect(foreign.error?.message).toContain("payment_not_found");
    const other = await rpc(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.lineB, p_action: "ignore" });
    expect(other.error?.message).toContain("line_not_found");

    const link = await rpc(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.lineA, p_action: "link", p_payment_id: ctx.payA });
    expect(link.error).toBeNull();
    expect(link.data).toMatchObject({ match_status: "matched", match_method: "manual", reconciled_payment: true });
    const { data: p1 } = await ctx.admin.from("payments").select("reconciled_at" as never).eq("id", ctx.payA).single();
    expect((p1 as unknown as { reconciled_at: string | null }).reconciled_at).not.toBeNull();
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantA)
      .in("action", ["payments_reconciled", "settlement_line_link"]);
    expect((logs ?? []).map((l) => l.action).sort()).toEqual(["payments_reconciled", "settlement_line_link"]);

    // Monto distinto: queda como diferencia y no concilia.
    const diff = await rpc(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.lineA, p_action: "link", p_payment_id: ctx.payA2 });
    expect(diff.data).toMatchObject({ match_status: "amount_diff", diff_amount: 300 });
    const { data: back } = await ctx.admin.from("payments").select("reconciled_at" as never).eq("id", ctx.payA).single();
    expect((back as unknown as { reconciled_at: string | null }).reconciled_at).toBeNull();

    const unlink = await rpc(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.lineA, p_action: "unlink" });
    expect(unlink.data).toMatchObject({ match_status: "missing_in_pos", payment_id: null });
    const cashier = await rpc(ctx.cashier, "settlement_line_resolve", { p_line_id: ctx.lineA, p_action: "ignore" });
    expect(cashier.error?.message).toContain("forbidden");
  });

  it("_settlement_apply_matches es sólo del servidor y valida el negocio", async () => {
    const byUser = await rpc(ctx.owner, "_settlement_apply_matches", { p_tenant: ctx.tenantA, p_matches: [] });
    expect(byUser.error).not.toBeNull();
    const svc = await rpc(ctx.admin, "_settlement_apply_matches", {
      p_tenant: ctx.tenantA,
      p_matches: [
        { line_id: ctx.lineA, match_status: "matched", match_method: "provider_id", payment_id: ctx.payA, diff_amount: 0 },
        // Línea y cobro de otro negocio: se ignoran.
        { line_id: ctx.lineB, match_status: "matched", match_method: "provider_id", payment_id: ctx.payB, diff_amount: 0 },
      ],
    });
    expect(svc.error).toBeNull();
    expect(svc.data).toMatchObject({ updated: 1, reconciled: 1 });
    const { data: lb } = await ctx.admin.from("settlement_lines" as never).select("payment_id").eq("id", ctx.lineB).single();
    expect((lb as unknown as { payment_id: string | null }).payment_id).toBeNull();
    const noPlan = await rpc(ctx.admin, "_settlement_apply_matches", { p_tenant: ctx.tenantB, p_matches: [] });
    expect(noPlan.error?.message).toContain("feature_not_in_plan");
  });

  it("switch de sincronización automática", async () => {
    const r = await rpc(ctx.owner, "settlement_set_auto_sync", { p_provider: "mercadopago", p_auto: false });
    expect(r.error).toBeNull();
    const { data } = await ctx.owner.from("settlement_sync_state" as never).select("auto_sync, provider_key");
    expect(data).toEqual([{ auto_sync: false, provider_key: "mercadopago" }]);
    const cashier = await ctx.cashier.from("settlement_sync_state" as never).select("auto_sync");
    expect(cashier.data ?? []).toEqual([]);
  });

  it("sin políticas que abran negocios ajenos al staff interno", async () => {
    const { data, error } = await rpc(ctx.admin, "rls_internal_scope_leaks", {});
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
