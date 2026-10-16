// @vitest-environment node
// =============================================================================
// Tesorería de punta a punta (F23 · H157, ADR-162; migraciones 20261231100000
// a 20261231100200 sobre las de ADR-158).
//
// Un día del mes pasado: venta en efectivo, por transferencia (a Galicia), con
// QR de Mercado Pago y con crédito Payway; retiro del cajón a la caja fuerte y
// depósito en el banco; liquidación de MP (con IVA de la comisión y retención)
// a la billetera y de Payway al banco; la de MP se desvincula y se vuelve a
// vincular (contra-asiento y contra-movimiento); un contracargo que va y vuelve
// dos veces; cobro de cuenta corriente por transferencia; extracto del banco
// con matching y una comisión creada desde el extracto; cierre de caja y de
// mes. Al final: Tesorería, Mayor de cada cuenta y Sumas y saldos cuadran al
// centavo, todos los asientos balancean y no quedan problemas. Después, NubCeo
// como fuente de los asientos de liquidación desde el mes en curso.
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

const STAMP = `h157-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;
async function ok<T = unknown>(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc(c, fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data as T;
}

const ctx = {} as {
  admin: SupabaseClient;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  tenantA: string;
  tenantB: string;
  userIds: string[];
  store: string;
  register: string;
  shift: string;
  prev: string;
  today: string;
  day: string;
  bank: string;
  wallet: string;
  safe: string;
  transferAccount: string;
  codes: Record<"bank" | "wallet" | "safe", string>;
  mpLine: string;
  mpPayment: string;
};

async function makeUser(email: string, tenantId: string, role: string) {
  const { data, error } = await ctx.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await ctx.admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  ctx.userIds.push(id);
  return client;
}

const arDay = (d: Date = new Date()) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Instante de un día argentino a una hora (UTC-3). */
const arAt = (day: string, hh: number, mm = 0) => new Date(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-03:00`).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

async function ledger(): Promise<Array<{ entry_id: string; account_code: string; debit: number; credit: number }>> {
  const { data, error } = await ctx.owner
    .from("acc_journal_lines")
    .select("entry_id, account_code, debit, credit")
    .eq("tenant_id", ctx.tenantA);
  if (error) throw error;
  return ((data ?? []) as Array<{ entry_id: string; account_code: string; debit: number; credit: number }>).map((l) => ({
    ...l,
    debit: Number(l.debit),
    credit: Number(l.credit),
  }));
}
async function ledgerBalance(code: string): Promise<number> {
  return round2((await ledger()).filter((l) => l.account_code === code).reduce((t, l) => t + l.debit - l.credit, 0));
}
async function position(): Promise<Record<string, number>> {
  const rows = await ok<Array<{ account_id: string; balance: number }>>(ctx.owner, "treasury_position");
  return Object.fromEntries(rows.map((r) => [r.account_id, Number(r.balance)]));
}

describe.skipIf(!enabled)("H157 · un día de punta a punta: Tesorería, Mayor y Sumas y saldos al centavo", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    ctx.today = arDay();
    const t = new Date(`${ctx.today}T12:00:00Z`);
    ctx.prev = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    ctx.day = addDays(ctx.prev, 9);

    const { data: tenants, error } = await ctx.admin
      .from("tenants")
      .insert([
        { name: `H157 A ${STAMP}`, slug: `a-${STAMP}`, status: "active" },
        { name: `H157 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;
    const { error: addErr } = await ctx.admin.from("subscription_addons").insert(
      ["tesoreria", "compras", "contabilidad", "conciliacion_procesadores", "conciliacion_bancaria", "cuenta_corriente", "integracion_nubceo"].map(
        (k) => ({ tenant_id: ctx.tenantA, addon_key: k, status: "active", source: "granted" }),
      ),
    );
    if (addErr) throw addErr;

    ctx.owner = await makeUser(`owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.cashier = await makeUser(`cajero-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(`owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");

    const { data: st } = await ctx.admin.from("stores").select("id").eq("tenant_id", ctx.tenantA).is("deleted_at", null).limit(1).maybeSingle();
    if (st?.id) ctx.store = st.id as string;
    else {
      const { data: s, error: sErr } = await ctx.admin.from("stores").insert({ tenant_id: ctx.tenantA, name: `Local ${STAMP}` }).select("id").single();
      if (sErr || !s) throw sErr ?? new Error("store");
      ctx.store = s.id as string;
    }
    const { data: reg } = await ctx.admin.from("cash_registers").select("id").eq("tenant_id", ctx.tenantA).is("deleted_at", null).limit(1).maybeSingle();
    if (reg?.id) ctx.register = reg.id as string;
    else {
      const { data: r, error: rErr } = await ctx.admin
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

  it("cuentas: Galicia (acredita Payway), billetera de MP y caja fuerte, cada una con su cuenta contable", async () => {
    await ok(ctx.owner, "acc_setup", { p: { start_date: ctx.prev, vat_mode: "included_rate" } });
    const ins = async (row: Record<string, unknown>) => {
      const { data, error } = await ctx.owner
        .from("treasury_accounts")
        .insert({ tenant_id: ctx.tenantA, currency: "ARS", opening_balance: 0, opening_date: ctx.prev, ...row } as never)
        .select("id")
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    };
    ctx.bank = await ins({ kind: "bank", name: "Galicia CC" });
    ctx.wallet = await ins({ kind: "wallet", name: "Mercado Pago", provider_key: "mercadopago" });
    ctx.safe = await ins({ kind: "cash", name: "Caja fuerte" });
    await ok(ctx.owner, "treasury_account_set_settlement", { p_account: ctx.bank, p_providers: ["payway"] });
    const codeOf = async (accId: string) => {
      const id = await ok<string>(ctx.owner, "treasury_account_ledger_create", { p_account: accId });
      const { data } = await ctx.owner.from("acc_accounts").select("code").eq("id", id).single();
      return (data as { code: string }).code;
    };
    ctx.codes = { bank: await codeOf(ctx.bank), wallet: await codeOf(ctx.wallet), safe: await codeOf(ctx.safe) };

    const { data: ta, error } = await ctx.admin
      .from("transfer_accounts")
      .insert({ tenant_id: ctx.tenantA, bank_slug: "galicia", bank_name: "Galicia", holder_name: "Test", alias: `h157.${STAMP.slice(-6)}`, currency: "ARS" } as never)
      .select("id")
      .single();
    if (error) throw error;
    ctx.transferAccount = (ta as { id: string }).id;
    await ok(ctx.owner, "treasury_account_link_transfer", { p_treasury: ctx.bank, p_transfer: ctx.transferAccount, p_linked: true });
  });

  it("el día: cuatro ventas, retiro a la caja fuerte y depósito en el banco", async () => {
    ctx.shift = await ok<string>(ctx.owner, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 0 });
    const sale = async (n: number, total: number, at: string, pay: Record<string, unknown>) => {
      const { data, error } = await ctx.admin
        .from("sales")
        .insert({ tenant_id: ctx.tenantA, store_id: ctx.store, cash_shift_id: ctx.shift, number: 157000 + n, subtotal: total, total, status: "completed", created_at: at } as never)
        .select("id")
        .single();
      if (error) throw error;
      const sid = (data as { id: string }).id;
      const { data: p, error: pErr } = await ctx.admin
        .from("payments")
        .insert({ tenant_id: ctx.tenantA, sale_id: sid, amount: total, created_at: at, ...pay } as never)
        .select("id")
        .single();
      if (pErr) throw pErr;
      return { sid, pid: (p as { id: string }).id };
    };
    const s1 = await sale(1, 1000, arAt(ctx.day, 12), { method: "cash" });
    await ctx.admin.from("cash_movements").insert({
      tenant_id: ctx.tenantA, cash_shift_id: ctx.shift, type: "sale", amount: 1000, payment_method: "cash", reference_id: s1.sid,
    } as never);
    await sale(2, 2000, arAt(ctx.day, 12, 10), { method: "transfer", reference: "op-1", metadata: { transfer: { account_id: ctx.transferAccount } } });
    const s3 = await sale(3, 3000, arAt(ctx.day, 12, 20), { method: "qr", reference: "987654321" });
    ctx.mpPayment = s3.pid;
    const s4 = await sale(4, 4000, arAt(ctx.day, 12, 30), { method: "credit", card_voucher: { adquirente: "payway", lote: "7", cupon: "15" } });

    // El cajero ve a dónde puede ir el retiro; el destino inválido se rechaza.
    const dest = await ok<Array<{ id: string }>>(ctx.cashier, "treasury_drop_destinations");
    expect(dest.map((d) => d.id)).toEqual(expect.arrayContaining([ctx.safe, ctx.bank]));
    expect(dest.map((d) => d.id)).not.toContain(ctx.wallet);
    const bad = await ctx.admin.from("cash_movements").insert({
      tenant_id: ctx.tenantA, cash_shift_id: ctx.shift, type: "expense", amount: 10, payment_method: "cash", treasury_account_id: ctx.wallet,
    } as never);
    expect(bad.error?.message).toMatch(/cash_destination_invalid/);
    const { error: dropErr } = await ctx.admin.from("cash_movements").insert({
      tenant_id: ctx.tenantA, cash_shift_id: ctx.shift, type: "expense", amount: 600, payment_method: "cash",
      reason: "Retiro a caja fuerte", created_at: arAt(ctx.day, 17), treasury_account_id: ctx.safe,
    } as never);
    if (dropErr) throw dropErr;
    await ok(ctx.owner, "treasury_transfer", { p_from: ctx.safe, p_to: ctx.bank, p_amount: 600, p_date: ctx.day, p_description: "Depósito del retiro" });

    // Liquidaciones: MP a la billetera (IVA de la comisión y retención aparte) y Payway al banco.
    const { data: imp } = await ctx.admin
      .from("settlement_imports")
      .insert({ tenant_id: ctx.tenantA, provider_key: "mercadopago", source: "api", file_name: "h157", row_count: 2 } as never)
      .select("id")
      .single();
    const base = { tenant_id: ctx.tenantA, import_id: (imp as { id: string }).id, kind: "payment", status: "approved", released: true, refunded: 0, currency: "ARS", reconciled_payment: true };
    const { data: l3, error: e3 } = await ctx.admin
      .from("settlement_lines")
      .insert({
        ...base, provider_key: "mercadopago", line_key: `mp-${STAMP}`, external_id: "987654321",
        operation_at: arAt(ctx.day, 12, 20), release_date: arAt(addDays(ctx.day, 1), 12), gross: 3000, fee: 120, taxes: 55.2, net: 2824.8,
        fee_detail: [
          { label: "Comisión de Mercado Pago", amount: 120, kind: "fee" },
          { label: "IVA sobre la comisión", amount: 25.2, kind: "tax", code: "iva_comision_mp" },
          { label: "Retención de Ingresos Brutos", amount: 30, kind: "tax", code: "iibb" },
        ],
        payment_id: s3.pid, sale_id: s3.sid, match_status: "matched", match_method: "provider_id",
      } as never)
      .select("id")
      .single();
    if (e3) throw e3;
    ctx.mpLine = (l3 as { id: string }).id;
    const { error: e4 } = await ctx.admin.from("settlement_lines").insert({
      ...base, provider_key: "payway", line_key: `pw-${STAMP}`, operation_at: arAt(ctx.day, 12, 30),
      release_date: arAt(addDays(ctx.day, 14), 12), gross: 4000, fee: 80, taxes: 16.8, net: 3903.2, lote: "7", cupon: "15",
      fee_detail: [
        { label: "Arancel", amount: 80, kind: "fee" },
        { label: "IVA sobre el arancel", amount: 16.8, kind: "tax", code: "iva_comision" },
      ],
      payment_id: s4.pid, sale_id: s4.sid, match_status: "matched", match_method: "voucher",
    } as never);
    if (e4) throw e4;
  });

  it("desvincular deshace el asiento y el movimiento; volver a vincular los rearma", async () => {
    await ok(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.mpLine, p_action: "unlink" });
    expect((await position())[ctx.wallet]).toBe(0);
    await ok(ctx.owner, "settlement_line_resolve", { p_line_id: ctx.mpLine, p_action: "link", p_payment_id: ctx.mpPayment, p_note: "Es el QR" });
    expect((await position())[ctx.wallet]).toBe(2824.8);
  });

  it("contracargo perdido, ganado, perdido y ganado: la billetera vuelve a su saldo (T16)", async () => {
    const { data, error } = await ctx.admin
      .from("payment_disputes")
      .insert({
        tenant_id: ctx.tenantA, provider_key: "mercadopago", kind: "chargeback", dispute_key: `cb-${STAMP}`, provider_payment_id: "987654321",
        payment_id: ctx.mpPayment, amount: 3000, status: "lost", origin: "provider", occurred_at: arAt(addDays(ctx.day, 3), 10), resolved_at: arAt(addDays(ctx.day, 3), 10),
      } as never)
      .select("id")
      .single();
    if (error) throw error;
    const id = (data as { id: string }).id;
    expect((await position())[ctx.wallet]).toBe(-175.2);
    for (const status of ["won", "lost", "won"]) {
      const { error: uErr } = await ctx.admin.from("payment_disputes").update({ status } as never).eq("id", id);
      if (uErr) throw uErr;
    }
    expect((await position())[ctx.wallet]).toBe(2824.8);
  });

  it("cobro de cuenta corriente por transferencia entra a Galicia", async () => {
    const { data: c } = await ctx.admin.from("customers").insert({ tenant_id: ctx.tenantA, name: `Cliente ${STAMP}` } as never).select("id").single();
    await ok(ctx.owner, "account_collect", {
      p_customer_id: (c as { id: string }).id, p_amount: 500, p_method: "transfer", p_idempotency_key: `cc-${STAMP}`,
      p_note: "Pago por transferencia", p_transfer_account: ctx.transferAccount,
    });
    const { data: mv } = await ctx.owner.from("treasury_movements").select("type, amount").eq("account_id", ctx.bank).eq("type", "cc_collection");
    expect((mv ?? []).length).toBe(1);
  });

  it("extracto del banco: tilda solo lo que coincide; la comisión se crea desde el extracto; no duplica", async () => {
    const lines = [
      { date: ctx.day, description: "TRANSF RECIBIDA", reference: "op-1", amount: 2000 },
      { date: addDays(ctx.day, 1), description: "DEPOSITO EFECTIVO", amount: 600 },
      { date: addDays(ctx.day, 14), description: "PAYWAY LIQ", amount: 3903.2 },
      { date: addDays(ctx.day, 16), description: "COMISION MANT CUENTA", amount: -150 },
    ];
    const r = await ok<{ matched: number; pending: number; inserted: number }>(ctx.owner, "bank_statement_import", {
      p_account: ctx.bank, p_file_name: "galicia.csv", p_preset: "galicia", p_lines: lines,
    });
    expect(r).toMatchObject({ inserted: 4, matched: 3, pending: 1 });
    const again = await ok<{ inserted: number; duplicates: number }>(ctx.owner, "bank_statement_import", {
      p_account: ctx.bank, p_file_name: "galicia.csv", p_preset: "galicia", p_lines: lines.slice(0, 1),
    });
    expect(again).toMatchObject({ inserted: 0, duplicates: 1 });
    const { data: pend } = await ctx.owner.from("bank_statement_lines").select("id").eq("treasury_account_id", ctx.bank).eq("match_status", "pending");
    const { data: gb } = await ctx.owner.from("acc_accounts").select("id").eq("tenant_id", ctx.tenantA).eq("system_key", "gastos_bancarios").single();
    await ok(ctx.owner, "bank_statement_line_resolve", {
      p_line: (pend as Array<{ id: string }>)[0]!.id, p_action: "create", p_note: "Comisión del banco",
      p: { expense_account_id: (gb as { id: string }).id },
    });
    const { data: all } = await ctx.owner.from("bank_statement_lines").select("match_status").eq("treasury_account_id", ctx.bank);
    expect((all ?? []).every((l) => (l as { match_status: string }).match_status === "matched")).toBe(true);
  });

  it("cierre de caja con lo contado exacto y cierre del mes", async () => {
    await ok(ctx.owner, "close_cash_shift", { p_shift_id: ctx.shift, p_closing_amount: 400, p_notes: "Cierre H157" });
    const regen = await ok<{ failed: number }>(ctx.owner, "acc_generate", { p_from: ctx.prev, p_to: ctx.today, p_regenerate: true });
    expect(regen.failed).toBe(0);
    const close = await ok<{ open_issues: number }>(ctx.owner, "acc_period_close", { p_period: ctx.prev, p_notes: "H157" });
    expect(close.open_issues).toBe(0);
  });

  it("Tesorería, Mayor y Sumas y saldos cuadran al centavo", async () => {
    const pos = await position();
    expect(pos[ctx.bank]).toBe(6853.2);
    expect(pos[ctx.wallet]).toBe(2824.8);
    expect(pos[ctx.safe]).toBe(0);
    expect(await ledgerBalance(ctx.codes.bank)).toBe(6853.2);
    expect(await ledgerBalance(ctx.codes.wallet)).toBe(2824.8);
    expect(await ledgerBalance(ctx.codes.safe)).toBe(0);

    const code = async (k: string) =>
      ((await ctx.owner.from("acc_accounts").select("code").eq("tenant_id", ctx.tenantA).eq("system_key", k).single()).data as { code: string }).code;
    expect(await ledgerBalance(await code("caja"))).toBe(400);
    expect(await ledgerBalance(await code("mp_a_cobrar"))).toBe(0);
    expect(await ledgerBalance(await code("tarjetas_payway"))).toBe(0);
    expect(await ledgerBalance(await code("comisiones_procesadores"))).toBe(200);
    expect(await ledgerBalance(await code("iva_cf"))).toBe(42);
    expect(await ledgerBalance(await code("ret_cobros"))).toBe(30);
    expect(await ledgerBalance(await code("gastos_bancarios"))).toBe(150);

    const lines = await ledger();
    const byEntry = new Map<string, number>();
    for (const l of lines) byEntry.set(l.entry_id, (byEntry.get(l.entry_id) ?? 0) + l.debit - l.credit);
    for (const diff of byEntry.values()) expect(Math.abs(diff)).toBeLessThan(0.005);
    const tb = await ok<Array<{ debit: number; credit: number }>>(ctx.owner, "acc_trial_balance", { p_from: ctx.prev, p_to: ctx.today });
    const d = tb.reduce((t, x) => t + Number(x.debit), 0);
    const c = tb.reduce((t, x) => t + Number(x.credit), 0);
    expect(Math.abs(d - c)).toBeLessThan(0.005);
    const { data: issues } = await ctx.owner.from("acc_issues").select("message").eq("tenant_id", ctx.tenantA).is("resolved_at", null).is("dismissed_at", null);
    expect(issues ?? []).toHaveLength(0);
  });

  it("NubCeo como fuente desde el mes en curso: equivalencias, asiento balanceado y baja desde NubCeo (H153)", async () => {
    const closed = await rpc(ctx.owner, "acc_settlement_source_set", { p_source: "nubceo", p_from: ctx.prev });
    expect(closed.error?.message).toMatch(/acc_period_closed/);
    const month = `${ctx.today.slice(0, 7)}-01`;
    await ok(ctx.owner, "acc_settlement_source_set", { p_source: "nubceo", p_from: month });
    const { data: h, error } = await ctx.admin
      .from("nubceo_ledger_headers")
      .insert({ tenant_id: ctx.tenantA, source: "api", nubceo_id: `nb-${STAMP}`, number: "100", category: "settlement", status: "confirmed", entry_date: ctx.today, currency: "ARS" } as never)
      .select("id")
      .single();
    if (error) throw error;
    const hid = (h as { id: string }).id;
    await ctx.admin.from("nubceo_ledger_entries").insert([
      { tenant_id: ctx.tenantA, header_id: hid, position: 1, account_code: "1.1.1", account_name: "Banco", amount: 970 },
      { tenant_id: ctx.tenantA, header_id: hid, position: 2, account_code: "5.1", account_name: "Comisiones", amount: 30 },
      { tenant_id: ctx.tenantA, header_id: hid, position: 3, account_code: "1.3", account_name: "Tarjetas", amount: -1000 },
    ] as never);
    await ctx.admin.from("nubceo_ledger_headers").update({ total_debit: 1000, total_credit: 1000 } as never).eq("id", hid);
    const { data: issue } = await ctx.owner.from("acc_issues").select("message").eq("tenant_id", ctx.tenantA).eq("source_type", "nubceo_ledger").is("resolved_at", null);
    expect((issue as Array<{ message: string }>)[0]?.message).toMatch(/nubceo_account_unmapped/);

    const idOf = async (k: string) =>
      ((await ctx.owner.from("acc_accounts").select("id").eq("tenant_id", ctx.tenantA).eq("system_key", k).single()).data as { id: string }).id;
    await ok(ctx.owner, "nubceo_account_map_set", { p_code: "1.1.1", p_subcode: "", p_account: await idOf("banco") });
    await ok(ctx.owner, "nubceo_account_map_set", { p_code: "5.1", p_subcode: "", p_account: await idOf("comisiones_procesadores") });
    const last = await ok<{ retried: number }>(ctx.owner, "nubceo_account_map_set", { p_code: "1.3", p_subcode: "", p_account: await idOf("tarjetas_payway") });
    expect(last.retried).toBe(1);
    const { data: e1 } = await ctx.owner.from("acc_entries").select("id, total").eq("source_type", "nubceo_ledger").eq("source_id", hid).is("deleted_at", null);
    expect((e1 ?? []).length).toBe(1);

    await ctx.admin.from("nubceo_ledger_headers").update({ deleted_in_nubceo: true } as never).eq("id", hid);
    const { data: e2 } = await ctx.owner.from("acc_entries").select("id, reversal_of").eq("source_type", "nubceo_ledger").eq("source_id", hid).is("deleted_at", null);
    expect((e2 ?? []).filter((e) => (e as { reversal_of: string | null }).reversal_of)).toHaveLength(1);
  });

  it("gating y RLS: sin la feature no se sube un extracto, el cajero tampoco, y no se ve desde otro negocio", async () => {
    const b = await rpc(ctx.ownerB, "bank_statement_import", { p_account: ctx.bank, p_file_name: "x", p_preset: null, p_lines: [] });
    expect(b.error?.message).toMatch(/feature_not_in_plan|forbidden/);
    const c = await rpc(ctx.cashier, "bank_statement_import", { p_account: ctx.bank, p_file_name: "x", p_preset: null, p_lines: [] });
    expect(c.error?.message).toMatch(/forbidden/);
    const other = await ctx.ownerB.from("bank_statement_lines").select("id").eq("tenant_id", ctx.tenantA);
    expect(other.data ?? []).toHaveLength(0);
    const cashierSees = await ctx.cashier.from("bank_statement_lines").select("id").eq("tenant_id", ctx.tenantA);
    expect(cashierSees.data ?? []).toHaveLength(0);
    const direct = await ctx.owner.from("bank_statement_lines").update({ match_status: "ignored" } as never).eq("tenant_id", ctx.tenantA);
    expect(direct.error).not.toBeNull();
    const map = await ctx.ownerB.from("nubceo_account_map").select("id").eq("tenant_id", ctx.tenantA);
    expect(map.data ?? []).toHaveLength(0);
  });

  it("sin políticas PERMISSIVE con is_internal() ni tenant sin initplan (ADR-052)", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await rpc(ctx.admin, fn);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});
