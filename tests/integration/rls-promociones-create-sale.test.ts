// @vitest-environment node
// =============================================================================
// PRD-02 · Motor de promociones contra la create_sale VIGENTE (hoy la de
// 20270123100000_sec43_create_sale_idempotency.sql, SEC-43 / ADR-187), en los
// caminos que se sumaron después de ADR-074:
//   · precio libre (ADR-151): el motor ve el precio tipeado;
//   · seña de turno (ADR-088): la seña es un pago más y cubre hasta el total
//     ya descontada la promo;
//   · venta que entrega una reserva (ADR-096): la reserva se valida antes y la
//     promo/regalo no la rompen;
//   · cupón con tope (F9 · H54): excluye las promos de descuento, consume el
//     tope y, agotado, la venta vuelve a llevar la promo.
// La matriz del motor (promotion_preview) la corre tests/integration/rls-promociones.test.ts
// con tests/fixtures/promoMatrix.ts (incluye los casos nuevos de PRD-02).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Cada escenario usa su propio producto y promos acotadas a ese producto, así
// no se pisan entre sí.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `prd02-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: User;
  cashier: User;
  userIds: string[];
  store: string;
  shift: string;
  libre: string;
  corte: string;
  campera: string;
  llavero: string;
  gaseosa: string;
  customer: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

type SaleRes = {
  sale_id: string;
  total: number;
  promo_discount: number;
  coupon_discount: number;
  deposit_applied: number;
  promotions: { label: string; kind: string; discount: number }[];
};
const res = (r: RpcRes) => r.data as SaleRes;
/** Lo esperado por el servidor en promo_mismatch / deposit_mismatch (JSON tras el prefijo). */
const expectedOf = (r: RpcRes): number => {
  const m = r.error?.message ?? "";
  const i = m.indexOf("{");
  return i < 0 ? Number.NaN : Number((JSON.parse(m.slice(i)) as { expected: unknown }).expected);
};

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

const sell = (args: Record<string, unknown>) =>
  rpc(ctx.cashier.client, "create_sale", { p_cash_shift_id: ctx.shift, ...args });

async function addPromo(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await ctx.owner.client
    .from("promotions")
    .insert({ tenant_id: ctx.tenant, scope: "product", ...row } as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("promo");
  return (data as { id: string }).id;
}

async function addCoupon(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await ctx.admin
    .from("coupons")
    .insert({ tenant_id: ctx.tenant, ...row } as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("coupon");
  return (data as { id: string }).id;
}

describe.skipIf(!enabled)("PRD-02 · promociones en la create_sale vigente", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const t = await admin
      .from("tenants")
      .insert({ name: `PRD02 ${STAMP}`, slug: `p-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;

    const { error: aErr } = await admin.from("subscription_addons").insert(
      ["promociones", "descuentos", "precio_libre", "agenda_senas", "reservas_stock"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id);

    const st = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as { id: string }).id;

    // Insert multi-fila: todas las claves en cada fila.
    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Libre ${STAMP}`, price: 1000, stock: 0, track_stock: false, price_mode: "open", open_price_min: 500, open_price_max: 5000 },
        { tenant_id: ctx.tenant, name: `Corte ${STAMP}`, price: 4000, stock: 0, track_stock: false, price_mode: "fixed", open_price_min: null, open_price_max: null },
        { tenant_id: ctx.tenant, name: `Campera ${STAMP}`, price: 100, stock: 10, track_stock: true, price_mode: "fixed", open_price_min: null, open_price_max: null },
        { tenant_id: ctx.tenant, name: `Llavero ${STAMP}`, price: 300, stock: 0, track_stock: false, price_mode: "fixed", open_price_min: null, open_price_max: null },
        { tenant_id: ctx.tenant, name: `Gaseosa ${STAMP}`, price: 1000, stock: 0, track_stock: false, price_mode: "fixed", open_price_min: null, open_price_max: null },
      ] as never)
      .select("id, name");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    const byName = (p: string) => (prods.data as { id: string; name: string }[]).find((x) => x.name.startsWith(p))!.id;
    ctx.libre = byName("Libre");
    ctx.corte = byName("Corte");
    ctx.campera = byName("Campera");
    ctx.llavero = byName("Llavero");
    ctx.gaseosa = byName("Gaseosa");

    const cust = await ctx.owner.client
      .from("customers")
      .insert({ tenant_id: ctx.tenant, name: `Cliente ${STAMP}` } as never)
      .select("id")
      .single();
    if (cust.error || !cust.data) throw cust.error ?? new Error("customer");
    ctx.customer = (cust.data as { id: string }).id;

    const reg = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    // El cajero abre SU turno y vende en él.
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
    await admin.from("stock_reservations" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("appointment_deposits" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
    // sus auditorías, queda (datos de prueba con sello único).
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── Precio libre (ADR-151) ──────────────────────────────────────────────────
  it("precio libre: la promo se calcula sobre el precio tipeado, no sobre el de lista", async () => {
    await addPromo({ name: `10% libre ${STAMP}`, scope_ids: [ctx.libre], action_type: "percent", action_value: 10 });
    const items = [item(ctx.libre, 1, 1234.56)];

    // El 10% del precio de lista (1000) no es lo que calcula el servidor.
    const byList = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 1134.56 }], p_promo_discount: 100 });
    expect(byList.error?.message).toMatch(/promo_mismatch/);
    expect(expectedOf(byList)).toBe(123.46);

    const ok = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 1111.1 }], p_promo_discount: 123.46 });
    expect(ok.error).toBeNull();
    expect(Number(res(ok).total)).toBe(1111.1);
    expect(res(ok).promotions.map((p) => [p.kind, Number(p.discount)])).toEqual([["discount", 123.46]]);

    const line = await ctx.owner.client
      .from("sale_items")
      .select("unit_price, list_price, promo_discount")
      .eq("sale_id", res(ok).sale_id)
      .single();
    expect(line.error).toBeNull();
    const l = line.data as { unit_price: number; list_price: number; promo_discount: number };
    expect([Number(l.unit_price), Number(l.list_price), Number(l.promo_discount)]).toEqual([1234.56, 1234.56, 123.46]);

    const audit = await ctx.owner.client
      .from("audit_logs")
      .select("action")
      .eq("entity_type", "sales")
      .eq("entity_id", res(ok).sale_id);
    expect((audit.data ?? []).map((a) => (a as { action: string }).action)).toContain("sale_open_price");
  });

  it("precio libre: fuera de rango falla antes que la promo", async () => {
    const r = await sell({
      p_items: [item(ctx.libre, 1, 100)],
      p_payments: [{ method: "cash", amount: 90 }],
      p_promo_discount: 10,
    });
    expect(r.error?.message).toMatch(/open_price_out_of_range/);
  });

  // ── Seña de turno (ADR-088) ─────────────────────────────────────────────────
  async function apptWithDeposit(amount: number): Promise<string> {
    const ap = await ctx.owner.client
      .from("appointments")
      .insert({
        tenant_id: ctx.tenant,
        service_product_id: ctx.corte,
        service_name: "Corte",
        service_price: 4000,
        starts_at: new Date().toISOString(),
      } as never)
      .select("id")
      .single();
    if (ap.error || !ap.data) throw ap.error ?? new Error("appointment");
    const appt = (ap.data as { id: string }).id;
    const d = await rpc(ctx.cashier.client, "appointment_deposit_register", {
      p_appointment_id: appt,
      p_amount: amount,
      p_method: "cash",
      p_cash_shift_id: ctx.shift,
    });
    if (d.error) throw new Error(d.error.message);
    return appt;
  }

  it("seña: la promo sin condición aplica, la de efectivo no (la seña es otro pago) y la seña cubre el total ya descontado", async () => {
    await addPromo({ name: `10% corte ${STAMP}`, scope_ids: [ctx.corte], action_type: "percent", action_value: 10 });
    await addPromo({ name: `20% corte efectivo ${STAMP}`, scope_ids: [ctx.corte], action_type: "percent", action_value: 20, payment_method: "cash" });
    const appt = await apptWithDeposit(1000);
    const items = [item(ctx.corte, 1, 4000)];
    const extras = [{ kind: "appointment", id: appt }];
    const pays = (cash: number) => [
      { method: "sena", amount: 1000 },
      { method: "cash", amount: cash },
    ];

    // El 20% en efectivo no aplica: parte se pagó con la seña.
    const cashPromo = await sell({ p_items: items, p_payments: pays(2200), p_extras: extras, p_promo_discount: 800 });
    expect(cashPromo.error?.message).toMatch(/promo_mismatch/);
    expect(expectedOf(cashPromo)).toBe(400);

    const ok = await sell({ p_items: items, p_payments: pays(2600), p_extras: extras, p_promo_discount: 400 });
    expect(ok.error).toBeNull();
    expect(Number(res(ok).total)).toBe(3600);
    expect(Number(res(ok).promo_discount)).toBe(400);
    expect(Number(res(ok).deposit_applied)).toBe(1000);
  });

  it("seña mayor que la venta con promo: se aplica hasta el total descontado", async () => {
    const appt = await apptWithDeposit(5000);
    const extras = [{ kind: "appointment", id: appt }];
    const items = [item(ctx.corte, 1, 4000)];

    // La seña por el total SIN la promo es de más.
    const full = await sell({ p_items: items, p_payments: [{ method: "sena", amount: 4000 }], p_extras: extras, p_promo_discount: 400 });
    expect(full.error?.message).toMatch(/deposit_mismatch/);
    expect(expectedOf(full)).toBe(3600);

    const ok = await sell({ p_items: items, p_payments: [{ method: "sena", amount: 3600 }], p_extras: extras, p_promo_discount: 400 });
    expect(ok.error).toBeNull();
    expect(Number(res(ok).deposit_applied)).toBe(3600);
    expect(Number(res(ok).total)).toBe(3600);
  });

  // ── Reserva (ADR-096) ───────────────────────────────────────────────────────
  it("reserva: 2x1 y regalo en la venta que la entrega; se valida la reserva antes que la promo", async () => {
    await addPromo({ name: `2x1 camperas ${STAMP}`, scope_ids: [ctx.campera], action_type: "nxm", action_value: 0, buy_qty: 2, pay_qty: 1 });
    const gift = await addPromo({
      name: `Llavero con campera ${STAMP}`,
      scope_ids: [ctx.campera],
      action_type: "gift",
      action_value: 0,
      gift_product_id: ctx.llavero,
      gift_qty: 1,
    });

    const r = await rpc(ctx.cashier.client, "stock_reservation_create", {
      p_store_id: ctx.store,
      p_items: [{ product_id: ctx.campera, variant_id: null, qty: 4 }],
      p_customer_name: "Ana",
      p_customer_doc: "30123456",
    });
    expect(r.error).toBeNull();
    const resv = r.data as { id: string; pickup_code: string };
    const extras = [{ kind: "reservation", id: resv.id }];
    const items = [item(ctx.campera, 4, 100), { ...item(ctx.llavero, 1, 0), gift_promo_id: gift }];

    // Sin validar la identidad, falla por la reserva aunque la promo esté mal.
    const unverified = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 400 }], p_extras: extras, p_promo_discount: 0 });
    expect(unverified.error?.message).toMatch(/reservation_not_verified/);

    const v = await rpc(ctx.cashier.client, "stock_reservation_pickup_verify", { p_id: resv.id, p_code: resv.pickup_code });
    expect(v.error).toBeNull();
    expect((v.data as { ok: boolean }).ok).toBe(true);

    // Promo equivocada: rechaza y la reserva sigue abierta (todo en la misma transacción).
    const bad = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 400 }], p_extras: extras, p_promo_discount: 0 });
    expect(bad.error?.message).toMatch(/promo_mismatch/);
    const still = await ctx.admin.from("stock_reservations" as never).select("status").eq("id", resv.id).single();
    expect((still.data as unknown as { status: string }).status).toBe("reservada");

    const ok = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 200 }], p_extras: extras, p_promo_discount: 200 });
    expect(ok.error).toBeNull();
    expect(Number(res(ok).total)).toBe(200);
    expect(res(ok).promotions.map((p) => p.kind).sort()).toEqual(["discount", "gift"]);
    const done = await ctx.admin.from("stock_reservations" as never).select("status, sale_id").eq("id", resv.id).single();
    expect(done.data).toEqual({ status: "entregada", sale_id: res(ok).sale_id });
  });

  // ── Cupón con tope (F9 · H54) ───────────────────────────────────────────────
  it("cupón con tope: excluye la promo de descuento, consume el tope y, agotado, vuelve la promo", async () => {
    await addPromo({ name: `15% gaseosa ${STAMP}`, scope_ids: [ctx.gaseosa], action_type: "percent", action_value: 15 });
    const coupon = await addCoupon({ code: `TOPE-${STAMP}`, discount_type: "percent", discount_value: 10, max_uses: 1 });
    const items = [item(ctx.gaseosa, 1, 1000)];

    // Con cupón la promo no se suma.
    const both = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 750 }], p_coupon_id: coupon, p_promo_discount: 150 });
    expect(both.error?.message).toMatch(/promo_mismatch/);
    expect(expectedOf(both)).toBe(0);

    const ok = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 900 }], p_coupon_id: coupon, p_promo_discount: 0 });
    expect(ok.error).toBeNull();
    expect([Number(res(ok).coupon_discount), Number(res(ok).promo_discount), Number(res(ok).total)]).toEqual([100, 0, 900]);
    expect(res(ok).promotions).toEqual([]);
    const c = await ctx.admin.from("coupons").select("used_count").eq("id", coupon).single();
    expect(Number((c.data as { used_count: number }).used_count)).toBe(1);

    // Tope agotado: el cupón se rechaza (no se cae a la promo en silencio).
    const again = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 900 }], p_coupon_id: coupon, p_promo_discount: 0 });
    expect(again.error?.message).toMatch(/coupon_usage_exceeded/);

    // Sin el cupón, la promo vuelve.
    const promo = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 850 }], p_promo_discount: 150 });
    expect(promo.error).toBeNull();
    expect(Number(res(promo).promo_discount)).toBe(150);
  });

  it("cupón con tope por cliente: sin cliente no vale y el segundo uso del mismo cliente se rechaza", async () => {
    const coupon = await addCoupon({ code: `CLI-${STAMP}`, discount_type: "amount", discount_value: 50, max_per_customer: 1 });
    const items = [item(ctx.gaseosa, 1, 1000)];
    const noCust = await sell({ p_items: items, p_payments: [{ method: "cash", amount: 950 }], p_coupon_id: coupon });
    expect(noCust.error?.message).toMatch(/coupon_needs_customer/);
    const args = { p_items: items, p_payments: [{ method: "cash", amount: 950 }], p_coupon_id: coupon, p_customer_id: ctx.customer };
    const first = await sell(args);
    expect(first.error).toBeNull();
    expect(Number(res(first).coupon_discount)).toBe(50);
    const second = await sell(args);
    expect(second.error?.message).toMatch(/coupon_customer_exceeded/);
  });

  // DIVERGENCIA: create_sale calcula el cupón % sobre v_subtotal, que incluye
  // las líneas sin producto de la hoja de cobro (recargo de cuotas, garantía).
  // El POS lo calcula sobre el subtotal del carrito (usePosPricing) y cobra el
  // recargo entero: acá el POS cobra 1000 (1000 − 100 + 100) y el servidor
  // graba un total de 990 (cupón de 110). Ver tests/unit/createSalePromoIntegrity.test.ts.
  it.fails("DIVERGENCIA: cupón % con recargo de cuotas: el servidor descuenta lo mismo que el POS", async () => {
    const coupon = await addCoupon({ code: `REC-${STAMP}`, discount_type: "percent", discount_value: 10 });
    const r = await sell({
      p_items: [item(ctx.gaseosa, 1, 1000), { product_id: null, name: "Recargo 3 cuotas", quantity: 1, unit_price: 100, discount: 0 }],
      p_extras: [{ kind: "surcharge", amount: 100 }],
      p_payments: [{ method: "cash", amount: 1000 }],
      p_coupon_id: coupon,
      p_promo_discount: 0,
    });
    expect(r.error).toBeNull();
    expect(Number(res(r).coupon_discount)).toBe(100);
    expect(Number(res(r).total)).toBe(1000);
  });
});
