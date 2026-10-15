// @vitest-environment node
// =============================================================================
// H10 · ADR-130: carrito y pedido del catálogo público.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// El cliente pide como anon; la cajera lo levanta y lo cobra en SU turno con
// el create_sale real; el cliente sigue el pedido con el token.
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// Las fechas se comparan en hora de Argentina (America/Argentina/Buenos_Aires).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `h10-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const AR_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

type Ctx = {
  admin: SupabaseClient;
  anon: SupabaseClient;
  tenant: string;
  other: string;
  slug: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  stranger: SupabaseClient;
  userIds: string[];
  cashierId: string;
  store: string;
  shift: string;
  campera: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

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

const token = () => `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;

function order(qty: number, extra: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    token: token(),
    items: [{ product_id: ctx.campera, variant_id: null, qty, unit_price: 1 }],
    delivery_type: "retiro",
    customer_name: "Ana Pérez",
    customer_phone: "11 4444-3333",
    customer_email: "ana@test.local",
    ...extra,
  };
}

describe.skipIf(!enabled)("H10 · pedidos desde el catálogo público (anon + RLS + create_sale real)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    ctx.userIds = [];
    ctx.slug = `cat-${STAMP}`;

    const t = await admin.from("tenants").insert({ name: `H10 ${STAMP}`, slug: ctx.slug, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `H10 B ${STAMP}`, slug: `catb-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["catalogo_publico", "catalogo_pedidos", "pedidos_despacho", "reservas_stock"].map((key) => ({
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
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, stranger: stranger.client, cashierId: cashier.id });
    ctx.userIds.push(owner.id, cashier.id, stranger.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const ps = await admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: true, order_config: { catalog: { enabled: true } } } as never, {
        onConflict: "tenant_id",
      });
    if (ps.error) throw ps.error;

    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Campera ${STAMP}`, price: 100, cost: 50, stock: 10, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.campera = (prod.data as { id: string }).id;

    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja 1" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("dispatches" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("stock_reservations" as never).update({ sale_order_id: null } as never).eq("tenant_id", ctx.tenant);
    await admin.from("sale_orders" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("stock_reservations" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("catalog_order_attempts" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("notifications").delete().eq("target_tenant_id", ctx.tenant);
    await admin.from("system_emails").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("criterio H10: el cliente pide como anon, la caja cobra, expedición entrega y el cliente lo sigue", async () => {
    const cat = await rpc(ctx.anon, "public_catalog", { p_slug: ctx.slug });
    expect(cat.error).toBeNull();
    expect((cat.data as { ordering: { enabled: boolean } | null }).ordering?.enabled).toBe(true);

    const o = order(3);
    const created = await rpc(ctx.anon, "public_catalog_order_create", { p_slug: ctx.slug, p_order: o });
    expect(created.error).toBeNull();
    const out = created.data as { ok: boolean; number: number; total: number; pickup_code: string };
    expect(out.ok).toBe(true);
    expect(Number(out.total)).toBe(300); // el precio del cliente (1) se ignora
    expect(out.pickup_code).toMatch(/^[0-9]{6}$/);

    // anon no lee tablas.
    const peek = await ctx.anon.from("sale_orders" as never).select("id");
    expect(peek.error ?? (peek.data as unknown[]).length === 0).toBeTruthy();

    // La cajera lo ve con su origen.
    const { data: row } = await ctx.cashier
      .from("sale_orders" as never)
      .select("id, status, source, customer_email, reservation_id, created_at")
      .eq("id", o.id)
      .single();
    const r = row as unknown as { status: string; source: string; customer_email: string; reservation_id: string; created_at: string };
    expect(r).toMatchObject({ status: "abierto", source: "catalogo_publico", customer_email: "ana@test.local" });
    expect(AR_DAY.format(new Date(r.created_at))).toBe(AR_DAY.format(new Date()));

    // Aviso en el centro de notificaciones y email encolado.
    const { data: notes } = await ctx.admin.from("notifications").select("type, title").eq("target_tenant_id", ctx.tenant);
    expect((notes ?? []).some((n) => (n as { type: string }).type === "pedidos")).toBe(true);
    const { data: mails } = await ctx.admin.from("system_emails").select("recipient, status").eq("tenant_id", ctx.tenant);
    expect((mails ?? []).some((m) => (m as { recipient: string }).recipient === "ana@test.local")).toBe(true);

    const taken = await rpc(ctx.cashier, "sale_order_take", { p_id: o.id });
    expect(taken.error).toBeNull();
    expect(JSON.stringify(taken.data)).not.toMatch(/public_token_hash|pickup_code_hash/);

    const paid = await rpc(ctx.cashier, "create_sale", {
      p_items: [{ product_id: ctx.campera, quantity: 3, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 300 }],
      p_extras: [{ kind: "reservation", id: r.reservation_id }],
      p_cash_shift_id: ctx.shift,
    });
    expect(paid.error).toBeNull();

    const st1 = await rpc(ctx.anon, "public_catalog_order_status", { p_token: o.token });
    const s1 = st1.data as { status: string; dispatch: { status: string } | null };
    expect(s1.status).toBe("cobrado");
    expect(s1.dispatch?.status).toBe("pendiente");

    const saleId = (paid.data as { sale_id: string }).sale_id;
    const { data: d } = await ctx.cashier.from("dispatches" as never).select("id").eq("sale_id", saleId).single();
    const dispId = (d as unknown as { id: string }).id;
    expect((await rpc(ctx.cashier, "dispatch_advance", { p_id: dispId, p_to: "listo" })).error).toBeNull();
    const ok = await rpc(ctx.cashier, "dispatch_deliver", { p_id: dispId, p_code: out.pickup_code, p_delivered_to: "Ana Pérez" });
    expect((ok.data as { ok: boolean }).ok).toBe(true);
    const st2 = await rpc(ctx.anon, "public_catalog_order_status", { p_token: o.token });
    expect((st2.data as { dispatch: { status: string } }).dispatch.status).toBe("entregado");
  });

  it("seguridad: stock del servidor, aislamiento, honeypot y feature", async () => {
    const over = await rpc(ctx.anon, "public_catalog_order_create", { p_slug: ctx.slug, p_order: order(50) });
    expect(over.error?.message).toMatch(/insufficient_available_stock/);

    const hp = await rpc(ctx.anon, "public_catalog_order_create", { p_slug: ctx.slug, p_order: order(1, { website: "spam" }) });
    expect((hp.data as { ok: boolean; number: number | null }).number).toBeNull();

    const foreign = await ctx.stranger.from("sale_orders" as never).select("id").eq("tenant_id", ctx.tenant);
    expect(foreign.data ?? []).toHaveLength(0);

    const peek = await ctx.cashier.from("catalog_order_attempts" as never).select("id");
    expect(peek.error ?? (peek.data as unknown[]).length === 0).toBeTruthy();

    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant).eq("addon_key", "catalogo_pedidos");
    const off = await rpc(ctx.anon, "public_catalog_order_create", { p_slug: ctx.slug, p_order: order(1) });
    expect(off.error?.message).toMatch(/catalog_orders_unavailable/);
  });
});
