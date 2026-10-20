// @vitest-environment node
// =============================================================================
// F18 · compras v2 y tesorería (ADR-059): devoluciones a proveedor, anulación
// de recepciones, órdenes de pago con imputación, tesorería, cheques, consumo
// por lote y listas de precios del proveedor.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio C con compras y tesorería (addons otorgados), una
// sucursal y una caja; negocio S con compras y sin tesorería. Dueño y cajero
// en C, dueño en S.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `comprasv2-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantC: string;
  tenantS: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerS: SupabaseClient;
  userIds: string[];
  store: string;
  storeS: string;
  register: string;
  supplier: string;
  supplierS: string;
  milk: string;
  rice: string;
  rec1: string;
  rec2: string;
  bank: string;
  cheque: string;
  inv1: string;
  inv2: string;
  op: string;
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

const one = async <T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> => {
  const { data, error } = await q;
  if (error) throw error;
  return data as T;
};

const receive = (c: SupabaseClient, productId: string, qty: number, cost: number, extra: Record<string, unknown> = {}) =>
  rpc(c, "purchase_receive", {
    p_order_id: null,
    p_store_id: ctx.store,
    p_supplier_id: ctx.supplier,
    p_received_date: null,
    p_remito_number: null,
    p_currency: "ARS",
    p_fx_rate: 1,
    p_items: [{ product_id: productId, qty, unit_cost: cost, ...extra }],
    p_close: false,
    p_notes: null,
  });

describe.skipIf(!enabled)("F18 · compras v2 y tesorería", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await one<Array<{ id: string }>>(
      admin
        .from("tenants")
        .insert([
          { name: `Compras v2 ${STAMP}`, slug: `c2-${STAMP}`, status: "active" },
          { name: `Sin tesorería ${STAMP}`, slug: `s2-${STAMP}`, status: "active" },
        ])
        .select("id"),
    );
    ctx.tenantC = tenants[0]!.id;
    ctx.tenantS = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert([
      { tenant_id: ctx.tenantC, addon_key: "compras", status: "active", source: "granted" },
      { tenant_id: ctx.tenantC, addon_key: "tesoreria", status: "active", source: "granted" },
      { tenant_id: ctx.tenantS, addon_key: "compras", status: "active", source: "granted" },
    ]);
    if (addonErr) throw addonErr;

    const stores = await one<Array<{ id: string; tenant_id: string }>>(
      admin
        .from("stores")
        .insert([
          { tenant_id: ctx.tenantC, name: "Central", is_default: true },
          { tenant_id: ctx.tenantS, name: "Única", is_default: true },
        ] as never)
        .select("id, tenant_id"),
    );
    ctx.store = stores.find((s) => s.tenant_id === ctx.tenantC)!.id;
    ctx.storeS = stores.find((s) => s.tenant_id === ctx.tenantS)!.id;
    const reg = await one<{ id: string }>(
      admin.from("cash_registers").insert({ tenant_id: ctx.tenantC, store_id: ctx.store, name: "Caja 1" } as never).select("id").single(),
    );
    ctx.register = reg.id;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantC, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantC, "cashier");
    const ownerS = await makeUser(admin, `owner-s-${STAMP}@test.local`, ctx.tenantS, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.ownerS = ownerS.client;
    ctx.userIds.push(owner.id, cashier.id, ownerS.id);

    const prods = await one<Array<{ id: string; name: string }>>(
      admin
        .from("products")
        .insert([
          { tenant_id: ctx.tenantC, name: `Leche ${STAMP}`, price: 300, cost: 100, stock: 0 },
          { tenant_id: ctx.tenantC, name: `Arroz ${STAMP}`, price: 500, cost: 200, stock: 0, sku: `ARZ-${STAMP}` },
        ] as never)
        .select("id, name"),
    );
    ctx.milk = prods.find((p) => p.name.startsWith("Leche"))!.id;
    ctx.rice = prods.find((p) => p.name.startsWith("Arroz"))!.id;

    const sup = await one<{ id: string }>(
      ctx.owner.from("suppliers").insert({ name: "Láctea", payment_terms_days: 30 } as never).select("id").single(),
    );
    ctx.supplier = sup.id;
    const supS = await one<{ id: string }>(
      ctx.ownerS.from("suppliers").insert({ name: "Otro" } as never).select("id").single(),
    );
    ctx.supplierS = supS.id;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantC, ctx.tenantS].filter(Boolean)) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("lotes: la venta consume por vencimiento y la anulación devuelve", async () => {
    const a = await receive(ctx.owner, ctx.milk, 10, 100, { lot_code: "A", expires_on: "2099-01-31" });
    expect(a.error).toBeNull();
    ctx.rec1 = a.data as string;
    const b = await receive(ctx.owner, ctx.milk, 5, 120, { lot_code: "B", expires_on: "2098-12-31" });
    expect(b.error).toBeNull();
    ctx.rec2 = b.data as string;

    expect((await rpc(ctx.owner, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 1000 })).error).toBeNull();
    const sale = await rpc(ctx.owner, "create_sale", {
      p_items: [{ product_id: ctx.milk, quantity: 7, unit_price: 300, discount: 0 }],
      p_payments: [{ method: "cash", amount: 2100 }],
    });
    expect(sale.error).toBeNull();
    const saleId = (sale.data as { sale_id: string }).sale_id;

    const lots = await one<Array<{ lot_code: string; qty_available: number }>>(
      ctx.owner.from("product_lots").select("lot_code, qty_available").eq("product_id", ctx.milk),
    );
    const by = new Map(lots.map((l) => [l.lot_code, Number(l.qty_available)]));
    expect(by.get("B")).toBe(0);
    expect(by.get("A")).toBe(8);

    const trace = await one<Array<{ qty: number }>>(ctx.owner.from("lot_sales").select("qty").eq("sale_id", saleId));
    expect(trace.reduce((t, r) => t + Number(r.qty), 0)).toBe(7);

    // Otro negocio no ve el libro de lotes.
    const other = await ctx.ownerS.from("lot_allocations").select("id").eq("sale_id", saleId);
    expect(other.data ?? []).toHaveLength(0);
  });

  it("devolución: el cajero no puede; el dueño saca stock, baja el promedio y vincula la NC", async () => {
    const items = await one<Array<{ id: string }>>(
      ctx.owner.from("goods_receipt_items").select("id").eq("receipt_id", ctx.rec1),
    );
    const args = {
      p: {
        receipt_id: ctx.rec1,
        reason: "danado",
        items: [{ receipt_item_id: items[0]!.id, qty: 3 }],
        credit_note: {
          letter: "A",
          point_of_sale: 1,
          number: 77,
          issue_date: "2026-10-05",
          vat_lines: [{ rate: 21, net: 300, vat: 63 }],
          total: 363,
        },
      },
    };
    const denied = await rpc(ctx.cashier, "purchase_return_create", args);
    expect(denied.error?.message).toMatch(/forbidden/);

    const ok = await rpc(ctx.owner, "purchase_return_create", args);
    expect(ok.error).toBeNull();
    const ret = await one<{ credit_invoice_id: string | null; total_units: number }>(
      ctx.owner.from("purchase_returns").select("credit_invoice_id, total_units").eq("id", ok.data as string).single(),
    );
    expect(ret.credit_invoice_id).not.toBeNull();
    expect(Number(ret.total_units)).toBe(3);

    const p = await one<{ stock: number; avg_cost: number }>(
      ctx.admin.from("products").select("stock, avg_cost").eq("id", ctx.milk).single(),
    );
    expect(Number(p.stock)).toBe(5);
    // (8 × 106,6667 − 3 × 100) / 5 = 110,6667
    expect(Number(p.avg_cost)).toBe(110.6667);

    const mv = await one<Array<{ delta: number }>>(
      ctx.admin.from("stock_movements").select("delta").eq("reference_id", ok.data as string).eq("reason", "purchase_return"),
    );
    expect(mv.map((x) => Number(x.delta))).toEqual([-3]);

    const otherTenant = await ctx.ownerS.from("purchase_returns").select("id").eq("id", ok.data as string);
    expect(otherTenant.data ?? []).toHaveLength(0);
  });

  it("anulación de recepción: bloqueos y reversa de stock y último costo", async () => {
    const consumed = await rpc(ctx.owner, "purchase_receipt_void", { p_id: ctx.rec2, p_reason: "x" });
    expect(consumed.error?.message).toMatch(/receipt_lots_consumed/);
    const withReturn = await rpc(ctx.owner, "purchase_receipt_void", { p_id: ctx.rec1, p_reason: "x" });
    expect(withReturn.error?.message).toMatch(/receipt_has_returns/);

    await ctx.admin.from("products").update({ last_cost: 200, avg_cost: 200 } as never).eq("id", ctx.rice);
    const r = await receive(ctx.owner, ctx.rice, 4, 260);
    expect(r.error).toBeNull();
    const cashierTry = await rpc(ctx.cashier, "purchase_receipt_void", { p_id: r.data, p_reason: "x" });
    expect(cashierTry.error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.owner, "purchase_receipt_void", { p_id: r.data, p_reason: "Cargada dos veces" })).error).toBeNull();

    const p = await one<{ stock: number; last_cost: number }>(
      ctx.admin.from("products").select("stock, last_cost").eq("id", ctx.rice).single(),
    );
    expect(Number(p.stock)).toBe(0);
    expect(Number(p.last_cost)).toBe(200);
    const g = await one<{ status: string }>(ctx.owner.from("goods_receipts").select("status").eq("id", r.data as string).single());
    expect(g.status).toBe("voided");
  });

  it("tesorería: sin la feature el servidor rechaza cuentas y movimientos", async () => {
    const ins = await ctx.ownerS.from("treasury_accounts").insert({ kind: "cash", name: "Caja" } as never);
    expect(ins.error).not.toBeNull();
    const mv = await rpc(ctx.ownerS, "treasury_movement_create", { p: { account_id: ctx.storeS, type: "deposit", amount: 1 } });
    expect(mv.error?.message).toMatch(/feature_not_in_plan: tesoreria/);
    const ch = await rpc(ctx.ownerS, "supplier_payment_order_create", {
      p: {
        supplier_id: ctx.supplierS,
        lines: [{ method: "cheque_propio", amount: 10, treasury_account_id: ctx.storeS, cheque: { number: "1", payment_date: "2026-11-01" } }],
      },
    });
    expect(ch.error?.message).toMatch(/feature_not_in_plan: tesoreria/);
  });

  it("tesorería: cuenta, cheque en cartera y cajero sin permiso", async () => {
    const bank = await one<{ id: string; tenant_id: string }>(
      ctx.owner
        .from("treasury_accounts")
        .insert({ kind: "bank", name: "Banco Nación", bank_name: "Nación", opening_balance: 5000 } as never)
        .select("id, tenant_id")
        .single(),
    );
    expect(bank.tenant_id).toBe(ctx.tenantC);
    ctx.bank = bank.id;

    const cashierAcc = await ctx.cashier.from("treasury_accounts").insert({ kind: "cash", name: "Mía" } as never);
    expect(cashierAcc.error).not.toBeNull();

    const ch = await rpc(ctx.owner, "cheque_register", {
      p: { number: "555", bank_name: "Galicia", payment_date: "2026-11-01", amount: 200, drawer_name: "Cliente" },
    });
    expect(ch.error).toBeNull();
    ctx.cheque = ch.data as string;

    const otherSees = await ctx.ownerS.from("cheques").select("id").eq("id", ctx.cheque);
    expect(otherSees.data ?? []).toHaveLength(0);
  });

  it("orden de pago: imputación, efectivo de la caja propia, banco y cheques; anulación revierte todo", async () => {
    const inv = async (number: number, total: number) =>
      rpc(ctx.owner, "supplier_invoice_save", {
        p_id: null,
        p: {
          supplier_id: ctx.supplier,
          kind: "invoice",
          // ADR-171: el proveedor es responsable inscripto (default), así que C no corresponde.
          letter: "B",
          point_of_sale: 2,
          number,
          issue_date: "2026-10-01",
          vat_lines: [{ rate: 0, net: total, vat: 0 }],
          total,
        },
      });
    ctx.inv1 = (await inv(10, 1000)).data as string;
    ctx.inv2 = (await inv(11, 500)).data as string;

    const args = {
      p: {
        supplier_id: ctx.supplier,
        paid_date: "2026-10-10",
        lines: [
          { method: "efectivo", amount: 300 },
          { method: "transferencia", amount: 400, treasury_account_id: ctx.bank, reference: "TRX1" },
          { method: "cheque_propio", amount: 250, treasury_account_id: ctx.bank, cheque: { number: "0001", payment_date: "2026-11-15" } },
          { method: "cheque_tercero", amount: 200, cheque_id: ctx.cheque },
        ],
        withholdings: [{ kind: "iibb", certificate: "C-1", amount: 50 }],
        allocations: [
          { invoice_id: ctx.inv1, amount: 1000 },
          { invoice_id: ctx.inv2, amount: 150 },
        ],
      },
    };
    const denied = await rpc(ctx.cashier, "supplier_payment_order_create", args);
    expect(denied.error?.message).toMatch(/forbidden/);

    const over = await rpc(ctx.owner, "supplier_payment_order_create", {
      p: { supplier_id: ctx.supplier, lines: [{ method: "otro", amount: 100 }], allocations: [{ invoice_id: ctx.inv2, amount: 600 }] },
    });
    expect(over.error?.message).toMatch(/allocation_exceeds/);

    const ok = await rpc(ctx.owner, "supplier_payment_order_create", args);
    expect(ok.error).toBeNull();
    ctx.op = ok.data as string;

    const pay = await one<{ amount: number; method: string; kind: string }>(
      ctx.owner.from("supplier_payments").select("amount, method, kind").eq("id", ctx.op).single(),
    );
    expect(Number(pay.amount)).toBe(1200);
    expect(pay.method).toBe("mixto");
    expect(pay.kind).toBe("order");

    const open = await one<Array<{ invoice_id: string; open_ars: number }>>(
      ctx.owner.from("supplier_invoice_open").select("invoice_id, open_ars").eq("supplier_id", ctx.supplier),
    );
    const byInv = new Map(open.map((o) => [o.invoice_id, Number(o.open_ars)]));
    expect(byInv.get(ctx.inv1)).toBe(0);
    expect(byInv.get(ctx.inv2)).toBe(350);

    const bal = await one<{ balance: number }>(
      ctx.owner.from("treasury_balances").select("balance").eq("account_id", ctx.bank).single(),
    );
    expect(Number(bal.balance)).toBe(4600);

    const cash = await one<Array<{ type: string; amount: number }>>(
      ctx.owner.from("cash_movements").select("type, amount").eq("reference_id", ctx.op),
    );
    expect(cash.map((c) => [c.type, Number(c.amount)])).toEqual([["expense", 300]]);

    const ch = await one<{ status: string }>(ctx.owner.from("cheques").select("status").eq("id", ctx.cheque).single());
    expect(ch.status).toBe("entregado");

    const lines = await ctx.ownerS.from("supplier_payment_lines").select("id").eq("payment_id", ctx.op);
    expect(lines.data ?? []).toHaveLength(0);

    expect((await rpc(ctx.owner, "supplier_payment_void", { p_id: ctx.op, p_reason: "Error" })).error).toBeNull();
    const after = await one<{ open_ars: number }>(
      ctx.owner.from("supplier_invoice_open").select("open_ars").eq("invoice_id", ctx.inv1).single(),
    );
    expect(Number(after.open_ars)).toBe(1000);
    const bal2 = await one<{ balance: number }>(
      ctx.owner.from("treasury_balances").select("balance").eq("account_id", ctx.bank).single(),
    );
    expect(Number(bal2.balance)).toBe(5000);
    const ch2 = await one<{ status: string }>(ctx.owner.from("cheques").select("status").eq("id", ctx.cheque).single());
    expect(ch2.status).toBe("en_cartera");
    const own = await one<Array<{ status: string }>>(
      ctx.owner.from("cheques").select("status").eq("kind", "own").eq("payment_id", ctx.op),
    );
    expect(own.map((c) => c.status)).toEqual(["anulado"]);
  });

  it("cheques: depositar suma, rechazar revierte y las transiciones de la OP no se hacen a mano", async () => {
    const manual = await rpc(ctx.owner, "cheque_transition", { p_id: ctx.cheque, p_to: "entregado", p: {} });
    expect(manual.error?.message).toMatch(/cheque_transition_via_payment/);
    expect(
      (await rpc(ctx.owner, "cheque_transition", { p_id: ctx.cheque, p_to: "depositado", p: { account_id: ctx.bank } })).error,
    ).toBeNull();
    const bal = await one<{ balance: number }>(
      ctx.owner.from("treasury_balances").select("balance").eq("account_id", ctx.bank).single(),
    );
    expect(Number(bal.balance)).toBe(5200);
    expect(
      (await rpc(ctx.owner, "cheque_transition", { p_id: ctx.cheque, p_to: "rechazado", p: { reason: "Sin fondos" } })).error,
    ).toBeNull();
    const bal2 = await one<{ balance: number }>(
      ctx.owner.from("treasury_balances").select("balance").eq("account_id", ctx.bank).single(),
    );
    expect(Number(bal2.balance)).toBe(5000);
  });

  it("lista de precios del proveedor: costo de lista y de reposición", async () => {
    const r = await rpc(ctx.owner, "supplier_price_list_apply", {
      p_supplier_id: ctx.supplier,
      p_rows: [{ product_id: ctx.rice, list_cost: 1200, units_per_purchase: 4, supplier_sku: "ARZ-4" }],
      p_options: { update_replacement: true, link_new: true, mapping: { cost: 1, supplier_sku: 0 } },
    });
    expect(r.error).toBeNull();
    const p = await one<{ replacement_cost: number }>(
      ctx.admin.from("products").select("replacement_cost").eq("id", ctx.rice).single(),
    );
    expect(Number(p.replacement_cost)).toBe(300);
    const denied = await rpc(ctx.cashier, "supplier_price_list_apply", { p_supplier_id: ctx.supplier, p_rows: [], p_options: {} });
    expect(denied.error?.message).toMatch(/forbidden/);
  });

  it("ADR-052: las policies nuevas no abren el acceso a todo el staff interno", async () => {
    const r = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    if (r.error) return;
    const tables = new Set([
      "lot_allocations",
      "purchase_returns",
      "purchase_return_items",
      "treasury_accounts",
      "treasury_movements",
      "cheques",
      "supplier_payment_lines",
      "supplier_payment_allocations",
      "supplier_price_list_imports",
    ]);
    const leaks = ((r.data ?? []) as Array<{ tablename: string }>).filter((x) => tables.has(x.tablename));
    expect(leaks).toEqual([]);
  });
});
