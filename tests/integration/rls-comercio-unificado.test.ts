// @vitest-environment node
// =============================================================================
// F16 primer corte (ADR-091): reservas de stock con retiro en tienda (H77),
// cockpit de comercio unificado (H76) y riesgo operativo (H82).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: un negocio con las tres features (dueño, cajero y solo lectura)
// y otro negocio sin ellas. El cajero vende en SU turno, abierto por él.
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `cu-${Math.random().toString(36).slice(2, 8)}`;
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
  storeB: string;
  product: string;
  register: string;
  shiftCashier: string;
  reservation: string;
  code: string;
  saleNumber: number;
  saleId: string;
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

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

async function sellOne(qty: number): Promise<{ id: string; number: number }> {
  const s = await rpc(ctx.cashier, "create_sale", {
    p_items: [{ product_id: ctx.product, quantity: qty, unit_price: 100, discount: 0 }],
    p_payments: [{ method: "cash", amount: 100 * qty }],
    p_cash_shift_id: ctx.shiftCashier,
  });
  if (s.error) throw new Error(s.error.message);
  const { data } = await ctx.admin
    .from("sales")
    .select("id, number")
    .eq("cash_shift_id", ctx.shiftCashier)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data as unknown as { id: string; number: number };
}

describe.skipIf(!enabled)("F16 · reservas, cockpit y riesgo operativo (ADR-091)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `CU ${STAMP}`, slug: `cu-${STAMP}`, status: "active" },
        { name: `CUB ${STAMP}`, slug: `cub-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `cu-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `cub-${STAMP}`)!.id;

    // Sólo el negocio A tiene las features. Todas las claves en cada fila.
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["cockpit_comercio", "reservas_stock", "prevencion_fraude"].map((key) => ({
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
    const stB = await ownerB.client.from("stores").insert({ name: "Otra" } as never).select("id").single();
    if (stB.error || !stB.data) throw stB.error ?? new Error("storeB");
    ctx.storeB = (stB.data as unknown as { id: string }).id;

    const prod = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Campera ${STAMP}`, sku: `CAM-${STAMP}`, price: 100, cost: 50, stock: 10 },
      ])
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.product = (prod.data as unknown as { id: string }).id;

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
    ctx.shiftCashier = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [ctx.tenant, ctx.tenantB]) {
      await admin.from("risk_flags" as never).delete().eq("tenant_id", t);
      await admin.from("risk_settings" as never).delete().eq("tenant_id", t);
      await admin.from("stock_reservations" as never).delete().eq("tenant_id", t);
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

  // ── H77 ─────────────────────────────────────────────────────────────────
  it("el cajero reserva y el código se devuelve una sola vez", async () => {
    const r = await rpc(ctx.cashier, "stock_reservation_create", {
      p_store_id: ctx.store,
      p_items: [{ product_id: ctx.product, variant_id: null, qty: 4 }],
      p_customer_name: "Ana",
      p_customer_doc: "30.123.456",
      p_channel: "whatsapp",
    });
    expect(r.error).toBeNull();
    const out = r.data as { id: string; number: number; pickup_code: string };
    expect(out.pickup_code).toMatch(/^\d{6}$/);
    ctx.reservation = out.id;
    ctx.code = out.pickup_code;

    const { data } = await ctx.owner
      .from("stock_reservations" as never)
      .select("pickup_code_hash, customer_doc, status")
      .eq("id", ctx.reservation)
      .single();
    const row = data as unknown as { pickup_code_hash: string; customer_doc: string; status: string };
    expect(row.pickup_code_hash).not.toContain(ctx.code);
    expect(row.customer_doc).toBe("30123456");
    expect(row.status).toBe("reservada");
  });

  it("lo reservado compromete el disponible: no se reserva dos veces lo mismo", async () => {
    const a = await rpc(ctx.owner, "stock_reservation_availability", {
      p_store_id: ctx.store,
      p_product_ids: [ctx.product],
    });
    expect(a.error).toBeNull();
    const row = (a.data as { reserved: number; available: number }[])[0]!;
    expect(Number(row.reserved)).toBe(4);
    expect(Number(row.available)).toBe(6);

    const r = await rpc(ctx.cashier, "stock_reservation_create", {
      p_store_id: ctx.store,
      p_items: [{ product_id: ctx.product, variant_id: null, qty: 7 }],
      p_customer_name: "Beto",
    });
    expect(r.error?.message).toMatch(/insufficient_available_stock/);
  });

  it("solo lectura no reserva; nadie escribe por REST; otro negocio no ve ni puede", async () => {
    const v = await rpc(ctx.viewer, "stock_reservation_create", {
      p_store_id: ctx.store,
      p_items: [{ product_id: ctx.product, variant_id: null, qty: 1 }],
      p_customer_name: "X",
    });
    expect(v.error?.message).toMatch(/forbidden/);

    const { error } = await ctx.owner.from("stock_reservations" as never).insert({
      tenant_id: ctx.tenant,
      number: 999,
      store_id: ctx.store,
      customer_name: "X",
      pickup_code_hash: "x",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    } as never);
    expect(error).not.toBeNull();

    const { data } = await ctx.ownerB.from("stock_reservations" as never).select("id").eq("id", ctx.reservation);
    expect(data ?? []).toHaveLength(0);
    const b = await rpc(ctx.ownerB, "stock_reservation_create", {
      p_store_id: ctx.storeB,
      p_items: [],
      p_customer_name: "X",
    });
    expect(b.error?.message).toMatch(/feature_not_in_plan: reservas_stock/);
  });

  it("un código incorrecto cuenta el intento y no entrega", async () => {
    const sale = await sellOne(4);
    ctx.saleNumber = sale.number;
    ctx.saleId = sale.id;
    const r = await rpc(ctx.cashier, "stock_reservation_deliver", {
      p_id: ctx.reservation,
      p_sale_number: ctx.saleNumber,
      p_code: ctx.code === "000000" ? "111111" : "000000",
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ ok: false, error: "pickup_code_invalid", attempts_left: 4 });
  });

  it("el cajero no entrega sin código (pide encargado)", async () => {
    const r = await rpc(ctx.cashier, "stock_reservation_deliver", {
      p_id: ctx.reservation,
      p_sale_number: ctx.saleNumber,
      p_override_reason: "Se olvidó el código",
    });
    expect(r.error?.message).toMatch(/override_requires_manager/);
  });

  it("criterio H77: retira en la sucursal con el código contra la venta cobrada en su turno", async () => {
    const r = await rpc(ctx.cashier, "stock_reservation_deliver", {
      p_id: ctx.reservation,
      p_sale_number: ctx.saleNumber,
      p_code: ctx.code,
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ ok: true, sale_id: ctx.saleId });

    // La misma venta no entrega otra reserva.
    const other = await rpc(ctx.cashier, "stock_reservation_create", {
      p_store_id: ctx.store,
      p_items: [{ product_id: ctx.product, variant_id: null, qty: 1 }],
      p_customer_name: "Carla",
      p_customer_doc: "20111222",
    });
    expect(other.error).toBeNull();
    const id = (other.data as { id: string }).id;
    const again = await rpc(ctx.cashier, "stock_reservation_deliver", {
      p_id: id,
      p_sale_number: ctx.saleNumber,
      p_customer_doc: "20.111.222",
    });
    expect(again.error?.message).toMatch(/sale_already_used/);

    const c = await rpc(ctx.cashier, "stock_reservation_cancel", { p_id: id, p_reason: "No vino" });
    expect(c.error).toBeNull();
  });

  // ── H76 ─────────────────────────────────────────────────────────────────
  it("criterio H76: el dueño ve canales, pedidos, pagos y stock comprometido en una lectura", async () => {
    const r = await rpc(ctx.owner, "commerce_cockpit", { p_store_id: null });
    expect(r.error).toBeNull();
    const c = r.data as {
      channels: { channel: string; sales: number }[];
      orders: { reservations_open: number };
      payments: { rejected: number };
      stock: { reserved_units: number };
      risk: unknown;
    };
    expect(c.channels.find((x) => x.channel === "retiro")?.sales).toBe(1);
    expect(typeof c.payments.rejected).toBe("number");
    expect(Number(c.stock.reserved_units)).toBe(0);
    expect(c.risk).not.toBeNull();
  });

  it("el cajero no ve el cockpit y otro negocio sin plan tampoco", async () => {
    const a = await rpc(ctx.cashier, "commerce_cockpit", {});
    expect(a.error?.message).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB, "commerce_cockpit", {});
    expect(b.error?.message).toMatch(/feature_not_in_plan: cockpit_comercio/);
  });

  // ── H82 ─────────────────────────────────────────────────────────────────
  it("criterio H82: una anulación de riesgo queda marcada y en la auditoría", async () => {
    const s = await rpc(ctx.owner, "risk_settings_save", {
      p_settings: { return_amount_high: 1, flag_score_min: 30 },
    });
    expect(s.error).toBeNull();
    expect(s.data).toMatchObject({ return_amount_high: 1, flag_score_min: 30 });

    const sale = await sellOne(1);
    const v = await rpc(ctx.owner, "void_sale", { p_sale_id: sale.id, p_reason: "Prueba de riesgo" });
    expect(v.error).toBeNull();

    const { data } = await ctx.owner
      .from("risk_flags" as never)
      .select("id, kind, score, reasons, status")
      .eq("entity_id", sale.id)
      .single();
    const flag = data as unknown as { id: string; kind: string; score: number; reasons: string[]; status: string };
    expect(flag.kind).toBe("void");
    expect(flag.reasons).toContain("monto_alto");
    expect(flag.status).toBe("pendiente");

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("entity_id", flag.id)
      .eq("action", "risk_flag_raised");
    expect(audit ?? []).toHaveLength(1);

    // El cajero no ve las marcas ni las señales.
    const { data: cs } = await ctx.cashier.from("risk_flags" as never).select("id");
    expect(cs ?? []).toHaveLength(0);
    const sig = await rpc(ctx.cashier, "operational_risk_signals", {
      p_from: new Date(Date.now() - 86_400_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(sig.error?.message).toMatch(/forbidden/);

    // Descartar pide nota; revisar queda auditado.
    const d = await rpc(ctx.owner, "risk_flag_review", { p_id: flag.id, p_status: "descartada" });
    expect(d.error?.message).toMatch(/note_required/);
    const ok = await rpc(ctx.owner, "risk_flag_review", { p_id: flag.id, p_status: "revisada", p_note: "Error de carga" });
    expect(ok.error).toBeNull();
  });

  it("señales por persona para el dueño", async () => {
    const r = await rpc(ctx.owner, "operational_risk_signals", {
      p_from: new Date(Date.now() - 86_400_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
      p_store_id: ctx.store,
    });
    expect(r.error).toBeNull();
    const people = (r.data as { people: { sales_count: number; voids_count: number }[] }).people;
    expect(people.reduce((a, p) => a + p.sales_count, 0)).toBeGreaterThanOrEqual(1);
    expect(people.reduce((a, p) => a + p.voids_count, 0)).toBe(1);
  });
});
