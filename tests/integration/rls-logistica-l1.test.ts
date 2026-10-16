// @vitest-environment node
// =============================================================================
// ADR-157 · F22 · H144 (L1 de ADR-149): cliente obligatorio para enviar (en el
// servidor), direcciones del cliente con RLS y copia de la dirección en la
// entrega, guardar la dirección al cobrar, aislamiento entre negocios y
// tablas de la Edge geo cerradas a los usuarios.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `adr157-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  other: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  stranger: SupabaseClient;
  userIds: string[];
  store: string;
  shift: string;
  mesa: string;
  ana: string;
  beto: string;
  anaAddress: string;
  dispatchId: string;
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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const sale = (customer: string | null, qty = 1) => ({
  p_items: [{ product_id: ctx.mesa, quantity: qty, unit_price: 1000, discount: 0 }],
  p_payments: [{ method: "cash", amount: 1000 * qty }],
  p_cash_shift_id: ctx.shift,
  ...(customer ? { p_customer_id: customer } : {}),
});
const envio = (extra: Record<string, unknown> = {}) => ({
  deliveries: [{ mode: "envio", items: [{ product_id: ctx.mesa, variant_id: null, qty: 1 }], ...extra }],
});
const NEW_ADDRESS = {
  street: "Belgrano",
  number: "50",
  locality: "Tigre",
  province: "Buenos Aires",
  province_code: "B",
  reference: "Portón verde",
  lat: -34.42,
  lng: -58.58,
  geo_source: "georef",
  geo_quality: "exacta",
  // Basura que el servidor tiene que descartar.
  tenant_id: "00000000-0000-0000-0000-000000000000",
  is_admin: true,
};

describe.skipIf(!enabled)("ADR-157 · L1: cliente obligatorio y direcciones (RLS + RPC reales)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin.from("tenants").insert({ name: `ADR157 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `ADR157 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["pedidos_despacho", "entregas_remitos", "depositos", "direcciones_geo"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajera-${STAMP}@test.local`, ctx.tenant, "cashier");
    const stranger = await makeUser(admin, `otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, stranger: stranger.client });
    ctx.userIds.push(owner.id, cashier.id, stranger.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;
    const ps = await admin.from("pos_settings").upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Mesa ${STAMP}`, price: 1000, cost: 500, stock: 0, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.mesa = (prod.data as { id: string }).id;

    const cust = await admin
      .from("customers")
      .insert([
        { tenant_id: ctx.tenant, name: `Ana ${STAMP}` },
        { tenant_id: ctx.tenant, name: `Beto ${STAMP}` },
      ])
      .select("id, name");
    if (cust.error || !cust.data) throw cust.error ?? new Error("customers");
    const rows = cust.data as { id: string; name: string }[];
    ctx.ana = rows.find((r) => r.name.startsWith("Ana"))!.id;
    ctx.beto = rows.find((r) => r.name.startsWith("Beto"))!.id;

    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("dispatch_items" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("dispatches" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("customer_addresses" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("geo_usage" as never).delete().in("tenant_id", [ctx.tenant, ctx.other]);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el servidor rechaza un envío sin cliente (también por pos_sale_create_fulfilled)", async () => {
    const a = await rpc(ctx.cashier, "pos_sale_create_delivery", { p_sale: sale(null), p_plan: envio({ ship_address: "Calle 9 100, Tigre" }) });
    expect(a.error?.message).toMatch(/customer_required_for_shipping/);
    const b = await rpc(ctx.cashier, "pos_sale_create_fulfilled", { p_sale: sale(null), p_plan: envio({ ship_address: "Calle 9 100, Tigre" }) });
    expect(b.error?.message).toMatch(/customer_required_for_shipping/);
    // Nada quedó a medias: la venta se deshizo con la entrega.
    const { count } = await ctx.admin.from("sales").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenant);
    expect(count ?? 0).toBe(0);
  });

  it("agregar un envío a una venta sin cliente también se rechaza", async () => {
    const s = await rpc(ctx.cashier, "create_sale", sale(null));
    expect(s.error).toBeNull();
    const d = await rpc(ctx.cashier, "dispatch_create_for_sale", {
      p_sale_id: (s.data as { sale_id: string }).sale_id,
      p_delivery: { delivery_type: "envio", ship_address: "Calle 9 100, Tigre" },
    });
    expect(d.error?.message).toMatch(/customer_required_for_shipping/);
  });

  it("cobra un envío con dirección nueva: la guarda en el cliente y la copia en la entrega", async () => {
    const r = await rpc(ctx.cashier, "pos_sale_create_delivery", {
      p_sale: sale(ctx.ana),
      p_plan: envio({ ship_to: NEW_ADDRESS, save_to_customer: true, notes: "Tocar timbre" }),
    });
    expect(r.error).toBeNull();
    const out = r.data as { sale_id: string; deliveries: { id: string; mode: string }[] };
    ctx.dispatchId = out.deliveries.find((d) => d.mode === "envio")!.id;
    const { data: disp } = await ctx.cashier
      .from("dispatches" as never)
      .select("ship_address, address_id, ship_to, notes")
      .eq("id", ctx.dispatchId)
      .single();
    const d = disp as unknown as { ship_address: string; address_id: string; ship_to: Record<string, unknown>; notes: string };
    expect(d.ship_address).toBe("Belgrano 50, Tigre, Buenos Aires");
    expect(d.notes).toBe("Tocar timbre");
    expect(d.ship_to).toMatchObject({ street: "Belgrano", number: "50", province_code: "B", lat: -34.42, geo_quality: "exacta" });
    expect(d.ship_to).not.toHaveProperty("tenant_id");
    expect(d.ship_to).not.toHaveProperty("is_admin");
    const { data: addrs } = await ctx.cashier.from("customer_addresses" as never).select("id, is_default, street").eq("customer_id", ctx.ana);
    const list = (addrs ?? []) as unknown as { id: string; is_default: boolean; street: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.is_default).toBe(true);
    expect(d.address_id).toBe(list[0]!.id);
    ctx.anaAddress = list[0]!.id;
  });

  it("con la dirección guardada: la entrega es una copia y no cambia si el cliente la edita", async () => {
    const r = await rpc(ctx.cashier, "pos_sale_create_delivery", {
      p_sale: sale(ctx.ana),
      p_plan: envio({ address_id: ctx.anaAddress }),
    });
    expect(r.error).toBeNull();
    const id = (r.data as { deliveries: { id: string; mode: string }[] }).deliveries.find((x) => x.mode === "envio")!.id;
    const e = await rpc(ctx.cashier, "customer_address_save", {
      p_customer_id: ctx.ana,
      p_id: ctx.anaAddress,
      p_data: { ...NEW_ADDRESS, number: "999" },
    });
    expect(e.error).toBeNull();
    const { data } = await ctx.cashier.from("dispatches" as never).select("ship_to, address_id").eq("id", id).single();
    const d = data as unknown as { ship_to: { number: string }; address_id: string };
    expect(d.address_id).toBe(ctx.anaAddress);
    expect(d.ship_to.number).toBe("50");
  });

  it("no se puede usar la dirección de otro cliente", async () => {
    const r = await rpc(ctx.cashier, "pos_sale_create_delivery", {
      p_sale: sale(ctx.beto),
      p_plan: envio({ address_id: ctx.anaAddress }),
    });
    expect(r.error?.message).toMatch(/address_not_found/);
  });

  it("RLS: otro negocio no ve ni escribe direcciones; nadie escribe la tabla directo", async () => {
    const { data } = await ctx.stranger.from("customer_addresses" as never).select("id").eq("id", ctx.anaAddress);
    expect(data ?? []).toHaveLength(0);
    const s = await rpc(ctx.stranger, "customer_address_save", { p_customer_id: ctx.ana, p_id: null, p_data: NEW_ADDRESS });
    expect(s.error?.message).toMatch(/customer_not_found/);
    const del = await rpc(ctx.stranger, "customer_address_delete", { p_id: ctx.anaAddress });
    expect(del.error?.message).toMatch(/address_not_found/);
    const ins = await ctx.owner.from("customer_addresses" as never).insert({ customer_id: ctx.ana, street: "Directa" } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.owner.from("customer_addresses" as never).update({ street: "Otra" } as never).eq("id", ctx.anaAddress).select("id");
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    const { data: disp } = await ctx.stranger.from("dispatches" as never).select("id").eq("id", ctx.dispatchId);
    expect(disp ?? []).toHaveLength(0);
  });

  it("tablas de la Edge geo cerradas a los usuarios", async () => {
    for (const t of ["geocode_cache", "geo_providers", "geo_usage"]) {
      const r = await ctx.owner.from(t as never).select("*").limit(1);
      expect(r.error !== null || (r.data ?? []).length === 0).toBe(true);
    }
    const g = await rpc(ctx.owner, "geo_rate_take", { p_tenant: ctx.tenant, p_kind: "suggest", p_per_minute: 1, p_per_day: 1 });
    expect(g.error).not.toBeNull();
    // service_role: cupo por minuto.
    const a = await rpc(ctx.admin, "geo_rate_take", { p_tenant: ctx.tenant, p_kind: "suggest", p_per_minute: 1, p_per_day: 5 });
    const b = await rpc(ctx.admin, "geo_rate_take", { p_tenant: ctx.tenant, p_kind: "suggest", p_per_minute: 1, p_per_day: 5 });
    expect([a.data, b.data]).toEqual(["ok", "tenant_minute"]);
    const guard = await rpc(ctx.admin, "geo_guard", { p_tenant: ctx.other, p_user: ctx.userIds[0] });
    expect(guard.data).toBe("forbidden");
  });

  it("borrar la predeterminada pasa a predeterminada la otra", async () => {
    const n = await rpc(ctx.cashier, "customer_address_save", {
      p_customer_id: ctx.ana,
      p_id: null,
      p_data: { street: "Mitre", number: "10", locality: "Tigre", label: "Depósito" },
    });
    expect(n.error).toBeNull();
    expect((n.data as { is_default: boolean; geo_quality: string }).is_default).toBe(false);
    expect((n.data as { geo_quality: string }).geo_quality).toBe("sin_geo");
    const del = await rpc(ctx.owner, "customer_address_delete", { p_id: ctx.anaAddress });
    expect(del.error).toBeNull();
    const { data } = await ctx.cashier
      .from("customer_addresses" as never)
      .select("id, is_default")
      .eq("customer_id", ctx.ana)
      .is("deleted_at", null);
    const list = (data ?? []) as unknown as { id: string; is_default: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.is_default).toBe(true);
    const bad = await rpc(ctx.cashier, "customer_address_save", { p_customer_id: ctx.ana, p_id: null, p_data: { street: "" } });
    expect(bad.error?.message).toMatch(/ship_to_invalid/);
  });
});
