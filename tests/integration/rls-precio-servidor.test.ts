// @vitest-environment node
// =============================================================================
// F18 · H100 (ADR-056): precio autoritativo en create_sale, cambio manual con
// PIN de supervisor, lista de precios aplicada, cobro en espera que se acredita
// con el snapshot e historial de precios con RLS.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio de una sucursal con dos cajas (multi_caja por addon),
// listas de precios, dueño (supervisor) y cajero. Otro negocio para la RLS.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `ps-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  ownerB: User;
  product: string;
  regs: string[];
  shiftCashier: string;
  store: string;
  list: string;
  userIds: string[];
};
const ctx = {} as Ctx;

async function signIn(email: string, headers?: Record<string, string>) {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

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
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  return { id, email, client: await signIn(email) };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const line = (price: number, extra: Record<string, unknown> = {}) => [
  { product_id: ctx.product, quantity: 1, unit_price: price, discount: 0, ...extra },
];
const cash = (amount: number) => [{ method: "cash", amount }];

function expected(err: { message: string } | null): number | null {
  const m = /price_mismatch:(.*)$/.exec(err?.message ?? "");
  if (!m) return null;
  return Number((JSON.parse(m[1]!) as { items: { expected: number }[] }).items[0]!.expected);
}

describe.skipIf(!enabled)("F18 · H100 precio autoritativo e historial", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `Precio ${STAMP}`, slug: `ps-${STAMP}`, status: "active" },
        { name: `Precio B ${STAMP}`, slug: `psb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = (t as { id: string; slug: string }[]).find((x) => x.slug === `ps-${STAMP}`)!.id;
    ctx.tenantB = (t as { id: string; slug: string }[]).find((x) => x.slug === `psb-${STAMP}`)!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_caja", "descuentos", "listas_precios", "mercado_pago", "cobros_en_espera"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.ownerB.id);

    // El dueño carga el producto (queda el alta en el historial con su usuario).
    const { data: prod, error: pErr } = await ctx.owner.client
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Producto ${STAMP}`, price: 100 } as never)
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = (prod as { id: string }).id;

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    ctx.store = (store as { id: string }).id;
    const { data: regs, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert([1, 2].map((n) => ({ store_id: ctx.store, name: `Caja ${n}` })) as never)
      .select("id");
    if (rErr || !regs) throw rErr ?? new Error("registers");
    ctx.regs = (regs as { id: string }[]).map((r) => r.id);

    const a = await rpc(ctx.owner.client, "open_cash_shift", { p_register_id: ctx.regs[0], p_opening_amount: 0 });
    if (a.error) throw new Error(a.error.message);
    const b = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: ctx.regs[1], p_opening_amount: 0 });
    if (b.error) throw new Error(b.error.message);
    ctx.shiftCashier = b.data as string;

    const pin = await rpc(ctx.owner.client, "supervisor_set_pin", { p_pin: "4826" });
    if (pin.error) throw new Error(pin.error.message);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("pending_charges").delete().eq("tenant_id", tenant);
      await admin.from("supervisor_auth_tokens").delete().eq("tenant_id", tenant);
      await admin.from("account_supervisor_pins").delete().eq("tenant_id", tenant);
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("rechaza un precio alterado con el esperado; acepta la tolerancia de redondeo", async () => {
    const bad = await rpc(ctx.cashier.client, "create_sale", { p_items: line(90), p_payments: cash(90) });
    expect(bad.error?.message).toMatch(/^price_mismatch:/);
    expect(expected(bad.error)).toBe(100);

    const ok = await rpc(ctx.cashier.client, "create_sale", { p_items: line(100.01), p_payments: cash(100.01) });
    expect(ok.error).toBeNull();
    const { data: it } = await ctx.admin
      .from("sale_items")
      .select("list_price, price_override_reason")
      .eq("sale_id", (ok.data as { sale_id: string }).sale_id)
      .single();
    expect(Number((it as { list_price: number }).list_price)).toBe(100);
  });

  it("aplica la lista de precios mostrador (% y precio puntual)", async () => {
    const { data: list, error } = await ctx.owner.client
      .from("price_lists")
      .insert({ tenant_id: ctx.tenant, name: "Mostrador", channel: "mostrador", adjustment_pct: 10 } as never)
      .select("id")
      .single();
    expect(error).toBeNull();
    ctx.list = (list as { id: string }).id;

    const old = await rpc(ctx.cashier.client, "create_sale", { p_items: line(100), p_payments: cash(100) });
    expect(expected(old.error)).toBe(110);
    const ok = await rpc(ctx.cashier.client, "create_sale", { p_items: line(110), p_payments: cash(110) });
    expect(ok.error).toBeNull();

    const { error: iErr } = await ctx.owner.client
      .from("price_list_items")
      .insert({ tenant_id: ctx.tenant, price_list_id: ctx.list, product_id: ctx.product, price: 95 } as never);
    expect(iErr).toBeNull();
    const fixed = await rpc(ctx.cashier.client, "create_sale", { p_items: line(95), p_payments: cash(95) });
    expect(fixed.error).toBeNull();

    const resolved = await rpc(ctx.cashier.client, "resolve_unit_price", { p_tenant: ctx.tenant, p_product: ctx.product });
    expect(Number(resolved.data)).toBe(95);
    const foreign = await rpc(ctx.ownerB.client, "resolve_unit_price", { p_tenant: ctx.tenant, p_product: ctx.product });
    expect(foreign.error?.message).toMatch(/forbidden/);
  });

  it("cambio manual: motivo obligatorio, PIN para el cajero y el supervisor sin PIN", async () => {
    const noReason = await rpc(ctx.cashier.client, "create_sale", {
      p_items: line(80, { price_override: true }),
      p_payments: cash(80),
    });
    expect(noReason.error?.message).toMatch(/price_override_reason_required/);

    const noPin = await rpc(ctx.cashier.client, "create_sale", {
      p_items: line(80, { price_override: true, override_reason: "Producto con falla" }),
      p_payments: cash(80),
    });
    expect(noPin.error?.message).toMatch(/supervisor_required:cambio_precio/);

    const auth = await rpc(ctx.cashier.client, "supervisor_authorize", {
      p_action: "cambio_precio",
      p_supervisor_id: ctx.owner.id,
      p_pin: "4826",
      p_amount: 15.79,
      p_reason: "Falla",
    });
    const tok = auth.data as { ok: boolean; token: string };
    expect(tok.ok).toBe(true);
    const withToken = await signIn(ctx.cashier.email, { "x-ninja-supervisor-token": tok.token });
    const ok = await rpc(withToken, "create_sale", {
      p_items: line(80, { price_override: true, override_reason: "Producto con falla" }),
      p_payments: cash(80),
    });
    expect(ok.error).toBeNull();
    const saleId = (ok.data as { sale_id: string }).sale_id;
    const { data: it } = await ctx.admin
      .from("sale_items")
      .select("unit_price, list_price, price_override_reason")
      .eq("sale_id", saleId)
      .single();
    expect(it).toMatchObject({ price_override_reason: "Producto con falla" });
    expect(Number((it as { list_price: number }).list_price)).toBe(95);
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("after_data")
      .eq("entity_id", saleId)
      .eq("action", "price_override");
    expect((logs ?? []).length).toBe(1);

    const owner = await rpc(ctx.owner.client, "create_sale", {
      p_items: line(120, { price_override: true, override_reason: "Ajuste del dueño" }),
      p_payments: cash(120),
    });
    expect(owner.error).toBeNull();
  });

  it("venta libre: tope por rol y apagada", async () => {
    const free = [{ product_id: null, name: "Varios", quantity: 1, unit_price: 60, discount: 0 }];
    const ok = await rpc(ctx.cashier.client, "create_sale", { p_items: free, p_payments: cash(60) });
    expect(ok.error).toBeNull();

    await ctx.admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, max_free_sale: { cashier: 50 } } as never, { onConflict: "tenant_id" });
    const capped = await rpc(ctx.cashier.client, "create_sale", { p_items: free, p_payments: cash(60) });
    expect(capped.error?.message).toMatch(/free_sale_exceeds_limit/);

    await ctx.admin
      .from("pos_settings")
      .update({ allow_free_sale: false, max_free_sale: {} } as never)
      .eq("tenant_id", ctx.tenant);
    const off = await rpc(ctx.cashier.client, "create_sale", { p_items: free, p_payments: cash(60) });
    expect(off.error?.message).toMatch(/free_sale_not_allowed/);
    await ctx.admin.from("pos_settings").update({ allow_free_sale: true } as never).eq("tenant_id", ctx.tenant);
  });

  it("el cobro en espera se acredita con el precio guardado aunque la lista cambie", async () => {
    const { data: intent, error } = await ctx.admin
      .from("mp_payment_intents")
      .insert({ tenant_id: ctx.tenant, amount: 95, provider_key: "mercadopago", status: "approved" })
      .select("id")
      .single();
    if (error || !intent) throw error ?? new Error("intent");
    const { data: pc, error: pcErr } = await ctx.admin
      .from("pending_charges")
      .insert({
        tenant_id: ctx.tenant,
        store_id: ctx.store,
        register_id: ctx.regs[1],
        cash_shift_id: ctx.shiftCashier,
        origin_shift_id: ctx.shiftCashier,
        created_by: ctx.cashier.id,
        sale_args: { items: line(95) },
        amount: 95,
        sale_total: 95,
        provider_key: "mercadopago",
        channel: "link",
        intent_id: (intent as { id: string }).id,
        status: "waiting",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      } as never)
      .select("id")
      .single();
    if (pcErr || !pc) throw pcErr ?? new Error("pending");

    // La lista sube después de estacionar.
    await ctx.owner.client.from("price_list_items").update({ price: 130 } as never).eq("price_list_id", ctx.list);

    const done = await rpc(ctx.cashier.client, "complete_pending_charge", { p_id: (pc as { id: string }).id, p_force: false });
    expect(done.error).toBeNull();
    expect((done.data as { status: string }).status).toBe("completed");
  });

  it("historial de precios: alta, lista y cambio, sólo para el negocio", async () => {
    await ctx.owner.client.from("products").update({ price: 150 } as never).eq("id", ctx.product);
    const { data: rows, error } = await ctx.owner.client
      .from("product_price_history" as never)
      .select("old_price, new_price, list_id, source, changed_by")
      .eq("product_id", ctx.product)
      .order("at", { ascending: true });
    expect(error).toBeNull();
    const list = (rows ?? []) as unknown as {
      old_price: number | null;
      new_price: number | null;
      list_id: string | null;
      source: string;
      changed_by: string | null;
    }[];
    expect(list[0]).toMatchObject({ old_price: null, source: "manual", changed_by: ctx.owner.id });
    expect(list.some((r) => r.list_id === ctx.list && r.source === "list")).toBe(true);
    expect(list.some((r) => Number(r.old_price) === 100 && Number(r.new_price) === 150)).toBe(true);

    const { data: foreign } = await ctx.ownerB.client
      .from("product_price_history" as never)
      .select("id")
      .eq("product_id", ctx.product);
    expect(foreign ?? []).toHaveLength(0);

    const write = await ctx.owner.client
      .from("product_price_history" as never)
      .insert({ tenant_id: ctx.tenant, product_id: ctx.product, new_price: 1 } as never);
    expect(write.error).not.toBeNull();
  });
});
