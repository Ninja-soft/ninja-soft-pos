// @vitest-environment node
// =============================================================================
// Canales de delivery externos (ADR-102, migraciones 20261110200000 a
// 20261110200300): ingesta idempotente, comanda, acciones del local, cola
// saliente, facturación en el turno del cajero, cancelación con anulación de
// comanda y venta, y aislamiento entre negocios.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con la feature (dueño y cajero), negocio B sin ella.
// La "plataforma" es el service_role llamando a delivery_channel_ingest_event,
// como hace la Edge delivery_channel_webhook después de validar la firma.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `cdl-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  storeB: string;
  product: string;
  register: string;
  shiftCashier: string;
  conn: string;
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

const newOrderEvent = (eventId: string, orderId: string, extra: Record<string, unknown> = {}) => ({
  external_event_id: eventId,
  type: "order.new",
  external_order_id: orderId,
  order: {
    external_order_id: orderId,
    brand: "pedidosya",
    display_code: orderId.slice(-4),
    customer_name: "Ana",
    order_type: "delivery",
    address: "Córdoba 1234",
    items: [
      {
        external_id: `SIM-${STAMP}`,
        name: "Milanesa",
        quantity: 2,
        unit_price: 1200,
        modifiers: [{ external_id: "MOD-X", name: "Sin sal" }],
      },
      { external_id: "NO-MAP", name: "Gaseosa", quantity: 1, unit_price: 800 },
    ],
    ...extra,
  },
});

async function channelOrder(externalId: string) {
  const { data } = await ctx.admin
    .from("delivery_channel_orders" as never)
    .select("id, delivery_order_id, external_status, billing_status, sale_id, needs_review")
    .eq("connection_id", ctx.conn)
    .eq("external_order_id", externalId)
    .maybeSingle();
  return data as unknown as {
    id: string;
    delivery_order_id: string;
    external_status: string;
    billing_status: string;
    sale_id: string | null;
    needs_review: boolean;
  } | null;
}

describe.skipIf(!enabled)("Canales de delivery (ADR-102)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `CDL ${STAMP}`, slug: `cdl-${STAMP}`, status: "active" },
        { name: `CDLB ${STAMP}`, slug: `cdlb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `cdl-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `cdlb-${STAMP}`)!.id;

    // Multi-fila con todas las claves en cada fila (PostgREST no completa defaults).
    const { error: addonErr } = await admin.from("subscription_addons").insert([
      { tenant_id: ctx.tenant, addon_key: "canales_delivery", status: "active", source: "granted" },
      { tenant_id: ctx.tenantB, addon_key: "transferencia", status: "active", source: "granted" },
    ]);
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;
    const stB = await ownerB.client.from("stores").insert({ name: "Otro" } as never).select("id").single();
    if (stB.error || !stB.data) throw stB.error ?? new Error("storeB");
    ctx.storeB = (stB.data as unknown as { id: string }).id;

    const prod = await admin
      .from("products")
      .insert([{ tenant_id: ctx.tenant, name: `Milanesa ${STAMP}`, sku: `MILA-${STAMP}`, price: 1000, cost: 400, stock: 100 }])
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.product = (prod.data as unknown as { id: string }).id;

    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja 1" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    ctx.register = (reg.data as unknown as { id: string }).id;

    // El cajero abre SU turno.
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shiftCashier = sh.data as string;
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

  it("el dueño conecta el simulador y mapea; el cajero no puede", async () => {
    const c = await rpc(ctx.owner, "delivery_channel_connect", {
      p_provider: "simulador",
      p_store_id: ctx.store,
      p_label: "Simulador",
      p_external_store_id: null,
      p_settings: { default_prep_minutes: 15, commission_pct: 25 },
    });
    expect(c.error).toBeNull();
    ctx.conn = c.data as string;

    const m = await rpc(ctx.owner, "delivery_channel_map_set", {
      p_connection: ctx.conn,
      p_rows: [
        { kind: "product", external_id: `SIM-${STAMP}`, external_name: "Milanesa", product_id: ctx.product, modifier_option_id: null },
      ],
    });
    expect(m.error).toBeNull();

    const denied = await rpc(ctx.cashier, "delivery_channel_connect", { p_provider: "simulador", p_store_id: ctx.store });
    expect(denied.error?.message).toMatch(/forbidden/);
  });

  it("los secretos no se leen y nadie escribe tablas de canales por REST", async () => {
    const s = await ctx.owner.from("delivery_channel_secrets" as never).select("*");
    expect(s.error).not.toBeNull();
    const ins = await ctx.owner.from("delivery_channel_orders" as never).insert({ tenant_id: ctx.tenant } as never);
    expect(ins.error).not.toBeNull();
    const keys = await rpc(ctx.owner, "delivery_channel_credential_keys", { p_id: ctx.conn });
    expect((keys.data as { has_webhook_secret: boolean }).has_webhook_secret).toBe(true);
  });

  it("webhook duplicado no duplica pedido ni comanda", async () => {
    const ev = newOrderEvent("ev-1", `PY-${STAMP}-1`);
    const r1 = await rpc(ctx.admin, "delivery_channel_ingest_event", { p_connection: ctx.conn, p_event: ev, p_source: "webhook" });
    expect(r1.error).toBeNull();
    expect((r1.data as { status: string }).status).toBe("procesado");
    const r2 = await rpc(ctx.admin, "delivery_channel_ingest_event", { p_connection: ctx.conn, p_event: ev, p_source: "webhook" });
    expect((r2.data as { duplicate: boolean }).duplicate).toBe(true);
    const r3 = await rpc(ctx.admin, "delivery_channel_ingest_event", {
      p_connection: ctx.conn,
      p_event: { ...ev, external_event_id: `recon:PY-${STAMP}-1` },
      p_source: "reconciliacion",
    });
    expect((r3.data as { duplicate_order: boolean }).duplicate_order).toBe(true);

    const co = await channelOrder(`PY-${STAMP}-1`);
    expect(co?.external_status).toBe("nuevo");
    expect(co?.needs_review).toBe(true);
    const { data: orders } = await ctx.admin.from("delivery_orders" as never).select("id").eq("tenant_id", ctx.tenant);
    expect((orders as unknown[]).length).toBe(1);
    const { data: items } = await ctx.admin
      .from("delivery_order_items" as never)
      .select("id, fired_at, product_id, notes")
      .eq("order_id", co!.delivery_order_id);
    const list = items as unknown as { fired_at: string | null; product_id: string | null; notes: string | null }[];
    expect(list).toHaveLength(2);
    expect(list.every((i) => i.fired_at === null)).toBe(true);
    expect(list.find((i) => i.product_id === ctx.product)?.notes).toMatch(/Sin sal/);
  });

  it("el cajero acepta con tiempo de prep: comanda a cocina y aviso a la app", async () => {
    const co = await channelOrder(`PY-${STAMP}-1`);
    const r = await rpc(ctx.cashier, "delivery_channel_order_accept", { p_id: co!.id, p_prep_minutes: 25 });
    expect(r.error).toBeNull();
    const { data: items } = await ctx.admin
      .from("delivery_order_items" as never)
      .select("fired_at")
      .eq("order_id", co!.delivery_order_id);
    expect((items as unknown as { fired_at: string | null }[]).every((i) => i.fired_at)).toBe(true);
    const { data: ob } = await ctx.cashier.from("delivery_channel_outbox" as never).select("action, status").eq("channel_order_id", co!.id);
    expect(ob as unknown as { action: string }[]).toEqual([expect.objectContaining({ action: "accept", status: "pendiente" })]);
    // aceptar dos veces no pasa
    const again = await rpc(ctx.cashier, "delivery_channel_order_accept", { p_id: co!.id, p_prep_minutes: 25 });
    expect(again.error?.message).toMatch(/invalid_transition/);
  });

  it("la cola saliente toma con lease y reintenta con backoff", async () => {
    const claim = await rpc(ctx.admin, "delivery_channel_outbox_claim", { p_limit: 10, p_tenant: ctx.tenant });
    const rows = claim.data as { id: string; action: string }[];
    expect(rows.length).toBe(1);
    const res = await rpc(ctx.admin, "delivery_channel_outbox_result", {
      p_id: rows[0]!.id,
      p_ok: false,
      p_error: "timeout",
      p_response: null,
      p_retryable: true,
    });
    expect((res.data as { status: string }).status).toBe("pendiente");
    const again = await rpc(ctx.admin, "delivery_channel_outbox_claim", { p_limit: 10, p_tenant: ctx.tenant });
    expect((again.data as unknown[]).length).toBe(0);
  });

  it("el cajero cobra en SU turno con el medio plataforma y sin movimiento de caja", async () => {
    const up = await rpc(ctx.owner, "delivery_channel_update", { p_id: ctx.conn, p: { billing_mode: "auto" } });
    expect(up.error).toBeNull();
    const co = await channelOrder(`PY-${STAMP}-1`);
    const r = await rpc(ctx.cashier, "delivery_channel_order_picked_up", { p_id: co!.id, p_cash_shift_id: null });
    expect(r.error).toBeNull();
    expect((r.data as { billing_error: string | null }).billing_error).toBeNull();

    const after = await channelOrder(`PY-${STAMP}-1`);
    expect(after?.billing_status).toBe("facturado");
    const { data: sale } = await ctx.admin.from("sales").select("id, cash_shift_id, total, status").eq("id", after!.sale_id!).single();
    expect(sale?.cash_shift_id).toBe(ctx.shiftCashier);
    expect(Number(sale?.total)).toBe(3200);
    const { data: pays } = await ctx.admin.from("payments").select("method, amount").eq("sale_id", after!.sale_id!);
    expect(pays).toEqual([expect.objectContaining({ method: "plataforma" })]);
    const { data: mov } = await ctx.admin.from("cash_movements").select("id").eq("reference_id", after!.sale_id!);
    expect(mov).toEqual([]);
  });

  it("la cancelación de la app anula la venta facturada", async () => {
    const r = await rpc(ctx.admin, "delivery_channel_ingest_event", {
      p_connection: ctx.conn,
      p_event: { external_event_id: "ev-c1", type: "order.cancelled", external_order_id: `PY-${STAMP}-1`, reason: "Cliente arrepentido" },
      p_source: "webhook",
    });
    expect((r.data as { status: string }).status).toBe("procesado");
    const co = await channelOrder(`PY-${STAMP}-1`);
    expect(co?.external_status).toBe("cancelado");
    expect(co?.billing_status).toBe("anulado");
    const { data: sale } = await ctx.admin.from("sales").select("status").eq("id", co!.sale_id!).single();
    expect(sale?.status).toBe("voided");
  });

  it("auto-aceptar manda la comanda sola y la cancelación la anula con motivo", async () => {
    await rpc(ctx.owner, "delivery_channel_update", { p_id: ctx.conn, p: { auto_accept: true } });
    const ext = `PY-${STAMP}-2`;
    await rpc(ctx.admin, "delivery_channel_ingest_event", { p_connection: ctx.conn, p_event: newOrderEvent("ev-2", ext), p_source: "webhook" });
    const co = await channelOrder(ext);
    expect(co?.external_status).toBe("aceptado");
    await rpc(ctx.admin, "delivery_channel_ingest_event", {
      p_connection: ctx.conn,
      p_event: { external_event_id: "ev-2c", type: "order.cancelled", external_order_id: ext, reason: "Sin repartidor" },
      p_source: "webhook",
    });
    const { data: voids } = await ctx.cashier
      .from("delivery_order_voids" as never)
      .select("reason, order_id")
      .eq("order_id", co!.delivery_order_id);
    const v = voids as unknown as { reason: string }[];
    expect(v.length).toBe(2);
    expect(v[0]!.reason).toMatch(/Sin repartidor/);
    const { data: kds } = (await ctx.cashier.rpc("kds_tickets" as never, { p_station: null } as never)) as unknown as {
      data: { order_id: string }[];
    };
    expect((kds ?? []).some((k) => k.order_id === co!.delivery_order_id)).toBe(false);
  });

  it("el cajero ve los pedidos pero no los eventos crudos", async () => {
    const { data: orders } = await ctx.cashier.from("delivery_channel_orders" as never).select("id");
    expect((orders as unknown[]).length).toBe(2);
    const { data: events } = await ctx.cashier.from("delivery_channel_events" as never).select("id");
    expect(events).toEqual([]);
    const { data: ownerEvents } = await ctx.owner.from("delivery_channel_events" as never).select("id");
    expect((ownerEvents as unknown[]).length).toBeGreaterThan(0);
  });

  it("otro negocio no ve nada, no conecta sin la feature y no toca pedidos ajenos", async () => {
    for (const t of ["delivery_channel_orders", "delivery_channel_connections", "delivery_channel_events", "delivery_channel_outbox"]) {
      const { data } = await ctx.ownerB.from(t as never).select("id");
      expect(data, t).toEqual([]);
    }
    const c = await rpc(ctx.ownerB, "delivery_channel_connect", { p_provider: "simulador", p_store_id: ctx.storeB });
    expect(c.error?.message).toMatch(/feature_not_in_plan/);
    const co = await channelOrder(`PY-${STAMP}-2`);
    const touch = await rpc(ctx.ownerB, "delivery_channel_order_ready", { p_id: co!.id });
    expect(touch.error).not.toBeNull();
  });
});
