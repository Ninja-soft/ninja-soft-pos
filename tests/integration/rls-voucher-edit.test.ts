// @vitest-environment node
// =============================================================================
// Conciliación de tarjetas (ADR-044, adenda): edición de la numeración del
// cupón por RPC update_payment_voucher (migración 20261018200000).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con dueño, encargado, dos cajeros (cada uno con su
// turno) y un solo lectura; negocio B con su dueño. Ambos con
// conciliacion_tarjetas por addon.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `voucher-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: SupabaseClient;
  manager: SupabaseClient;
  cashier1: SupabaseClient;
  cashier2: SupabaseClient;
  viewer: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  /** Cobro de débito de una venta del turno del cajero 1. */
  pay1: string;
  /** Cobro de crédito de una venta del turno del cajero 2. */
  pay2: string;
  /** Cobro que no es de tarjeta (turno del cajero 1). */
  payOther: string;
  /** Cobro de tarjeta del negocio B. */
  payB: string;
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

type RpcResult = { data: unknown; error: { message: string } | null };
const edit = (c: SupabaseClient, paymentId: string, patch: Record<string, unknown>, reason: string | null = null) =>
  c.rpc("update_payment_voucher" as never, {
    p_payment_id: paymentId,
    p_patch: patch,
    p_reason: reason,
  } as never) as unknown as Promise<RpcResult>;

async function storeOf(admin: SupabaseClient, tenantId: string, name: string): Promise<string> {
  const { data: existing } = await admin
    .from("stores")
    .select("id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await admin.from("stores").insert({ tenant_id: tenantId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("store");
  return data.id as string;
}

async function voucherOf(id: string): Promise<{ card_voucher: Record<string, unknown>; reconciled_at: string | null }> {
  const { data } = await ctx.admin
    .from("payments")
    .select("card_voucher, reconciled_at" as never)
    .eq("id", id)
    .single();
  return data as unknown as { card_voucher: Record<string, unknown>; reconciled_at: string | null };
}

describe.skipIf(!enabled)("conciliación de tarjetas · edición del cupón", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `Cupones A ${STAMP}`, slug: `va-${STAMP}`, status: "active" },
        { name: `Cupones B ${STAMP}`, slug: `vb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      [ctx.tenantA, ctx.tenantB].map((t) => ({
        tenant_id: t,
        addon_key: "conciliacion_tarjetas",
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    const manager = await makeUser(admin, `manager-${STAMP}@test.local`, ctx.tenantA, "manager");
    const cashier1 = await makeUser(admin, `cajero1-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const cashier2 = await makeUser(admin, `cajero2-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const viewer = await makeUser(admin, `viewer-${STAMP}@test.local`, ctx.tenantA, "viewer");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    Object.assign(ctx, {
      owner: owner.client,
      manager: manager.client,
      cashier1: cashier1.client,
      cashier2: cashier2.client,
      viewer: viewer.client,
      ownerB: ownerB.client,
    });
    ctx.userIds.push(owner.id, manager.id, cashier1.id, cashier2.id, viewer.id, ownerB.id);

    const storeA = await storeOf(admin, ctx.tenantA, `Local A ${STAMP}`);
    const storeB = await storeOf(admin, ctx.tenantB, `Local B ${STAMP}`);

    // Una sola caja (la segunda exige multi_caja): el turno del cajero 1 ya
    // cerrado y el del cajero 2 abierto.
    const { data: reg, error: rErr } = await admin
      .from("cash_registers")
      .insert({ tenant_id: ctx.tenantA, store_id: storeA, name: `Caja ${STAMP}` })
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    const { data: s1, error: s1Err } = await admin
      .from("cash_shifts")
      .insert({
        tenant_id: ctx.tenantA,
        cash_register_id: reg.id,
        opened_by: cashier1.id,
        closed_by: cashier1.id,
        opening_amount: 0,
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (s1Err || !s1) throw s1Err ?? new Error("shift 1");
    const { data: s2, error: s2Err } = await admin
      .from("cash_shifts")
      .insert({ tenant_id: ctx.tenantA, cash_register_id: reg.id, opened_by: cashier2.id, opening_amount: 0 })
      .select("id")
      .single();
    if (s2Err || !s2) throw s2Err ?? new Error("shift 2");

    const { data: sales, error: saleErr } = await admin
      .from("sales")
      .insert([
        { tenant_id: ctx.tenantA, store_id: storeA, cash_shift_id: s1.id, number: 991001, subtotal: 300, total: 300 },
        { tenant_id: ctx.tenantA, store_id: storeA, cash_shift_id: s2.id, number: 991002, subtotal: 500, total: 500 },
      ])
      .select("id, number");
    if (saleErr || !sales) throw saleErr ?? new Error("sales");
    const sale1 = sales.find((s) => Number(s.number) === 991001)!.id;
    const sale2 = sales.find((s) => Number(s.number) === 991002)!.id;

    const { data: saleB, error: saleBErr } = await admin
      .from("sales")
      .insert({ tenant_id: ctx.tenantB, store_id: storeB, number: 991003, subtotal: 100, total: 100 })
      .select("id")
      .single();
    if (saleBErr || !saleB) throw saleBErr ?? new Error("sale B");

    const voucher = { lote: "12", cupon: "345", autorizacion: "A1", marca: "Visa", ultimos4: "1111", comercio: "111" };
    const { data: pays, error: pErr } = await admin
      .from("payments")
      .insert([
        { tenant_id: ctx.tenantA, sale_id: sale1, method: "debit", amount: 200, reference: "d1", card_voucher: voucher },
        { tenant_id: ctx.tenantA, sale_id: sale1, method: "other", amount: 100, reference: "o1", card_voucher: {} },
        { tenant_id: ctx.tenantA, sale_id: sale2, method: "credit", amount: 500, reference: "c2", card_voucher: voucher },
        { tenant_id: ctx.tenantB, sale_id: saleB.id, method: "debit", amount: 100, reference: "b1", card_voucher: voucher },
      ] as never)
      .select("id, reference");
    if (pErr || !pays) throw pErr ?? new Error("payments");
    const list = pays as unknown as { id: string; reference: string }[];
    const byRef = (r: string) => list.find((p) => p.reference === r)!.id;
    ctx.pay1 = byRef("d1");
    ctx.payOther = byRef("o1");
    ctx.pay2 = byRef("c2");
    ctx.payB = byRef("b1");
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("payment_voucher_edits" as never).delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("payments").delete().eq("tenant_id", t);
      await admin.from("sales").delete().eq("tenant_id", t);
      await admin.from("cash_shifts").delete().eq("tenant_id", t);
      await admin.from("cash_registers").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el cajero corrige un cobro de su turno: mezcla con lo demás del cupón, historial y auditoría", async () => {
    const { data, error } = await edit(ctx.cashier1, ctx.pay1, { lote: " 13 ", autorizacion: "b2c3", cuotas: null }, "lote mal");
    expect(error).toBeNull();
    expect((data as { changed: boolean }).changed).toBe(true);

    const row = await voucherOf(ctx.pay1);
    expect(row.card_voucher).toMatchObject({ lote: "13", autorizacion: "B2C3", marca: "Visa", cupon: "345", comercio: "111" });

    const { data: edits } = await ctx.cashier1
      .from("payment_voucher_edits" as never)
      .select("changed_keys, before_data, after_data, was_reconciled, as_supervisor, reason" as never)
      .eq("payment_id" as never, ctx.pay1 as never);
    const list = (edits ?? []) as unknown as Array<{
      changed_keys: string[];
      before_data: Record<string, unknown>;
      after_data: Record<string, unknown>;
      was_reconciled: boolean;
      as_supervisor: boolean;
      reason: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.changed_keys.sort()).toEqual(["autorizacion", "lote"]);
    expect(list[0]!.before_data).toEqual({ lote: "12", autorizacion: "A1" });
    expect(list[0]!.as_supervisor).toBe(false);
    expect(list[0]!.reason).toBe("lote mal");

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, entity_id, before_data, after_data")
      .eq("tenant_id", ctx.tenantA)
      .eq("action", "payment_voucher_updated");
    expect(logs?.length).toBe(1);
    expect(logs?.[0]?.entity_id).toBe(ctx.pay1);
  });

  it("sin cambios no escribe historial", async () => {
    const { data, error } = await edit(ctx.cashier1, ctx.pay1, { lote: "13" });
    expect(error).toBeNull();
    expect((data as { changed: boolean }).changed).toBe(false);
  });

  it("el cajero no puede editar cobros del turno de otro cajero", async () => {
    const { error } = await edit(ctx.cashier1, ctx.pay2, { lote: "99" });
    expect(error?.message).toMatch(/not_own_shift/);
    expect((await voucherOf(ctx.pay2)).card_voucher.lote).toBe("12");
  });

  it("lista blanca y validación de valores", async () => {
    const bad = await edit(ctx.cashier1, ctx.pay1, { marca: "Amex" });
    expect(bad.error?.message).toMatch(/invalid_key/);
    const bad4 = await edit(ctx.cashier1, ctx.pay1, { ultimos4: "12" });
    expect(bad4.error?.message).toMatch(/invalid_value/);
    const badLote = await edit(ctx.cashier1, ctx.pay1, { lote: "12A" });
    expect(badLote.error?.message).toMatch(/invalid_value/);
    const badCuotas = await edit(ctx.cashier1, ctx.pay1, { cuotas: 0 });
    expect(badCuotas.error?.message).toMatch(/invalid_value/);
    expect((await voucherOf(ctx.pay1)).card_voucher.marca).toBe("Visa");
  });

  it("sólo cobros de tarjeta", async () => {
    const { error } = await edit(ctx.owner, ctx.payOther, { lote: "1" });
    expect(error?.message).toMatch(/payment_not_found/);
  });

  it("el encargado edita cualquier cobro del negocio", async () => {
    const { error } = await edit(ctx.manager, ctx.pay2, { cuotas: 6, comercio: "222" });
    expect(error).toBeNull();
    expect((await voucherOf(ctx.pay2)).card_voucher).toMatchObject({ cuotas: 6, comercio: "222", marca: "Visa" });
  });

  it("solo lectura no edita", async () => {
    const { error } = await edit(ctx.viewer, ctx.pay1, { lote: "14" });
    expect(error?.message).toMatch(/forbidden/);
  });

  it("conciliado: el cajero queda bloqueado; el dueño edita, sigue conciliado y queda marcado", async () => {
    const rec = await ctx.owner.rpc("set_payments_reconciled" as never, {
      p_payment_ids: [ctx.pay1],
      p_reconciled: true,
    } as never);
    expect(rec.error).toBeNull();

    const locked = await edit(ctx.cashier1, ctx.pay1, { cupon: "346" });
    expect(locked.error?.message).toMatch(/reconciled_locked/);

    const { data, error } = await edit(ctx.owner, ctx.pay1, { cupon: "346" });
    expect(error).toBeNull();
    expect((data as { was_reconciled: boolean }).was_reconciled).toBe(true);
    const row = await voucherOf(ctx.pay1);
    expect(row.card_voucher.cupon).toBe("346");
    expect(row.reconciled_at).not.toBeNull();

    const { data: edits } = await ctx.owner
      .from("payment_voucher_edits" as never)
      .select("was_reconciled, as_supervisor" as never)
      .eq("payment_id" as never, ctx.pay1 as never)
      .eq("was_reconciled" as never, true as never);
    expect(edits).toEqual([{ was_reconciled: true, as_supervisor: true }]);
  });

  it("otro negocio: no edita ni ve el historial de A", async () => {
    const { error } = await edit(ctx.ownerB, ctx.pay1, { lote: "77" });
    expect(error?.message).toMatch(/payment_not_found/);
    const { data } = await ctx.ownerB
      .from("payment_voucher_edits" as never)
      .select("id" as never)
      .eq("tenant_id" as never, ctx.tenantA as never);
    expect(data ?? []).toEqual([]);
    // Y A tampoco edita cobros de B.
    const cross = await edit(ctx.owner, ctx.payB, { lote: "77" });
    expect(cross.error?.message).toMatch(/payment_not_found/);
  });

  it("el historial no se escribe por fuera de la RPC", async () => {
    const { error } = await ctx.owner.from("payment_voucher_edits" as never).insert({
      tenant_id: ctx.tenantA,
      payment_id: ctx.pay1,
      changed_keys: ["lote"],
    } as never);
    expect(error).not.toBeNull();
  });
});
