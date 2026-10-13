// @vitest-environment node
// =============================================================================
// ADR-093 (F4): create_sale y return_sale_v2 con tenant_id explícito.
//
// La migración 20261108600000 recrea las dos RPC copiando su definición más
// nueva y sólo agrega tenant_id = v_tenant en cada insert. Esta suite verifica
// que el resultado es exactamente el de antes (mismos totales, ítems, pagos,
// caja y stock que daba 20261108200000 con el mismo escenario) y que todas las
// filas quedan en el negocio del cajero.
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

const STAMP = `f4cs-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  shift: string;
  zapa: string;
  variant: string;
  combo: string;
  compA: string;
  compB: string;
  sale: string;
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

async function rowsOf(table: string, col: string, value: string) {
  const { data, error } = await ctx.admin.from(table as never).select("*").eq(col, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

describe.skipIf(!enabled)("ADR-093 · create_sale y return_sale_v2 con tenant_id explícito", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `F4CS ${STAMP}`, slug: `a-${STAMP}`, status: "active" },
        { name: `F4CSB ${STAMP}`, slug: `b-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `a-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `b-${STAMP}`)!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["variantes", "descuentos"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.cashier = cashier.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const ps = await admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Zapatilla ${STAMP}`, price: 500, cost: 200, stock: 0, has_variants: true, is_kit: false },
        { tenant_id: ctx.tenant, name: `CompA ${STAMP}`, price: 10, cost: 5, stock: 100, has_variants: false, is_kit: false },
        { tenant_id: ctx.tenant, name: `CompB ${STAMP}`, price: 10, cost: 5, stock: 100, has_variants: false, is_kit: false },
        { tenant_id: ctx.tenant, name: `Combo ${STAMP}`, price: 300, cost: 0, stock: 0, has_variants: false, is_kit: true },
      ])
      .select("id, name");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    const byName = (p: string) => prods.data!.find((x) => x.name.startsWith(p))!.id;
    ctx.zapa = byName("Zapatilla");
    ctx.compA = byName("CompA");
    ctx.compB = byName("CompB");
    ctx.combo = byName("Combo");

    const v = await admin
      .from("product_variants")
      .insert({ tenant_id: ctx.tenant, product_id: ctx.zapa, option1: "42", option2: "Negro", stock: 5 } as never)
      .select("id")
      .single();
    if (v.error || !v.data) throw v.error ?? new Error("variant");
    ctx.variant = (v.data as unknown as { id: string }).id;

    const kit = await admin.from("product_kit_components").insert([
      { tenant_id: ctx.tenant, kit_product_id: ctx.combo, component_product_id: ctx.compA, quantity: 2 },
      { tenant_id: ctx.tenant, kit_product_id: ctx.combo, component_product_id: ctx.compB, quantity: 1 },
    ] as never);
    if (kit.error) throw kit.error;

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
    for (const t of [ctx.tenant, ctx.tenantB]) {
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

  it("la venta da lo mismo que antes y todas sus filas quedan en el negocio del cajero", async () => {
    const s = await rpc(ctx.cashier, "create_sale", {
      p_items: [
        { product_id: ctx.zapa, variant_id: ctx.variant, quantity: 2, unit_price: 500, discount: 50 },
        { product_id: ctx.combo, quantity: 1, unit_price: 300, discount: 0 },
        { name: "Varios", quantity: 3, unit_price: 33.33, discount: 0 },
      ],
      p_payments: [
        { method: "cash", amount: 1000 },
        { method: "cash", amount: 349.99 },
      ],
      p_notes: "f4",
      p_cash_shift_id: ctx.shift,
    });
    expect(s.error).toBeNull();
    // Mismo resultado que la definición de 20261108200000 con este escenario.
    expect(Number(obj(s).total)).toBe(1349.99);
    expect(Number(obj(s).promo_discount)).toBe(0);
    expect(obj(s).reserve_taken).toEqual([]);
    expect(obj(s).offline_conflicts).toBeNull();
    ctx.sale = obj(s).sale_id as string;

    const [sale] = await rowsOf("sales", "id", ctx.sale);
    expect(sale).toMatchObject({ tenant_id: ctx.tenant, store_id: ctx.store, cash_shift_id: ctx.shift, status: "completed", notes: "f4" });
    expect(Number(sale!.subtotal)).toBe(1349.99);
    expect(Number(sale!.total)).toBe(1349.99);

    const items = await rowsOf("sale_items", "sale_id", ctx.sale);
    expect(items).toHaveLength(3);
    expect(items.every((r) => r.tenant_id === ctx.tenant)).toBe(true);
    const sub = items.map((r) => Number(r.subtotal)).sort((a, b) => a - b);
    expect(sub).toEqual([99.99, 300, 950]);
    const zap = items.find((r) => r.variant_id === ctx.variant)!;
    expect(zap.product_name).toBe(`Zapatilla ${STAMP} · 42 / Negro`);

    const pays = await rowsOf("payments", "sale_id", ctx.sale);
    expect(pays.map((p) => Number(p.amount)).sort((a, b) => a - b)).toEqual([349.99, 1000]);
    expect(pays.every((p) => p.tenant_id === ctx.tenant)).toBe(true);

    const cash = await rowsOf("cash_movements", "reference_id", ctx.sale);
    expect(cash).toHaveLength(2);
    expect(cash.every((m) => m.tenant_id === ctx.tenant && m.type === "sale" && m.cash_shift_id === ctx.shift)).toBe(true);

    const stock = await rowsOf("stock_movements", "reference_id", ctx.sale);
    const deltas = stock.map((m) => `${m.product_id}:${m.variant_id ?? "-"}:${Number(m.delta)}`).sort();
    expect(deltas).toEqual(
      [`${ctx.zapa}:${ctx.variant}:-2`, `${ctx.compA}:-:-2`, `${ctx.compB}:-:-1`].sort(),
    );
    expect(stock.every((m) => m.tenant_id === ctx.tenant && m.store_id === ctx.store && m.reason === "sale")).toBe(true);

    const { data: v } = await ctx.admin.from("product_variants").select("stock").eq("id", ctx.variant).single();
    expect(Number((v as unknown as { stock: number }).stock)).toBe(3);
  });

  it("la devolución da lo mismo que antes y sus filas quedan en el negocio", async () => {
    const items = await rowsOf("sale_items", "sale_id", ctx.sale);
    const zap = items.find((r) => r.variant_id === ctx.variant)!;
    const r = await rpc(ctx.cashier, "return_sale_v2", {
      p_sale_id: ctx.sale,
      p_items: [{ sale_item_id: zap.id, quantity: 1 }],
      p_refund: "cash",
      p_cash_shift_id: ctx.shift,
    });
    expect(r.error).toBeNull();
    expect(Number(obj(r).total)).toBe(475);
    expect(Number(obj(r).cash_refund)).toBe(475);
    expect(obj(r).stock_destination).toBe("resale");
    const ret = obj(r).return_id as string;

    const [row] = await rowsOf("sale_returns", "id", ret);
    expect(row).toMatchObject({ tenant_id: ctx.tenant, sale_id: ctx.sale, refund_method: "cash" });
    const cash = await rowsOf("cash_movements", "reference_id", ret);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ tenant_id: ctx.tenant, type: "expense", cash_shift_id: ctx.shift });
    expect(Number(cash[0]!.amount)).toBe(475);
  });

  it("otro negocio no ve la venta", async () => {
    const { data } = await ctx.ownerB.from("sales").select("id").eq("id", ctx.sale);
    expect(data ?? []).toEqual([]);
    const { data: items } = await ctx.ownerB.from("sale_items").select("id").eq("sale_id", ctx.sale);
    expect(items ?? []).toEqual([]);
  });
});
