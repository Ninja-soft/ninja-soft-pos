// @vitest-environment node
// =============================================================================
// Tesorería ordenada (ADR-158, migraciones 20261227100000 a 20261227100200):
// cajas del POS como cuentas de sistema, vínculo con las cuentas de cobro por
// transferencia, cobro por transferencia que suma en Tesorería y en el Mayor
// de la misma cuenta al centavo (y la anulación resta en los dos), saldo
// inicial con asiento, gasto con cuenta de gasto e IVA, cheque de terceros que
// no deja "Valores a depositar" negativo, todos los asientos balanceados,
// cierre de caja con contado 0 y revisión del Z. RLS y gating.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con tesorería, compras y contabilidad (add-ons
// otorgados), dueño y cajero, una sucursal y una caja; negocio B sin las
// features con su dueño.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `tes-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  register: string;
  bank: string;
  ledgerCode: string;
  transferAccount: string;
  sale: string;
  lastMonth: string;
  today: string;
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

function firstOfPrevMonth(): string {
  const d = new Date();
  const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return p.toISOString().slice(0, 10);
}

/** Día de hoy en Argentina (UTC-3). */
function arToday(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

type Line = { debit: number; credit: number; account_code: string; entry_id: string };

async function journal(): Promise<Line[]> {
  const { data, error } = await ctx.owner
    .from("acc_journal_lines")
    .select("debit, credit, account_code, entry_id")
    .eq("tenant_id", ctx.tenantA);
  if (error) throw error;
  return ((data ?? []) as Line[]).map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) }));
}

async function ledgerBalance(code: string): Promise<number> {
  const rows = (await journal()).filter((l) => l.account_code === code);
  return Math.round(rows.reduce((t, l) => t + l.debit - l.credit, 0) * 100) / 100;
}

async function codeOf(systemKey: string): Promise<string> {
  const { data } = await ctx.owner.from("acc_accounts").select("code").eq("tenant_id", ctx.tenantA).eq("system_key", systemKey).single();
  return (data as { code: string }).code;
}

async function bankBalance(): Promise<number> {
  const r = await rpc(ctx.owner, "treasury_position", {});
  if (r.error) throw new Error(r.error.message);
  const row = (r.data as Array<{ account_id: string; balance: number }>).find((a) => a.account_id === ctx.bank);
  return Number(row?.balance ?? NaN);
}

async function regenerate() {
  const r = await rpc(ctx.owner, "acc_generate", { p_from: ctx.lastMonth, p_to: ctx.today, p_regenerate: true });
  expect(r.error).toBeNull();
}

describe.skipIf(!enabled)("tesorería unificada · cuentas, asientos por cuenta y controles de caja", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.lastMonth = firstOfPrevMonth();
    ctx.today = arToday();
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Tes A ${STAMP}`, slug: `ta-${STAMP}`, status: "active" },
        { name: `Tes B ${STAMP}`, slug: `tb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["tesoreria", "compras", "contabilidad"].map((k) => ({ tenant_id: ctx.tenantA, addon_key: k, status: "active", source: "granted" })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, ownerB: ownerB.client });
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const { data: existing } = await admin.from("stores").select("id").eq("tenant_id", ctx.tenantA).is("deleted_at", null).limit(1).maybeSingle();
    if (existing?.id) ctx.store = existing.id as string;
    else {
      const { data: st, error: stErr } = await admin.from("stores").insert({ tenant_id: ctx.tenantA, name: `Local ${STAMP}` }).select("id").single();
      if (stErr || !st) throw stErr ?? new Error("store");
      ctx.store = st.id as string;
    }
    const { data: reg } = await admin.from("cash_registers").select("id").eq("tenant_id", ctx.tenantA).is("deleted_at", null).limit(1).maybeSingle();
    if (reg?.id) ctx.register = reg.id as string;
    else {
      const { data: r, error: rErr } = await admin
        .from("cash_registers")
        .insert({ tenant_id: ctx.tenantA, store_id: ctx.store, name: "Caja 1" } as never)
        .select("id")
        .single();
      if (rErr || !r) throw rErr ?? new Error("register");
      ctx.register = (r as { id: string }).id;
    }
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("cada caja registradora es una cuenta de sistema que nadie edita", async () => {
    const { data } = await ctx.owner
      .from("treasury_accounts")
      .select("id, kind, is_system, cash_register_id")
      .eq("tenant_id", ctx.tenantA)
      .eq("kind", "pos_cash");
    const rows = (data ?? []) as Array<{ id: string; is_system: boolean; cash_register_id: string }>;
    expect(rows.some((r) => r.cash_register_id === ctx.register && r.is_system)).toBe(true);
    const ins = await ctx.owner
      .from("treasury_accounts")
      .insert({ tenant_id: ctx.tenantA, kind: "pos_cash", name: "Trucha", cash_register_id: ctx.register } as never);
    expect(ins.error?.message).toMatch(/treasury_system_account/);
    const upd = await ctx.owner.from("treasury_accounts").update({ name: "Otro" } as never).eq("id", rows[0]!.id).select("id");
    expect(upd.error?.message ?? "").toMatch(/treasury_system_account/);
  });

  it("gating: B sin la feature y el cajero no ven la posición", async () => {
    const b = await rpc(ctx.ownerB, "treasury_position", {});
    expect(b.error?.message).toMatch(/feature_not_in_plan: tesoreria/);
    const c = await rpc(ctx.cashier, "treasury_position", {});
    expect(c.error?.message).toMatch(/forbidden/);
  });

  it("banco con su subcuenta contable y asiento de saldo inicial", async () => {
    const setup = await rpc(ctx.owner, "acc_setup", { p: { start_date: ctx.lastMonth } });
    expect(setup.error).toBeNull();
    const { data: acc, error } = await ctx.owner
      .from("treasury_accounts")
      .insert({ tenant_id: ctx.tenantA, kind: "bank", name: "Galicia CC", currency: "ARS", opening_balance: 1000, opening_date: ctx.lastMonth } as never)
      .select("id")
      .single();
    expect(error).toBeNull();
    ctx.bank = (acc as { id: string }).id;
    const led = await rpc(ctx.owner, "treasury_account_ledger_create", { p_account: ctx.bank });
    expect(led.error).toBeNull();
    const again = await rpc(ctx.owner, "treasury_account_ledger_create", { p_account: ctx.bank });
    expect(again.data).toBe(led.data);
    const { data: la } = await ctx.owner.from("acc_accounts").select("code").eq("id", led.data as string).single();
    ctx.ledgerCode = (la as { code: string }).code;
    await regenerate();
    expect(await ledgerBalance(ctx.ledgerCode)).toBe(1000);
    expect(await bankBalance()).toBe(1000);
  });

  it("una venta por transferencia suma en Galicia en Tesorería y en el Mayor; anularla resta en los dos", async () => {
    const { data: ta, error: taErr } = await ctx.admin
      .from("transfer_accounts")
      .insert({ tenant_id: ctx.tenantA, bank_slug: "galicia", bank_name: "Galicia", holder_name: "Test", alias: `tes.${STAMP.slice(-6)}`, currency: "ARS" } as never)
      .select("id")
      .single();
    if (taErr) throw taErr;
    ctx.transferAccount = (ta as { id: string }).id;
    const link = await rpc(ctx.owner, "treasury_account_link_transfer", { p_treasury: ctx.bank, p_transfer: ctx.transferAccount, p_linked: true });
    expect(link.error).toBeNull();
    const bad = await rpc(ctx.owner, "treasury_account_link_transfer", {
      p_treasury: (await ctx.owner.from("treasury_accounts").select("id").eq("tenant_id", ctx.tenantA).eq("kind", "pos_cash").limit(1).single()).data!.id,
      p_transfer: ctx.transferAccount,
      p_linked: true,
    });
    expect(bad.error?.message).toMatch(/treasury_account_kind_not_linkable/);

    const { data: sale, error } = await ctx.admin
      .from("sales")
      .insert({ tenant_id: ctx.tenantA, store_id: ctx.store, number: 995001, subtotal: 1210, total: 1210, status: "completed" })
      .select("id")
      .single();
    if (error || !sale) throw error ?? new Error("sale");
    ctx.sale = sale.id as string;
    const { error: pErr } = await ctx.admin.from("payments").insert({
      tenant_id: ctx.tenantA,
      sale_id: ctx.sale,
      method: "transfer",
      amount: 1210,
      reference: "op-777",
      card_voucher: { transfer_account_id: ctx.transferAccount },
    } as never);
    if (pErr) throw pErr;
    await regenerate();

    expect(await bankBalance()).toBe(2210);
    expect(await ledgerBalance(ctx.ledgerCode)).toBe(2210);
    const { data: mv } = await ctx.owner.from("treasury_movements").select("id, type, sale_id").eq("tenant_id", ctx.tenantA).eq("type", "sale_collection");
    expect(((mv ?? []) as Array<{ sale_id: string }>)[0]?.sale_id).toBe(ctx.sale);
    // "Ver asiento" de un movimiento con origen trae el asiento de la venta.
    const lookup = await rpc(ctx.owner, "acc_entry_lookup", { p_source_type: "treasury_movement", p_source_id: (mv as Array<{ id: string }>)[0]!.id });
    expect(lookup.error).toBeNull();
    expect((lookup.data as Array<{ source_type: string }>).some((e) => e.source_type === "sale")).toBe(true);

    const { error: vErr } = await ctx.admin
      .from("sales")
      .update({ status: "voided", voided_at: new Date().toISOString(), void_reason: "test tesorería" } as never)
      .eq("id", ctx.sale);
    if (vErr) throw vErr;
    await rpc(ctx.owner, "acc_generate", { p_from: ctx.lastMonth, p_to: ctx.today, p_regenerate: false });
    expect(await bankBalance()).toBe(1000);
    expect(await ledgerBalance(ctx.ledgerCode)).toBe(1000);
  });

  it("gasto: alquiler pagado desde Galicia va a su cuenta de gasto con el IVA aparte", async () => {
    const { data: exp } = await ctx.owner.from("acc_accounts").select("id").eq("tenant_id", ctx.tenantA).eq("system_key", "alquileres").single();
    const bad = await rpc(ctx.owner, "treasury_movement_create", {
      p: { account_id: ctx.bank, type: "withdrawal", amount: 121, expense_account_id: (exp as { id: string }).id, receipt_vat: 121 },
    });
    expect(bad.error?.message).toMatch(/receipt_vat_invalid/);
    const ok = await rpc(ctx.owner, "treasury_movement_create", {
      p: { account_id: ctx.bank, type: "withdrawal", amount: 121, expense_account_id: (exp as { id: string }).id, receipt_number: "A-0001-00000001", receipt_vat: 21, date: ctx.today },
    });
    expect(ok.error).toBeNull();
    await regenerate();
    expect(await ledgerBalance(await codeOf("alquileres"))).toBe(100);
    expect(await ledgerBalance(await codeOf("iva_cf"))).toBe(21);
    expect(await ledgerBalance(ctx.ledgerCode)).toBe(879);
    expect(await bankBalance()).toBe(879);
  });

  it("cheque de terceros: recibido y rechazado sin dejar Valores a depositar negativo", async () => {
    const reg = await rpc(ctx.owner, "cheque_register", { p: { number: "777", payment_date: ctx.today, amount: 500, drawer_name: "Cliente" } });
    expect(reg.error).toBeNull();
    const rej = await rpc(ctx.owner, "cheque_transition", { p_id: reg.data, p_to: "rechazado", p: { reason: "Sin fondos" } });
    expect(rej.error).toBeNull();
    await regenerate();
    expect(await ledgerBalance(await codeOf("valores_a_depositar"))).toBe(0);
    expect(await ledgerBalance(await codeOf("cheques_rechazados"))).toBe(500);
  });

  it("todos los asientos del negocio balancean y Sumas y saldos cierra", async () => {
    const lines = await journal();
    expect(lines.length).toBeGreaterThan(0);
    const byEntry = new Map<string, number>();
    for (const l of lines) byEntry.set(l.entry_id, (byEntry.get(l.entry_id) ?? 0) + l.debit - l.credit);
    for (const diff of byEntry.values()) expect(Math.abs(diff)).toBeLessThan(0.005);
    const tb = await rpc(ctx.owner, "acc_trial_balance", { p_from: ctx.lastMonth, p_to: ctx.today });
    expect(tb.error).toBeNull();
    const rows = (tb.data ?? []) as Array<{ debit: number; credit: number }>;
    const d = rows.reduce((t, x) => t + Number(x.debit), 0);
    const c = rows.reduce((t, x) => t + Number(x.credit), 0);
    expect(Math.abs(d - c)).toBeLessThan(0.005);
    const { data: issues } = await ctx.owner.from("acc_issues").select("message").eq("tenant_id", ctx.tenantA).is("resolved_at", null).is("dismissed_at", null);
    expect(issues ?? []).toHaveLength(0);
  });

  it("RLS: el vínculo con transferencias no se ve desde otro negocio ni se escribe directo", async () => {
    const other = await ctx.ownerB.from("treasury_account_transfer_accounts").select("id").eq("tenant_id", ctx.tenantA);
    expect(other.data ?? []).toHaveLength(0);
    const mine = await ctx.owner.from("treasury_account_transfer_accounts").select("id").eq("tenant_id", ctx.tenantA);
    expect((mine.data ?? []).length).toBe(1);
    const ins = await ctx.owner
      .from("treasury_account_transfer_accounts")
      .insert({ tenant_id: ctx.tenantA, treasury_account_id: ctx.bank, transfer_account_id: ctx.transferAccount } as never);
    expect(ins.error).not.toBeNull();
    const pend = await rpc(ctx.ownerB, "treasury_pending_collections", {});
    expect(pend.error?.message).toMatch(/feature_not_in_plan: tesoreria/);
  });

  it("caja: no cierra con contado 0 sin confirmarlo y el Z se revisa con motivo", async () => {
    const open = await rpc(ctx.owner, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 100 });
    expect(open.error).toBeNull();
    const shift = open.data as string;
    const closeBad = await rpc(ctx.owner, "close_cash_shift", { p_shift_id: shift, p_closing_amount: 0, p_notes: null });
    expect(closeBad.error?.message).toMatch(/close_zero_needs_confirmation/);
    const direct = await ctx.owner.from("cash_shifts").update({ zero_close_confirmed_at: new Date().toISOString() } as never).eq("id", shift);
    expect(direct.error).not.toBeNull();
    const conf = await rpc(ctx.owner, "cash_shift_confirm_zero_close", { p_shift_id: shift, p_reason: "Retiré todo para el banco" });
    expect(conf.error).toBeNull();
    const close = await rpc(ctx.owner, "close_cash_shift", { p_shift_id: shift, p_closing_amount: 0, p_notes: "cierre" });
    expect(close.error).toBeNull();

    const { data: z } = await ctx.owner.from("cash_z_closures").select("id").eq("cash_shift_id", shift).single();
    const zid = (z as { id: string }).id;
    const byCashier = await rpc(ctx.cashier, "cash_z_review", { p_id: zid, p_kind: "conteo", p_reason: "Conté mal" });
    expect(byCashier.error?.message).toMatch(/forbidden/);
    const review = await rpc(ctx.owner, "cash_z_review", { p_id: zid, p_kind: "retiro_sin_registrar", p_reason: "Depósito en el banco sin registrar" });
    expect(review.error).toBeNull();
    const { data: zr } = await ctx.owner.from("cash_z_closures").select("review_kind, reviewed_at").eq("id", zid).single();
    expect((zr as { review_kind: string }).review_kind).toBe("retiro_sin_registrar");
  });

  it("sin políticas PERMISSIVE con is_internal() ni tenant sin initplan (ADR-052)", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await rpc(ctx.admin, fn, {});
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});
