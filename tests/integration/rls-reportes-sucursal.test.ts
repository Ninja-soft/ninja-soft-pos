// @vitest-environment node
// =============================================================================
// F17 · H97 (primer corte) y H94: reportes y merma por sucursal (ADR-049).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio con Centro y Norte (multi_sucursal + multi_caja +
// stock_sucursales por addon), una caja y un turno en cada una, una venta en
// cada sucursal y un cajero con base en Norte.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `rep-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  cashierId: string;
  userIds: string[];
  product: string;
  centro: string;
  norte: string;
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

const FROM = new Date(Date.now() - 86_400_000).toISOString();
const TO = new Date(Date.now() + 86_400_000).toISOString();

describe.skipIf(!enabled)("F17 · reportes y merma por sucursal", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Rep ${STAMP}`, slug: `r-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_sucursal", "multi_caja", "stock_sucursales"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.cashierId = cashier.id;
    ctx.userIds.push(owner.id, cashier.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    // Sucursales y cajas (como el dueño, para pasar por los triggers reales).
    const { data: c, error: e1 } = await owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (e1 || !c) throw e1 ?? new Error("centro");
    ctx.centro = (c as unknown as { id: string }).id;
    const { data: n, error: e2 } = await owner.client
      .from("stores")
      .insert({ name: "Norte" } as never)
      .select("id")
      .single();
    if (e2 || !n) throw e2 ?? new Error("norte");
    ctx.norte = (n as unknown as { id: string }).id;

    const { data: regs, error: e3 } = await owner.client
      .from("cash_registers")
      .insert([
        { store_id: ctx.centro, name: "Caja 1" },
        { store_id: ctx.norte, name: "Caja 1" },
      ] as never)
      .select("id, store_id");
    if (e3 || !regs) throw e3 ?? new Error("cajas");
    const list = regs as unknown as { id: string; store_id: string }[];
    const cajaCentro = list.find((r) => r.store_id === ctx.centro)!.id;
    const cajaNorte = list.find((r) => r.store_id === ctx.norte)!.id;

    // ADR-051 (H114): un turno abierto por usuario. El dueño vende en Centro,
    // cierra y vende en Norte.
    const a = await rpc(owner.client, "open_cash_shift", { p_register_id: cajaCentro, p_opening_amount: 0 });
    if (a.error) throw new Error(a.error.message);

    const item = (price: number) => [{ product_id: ctx.product, quantity: 1, unit_price: price, discount: 0 }];
    const sC = await rpc(owner.client, "create_sale", {
      p_items: item(100),
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: a.data,
    });
    if (sC.error) throw new Error(sC.error.message);
    const closeC = await rpc(owner.client, "close_cash_shift", { p_shift_id: a.data, p_closing_amount: 100 });
    if (closeC.error) throw new Error(closeC.error.message);
    const b = await rpc(owner.client, "open_cash_shift", { p_register_id: cajaNorte, p_opening_amount: 0 });
    if (b.error) throw new Error(b.error.message);
    const sN = await rpc(owner.client, "create_sale", {
      // ADR-056: el producto vale 100; el dueño (supervisor) lo vende a 40 con motivo.
      p_items: [{ ...item(40)[0], price_override: true, override_reason: "Precio de prueba" }],
      p_payments: [{ method: "cash", amount: 40 }],
      p_cash_shift_id: b.data,
    });
    if (sN.error) throw new Error(sN.error.message);

    const sched = await rpc(owner.client, "staff_branch_schedule", {
      p_store_id: ctx.norte,
      p_kind: "home",
      p_user_id: ctx.cashierId,
      p_reason: "Base Norte",
    });
    if (sched.error) throw new Error(sched.error.message);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("staff_branch_assignments").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño ve el consolidado y puede filtrar por sucursal", async () => {
    const all = await rpc(ctx.owner, "sales_report", { p_from: FROM, p_to: TO });
    expect(all.error).toBeNull();
    expect(Number((all.data as { total: number }).total)).toBe(140);

    const norte = await rpc(ctx.owner, "sales_report", { p_from: FROM, p_to: TO, p_store_id: ctx.norte });
    expect(norte.error).toBeNull();
    expect(Number((norte.data as { total: number }).total)).toBe(40);
    expect((norte.data as { count: number }).count).toBe(1);
  });

  it("la firma vieja (sin sucursal) sigue funcionando en todos los reportes", async () => {
    for (const fn of [
      "staff_productivity",
      "gastro_tables_report",
      "gastro_kitchen_report",
      "gastro_delivery_report",
      "gastro_top_items_report",
    ]) {
      const r = await rpc(ctx.owner, fn, { p_from: FROM, p_to: TO });
      expect(r.error, fn).toBeNull();
      const f = await rpc(ctx.owner, fn, { p_from: FROM, p_to: TO, p_store_id: ctx.centro });
      expect(f.error, fn).toBeNull();
    }
  });

  it("un cajero de Norte sin filtro sólo ve Norte (no el total del negocio)", async () => {
    const r = await rpc(ctx.cashier, "sales_report", { p_from: FROM, p_to: TO });
    expect(r.error).toBeNull();
    expect(Number((r.data as { total: number }).total)).toBe(40);
  });

  it("un cajero de Norte no puede pedir el reporte de Centro", async () => {
    const r = await rpc(ctx.cashier, "sales_report", { p_from: FROM, p_to: TO, p_store_id: ctx.centro });
    expect(r.error?.message).toMatch(/forbidden/);
    const g = await rpc(ctx.cashier, "gastro_tables_report", { p_from: FROM, p_to: TO, p_store_id: ctx.centro });
    expect(g.error?.message).toMatch(/forbidden/);
  });

  // TX-5 · ADR-100: filtros guardables por medio de pago y categoría.
  it("filtra por medio de pago y por categoría sin romper el alcance por sucursal", async () => {
    const cash = await rpc(ctx.owner, "sales_report", { p_from: FROM, p_to: TO, p_method: "cash" });
    expect(cash.error).toBeNull();
    expect(Number((cash.data as { total: number }).total)).toBe(140);

    const debit = await rpc(ctx.owner, "sales_report", { p_from: FROM, p_to: TO, p_method: "debit" });
    expect(debit.error).toBeNull();
    expect((debit.data as { count: number }).count).toBe(0);
    expect((debit.data as { by_method: unknown[] }).by_method).toEqual([]);

    const { data: cat, error: cErr } = await ctx.admin
      .from("categories")
      .insert({ tenant_id: ctx.tenant, name: `Cat ${STAMP}` })
      .select("id")
      .single();
    if (cErr || !cat) throw cErr ?? new Error("categoría");
    const otherCat = await rpc(ctx.owner, "sales_report", { p_from: FROM, p_to: TO, p_category_id: cat.id });
    expect((otherCat.data as { count: number }).count).toBe(0);

    await ctx.admin.from("products").update({ category_id: cat.id }).eq("id", ctx.product);
    const byCat = await rpc(ctx.owner, "sales_report", { p_from: FROM, p_to: TO, p_category_id: cat.id });
    expect(byCat.error).toBeNull();
    expect(Number((byCat.data as { total: number }).total)).toBe(140);
    expect((byCat.data as { by_category: { category: string }[] }).by_category.map((r) => r.category)).toEqual([
      `Cat ${STAMP}`,
    ]);

    // El cajero de Norte sigue viendo sólo Norte aunque filtre.
    const mine = await rpc(ctx.cashier, "sales_report", { p_from: FROM, p_to: TO, p_method: "cash", p_category_id: cat.id });
    expect(mine.error).toBeNull();
    expect(Number((mine.data as { total: number }).total)).toBe(40);
  });

  it("una sucursal de otro negocio da forbidden", async () => {
    const r = await rpc(ctx.owner, "sales_report", {
      p_from: FROM,
      p_to: TO,
      p_store_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("merma por sucursal: el movimiento queda en la sucursal elegida", async () => {
    const r = await rpc(ctx.owner, "register_stock_waste", {
      p_product_id: ctx.product,
      p_qty: 1,
      p_loss_reason: "roto",
      p_store_id: ctx.norte,
    });
    expect(r.error).toBeNull();
    const { data: mov } = await ctx.admin
      .from("stock_movements")
      .select("store_id, reason")
      .eq("product_id", ctx.product)
      .eq("reason", "loss")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(mov?.store_id).toBe(ctx.norte);

    // Sin sucursal sigue como antes (la principal).
    const old = await rpc(ctx.owner, "register_stock_waste", {
      p_product_id: ctx.product,
      p_qty: 1,
      p_loss_reason: "vencido",
    });
    expect(old.error).toBeNull();
  });

  it("merma: un cajero no puede descontar en una sucursal que no ve", async () => {
    const r = await rpc(ctx.cashier, "register_stock_waste", {
      p_product_id: ctx.product,
      p_qty: 1,
      p_loss_reason: "roto",
      p_store_id: ctx.centro,
    });
    expect(r.error?.message).toMatch(/forbidden/);
  });
});
