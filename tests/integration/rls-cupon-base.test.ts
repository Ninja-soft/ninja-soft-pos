// @vitest-environment node
// =============================================================================
// PRD-62 (ADR-192) · El cupón se calcula sobre la misma base que el POS.
//
// create_sale (20270129100000_prd62_coupon_base.sql) calcula el porcentaje,
// el mínimo de compra y el tope del cupón sobre el subtotal del carrito, sin
// las líneas sin producto que suma la hoja de cobro (recargo del medio de pago
// o de las cuotas y garantía extendida, anunciadas en p_extras). El POS
// (usePosPricing) hace lo mismo y cobra recargo y garantía enteros: el total
// grabado tiene que ser igual a lo que cobró el POS.
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

const STAMP = `prd62-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  cashier: User;
  userIds: string[];
  shift: string;
  gaseosa: string;
  chicle: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

type SaleRes = { sale_id: string; total: number; coupon_discount: number };
const res = (r: RpcRes) => r.data as SaleRes;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string): Promise<User> {
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

const item = (productId: string, quantity: number, unitPrice: number) => ({
  product_id: productId,
  quantity,
  unit_price: unitPrice,
  discount: 0,
});
/** Línea sin producto que agrega la hoja de cobro (buildSaleItemsAndExtras). */
const sheetLine = (name: string, amount: number) => ({ product_id: null, name, quantity: 1, unit_price: amount, discount: 0 });

const sell = (args: Record<string, unknown>) =>
  rpc(ctx.cashier.client, "create_sale", { p_cash_shift_id: ctx.shift, p_promo_discount: 0, ...args });

async function addCoupon(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await ctx.admin
    .from("coupons")
    .insert({ tenant_id: ctx.tenant, ...row } as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("coupon");
  return (data as { id: string }).id;
}

describe.skipIf(!enabled)("PRD-62 · base del cupón en create_sale", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const t = await admin
      .from("tenants")
      .insert({ name: `PRD62 ${STAMP}`, slug: `p-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;

    const { error: aErr } = await admin.from("subscription_addons").insert(
      ["promociones", "descuentos", "garantias"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (aErr) throw aErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.userIds.push(owner.id, ctx.cashier.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    const store = (st.data as { id: string }).id;

    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Gaseosa ${STAMP}`, price: 1000, stock: 0, track_stock: false },
        { tenant_id: ctx.tenant, name: `Chicle ${STAMP}`, price: 50, stock: 0, track_stock: false },
      ] as never)
      .select("id, name");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    const byName = (p: string) => (prods.data as { id: string; name: string }[]).find((x) => x.name.startsWith(p))!.id;
    ctx.gaseosa = byName("Gaseosa");
    ctx.chicle = byName("Chicle");

    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", {
      p_register_id: (reg.data as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
    // sus auditorías, queda (datos de prueba con sello único).
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("cupón 10 % con recargo de cuotas: 10 % del carrito, recargo entero y total = lo que cobra el POS", async () => {
    const coupon = await addCoupon({ code: `REC-${STAMP}`, discount_type: "percent", discount_value: 10 });
    // POS: carrito 1000 − cupón 100 (10 % de 1000) + recargo 100 = 1000.
    const posCharge = 1000 - 100 + 100;
    const r = await sell({
      p_items: [item(ctx.gaseosa, 1, 1000), sheetLine("Recargo 3 cuotas", 100)],
      p_extras: [{ kind: "surcharge", amount: 100 }],
      p_payments: [{ method: "cash", amount: posCharge }],
      p_coupon_id: coupon,
    });
    expect(r.error).toBeNull();
    expect(Number(res(r).coupon_discount)).toBe(100);
    expect(Number(res(r).total)).toBe(1000);
    expect(posCharge).toBeGreaterThanOrEqual(Number(res(r).total));

    const row = await ctx.admin.from("sales").select("total, coupon_discount").eq("id", res(r).sale_id).single();
    expect(row.error).toBeNull();
    const s = row.data as { total: number; coupon_discount: number };
    expect([Number(s.total), Number(s.coupon_discount)]).toEqual([1000, 100]);
  });

  it("cupón 10 % con recargo y garantía extendida: ninguno de los dos entra en la base", async () => {
    const coupon = await addCoupon({ code: `GAR-${STAMP}`, discount_type: "percent", discount_value: 10 });
    // POS: 2000 − 200 + recargo 150 + garantía 300 = 2250.
    const r = await sell({
      p_items: [item(ctx.gaseosa, 2, 1000), sheetLine("Garantía extendida", 300), sheetLine("Recargo 6 cuotas", 150)],
      p_extras: [
        { kind: "warranty", amount: 300 },
        { kind: "surcharge", amount: 150 },
      ],
      p_payments: [{ method: "cash", amount: 2250 }],
      p_coupon_id: coupon,
    });
    expect(r.error).toBeNull();
    expect([Number(res(r).coupon_discount), Number(res(r).total)]).toEqual([200, 2250]);
  });

  it("cupón de monto: el tope es el carrito, no el carrito más el recargo", async () => {
    const coupon = await addCoupon({ code: `MONTO-${STAMP}`, discount_type: "amount", discount_value: 100 });
    // POS: min(100, carrito 50) = 50 → 50 − 50 + 100 = 100.
    const r = await sell({
      p_items: [item(ctx.chicle, 1, 50), sheetLine("Recargo tarjeta", 100)],
      p_extras: [{ kind: "surcharge", amount: 100 }],
      p_payments: [{ method: "cash", amount: 100 }],
      p_coupon_id: coupon,
    });
    expect(r.error).toBeNull();
    expect([Number(res(r).coupon_discount), Number(res(r).total)]).toEqual([50, 100]);
  });

  it("el mínimo de compra del cupón mira el carrito: el recargo no lo habilita", async () => {
    const coupon = await addCoupon({ code: `MIN-${STAMP}`, discount_type: "percent", discount_value: 10, min_amount: 1050 });
    const r = await sell({
      p_items: [item(ctx.gaseosa, 1, 1000), sheetLine("Recargo 3 cuotas", 100)],
      p_extras: [{ kind: "surcharge", amount: 100 }],
      p_payments: [{ method: "cash", amount: 1100 }],
      p_coupon_id: coupon,
    });
    expect(r.error?.message).toMatch(/coupon_min_amount/);
  });
});
