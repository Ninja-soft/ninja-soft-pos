// @vitest-environment node
// =============================================================================
// Promociones (ADR-074, migraciones 20261102100000 a 20261102100300): paridad
// del motor (promotion_preview contra tests/fixtures/promoMatrix.ts), RLS de
// promotions y sale_promotions, gating por plan, auditoría y create_sale con
// el cálculo autoritativo (promo_mismatch, topes, regalos).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con `promociones` (add-on), dueño y cajero (el cajero
// abre SU turno y vende en él); negocio B sin la feature.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PROMO_CASES, promoSqlArgs } from "../fixtures/promoMatrix";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `promo-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  userIds: string[];
  category: string;
  gaseosa: string;
  alfajor: string;
  llavero: string;
  customer: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

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

describe.skipIf(!enabled)("promociones · motor, RLS, plan y create_sale", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Promo A ${STAMP}`, slug: `pa-${STAMP}`, status: "active" },
        { name: `Promo B ${STAMP}`, slug: `pb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `pa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `pb-${STAMP}`)!.id;

    const { error: aErr } = await admin.from("subscription_addons").insert(
      ["promociones", "descuentos"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: cat, error: cErr } = await ctx.owner.client
      .from("categories")
      .insert({ tenant_id: ctx.tenant, name: `Bebidas ${STAMP}` } as never)
      .select("id")
      .single();
    if (cErr || !cat) throw cErr ?? new Error("category");
    ctx.category = (cat as { id: string }).id;

    // Insert multi-fila: todas las claves en cada fila.
    const { data: prods, error: pErr } = await ctx.owner.client
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Gaseosa ${STAMP}`, price: 1000, category_id: ctx.category, track_stock: false },
        { tenant_id: ctx.tenant, name: `Alfajor ${STAMP}`, price: 500, category_id: null, track_stock: false },
        { tenant_id: ctx.tenant, name: `Llavero ${STAMP}`, price: 300, category_id: null, track_stock: false },
      ] as never)
      .select("id, name");
    if (pErr || !prods) throw pErr ?? new Error("products");
    const ps = prods as { id: string; name: string }[];
    ctx.gaseosa = ps.find((p) => p.name.startsWith("Gaseosa"))!.id;
    ctx.alfajor = ps.find((p) => p.name.startsWith("Alfajor"))!.id;
    ctx.llavero = ps.find((p) => p.name.startsWith("Llavero"))!.id;

    const { data: cust, error: cuErr } = await ctx.owner.client
      .from("customers")
      .insert({ tenant_id: ctx.tenant, name: `Cliente ${STAMP}` } as never)
      .select("id")
      .single();
    if (cuErr || !cust) throw cuErr ?? new Error("customer");
    ctx.customer = (cust as { id: string }).id;

    const { data: store, error: sErr } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: (store as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    // El cajero abre SU turno y vende en él (regla de caja propia).
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: (reg as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("matriz de paridad: promotion_preview da lo mismo que lib/promotions/engine.ts", async () => {
    for (const c of PROMO_CASES) {
      const r = await rpc(ctx.owner.client, "promotion_preview", promoSqlArgs(c));
      expect(r.error, c.name).toBeNull();
      const d = r.data as {
        discount: number;
        applied: { id: string; discount: number; lines: number[] }[];
        gifts: { id: string }[];
      };
      expect(Number(d.discount), c.name).toBe(c.expected.discount);
      expect(
        d.applied.map((a) => ({ id: a.id, discount: Number(a.discount) })),
        c.name,
      ).toEqual(c.expected.applied);
      if (c.expected.firstLines) expect(d.applied[0]?.lines.map(Number), c.name).toEqual(c.expected.firstLines);
      if (c.expected.gifts) expect(d.gifts.map((g) => g.id), c.name).toEqual(c.expected.gifts);
    }
  }, 120_000);

  it("RLS: el dueño crea promos, el cajero no; otro negocio no las ve", async () => {
    const own = await ctx.owner.client
      .from("promotions")
      .insert({ tenant_id: ctx.tenant, name: `10% todo ${STAMP}`, scope: "cart", action_type: "percent", action_value: 10 } as never)
      .select("id")
      .single();
    expect(own.error).toBeNull();

    const caj = await ctx.cashier.client
      .from("promotions")
      .insert({ tenant_id: ctx.tenant, name: "cajero", scope: "cart", action_type: "percent", action_value: 50 } as never);
    expect(caj.error?.message).toMatch(/row-level security/);

    const seenByCashier = await ctx.cashier.client.from("promotions").select("id");
    expect((seenByCashier.data ?? []).length).toBe(1);

    const seenByB = await ctx.ownerB.client.from("promotions").select("id");
    expect(seenByB.data ?? []).toEqual([]);

    // Negocio B sin la feature: no puede crear promos.
    const b = await ctx.ownerB.client
      .from("promotions")
      .insert({ tenant_id: ctx.tenantB, name: "sin plan", scope: "cart", action_type: "percent", action_value: 5 } as never);
    expect(b.error?.message).toMatch(/row-level security/);
  });

  it("create_sale calcula la promo: rechaza el monto equivocado y guarda cada promo aplicada", async () => {
    const items = [item(ctx.gaseosa, 2, 1000), item(ctx.alfajor, 1, 500)];
    const bad = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items,
      p_payments: [{ method: "cash", amount: 2500 }],
      p_promo_discount: 0,
    });
    expect(bad.error?.message).toMatch(/promo_mismatch/);

    const ok = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items,
      p_payments: [{ method: "cash", amount: 2250 }],
      p_promo_discount: 250,
    });
    expect(ok.error).toBeNull();
    const res = ok.data as { sale_id: string; total: number; promotions: { label: string; discount: number }[] };
    expect(Number(res.total)).toBe(2250);
    expect(res.promotions.map((p) => [p.label, Number(p.discount)])).toEqual([[`10% todo ${STAMP}`, 250]]);

    const rows = await ctx.owner.client.from("sale_promotions").select("label, kind, discount").eq("sale_id", res.sale_id);
    expect(rows.error).toBeNull();
    expect((rows.data ?? []).map((r) => Number((r as { discount: number }).discount))).toEqual([250]);

    const other = await ctx.ownerB.client.from("sale_promotions").select("id").eq("sale_id", res.sale_id);
    expect(other.data ?? []).toEqual([]);
  });

  it("acumulables con condición de tarjeta y auditoría de pausa", async () => {
    const promos = await ctx.owner.client.from("promotions").select("id").eq("tenant_id", ctx.tenant);
    const first = (promos.data as { id: string }[])[0]!.id;
    const pause = await ctx.owner.client.from("promotions").update({ is_active: false } as never).eq("id", first);
    expect(pause.error).toBeNull();

    const ins = await ctx.owner.client.from("promotions").insert([
      {
        tenant_id: ctx.tenant,
        name: "2x1 bebidas",
        scope: "category",
        scope_ids: [ctx.category],
        action_type: "nxm",
        action_value: 0,
        buy_qty: 2,
        pay_qty: 1,
        stackable: true,
        priority: 10,
        card_brands: null,
      },
      {
        tenant_id: ctx.tenant,
        name: "Visa 5%",
        scope: "cart",
        scope_ids: null,
        action_type: "percent",
        action_value: 5,
        buy_qty: null,
        pay_qty: null,
        stackable: true,
        priority: 0,
        card_brands: ["visa"],
      },
    ] as never);
    expect(ins.error).toBeNull();

    const items = [item(ctx.gaseosa, 2, 1000), item(ctx.alfajor, 1, 500)];
    const sale = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items,
      p_payments: [{ method: "credit", amount: 1425, card_voucher: { marca: "Visa", lote: "1", cupon: "2", autorizacion: "A1" } }],
      p_promo_discount: 1075,
    });
    expect(sale.error).toBeNull();
    expect((sale.data as { promotions: { label: string }[] }).promotions.map((p) => p.label)).toEqual(["2x1 bebidas", "Visa 5%"]);

    const audit = await ctx.owner.client
      .from("audit_logs")
      .select("action")
      .eq("entity_type", "promotions")
      .eq("entity_id", first);
    expect((audit.data ?? []).map((a) => (a as { action: string }).action)).toEqual(
      expect.arrayContaining(["promotion_created", "promotion_deactivated"]),
    );
  });

  it("regalo con tope por cliente: la segunda vez el servidor lo rechaza", async () => {
    const ins = await ctx.owner.client.from("promotions").insert({
      tenant_id: ctx.tenant,
      name: "Llavero de regalo",
      scope: "cart",
      action_type: "gift",
      action_value: 0,
      gift_product_id: ctx.llavero,
      gift_qty: 1,
      min_amount: 400,
      max_uses_per_customer: 1,
    } as never);
    expect(ins.error).toBeNull();
    const gift = await ctx.owner.client.from("promotions").select("id").eq("name", "Llavero de regalo").single();
    const giftId = (gift.data as { id: string }).id;
    const items = [
      { ...item(ctx.alfajor, 1, 500), gift_promo_id: null },
      { ...item(ctx.llavero, 1, 0), gift_promo_id: giftId },
    ];
    const args = { p_items: items, p_payments: [{ method: "cash", amount: 500 }], p_customer_id: ctx.customer, p_promo_discount: 0 };
    const first = await rpc(ctx.cashier.client, "create_sale", args);
    expect(first.error).toBeNull();
    const second = await rpc(ctx.cashier.client, "create_sale", args);
    expect(second.error?.message).toMatch(/promo_gift_invalid/);

    const usage = await rpc(ctx.cashier.client, "promotion_usage", { p_customer: ctx.customer });
    expect(usage.error).toBeNull();
    expect(Object.values(usage.data as Record<string, { customer: number }>)[0]?.customer).toBe(1);
  });

  it("sin la feature no hay promos: pedirlas da feature_not_in_plan", async () => {
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant).eq("addon_key", "promociones");
    const items = [item(ctx.gaseosa, 2, 1000)];
    const asked = await rpc(ctx.cashier.client, "create_sale", {
      p_items: items,
      p_payments: [{ method: "cash", amount: 1000 }],
      p_promo_discount: 1000,
    });
    expect(asked.error?.message).toMatch(/feature_not_in_plan: promociones/);
    const plain = await rpc(ctx.cashier.client, "create_sale", { p_items: items, p_payments: [{ method: "cash", amount: 2000 }] });
    expect(plain.error).toBeNull();
    const preview = await rpc(ctx.owner.client, "promotion_preview", { p_lines: [] });
    expect(preview.error?.message).toMatch(/feature_not_in_plan/);
  });
});
