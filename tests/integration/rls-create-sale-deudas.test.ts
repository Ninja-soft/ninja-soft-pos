// @vitest-environment node
// =============================================================================
// ADR-088: create_sale con depósitos (ADR-085), seña de turnos (ADR-082) y
// devoluciones parciales con promo (ADR-074).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: un negocio con `depositos`, `agenda_senas` y `promociones` (dueño,
// cajero y solo lectura) y otro negocio sin esas features. El cajero vende en
// SU turno, abierto por él. audit_logs es inmutable (ADR-083): el cleanup no
// la toca. Inserts multi-fila con todas las claves en cada fila.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `csd-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  viewer: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  remera: string;
  gaseosa: string;
  alfajor: string;
  corte: string;
  category: string;
  register: string;
  shift: string;
  reserva: string;
  appt: string;
  deposit: string;
  apptSale: string;
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

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
const obj = (r: RpcRes) => r.data as Record<string, unknown>;

async function principalQty(product: string): Promise<number> {
  const { data, error } = await rpc(ctx.owner, "warehouse_stock_overview", { p_store_id: ctx.store });
  if (error) throw new Error(error.message);
  const row = (data as { product_id: string; principal_qty: number }[]).find((r) => r.product_id === product);
  return Number(row?.principal_qty ?? 0);
}

async function reservaQty(): Promise<number> {
  const { data } = await ctx.owner
    .from("warehouse_stock" as never)
    .select("qty")
    .eq("warehouse_id", ctx.reserva)
    .eq("product_id", ctx.remera);
  const rows = (data ?? []) as unknown as { qty: number }[];
  return Number(rows[0]?.qty ?? 0);
}

const sell = (c: SupabaseClient, args: Record<string, unknown>) =>
  rpc(c, "create_sale", { p_cash_shift_id: ctx.shift, ...args });

describe.skipIf(!enabled)("ADR-088 · create_sale: depósitos, seña de turnos y devoluciones con promo", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `CSD ${STAMP}`, slug: `a-${STAMP}`, status: "active" },
        { name: `CSDB ${STAMP}`, slug: `b-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `a-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `b-${STAMP}`)!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["depositos", "agenda_senas", "promociones"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const viewer = await makeUser(admin, `lector-${STAMP}@test.local`, ctx.tenant, "viewer");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.viewer = viewer.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(owner.id, cashier.id, viewer.id, ownerB.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const cat = await owner.client
      .from("categories")
      .insert({ tenant_id: ctx.tenant, name: `Bebidas ${STAMP}` } as never)
      .select("id")
      .single();
    if (cat.error || !cat.data) throw cat.error ?? new Error("category");
    ctx.category = (cat.data as unknown as { id: string }).id;

    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Remera ${STAMP}`, price: 100, cost: 50, stock: 20, category_id: null, track_stock: true },
        { tenant_id: ctx.tenant, name: `Gaseosa ${STAMP}`, price: 100, cost: 50, stock: 50, category_id: ctx.category, track_stock: true },
        { tenant_id: ctx.tenant, name: `Alfajor ${STAMP}`, price: 100, cost: 50, stock: 50, category_id: null, track_stock: true },
        { tenant_id: ctx.tenant, name: `Corte ${STAMP}`, price: 4000, cost: 0, stock: 0, category_id: null, track_stock: false },
      ])
      .select("id, name");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    const byName = (p: string) => prods.data!.find((x) => x.name.startsWith(p))!.id;
    ctx.remera = byName("Remera");
    ctx.gaseosa = byName("Gaseosa");
    ctx.alfajor = byName("Alfajor");
    ctx.corte = byName("Corte");

    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    ctx.register = (reg.data as unknown as { id: string }).id;

    // El cajero abre SU turno.
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [ctx.tenant, ctx.tenantB]) {
      await admin.from("appointment_deposits" as never).delete().eq("tenant_id", t);
      await admin.from("warehouse_moves" as never).delete().eq("tenant_id", t);
      await admin.from("warehouse_stock" as never).delete().eq("tenant_id", t);
      await admin.from("warehouses" as never).delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── 1) Depósitos ──────────────────────────────────────────────────────────
  it("sin depósitos la venta es la de siempre (sin aviso de reserva)", async () => {
    const s = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.remera, quantity: 2, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 200 }],
    });
    expect(s.error).toBeNull();
    expect(Number(obj(s).total)).toBe(200);
    expect(obj(s).reserve_taken).toEqual([]);
    expect(Number(obj(s).deposit_applied)).toBe(0);
  });

  it("con depósitos y sin venta en negativo, el salón manda (no el total de la sucursal)", async () => {
    const w = await rpc(ctx.owner, "warehouse_save", { p_id: null, p_store_id: ctx.store, p_name: "Reserva", p_kind: "reserva" });
    expect(w.error).toBeNull();
    ctx.reserva = w.data as string;
    const cnt = await rpc(ctx.owner, "warehouse_stock_set", {
      p_warehouse_id: ctx.reserva,
      p_product_id: ctx.remera,
      p_variant_id: null,
      p_qty: 12,
    });
    expect(cnt.error).toBeNull();
    const ps = await ctx.admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: false } as never, { onConflict: "tenant_id" });
    expect(ps.error).toBeNull();
    expect(await principalQty(ctx.remera)).toBe(6);

    // La sucursal tiene 18, pero el salón 6: se rechaza.
    const no = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.remera, quantity: 10, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 1000 }],
    });
    expect(no.error?.message).toMatch(/insufficient_stock_salon/);

    const ok = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.remera, quantity: 6, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 600 }],
    });
    expect(ok.error).toBeNull();
    expect(await principalQty(ctx.remera)).toBe(0);
    expect(await reservaQty()).toBe(12);
  });

  it("vender de la reserva: sólo el dueño la prende; la venta toma lo que falta y deja aviso", async () => {
    for (const c of [ctx.cashier, ctx.viewer]) {
      const r = await rpc(c, "warehouse_settings_save", { p_sell_from_reserve: true });
      expect(r.error?.message).toMatch(/forbidden/);
    }
    const b = await rpc(ctx.ownerB, "warehouse_settings_save", { p_sell_from_reserve: true });
    expect(b.error?.message).toMatch(/feature_not_in_plan: depositos/);
    const on = await rpc(ctx.owner, "warehouse_settings_save", { p_sell_from_reserve: true });
    expect(on.error).toBeNull();

    const s = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.remera, quantity: 5, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 500 }],
    });
    expect(s.error).toBeNull();
    const taken = obj(s).reserve_taken as { product_id: string; taken: number }[];
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ product_id: ctx.remera });
    expect(Number(taken[0]!.taken)).toBe(5);
    expect(await reservaQty()).toBe(7);
    expect(await principalQty(ctx.remera)).toBe(0);

    // Sin stock ni en la reserva: sigue rechazando.
    const no = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.remera, quantity: 50, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 5000 }],
    });
    expect(no.error).not.toBeNull();

    // Invariante de ADR-046 intacto y auditoría de lo vendido de la reserva.
    const mm = await rpc(ctx.admin, "product_stock_mismatches", { p_tenant: ctx.tenant });
    expect(mm.error).toBeNull();
    expect(mm.data ?? []).toEqual([]);
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["sale_from_reserve", "warehouse_settings_saved"]);
    expect(((logs ?? []) as { action: string }[]).map((l) => l.action).sort()).toEqual([
      "sale_from_reserve",
      "warehouse_settings_saved",
    ]);
  });

  // ── 2) Seña de turnos ─────────────────────────────────────────────────────
  it("el cajero cobra la seña en su turno; solo lectura y otro negocio no", async () => {
    const ap = await ctx.owner
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
    expect(ap.error).toBeNull();
    ctx.appt = (ap.data as unknown as { id: string }).id;

    const viewer = await rpc(ctx.viewer, "appointment_deposit_register", { p_appointment_id: ctx.appt, p_amount: 1000 });
    expect(viewer.error?.message).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB, "appointment_deposit_register", { p_appointment_id: ctx.appt, p_amount: 1000 });
    expect(b.error?.message).toMatch(/feature_not_in_plan: agenda_senas/);

    const d = await rpc(ctx.cashier, "appointment_deposit_register", {
      p_appointment_id: ctx.appt,
      p_amount: 1000,
      p_method: "cash",
      p_cash_shift_id: ctx.shift,
    });
    expect(d.error).toBeNull();
    ctx.deposit = d.data as string;

    // Entró a la caja del cajero como ingreso en efectivo.
    const { data: mov } = await ctx.admin
      .from("cash_movements")
      .select("type, amount, payment_method")
      .eq("reference_id", ctx.deposit);
    expect(mov).toEqual([expect.objectContaining({ type: "income", payment_method: "cash" })]);

    // Nadie escribe la tabla por REST; el otro negocio no la ve.
    const direct = await ctx.owner.from("appointment_deposits" as never).update({ amount: 1 } as never).eq("id", ctx.deposit);
    expect(direct.error).not.toBeNull();
    const fake = await ctx.cashier.from("appointment_deposits" as never).insert({
      tenant_id: ctx.tenant,
      appointment_id: ctx.appt,
      method: "cash",
      amount: 999,
    } as never);
    expect(fake.error).not.toBeNull();
    const seenB = await ctx.ownerB.from("appointment_deposits" as never).select("id").eq("id", ctx.deposit);
    expect(seenB.data ?? []).toEqual([]);
  });

  it("cobrar el turno exige descontar la seña (no se cobra dos veces) y lo enlaza en la misma venta", async () => {
    const items = [{ product_id: ctx.corte, quantity: 1, unit_price: 4000, discount: 0 }];
    const extras = [{ kind: "appointment", id: ctx.appt }];

    const twice = await sell(ctx.cashier, { p_items: items, p_payments: [{ method: "cash", amount: 4000 }], p_extras: extras });
    expect(twice.error?.message).toMatch(/deposit_mismatch/);

    const noAppt = await sell(ctx.cashier, {
      p_items: items,
      p_payments: [
        { method: "sena", amount: 1000 },
        { method: "cash", amount: 3000 },
      ],
    });
    expect(noAppt.error?.message).toMatch(/deposit_needs_appointment/);

    const ok = await sell(ctx.cashier, {
      p_items: items,
      p_payments: [
        { method: "sena", amount: 1000 },
        { method: "cash", amount: 3000 },
      ],
      p_extras: extras,
    });
    expect(ok.error).toBeNull();
    expect(Number(obj(ok).total)).toBe(4000);
    expect(Number(obj(ok).deposit_applied)).toBe(1000);
    ctx.apptSale = obj(ok).sale_id as string;

    const { data: dep } = await ctx.owner
      .from("appointment_deposits" as never)
      .select("status, applied_amount, sale_id")
      .eq("id", ctx.deposit)
      .single();
    expect(dep).toMatchObject({ status: "applied", sale_id: ctx.apptSale });
    const { data: ap } = await ctx.owner.from("appointments").select("status, sale_id").eq("id", ctx.appt).single();
    expect(ap).toMatchObject({ status: "realizado", sale_id: ctx.apptSale });

    const again = await sell(ctx.cashier, {
      p_items: items,
      p_payments: [{ method: "cash", amount: 4000 }],
      p_extras: extras,
    });
    expect(again.error?.message).toMatch(/appointment_already_charged/);
  });

  it("anular la venta libera la seña y el turno se puede volver a cobrar", async () => {
    const v = await rpc(ctx.owner, "void_sale", { p_sale_id: ctx.apptSale, p_reason: "test" });
    expect(v.error).toBeNull();
    const { data: dep } = await ctx.owner
      .from("appointment_deposits" as never)
      .select("status, applied_amount, sale_id")
      .eq("id", ctx.deposit)
      .single();
    expect(dep).toMatchObject({ status: "held", sale_id: null });
    expect(Number((dep as unknown as { applied_amount: number }).applied_amount)).toBe(0);

    const ok = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.corte, quantity: 1, unit_price: 4000, discount: 0 }],
      p_payments: [
        { method: "sena", amount: 1000 },
        { method: "cash", amount: 3000 },
      ],
      p_extras: [{ kind: "appointment", id: ctx.appt }],
    });
    expect(ok.error).toBeNull();
  });

  it("seña mayor que la venta: cubre el total y el resto se devuelve una sola vez", async () => {
    const ap = await ctx.owner
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
    const appt = (ap.data as unknown as { id: string }).id;
    const d = await rpc(ctx.cashier, "appointment_deposit_register", {
      p_appointment_id: appt,
      p_amount: 5000,
      p_method: "transfer",
      p_reference: "op 123",
      p_cash_shift_id: ctx.shift,
    });
    expect(d.error).toBeNull();
    const dep = d.data as string;

    const s = await sell(ctx.cashier, {
      p_items: [{ product_id: ctx.corte, quantity: 1, unit_price: 4000, discount: 0 }],
      p_payments: [{ method: "sena", amount: 4000 }],
      p_extras: [{ kind: "appointment", id: appt }],
    });
    expect(s.error).toBeNull();

    const viewer = await rpc(ctx.viewer, "appointment_deposit_refund", { p_deposit_id: dep, p_reason: "sobrante" });
    expect(viewer.error?.message).toMatch(/forbidden/);
    const r = await rpc(ctx.cashier, "appointment_deposit_refund", {
      p_deposit_id: dep,
      p_reason: "sobrante de la seña",
      p_cash_shift_id: ctx.shift,
    });
    expect(r.error).toBeNull();
    expect(Number(obj(r).refunded)).toBe(1000);
    expect(obj(r).status).toBe("applied");
    const twice = await rpc(ctx.cashier, "appointment_deposit_refund", {
      p_deposit_id: dep,
      p_reason: "otra vez",
      p_cash_shift_id: ctx.shift,
    });
    expect(twice.error?.message).toMatch(/deposit_not_refundable/);
  });

  // ── 3) Devolución parcial con promo ───────────────────────────────────────
  it("devolución parcial de una venta con 2x1: cada unidad se reintegra neta de su promo", async () => {
    await ctx.admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
    const promo = await ctx.owner.from("promotions").insert({
      tenant_id: ctx.tenant,
      name: `2x1 bebidas ${STAMP}`,
      scope: "category",
      scope_ids: [ctx.category],
      action_type: "nxm",
      action_value: 0,
      buy_qty: 2,
      pay_qty: 1,
    } as never);
    expect(promo.error).toBeNull();

    const s = await sell(ctx.cashier, {
      p_items: [
        { product_id: ctx.gaseosa, quantity: 2, unit_price: 100, discount: 0 },
        { product_id: ctx.alfajor, quantity: 1, unit_price: 100, discount: 0 },
      ],
      p_payments: [{ method: "cash", amount: 200 }],
      p_promo_discount: 100,
    });
    expect(s.error).toBeNull();
    expect(Number(obj(s).total)).toBe(200);
    const saleId = obj(s).sale_id as string;

    const { data: items } = await ctx.cashier
      .from("sale_items")
      .select("id, product_id, promo_discount")
      .eq("sale_id", saleId);
    const rows = (items ?? []) as unknown as { id: string; product_id: string; promo_discount: number }[];
    const gas = rows.find((r) => r.product_id === ctx.gaseosa)!;
    const alf = rows.find((r) => r.product_id === ctx.alfajor)!;
    expect(Number(gas.promo_discount)).toBe(100);
    expect(Number(alf.promo_discount)).toBe(0);

    const ret = (item: string) =>
      rpc(ctx.cashier, "return_sale_v2", {
        p_sale_id: saleId,
        p_items: [{ sale_item_id: item, quantity: 1 }],
        p_refund: "cash",
        p_cash_shift_id: ctx.shift,
      });
    // El alfajor no tenía promo: vuelve entero (antes el prorrateo global daba 66,67).
    const r1 = await ret(alf.id);
    expect(r1.error).toBeNull();
    expect(Number(obj(r1).total)).toBe(100);
    // Cada gaseosa del 2x1 vuelve a la mitad; las dos suman lo cobrado.
    const r2 = await ret(gas.id);
    expect(r2.error).toBeNull();
    expect(Number(obj(r2).total)).toBe(50);
    const r3 = await ret(gas.id);
    expect(r3.error).toBeNull();
    expect(Number(obj(r3).total)).toBe(50);
  });
});
