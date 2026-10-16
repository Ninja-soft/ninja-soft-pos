// @vitest-environment node
// =============================================================================
// ADR-161 · F22 · H145 (L2 de ADR-149): flota, hojas de ruta y app del
// repartidor contra RLS y RPC reales. El Repartidor sólo ve y opera sus hojas:
// no ve ventas, caja, entregas ni clientes, no vende ni abre caja; los eventos
// son idempotentes por el id del teléfono y exigen lo que pide la
// configuración; lo no entregado vuelve a Expedición con su motivo; otro
// negocio no ve nada; las fotos van a la carpeta de la hoja.
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

const STAMP = `adr161-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const DRIVER_ROLE = "00000000-0000-4000-8000-0000000000a7";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  other: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  driver: SupabaseClient;
  stranger: SupabaseClient;
  driverId: string;
  userIds: string[];
  store: string;
  shift: string;
  mesa: string;
  ana: string;
  beto: string;
  vehicle: string;
  route: string;
  dispatches: string[];
  stopGeo: string;
  stopText: string;
};
const ctx = {} as Ctx;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string, roleId: string | null = null) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active", role_id: roleId });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
const uuid = () => crypto.randomUUID();

const sale = (customer: string, qty = 1) => ({
  p_items: [{ product_id: ctx.mesa, quantity: qty, unit_price: 1000, discount: 0 }],
  p_payments: [{ method: "cash", amount: 1000 * qty }],
  p_cash_shift_id: ctx.shift,
  p_customer_id: customer,
});

describe.skipIf(!enabled)("ADR-161 · L2: reparto propio y rol Repartidor (RLS + RPC reales)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin.from("tenants").insert({ name: `ADR161 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `ADR161 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["pedidos_despacho", "entregas_remitos", "depositos", "direcciones_geo", "reparto_propio"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajera-${STAMP}@test.local`, ctx.tenant, "cashier");
    const driver = await makeUser(admin, `chofer-${STAMP}@test.local`, ctx.tenant, "cashier", DRIVER_ROLE);
    const stranger = await makeUser(admin, `otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, driver: driver.client, stranger: stranger.client, driverId: driver.id });
    ctx.userIds.push(owner.id, cashier.id, driver.id, stranger.id);

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
        { tenant_id: ctx.tenant, name: `Ana ${STAMP}`, phone: "1155550000" },
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

    // Dos ventas con envío: Ana con dirección en el mapa, Beto en texto.
    const a = await rpc(cashier.client, "pos_sale_create_delivery", {
      p_sale: sale(ctx.ana, 2),
      p_plan: {
        deliveries: [
          {
            mode: "envio",
            items: [{ product_id: ctx.mesa, variant_id: null, qty: 2 }],
            ship_to: { street: "Belgrano", number: "50", locality: "Tigre", lat: -34.42, lng: -58.58, geo_source: "georef", geo_quality: "exacta" },
          },
        ],
      },
    });
    if (a.error) throw new Error(a.error.message);
    const b = await rpc(cashier.client, "pos_sale_create_delivery", {
      p_sale: sale(ctx.beto),
      p_plan: { deliveries: [{ mode: "envio", items: [{ product_id: ctx.mesa, variant_id: null, qty: 1 }], ship_address: "Mitre 10, Tigre" }] },
    });
    if (b.error) throw new Error(b.error.message);
    ctx.dispatches = [a, b].map((r) => (r.data as { deliveries: { id: string; mode: string }[] }).deliveries.find((d) => d.mode === "envio")!.id);
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    if (ctx.route) {
      const { data: files } = await admin.storage.from("logistics-media").list(`${ctx.tenant}/routes/${ctx.route}`);
      if (files?.length) await admin.storage.from("logistics-media").remove(files.map((f) => `${ctx.tenant}/routes/${ctx.route}/${f.name}`));
    }
    for (const t of ["delivery_events", "route_stop_dispatches", "route_stops", "remito_items", "remitos", "dispatch_items", "dispatches", "delivery_routes", "vehicle_photos", "vehicles", "driver_profiles", "logistics_origins", "logistics_settings", "customer_addresses"]) {
      await admin.from(t as never).delete().eq("tenant_id", ctx.tenant);
    }
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño carga el camión y arma la hoja; el Repartidor no puede", async () => {
    const v = await rpc(ctx.owner, "vehicle_save", { p_id: null, p: { name: "Camión 1", kind: "camion", plate: "ab 123 cd", capacity_kg: "1500" } });
    expect(v.error).toBeNull();
    ctx.vehicle = (v.data as { id: string; plate: string }).id;
    expect((v.data as { plate: string }).plate).toBe("AB 123 CD");
    const denied = await rpc(ctx.driver, "vehicle_save", { p_id: null, p: { name: "Moto" } });
    expect(denied.error?.message).toMatch(/forbidden_capability/);

    const r = await rpc(ctx.owner, "delivery_route_save", {
      p_id: null,
      p: { store_id: ctx.store, vehicle_id: ctx.vehicle, driver_user_id: ctx.driverId },
    });
    expect(r.error).toBeNull();
    ctx.route = (r.data as { id: string }).id;
    const add = await rpc(ctx.owner, "route_add_dispatches", { p_route: ctx.route, p_dispatch_ids: ctx.dispatches });
    expect(add.error).toBeNull();
    expect(add.data).toEqual({ added: 2, stops: 2 });
    // Una entrega no puede estar en dos hojas abiertas.
    const again = await rpc(ctx.owner, "route_add_dispatches", { p_route: ctx.route, p_dispatch_ids: [ctx.dispatches[0]] });
    expect(again.error?.message).toMatch(/dispatch_in_route/);
    const { data: stops } = await ctx.owner.from("route_stops" as never).select("id, lat").eq("route_id", ctx.route);
    const list = (stops ?? []) as unknown as { id: string; lat: number | null }[];
    ctx.stopGeo = list.find((s) => s.lat !== null)!.id;
    ctx.stopText = list.find((s) => s.lat === null)!.id;
    const plan = await rpc(ctx.owner, "route_set_status", { p_route: ctx.route, p_to: "planificada" });
    expect(plan.error).toBeNull();
  });

  it("el Repartidor no ve ventas, caja, entregas ni clientes, y no vende ni abre caja", async () => {
    for (const t of ["sales", "sale_items", "cash_shifts", "dispatches", "customers", "customer_addresses", "remitos", "vehicles"]) {
      const { data } = await ctx.driver.from(t as never).select("id").limit(5);
      expect(data ?? [], t).toHaveLength(0);
    }
    const s = await rpc(ctx.driver, "create_sale", { p_items: sale(ctx.ana).p_items, p_payments: sale(ctx.ana).p_payments, p_cash_shift_id: ctx.shift });
    expect(s.error?.message).toMatch(/store_not_allowed|forbidden_capability|forbidden/);
    const { data: reg } = await ctx.admin.from("cash_registers").select("id").eq("tenant_id", ctx.tenant).limit(1).single();
    const c = await rpc(ctx.driver, "open_cash_shift", { p_register_id: (reg as { id: string }).id, p_opening_amount: 0 });
    expect(c.error).not.toBeNull();
    const addr = await rpc(ctx.driver, "customer_address_save", { p_customer_id: ctx.ana, p_id: null, p_data: { street: "Otra 1" } });
    expect(addr.error).not.toBeNull();
    const isDriver = await rpc(ctx.driver, "is_driver_member");
    expect(isDriver.data).toBe(true);
    // El dueño y la cajera siguen viendo todo.
    const { data: cs } = await ctx.cashier.from("customers").select("id").eq("tenant_id", ctx.tenant);
    expect((cs ?? []).length).toBe(2);
  });

  it("ve sólo su hoja con lo necesario para entregar (por RPC)", async () => {
    const mine = await rpc(ctx.driver, "driver_my_routes");
    expect((mine.data as { id: string }[]).map((r) => r.id)).toEqual([ctx.route]);
    const d = await rpc(ctx.driver, "route_detail", { p_route: ctx.route });
    expect(d.error).toBeNull();
    const det = d.data as { stops: { contact_name: string; dispatches: { items: unknown[] }[] }[]; settings: { require_signature: boolean } };
    expect(det.stops).toHaveLength(2);
    expect(det.stops.some((s) => s.contact_name.startsWith("Ana"))).toBe(true);
    expect(det.stops[0]!.dispatches[0]!.items.length).toBeGreaterThan(0);
    expect(det.settings.require_signature).toBe(true);
    const { data: routes } = await ctx.driver.from("delivery_routes" as never).select("id");
    expect((routes ?? []).length).toBe(1);
  });

  it("sale, entrega con firma (idempotente) y lo no entregado vuelve a Expedición con el motivo", async () => {
    const startId = uuid();
    const st = await rpc(ctx.driver, "route_start", { p_route: ctx.route, p_event: { id: startId, lat: -34.4, lng: -58.55 } });
    expect(st.error).toBeNull();
    const dup = await rpc(ctx.driver, "route_start", { p_route: ctx.route, p_event: { id: startId } });
    expect((dup.data as { duplicate: boolean }).duplicate).toBe(true);

    // Sin firma no se puede (configuración por defecto).
    const noSig = await rpc(ctx.driver, "delivery_event_record", {
      p: { id: uuid(), type: "entregado", route_id: ctx.route, stop_id: ctx.stopGeo, lat: -34.42, lng: -58.58, received_by_name: "Ana" },
    });
    expect(noSig.error?.message).toMatch(/signature_required/);

    // La firma sube a la carpeta de la hoja; a la de vehículos, no.
    const sig = `${ctx.tenant}/routes/${ctx.route}/${uuid()}-firma.png`;
    const up = await ctx.driver.storage.from("logistics-media").upload(sig, new Blob(["png"], { type: "image/png" }), { contentType: "image/png" });
    expect(up.error).toBeNull();
    const upBad = await ctx.driver.storage
      .from("logistics-media")
      .upload(`${ctx.tenant}/vehicles/${ctx.vehicle}/x.png`, new Blob(["png"], { type: "image/png" }), { contentType: "image/png" });
    expect(upBad.error).not.toBeNull();

    // Lejos de la dirección sin confirmar: no.
    const far = await rpc(ctx.driver, "delivery_event_record", {
      p: { id: uuid(), type: "entregado", route_id: ctx.route, stop_id: ctx.stopGeo, lat: -34.5, lng: -58.58, received_by_name: "Ana", signature_path: sig },
    });
    expect(far.error?.message).toMatch(/too_far_from_stop/);

    const evId = uuid();
    const ev = { id: evId, type: "entregado", route_id: ctx.route, stop_id: ctx.stopGeo, lat: -34.4205, lng: -58.5801, received_by_name: "Ana", received_by_doc: "30.123.456", signature_path: sig };
    const ok = await rpc(ctx.driver, "delivery_event_record", { p: ev });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ ok: true, duplicate: false, stop_status: "entregada" });
    const okDup = await rpc(ctx.driver, "delivery_event_record", { p: ev });
    expect(okDup.data).toMatchObject({ ok: true, duplicate: true });
    const { count } = await ctx.admin.from("delivery_events" as never).select("id", { count: "exact", head: true }).eq("id", evId);
    expect(count).toBe(1);

    const failed = await rpc(ctx.driver, "delivery_event_record", {
      p: { id: uuid(), type: "no_entregado", route_id: ctx.route, stop_id: ctx.stopText, reason_key: "no_estaba" },
    });
    expect(failed.error).toBeNull();
    expect(failed.data).toMatchObject({ stop_status: "no_entregada", open_stops: 0 });

    const close = await rpc(ctx.driver, "route_close", { p_route: ctx.route, p_event: null });
    expect(close.error).toBeNull();
    expect((close.data as { summary: Record<string, number> }).summary).toMatchObject({ stops: 2, delivered: 1, failed: 1 });

    const { data: disp } = await ctx.owner
      .from("dispatches" as never)
      .select("id, status, delivered_to, route_id, delivery_attempts, last_failure_reason")
      .in("id", ctx.dispatches);
    const byId = new Map(((disp ?? []) as unknown as { id: string; status: string; delivered_to: string; route_id: string | null; delivery_attempts: number; last_failure_reason: string | null }[]).map((d) => [d.id, d]));
    expect(byId.get(ctx.dispatches[0]!)).toMatchObject({ status: "entregado", delivered_to: "Ana" });
    expect(byId.get(ctx.dispatches[1]!)).toMatchObject({ status: "listo", route_id: null, delivery_attempts: 1, last_failure_reason: "No estaba en el domicilio" });
  });

  it("otro negocio no ve hojas, eventos, flota ni fotos", async () => {
    for (const t of ["delivery_routes", "route_stops", "delivery_events", "vehicles", "logistics_settings"]) {
      const { data } = await ctx.stranger.from(t as never).select("*").limit(5);
      expect(data ?? [], t).toHaveLength(0);
    }
    const d = await rpc(ctx.stranger, "route_detail", { p_route: ctx.route });
    expect(d.error?.message).toMatch(/route_not_found/);
    const ev = await rpc(ctx.stranger, "delivery_event_record", {
      p: { id: uuid(), type: "llegada", route_id: ctx.route, stop_id: ctx.stopGeo },
    });
    expect(ev.error).not.toBeNull();
    const { data: files } = await ctx.stranger.storage.from("logistics-media").list(`${ctx.tenant}/routes/${ctx.route}`);
    expect(files ?? []).toHaveLength(0);
  });

  it("nadie escribe las tablas directo ni borra eventos", async () => {
    const ins = await ctx.owner.from("vehicles" as never).insert({ name: "Directo" } as never);
    expect(ins.error).not.toBeNull();
    const del = await ctx.owner.from("delivery_events" as never).delete().eq("route_id", ctx.route).select("id");
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
    const upd = await ctx.driver.from("delivery_routes" as never).update({ status: "borrador" } as never).eq("id", ctx.route).select("id");
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
  });

  it("el rol Repartidor sólo se asigna con reparto_propio en el plan", async () => {
    const { data: tu } = await ctx.admin.from("tenant_users").select("user_id").eq("tenant_id", ctx.tenant).eq("role", "cashier").neq("user_id", ctx.driverId).limit(1).single();
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant).eq("addon_key", "reparto_propio");
    const r = await rpc(ctx.owner, "permission_assign_role", { p_user: (tu as { user_id: string }).user_id, p_role_id: DRIVER_ROLE });
    expect(r.error?.message).toMatch(/feature_not_in_plan: reparto_propio|reparto_propio/);
  });
});
