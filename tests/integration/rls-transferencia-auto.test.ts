// @vitest-environment node
// =============================================================================
// Transferencias automáticas de Mercado Pago (ADR-061, migración
// 20261024100200): trigger de transfer_accounts (sólo cuentas de Mercado Pago
// y plan con transferencia_auto_mp) y RLS de transfer_watches.
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

const STAMP = `tauto-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  mpAccountA: string;
  mpAccountB: string;
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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const account = (tenant: string, slug: string, alias: string, extra: Record<string, unknown> = {}) => ({
  tenant_id: tenant,
  bank_slug: slug,
  bank_name: slug,
  holder_name: "Titular Test",
  alias,
  ...extra,
});

describe.skipIf(!enabled)("transferencias automáticas · trigger y RLS", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Auto A ${STAMP}`, slug: `ta-${STAMP}`, status: "active" },
        { name: `Auto B ${STAMP}`, slug: `tb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;
    const addons = [
      ...["transferencia", "transferencia_multicuenta", "transferencia_auto_mp"].map((k) => ({ tenant_id: ctx.tenantA, addon_key: k })),
      ...["transferencia", "transferencia_multicuenta"].map((k) => ({ tenant_id: ctx.tenantB, addon_key: k })),
    ].map((a) => ({ ...a, status: "active", source: "granted" }));
    const { error: addErr } = await admin.from("subscription_addons").insert(addons);
    if (addErr) throw addErr;
    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    Object.assign(ctx, { owner: owner.client, ownerB: ownerB.client });
    ctx.userIds.push(owner.id, ownerB.id);

    const { data: accs, error: aErr } = await admin
      .from("transfer_accounts" as never)
      .insert([account(ctx.tenantA, "mercado-pago", `mpa.${STAMP}`), account(ctx.tenantB, "mercado-pago", `mpb.${STAMP}`)] as never)
      .select("id, tenant_id");
    if (aErr || !accs) throw aErr ?? new Error("accounts");
    const list = accs as unknown as { id: string; tenant_id: string }[];
    ctx.mpAccountA = list.find((a) => a.tenant_id === ctx.tenantA)!.id;
    ctx.mpAccountB = list.find((a) => a.tenant_id === ctx.tenantB)!.id;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("transfer_watches" as never).delete().eq("tenant_id", t);
      await admin.from("transfer_accounts" as never).delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño con plan prende la detección en su cuenta de Mercado Pago", async () => {
    const { error } = await ctx.owner
      .from("transfer_accounts" as never)
      .update({ auto_detect: true, auto_tolerance: 50, auto_mode: "auto_close", auto_window_min: 20 } as never)
      .eq("id", ctx.mpAccountA);
    expect(error).toBeNull();
    const { data } = await ctx.admin.from("transfer_accounts" as never).select("auto_detect, auto_mode").eq("id", ctx.mpAccountA).single();
    expect(data).toEqual({ auto_detect: true, auto_mode: "auto_close" });
  });

  it("sin plan o en una cuenta que no es de Mercado Pago, no", async () => {
    const noPlan = await ctx.ownerB
      .from("transfer_accounts" as never)
      .update({ auto_detect: true } as never)
      .eq("id", ctx.mpAccountB);
    expect(noPlan.error?.message).toContain("feature_not_in_plan");
    const other = await ctx.owner
      .from("transfer_accounts" as never)
      .insert(account(ctx.tenantA, "galicia", `gal.${STAMP}`, { auto_detect: true }) as never);
    expect(other.error?.message).toContain("auto_detect_requires_mp_cvu");
    const badMode = await ctx.owner
      .from("transfer_accounts" as never)
      .update({ auto_mode: "otro" } as never)
      .eq("id", ctx.mpAccountA);
    expect(badMode.error).not.toBeNull();
  });

  it("cada negocio ve sólo sus esperas y nadie las escribe por PostgREST", async () => {
    const exp = new Date(Date.now() + 30 * 60_000).toISOString();
    const { error } = await ctx.admin.from("transfer_watches" as never).insert([
      { tenant_id: ctx.tenantA, account_id: ctx.mpAccountA, amount: 1000, expires_at: exp, mp_payment_id: `mp-${STAMP}` },
      { tenant_id: ctx.tenantB, account_id: ctx.mpAccountB, amount: 500, expires_at: exp },
    ] as never);
    expect(error).toBeNull();
    const a = await ctx.owner.from("transfer_watches" as never).select("amount");
    expect((a.data ?? []).map((r: { amount: number }) => Number(r.amount))).toEqual([1000]);
    const b = await ctx.ownerB.from("transfer_watches" as never).select("amount");
    expect((b.data ?? []).map((r: { amount: number }) => Number(r.amount))).toEqual([500]);
    const ins = await ctx.owner
      .from("transfer_watches" as never)
      .insert({ tenant_id: ctx.tenantA, account_id: ctx.mpAccountA, amount: 1, expires_at: exp } as never);
    expect(ins.error).not.toBeNull();
    await ctx.owner.from("transfer_watches" as never).update({ status: "closed" } as never).eq("tenant_id", ctx.tenantA);
    const { data } = await ctx.admin.from("transfer_watches" as never).select("status").eq("tenant_id", ctx.tenantA).single();
    expect((data as unknown as { status: string }).status).toBe("waiting");
  });

  it("un movimiento de Mercado Pago no se usa dos veces", async () => {
    const exp = new Date(Date.now() + 30 * 60_000).toISOString();
    const dup = await ctx.admin
      .from("transfer_watches" as never)
      .insert({ tenant_id: ctx.tenantA, account_id: ctx.mpAccountA, amount: 1000, expires_at: exp, mp_payment_id: `mp-${STAMP}` } as never);
    expect(dup.error).not.toBeNull();
  });

  it("sin políticas que abran negocios ajenos al staff interno", async () => {
    const { data, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
