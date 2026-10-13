// @vitest-environment node
// =============================================================================
// ADR-096: create_sale con reservas de stock (ADR-091) y garantía extendida
// enlazada (ADR-092).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// El cajero vende en SU turno, abierto por él. Inserts multi-fila con todas las
// claves en cada fila. audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `cs96-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  userIds: string[];
  store: string;
  shift: string;
  campera: string;
  celular: string;
  tablet: string;
  planPlus: string;
  planMax: string;
  reservation: string;
  code: string;
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

type Line = Record<string, unknown>;
const sale = (items: Line[], amount: number, extras: Line[] = []) =>
  rpc(ctx.cashier, "create_sale", {
    p_items: items,
    p_payments: [{ method: "cash", amount }],
    p_extras: extras,
    p_cash_shift_id: ctx.shift,
  });
const camperas = (qty: number) => [{ product_id: ctx.campera, quantity: qty, unit_price: 100, discount: 0 }];

async function stockOf(productId: string): Promise<number> {
  const { data } = await ctx.admin.from("products").select("stock").eq("id", productId).single();
  return Number((data as { stock: number }).stock);
}

type LookupSale = { extended_months: number; extended_label: string | null; extended_link: string | null };
async function lookup(serial: string): Promise<LookupSale> {
  const r = await rpc(ctx.cashier, "serial_lookup", { p_serial: serial });
  if (r.error) throw new Error(r.error.message);
  return (r.data as { sales: LookupSale[] }).sales[0]!;
}

describe.skipIf(!enabled)("ADR-096 · create_sale con reservas de stock y garantía enlazada", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const t = await admin
      .from("tenants")
      .insert({ name: `CS96 ${STAMP}`, slug: `a-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["reservas_stock", "garantias", "garantias_serie"].map((key) => ({
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
    ctx.userIds.push(owner.id, cashier.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    // Sin venta en negativo: el bloqueo por reservas aplica.
    const ps = await admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: false } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Campera ${STAMP}`, price: 100, cost: 50, stock: 10, track_stock: true, warranty_months: 0 },
        { tenant_id: ctx.tenant, name: `Celular ${STAMP}`, price: 1000, cost: 500, stock: 10, track_stock: true, warranty_months: 12 },
        { tenant_id: ctx.tenant, name: `Tablet ${STAMP}`, price: 2000, cost: 900, stock: 10, track_stock: true, warranty_months: 6 },
      ])
      .select("id, name");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    const byName = (p: string) => prods.data!.find((x) => x.name.startsWith(p))!.id;
    ctx.campera = byName("Campera");
    ctx.celular = byName("Celular");
    ctx.tablet = byName("Tablet");

    const wp = await admin
      .from("warranty_plans")
      .insert([
        { tenant_id: ctx.tenant, label: "Plus", months: 12, price: 300, sort: 1 },
        { tenant_id: ctx.tenant, label: "Max", months: 24, price: 500, sort: 2 },
      ])
      .select("id, label");
    if (wp.error || !wp.data) throw wp.error ?? new Error("warranty_plans");
    ctx.planPlus = wp.data.find((x) => x.label === "Plus")!.id;
    ctx.planMax = wp.data.find((x) => x.label === "Max")!.id;

    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");

    // El cajero abre SU turno.
    const sh = await rpc(cashier.client, "open_cash_shift", {
      p_register_id: (reg.data as unknown as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("stock_reservations" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
    // por sus auditorías, queda (datos de prueba con sello único).
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("la venta de mostrador no consume lo reservado para otro cliente", async () => {
    const r = await rpc(ctx.cashier, "stock_reservation_create", {
      p_store_id: ctx.store,
      p_items: [{ product_id: ctx.campera, variant_id: null, qty: 4 }],
      p_customer_name: "Ana",
      p_customer_doc: "30123456",
    });
    expect(r.error).toBeNull();
    const out = r.data as { id: string; pickup_code: string };
    ctx.reservation = out.id;
    ctx.code = out.pickup_code;

    // Hay 10 y 4 están reservados: 7 no alcanzan.
    const over = await sale(camperas(7), 700);
    expect(over.error?.message).toMatch(/insufficient_stock_reserved/);
    expect(await stockOf(ctx.campera)).toBe(10);

    const ok = await sale(camperas(6), 600);
    expect(ok.error).toBeNull();
    expect(await stockOf(ctx.campera)).toBe(4);

    // Lo que queda es de la reserva.
    const one = await sale(camperas(1), 100);
    expect(one.error?.message).toMatch(/insufficient_stock_reserved/);
  });

  it("el POS entrega la reserva con la venta: identidad validada antes, sin doble descuento", async () => {
    const extra = [{ kind: "reservation", id: ctx.reservation }];

    // Sin validar la identidad no se entrega.
    const unverified = await sale(camperas(4), 400, extra);
    expect(unverified.error?.message).toMatch(/reservation_not_verified/);

    // Un código mal tipeado cuenta el intento y no habilita.
    const bad = await rpc(ctx.cashier, "stock_reservation_pickup_verify", {
      p_id: ctx.reservation,
      p_code: ctx.code === "000000" ? "111111" : "000000",
    });
    expect(bad.error).toBeNull();
    expect(bad.data).toMatchObject({ ok: false, error: "pickup_code_invalid", attempts_left: 4 });

    const good = await rpc(ctx.cashier, "stock_reservation_pickup_verify", {
      p_id: ctx.reservation,
      p_code: ctx.code,
    });
    expect(good.error).toBeNull();
    const verified = good.data as { ok: boolean; items: { product_id: string; qty: number }[] };
    expect(verified.ok).toBe(true);
    expect(verified.items).toEqual([expect.objectContaining({ product_id: ctx.campera })]);
    expect(Number(verified.items[0]!.qty)).toBe(4);

    // La venta tiene que cubrir los renglones de la reserva.
    const short = await sale(camperas(3), 300, extra);
    expect(short.error?.message).toMatch(/reservation_items_mismatch/);

    const s = await sale(camperas(4), 400, extra);
    expect(s.error).toBeNull();
    const saleId = (s.data as { sale_id: string }).sale_id;
    // El stock baja una sola vez (la reserva no movía stock).
    expect(await stockOf(ctx.campera)).toBe(0);

    const { data: res } = await ctx.owner
      .from("stock_reservations" as never)
      .select("status, sale_id, pickup_verified_via")
      .eq("id", ctx.reservation)
      .single();
    expect(res).toEqual({ status: "entregada", sale_id: saleId, pickup_verified_via: "code" });

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("entity_id", ctx.reservation);
    expect((audit ?? []).map((a) => (a as { action: string }).action)).toEqual(
      expect.arrayContaining([
        "stock_reservation_pickup_failed",
        "stock_reservation_pickup_verified",
        "stock_reservation_delivered",
      ]),
    );

    // Ya entregada: no se entrega dos veces.
    const again = await sale([{ product_id: ctx.tablet, quantity: 1, unit_price: 2000, discount: 0 }], 2000, extra);
    expect(again.error?.message).toMatch(/reservation_not_open/);
  });

  it("la garantía extendida queda enlazada al producto que cubre", async () => {
    const s = await sale(
      [
        { product_id: ctx.celular, quantity: 1, unit_price: 1000, discount: 0, serial: `IMEI-${STAMP}` },
        { product_id: ctx.tablet, quantity: 1, unit_price: 2000, discount: 0, serial: `TAB-${STAMP}` },
        {
          product_id: null,
          name: "Garantía Max",
          quantity: 1,
          unit_price: 500,
          discount: 0,
          warranty_plan_id: ctx.planMax,
          warranty_for: 1,
        },
      ],
      3500,
      [{ kind: "warranty", amount: 500 }],
    );
    expect(s.error).toBeNull();
    const saleId = (s.data as { sale_id: string }).sale_id;

    const { data: items } = await ctx.admin
      .from("sale_items")
      .select("id, serial, product_id, warranty_plan_id, warranty_for_item_id, warranty_months, tenant_id")
      .eq("sale_id", saleId);
    const rows = (items ?? []) as unknown as {
      id: string;
      serial: string | null;
      product_id: string | null;
      warranty_plan_id: string | null;
      warranty_for_item_id: string | null;
      warranty_months: number | null;
      tenant_id: string;
    }[];
    const tab = rows.find((r) => r.product_id === ctx.tablet)!;
    const w = rows.find((r) => r.product_id === null)!;
    expect(w).toMatchObject({ warranty_plan_id: ctx.planMax, warranty_for_item_id: tab.id, warranty_months: 24 });
    expect(rows.every((r) => r.tenant_id === ctx.tenant)).toBe(true);

    // La tablet tiene la extendida; el celular del mismo ticket, no.
    expect(await lookup(`tab-${STAMP}`)).toMatchObject({ extended_months: 24, extended_label: "Max", extended_link: "explicit" });
    expect(await lookup(`IMEI-${STAMP}`)).toMatchObject({ extended_months: 0, extended_link: null });

    // Un vínculo a una línea sin producto se rechaza.
    const bad = await sale(
      [
        { product_id: ctx.celular, quantity: 1, unit_price: 1000, discount: 0 },
        { product_id: null, name: "Garantía Plus", quantity: 1, unit_price: 300, discount: 0, warranty_plan_id: ctx.planPlus, warranty_for: 1 },
      ],
      1300,
      [{ kind: "warranty", amount: 300 }],
    );
    expect(bad.error?.message).toMatch(/warranty_link_invalid/);
  });

  it("una venta sin vínculo (como las viejas) sigue encontrando la garantía por el nombre", async () => {
    const s = await sale(
      [
        { product_id: ctx.celular, quantity: 1, unit_price: 1000, discount: 0, serial: `OLD-${STAMP}` },
        { product_id: null, name: "Garantía Plus", quantity: 1, unit_price: 300, discount: 0 },
      ],
      1300,
      [{ kind: "warranty", amount: 300 }],
    );
    expect(s.error).toBeNull();
    expect(await lookup(`OLD-${STAMP}`)).toMatchObject({ extended_months: 12, extended_label: "Plus", extended_link: "name" });
  });

  it("sin la feature reservas_stock el extra de reserva se rechaza y la venta común sigue igual", async () => {
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant).eq("addon_key", "reservas_stock");
    const withExtra = await sale(
      [{ product_id: ctx.tablet, quantity: 1, unit_price: 2000, discount: 0 }],
      2000,
      [{ kind: "reservation", id: ctx.reservation }],
    );
    expect(withExtra.error?.message).toMatch(/feature_not_in_plan: reservas_stock/);
    const plain = await sale([{ product_id: ctx.tablet, quantity: 1, unit_price: 2000, discount: 0 }], 2000);
    expect(plain.error).toBeNull();
  });
});
