// @vitest-environment node
// =============================================================================
// SEC-43 (ADR-187): clave de idempotencia en create_sale.
//
// Misma clave dos veces (o dos a la vez) → una venta, un movimiento de stock y
// uno de caja, y el mismo resultado. Sin clave → dos ventas, como siempre. La
// misma clave en otro negocio no choca.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `sec43-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Shop = { tenant: string; seller: SupabaseClient; shift: string; product: string };
type Ctx = { admin: SupabaseClient; a: Shop; b: Shop; userIds: string[] };
const ctx = { userIds: [] as string[] } as unknown as Ctx;

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

async function stockOf(product: string) {
  const { data, error } = await ctx.admin.from("products").select("stock").eq("id", product).single();
  if (error) throw error;
  return Number((data as unknown as { stock: number }).stock);
}

/** Negocio con dueño y cajero, sucursal, caja, turno del cajero y un producto con stock. */
async function makeShop(admin: SupabaseClient, tag: string): Promise<Shop> {
  const { data: t, error: tErr } = await admin
    .from("tenants")
    .insert({ name: `SEC43 ${tag} ${STAMP}`, slug: `${tag}-${STAMP}`, status: "active" })
    .select("id")
    .single();
  if (tErr || !t) throw tErr ?? new Error("tenant");
  const tenant = (t as { id: string }).id;
  const owner = await makeUser(admin, `owner-${tag}-${STAMP}@test.local`, tenant, "owner");
  const cashier = await makeUser(admin, `cajero-${tag}-${STAMP}@test.local`, tenant, "cashier");
  ctx.userIds.push(owner.id, cashier.id);

  const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
  if (st.error || !st.data) throw st.error ?? new Error("store");
  const store = (st.data as unknown as { id: string }).id;

  const ps = await admin
    .from("pos_settings")
    .upsert({ tenant_id: tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
  if (ps.error) throw ps.error;

  const pr = await admin
    .from("products")
    .insert({ tenant_id: tenant, name: `Yerba ${tag} ${STAMP}`, price: 1000, cost: 500, stock: 10 } as never)
    .select("id")
    .single();
  if (pr.error || !pr.data) throw pr.error ?? new Error("product");

  const reg = await owner.client
    .from("cash_registers")
    .insert({ store_id: store, name: "Caja 1" } as never)
    .select("id")
    .single();
  if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
  const sh = await rpc(cashier.client, "open_cash_shift", {
    p_register_id: (reg.data as unknown as { id: string }).id,
    p_opening_amount: 0,
  });
  if (sh.error) throw new Error(sh.error.message);

  return { tenant, seller: cashier.client, shift: sh.data as string, product: (pr.data as unknown as { id: string }).id };
}

const sell = (shop: Shop, key?: string) =>
  rpc(shop.seller, "create_sale", {
    p_items: [{ product_id: shop.product, quantity: 1, unit_price: 1000, discount: 0 }],
    p_payments: [{ method: "cash", amount: 1000 }],
    p_cash_shift_id: shop.shift,
    ...(key ? { p_client_request_id: key } : {}),
  });

describe.skipIf(!enabled)("SEC-43 · clave de idempotencia en create_sale", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.a = await makeShop(ctx.admin, "a");
    ctx.b = await makeShop(ctx.admin, "b");
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.a?.tenant, ctx.b?.tenant].filter(Boolean) as string[]) {
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
      // sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("misma clave dos veces: una venta, un movimiento de stock y uno de caja, mismo resultado", async () => {
    const key = randomUUID();
    const before = await stockOf(ctx.a.product);

    const first = await sell(ctx.a, key);
    expect(first.error).toBeNull();
    const again = await sell(ctx.a, key);
    expect(again.error).toBeNull();

    expect(obj(again)).toEqual(obj(first));
    expect(Number(obj(first).total)).toBe(1000);
    const saleId = obj(first).sale_id as string;

    const sales = await rowsOf("sales", "client_request_id", key);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ id: saleId, tenant_id: ctx.a.tenant, status: "completed" });
    expect(await rowsOf("stock_movements", "reference_id", saleId)).toHaveLength(1);
    expect(await rowsOf("cash_movements", "reference_id", saleId)).toHaveLength(1);
    expect(await rowsOf("payments", "sale_id", saleId)).toHaveLength(1);
    expect(await stockOf(ctx.a.product)).toBe(before - 1);
  });

  it("misma clave en dos envíos simultáneos: una sola venta", async () => {
    const key = randomUUID();
    const before = await stockOf(ctx.a.product);
    const [x, y] = await Promise.all([sell(ctx.a, key), sell(ctx.a, key)]);
    expect(x.error).toBeNull();
    expect(y.error).toBeNull();
    expect(obj(x).sale_id).toBe(obj(y).sale_id);
    expect(obj(x).number).toBe(obj(y).number);
    expect(await rowsOf("sales", "client_request_id", key)).toHaveLength(1);
    expect(await rowsOf("cash_movements", "reference_id", obj(x).sale_id as string)).toHaveLength(1);
    expect(await stockOf(ctx.a.product)).toBe(before - 1);
  });

  it("sin clave: dos envíos son dos ventas (comportamiento de siempre)", async () => {
    const before = await stockOf(ctx.a.product);
    const x = await sell(ctx.a);
    const y = await sell(ctx.a);
    expect(x.error).toBeNull();
    expect(y.error).toBeNull();
    expect(obj(x).sale_id).not.toBe(obj(y).sale_id);
    expect(Number(obj(y).number)).toBe(Number(obj(x).number) + 1);
    for (const r of [x, y]) {
      const [sale] = await rowsOf("sales", "id", obj(r).sale_id as string);
      expect(sale!.client_request_id).toBeNull();
    }
    expect(await stockOf(ctx.a.product)).toBe(before - 2);
  });

  it("la misma clave en otro negocio no choca", async () => {
    const key = randomUUID();
    const inA = await sell(ctx.a, key);
    const inB = await sell(ctx.b, key);
    expect(inA.error).toBeNull();
    expect(inB.error).toBeNull();
    expect(obj(inA).sale_id).not.toBe(obj(inB).sale_id);
    const rows = await rowsOf("sales", "client_request_id", key);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([ctx.a.tenant, ctx.b.tenant].sort());
  });

  it("el helper interno no se ejecuta desde el cliente", async () => {
    const r = await rpc(ctx.a.seller, "_sale_replay_result", { p_tenant: ctx.a.tenant, p_sale: randomUUID() });
    expect(r.error).not.toBeNull();
  });
});
