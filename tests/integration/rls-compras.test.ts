// @vitest-environment node
// =============================================================================
// F18 · H101 + H102: compras, proveedores, costos e importaciones (ADR-050).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio C con la feature compras (addon otorgado) y una sucursal;
// negocio S sin compras. Dueño y cajero en C, dueño en S.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `compras-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
// CUIT con dígito verificador válido (20-12345678-6).
const CUIT_OK = "20123456786";

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
  product: string;
  supplier: string;
  order: string;
  receipt: string;
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

describe.skipIf(!enabled)("F18 · compras, proveedores y costos", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `Compras ${STAMP}`, slug: `c-${STAMP}`, status: "active" },
        { name: `Sin compras ${STAMP}`, slug: `s-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantC = tenants[0]!.id;
    ctx.tenantS = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert({
      tenant_id: ctx.tenantC,
      addon_key: "compras",
      status: "active",
      source: "granted",
    });
    if (addonErr) throw addonErr;

    const stores = await one<Array<{ id: string; tenant_id: string }>>(
      admin
        .from("stores")
        .insert([
          { tenant_id: ctx.tenantC, name: "Central" },
          { tenant_id: ctx.tenantS, name: "Única" },
        ] as never)
        .select("id, tenant_id"),
    );
    ctx.store = stores.find((s) => s.tenant_id === ctx.tenantC)!.id;
    ctx.storeS = stores.find((s) => s.tenant_id === ctx.tenantS)!.id;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantC, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantC, "cashier");
    const ownerS = await makeUser(admin, `owner-s-${STAMP}@test.local`, ctx.tenantS, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.ownerS = ownerS.client;
    ctx.userIds.push(owner.id, cashier.id, ownerS.id);

    // Producto con 10 u en stock a costo 100 (último y promedio parten de ahí).
    const prod = await one<{ id: string }>(
      admin
        .from("products")
        .insert({ tenant_id: ctx.tenantC, name: `Yerba ${STAMP}`, price: 300, cost: 100, stock: 10 } as never)
        .select("id")
        .single(),
    );
    ctx.product = prod.id;
    await admin.from("products").update({ last_cost: 100, avg_cost: 100 } as never).eq("id", ctx.product);
  }, 90_000);

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

  it("sin la feature compras el servidor rechaza proveedores y órdenes", async () => {
    const { error } = await ctx.ownerS.from("suppliers").insert({ name: "Pirata" } as never);
    expect(error).not.toBeNull();
    const r = await rpc(ctx.ownerS, "purchase_order_save", {
      p_id: null,
      p_supplier_id: ctx.tenantS,
      p_store_id: ctx.storeS,
      p_expected_date: null,
      p_currency: "ARS",
      p_fx_rate: 1,
      p_discount_pct: 0,
      p_payment_terms_days: null,
      p_notes: null,
      p_items: [],
    });
    expect(r.error?.message).toMatch(/feature_not_in_plan: compras/);
  });

  it("proveedor: CUIT validado, cajero sin permiso y alta del dueño", async () => {
    const bad = await ctx.owner.from("suppliers").insert({ name: "Mal CUIT", cuit: "20123456789" } as never);
    expect(bad.error).not.toBeNull();

    const cashierTry = await ctx.cashier.from("suppliers").insert({ name: "Del cajero" } as never);
    expect(cashierTry.error).not.toBeNull();

    const s = await one<{ id: string; cuit: string; tenant_id: string }>(
      ctx.owner
        .from("suppliers")
        .insert({ name: "Distribuidora Norte", cuit: "20-12345678-6", payment_terms_days: 30 } as never)
        .select("id, cuit, tenant_id")
        .single(),
    );
    expect(s.cuit).toBe(CUIT_OK);
    expect(s.tenant_id).toBe(ctx.tenantC);
    ctx.supplier = s.id;

    const dup = await ctx.owner.from("suppliers").insert({ name: "Duplicado", cuit: CUIT_OK } as never);
    expect(dup.error).not.toBeNull();
  });

  it("aislamiento: otro negocio no ve los proveedores", async () => {
    const { data } = await ctx.ownerS.from("suppliers").select("id").eq("id", ctx.supplier);
    expect(data ?? []).toHaveLength(0);
    const { data: own } = await ctx.cashier.from("suppliers").select("id").eq("id", ctx.supplier);
    expect(own ?? []).toHaveLength(1);
  });

  it("OC: borrador con descuentos en cascada, enviar y recibir en parte", async () => {
    const save = await rpc(ctx.owner, "purchase_order_save", {
      p_id: null,
      p_supplier_id: ctx.supplier,
      p_store_id: ctx.store,
      p_expected_date: null,
      p_currency: "ARS",
      p_fx_rate: 1,
      p_discount_pct: 0,
      p_payment_terms_days: 30,
      p_notes: null,
      p_items: [{ product_id: ctx.product, qty: 10, unit_cost: 200, discounts: [10, 5], tax_rate: 21 }],
    });
    expect(save.error).toBeNull();
    ctx.order = save.data as string;

    const o = await one<{ subtotal: number; status: string; number: number }>(
      ctx.owner.from("purchase_orders").select("subtotal, status, number").eq("id", ctx.order).single(),
    );
    expect(Number(o.subtotal)).toBe(1710); // 10 × 200 × 0,9 × 0,95
    expect(o.status).toBe("draft");

    // El cajero no envía.
    const cs = await rpc(ctx.cashier, "purchase_order_send", { p_id: ctx.order });
    expect(cs.error).not.toBeNull();
    expect((await rpc(ctx.owner, "purchase_order_send", { p_id: ctx.order })).error).toBeNull();

    const items = await one<Array<{ id: string }>>(
      ctx.owner.from("purchase_order_items").select("id").eq("order_id", ctx.order),
    );
    // Recibe el cajero (permitido por defecto): 6 de 10 al costo neto 171.
    const rec = await rpc(ctx.cashier, "purchase_receive", {
      p_order_id: ctx.order,
      p_store_id: null,
      p_supplier_id: null,
      p_received_date: null,
      p_remito_number: "0001-00000123",
      p_currency: null,
      p_fx_rate: null,
      p_items: [{ order_item_id: items[0]!.id, qty: 6 }],
      p_close: false,
      p_notes: null,
    });
    expect(rec.error).toBeNull();
    ctx.receipt = rec.data as string;

    const after = await one<{ status: string; units_received: number }>(
      ctx.owner.from("purchase_orders").select("status, units_received").eq("id", ctx.order).single(),
    );
    expect(after.status).toBe("partially_received");
    expect(Number(after.units_received)).toBe(6);
  });

  it("recepción: stock por sucursal, movimiento 'purchase' y costos", async () => {
    const p = await one<{ stock: number; last_cost: number; avg_cost: number; cost: number }>(
      ctx.admin.from("products").select("stock, last_cost, avg_cost, cost").eq("id", ctx.product).single(),
    );
    expect(Number(p.stock)).toBe(16);
    expect(Number(p.last_cost)).toBe(171);
    // (10 × 100 + 6 × 171) / 16 = 126,625
    expect(Number(p.avg_cost)).toBe(126.625);
    // Base por defecto: último costo, sincronizado al costo del producto.
    expect(Number(p.cost)).toBe(171);

    const ps = await one<Array<{ qty: number }>>(
      ctx.admin.from("product_stock").select("qty").eq("product_id", ctx.product).eq("store_id", ctx.store),
    );
    expect(Number(ps[0]?.qty)).toBe(16);

    const mv = await one<Array<{ delta: number; store_id: string }>>(
      ctx.admin
        .from("stock_movements")
        .select("delta, store_id")
        .eq("reference_id", ctx.receipt)
        .eq("reason", "purchase"),
    );
    expect(mv).toHaveLength(1);
    expect(mv[0]!.store_id).toBe(ctx.store);
    expect(Number(mv[0]!.delta)).toBe(6);

    const sp = await one<Array<{ last_cost: number }>>(
      ctx.owner.from("supplier_products").select("last_cost").eq("supplier_id", ctx.supplier),
    );
    expect(Number(sp[0]?.last_cost)).toBe(171);

    const hist = await one<Array<{ kind: string }>>(
      ctx.owner.from("product_cost_history").select("kind").eq("product_id", ctx.product),
    );
    expect(hist.map((h) => h.kind)).toEqual(expect.arrayContaining(["last", "average", "cost"]));
  });

  it("cerrar con faltante y no cancelar lo ya recibido", async () => {
    const cancel = await rpc(ctx.owner, "purchase_order_cancel", { p_id: ctx.order, p_reason: "x" });
    expect(cancel.error?.message).toMatch(/invalid_transition/);
    expect((await rpc(ctx.owner, "purchase_order_close", { p_id: ctx.order, p_reason: "No hay más" })).error).toBeNull();
    const o = await one<{ status: string }>(
      ctx.owner.from("purchase_orders").select("status").eq("id", ctx.order).single(),
    );
    expect(o.status).toBe("received");
  });

  it("factura con percepción, pago y saldo en la cuenta corriente", async () => {
    const inv = await rpc(ctx.owner, "supplier_invoice_save", {
      p_id: null,
      p: {
        supplier_id: ctx.supplier,
        kind: "invoice",
        letter: "A",
        point_of_sale: 1,
        number: 123,
        issue_date: "2026-10-01",
        vat_lines: [{ rate: 21, net: 1026, vat: 215.46 }],
        other_taxes: [{ kind: "percepcion_iibb", jurisdiction: "Buenos Aires", amount: 30 }],
        total: 1271.46,
      },
      p_receipt_ids: [ctx.receipt],
    });
    expect(inv.error).toBeNull();

    const dup = await rpc(ctx.owner, "supplier_invoice_save", {
      p_id: null,
      p: {
        supplier_id: ctx.supplier,
        kind: "invoice",
        letter: "A",
        point_of_sale: 1,
        number: 123,
        issue_date: "2026-10-01",
        vat_lines: [{ rate: 21, net: 100, vat: 21 }],
        total: 121,
      },
    });
    expect(dup.error?.message).toMatch(/invoice_duplicated/);

    const badC = await rpc(ctx.owner, "supplier_invoice_save", {
      p_id: null,
      p: {
        supplier_id: ctx.supplier,
        kind: "invoice",
        letter: "C",
        point_of_sale: 2,
        number: 1,
        issue_date: "2026-10-01",
        vat_lines: [{ rate: 21, net: 100, vat: 21 }],
        total: 121,
      },
    });
    expect(badC.error?.message).toMatch(/vat_not_discriminated/);

    const pay = await rpc(ctx.owner, "supplier_payment_create", {
      p: {
        supplier_id: ctx.supplier,
        method: "transferencia",
        net_paid: 1000,
        withholdings: [{ kind: "ganancias", amount: 71.46 }],
      },
    });
    expect(pay.error).toBeNull();

    const bal = await one<Array<{ balance_ars: number }>>(
      ctx.owner.from("supplier_balances").select("balance_ars").eq("supplier_id", ctx.supplier),
    );
    expect(Number(bal[0]?.balance_ars)).toBe(200);

    const linked = await one<{ invoice_id: string | null }>(
      ctx.owner.from("goods_receipts").select("invoice_id").eq("id", ctx.receipt).single(),
    );
    expect(linked.invoice_id).toBe(inv.data);

    // Otro negocio no ve ni la cuenta corriente.
    const other = await ctx.ownerS.from("supplier_account_entries").select("doc_id").eq("supplier_id", ctx.supplier);
    expect(other.data ?? []).toHaveLength(0);
  });

  it("costeo de importación exige compras_importacion y ajusta el promedio", async () => {
    const items = await one<Array<{ id: string }>>(
      ctx.owner.from("goods_receipt_items").select("id").eq("receipt_id", ctx.receipt),
    );
    const args = {
      p_receipt_id: ctx.receipt,
      p_costing: { sheet: "test" },
      p_items: [{ item_id: items[0]!.id, landed_unit_cost: 211 }],
      p_dispatch_number: "24001IC04123456K",
    };
    const denied = await rpc(ctx.owner, "purchase_apply_costing", args);
    expect(denied.error?.message).toMatch(/feature_not_in_plan: compras_importacion/);

    await ctx.admin.from("subscription_addons").insert({
      tenant_id: ctx.tenantC,
      addon_key: "compras_importacion",
      status: "active",
      source: "granted",
    });
    const ok = await rpc(ctx.owner, "purchase_apply_costing", args);
    expect(ok.error).toBeNull();

    const p = await one<{ avg_cost: number; last_cost: number }>(
      ctx.admin.from("products").select("avg_cost, last_cost").eq("id", ctx.product).single(),
    );
    // +40 × 6 u = 240 repartidos en 16 u de stock: 126,625 + 15 = 141,625
    expect(Number(p.avg_cost)).toBe(141.625);
    expect(Number(p.last_cost)).toBe(211);

    const lots = await one<Array<{ dispatch_number: string }>>(
      ctx.owner.from("product_lots").select("dispatch_number").eq("product_id", ctx.product),
    );
    expect(lots[0]?.dispatch_number).toBe("24001IC04123456K");
  });

  it("ADR-052: las policies nuevas no abren el acceso a todo el staff interno", async () => {
    const r = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    if (r.error) return; // la función llega con fix/sucursales-tenant
    const tables = new Set([
      "suppliers",
      "supplier_products",
      "product_cost_history",
      "purchase_settings",
      "purchase_orders",
      "purchase_order_items",
      "purchase_events",
      "goods_receipts",
      "goods_receipt_items",
      "product_lots",
      "supplier_invoices",
      "supplier_payments",
    ]);
    const leaks = ((r.data ?? []) as Array<{ tablename: string }>).filter((x) => tables.has(x.tablename));
    expect(leaks).toEqual([]);
  });
});
