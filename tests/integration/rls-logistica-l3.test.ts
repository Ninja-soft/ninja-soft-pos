// @vitest-environment node
// =============================================================================
// ADR-164 · F22 · H146 (L3 de ADR-149): planificación entre camiones,
// seguimiento y desvíos contra RLS y RPC reales. El Repartidor sólo escribe
// sus posiciones (por RPC, en su hoja en curso) y ve su hoja; no ve el mapa
// en vivo, las últimas posiciones ni los avisos; las posiciones son
// idempotentes por el id del teléfono; 600 m por 5 minutos abre el aviso;
// otro negocio no ve nada.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `adr164-${Math.random().toString(36).slice(2, 8)}`;
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
  customers: string[];
  dispatches: string[];
  vehicles: string[];
  origin: string;
  routes: { id: string; number: number }[];
  startedAt: number;
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
const iso = (ms: number) => new Date(ms).toISOString();

describe.skipIf(!enabled)("ADR-164 · L3: planificación, seguimiento y desvíos (RLS + RPC reales)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin.from("tenants").insert({ name: `ADR164 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `ADR164 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["pedidos_despacho", "entregas_remitos", "direcciones_geo", "reparto_propio"].map((key) => ({
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
    await admin.from("pos_settings").upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Mesa ${STAMP}`, price: 1000, cost: 500, stock: 0, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.mesa = (prod.data as { id: string }).id;
    const cust = await admin
      .from("customers")
      .insert([1, 2, 3].map((i) => ({ tenant_id: ctx.tenant, name: `Cliente ${i} ${STAMP}` })))
      .select("id");
    if (cust.error || !cust.data) throw cust.error ?? new Error("customers");
    ctx.customers = (cust.data as { id: string }[]).map((c) => c.id);
    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;

    ctx.dispatches = [];
    for (const [i, c] of ctx.customers.entries()) {
      const r = await rpc(cashier.client, "pos_sale_create_delivery", {
        p_sale: {
          p_items: [{ product_id: ctx.mesa, quantity: 1, unit_price: 1000, discount: 0 }],
          p_payments: [{ method: "cash", amount: 1000 }],
          p_cash_shift_id: ctx.shift,
          p_customer_id: c,
        },
        p_plan: {
          deliveries: [
            {
              mode: "envio",
              items: [{ product_id: ctx.mesa, variant_id: null, qty: 1 }],
              ship_to: { street: "Calle", number: String(10 + i), locality: i < 2 ? "Tigre" : "Pilar", lat: -34.41 - i * 0.01, lng: -58.58, geo_source: "georef", geo_quality: "exacta" },
            },
          ],
        },
      });
      if (r.error) throw new Error(r.error.message);
      ctx.dispatches.push((r.data as { deliveries: { id: string; mode: string }[] }).deliveries.find((d) => d.mode === "envio")!.id);
    }

    ctx.vehicles = [];
    for (const name of ["Camión 1", "Camión 2"]) {
      const v = await rpc(owner.client, "vehicle_save", { p_id: null, p: { name, kind: "camion", capacity_packages: 10 } });
      if (v.error) throw new Error(v.error.message);
      ctx.vehicles.push((v.data as { id: string }).id);
    }
    const o = await rpc(owner.client, "logistics_origin_save", {
      p_id: null,
      p: {
        store_id: ctx.store,
        name: "Depósito",
        is_default: true,
        address: { street: "Depósito", number: "1", locality: "Tigre", lat: -34.4, lng: -58.58, geo_source: "pin", geo_quality: "exacta" },
      },
    });
    if (o.error) throw new Error(o.error.message);
    ctx.origin = (o.data as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [
      "route_positions_last", "route_alerts", "route_positions", "delivery_events", "route_stop_dispatches", "route_stops",
      "remito_items", "remitos", "dispatch_items", "dispatches", "delivery_routes", "route_plans", "route_tracking_settings",
      "vehicle_photos", "vehicles", "driver_profiles", "logistics_origins", "logistics_settings", "customer_addresses",
    ]) {
      await admin.from(t as never).delete().eq("tenant_id", ctx.tenant);
    }
    await admin.from("notifications").delete().eq("target_tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño confirma el reparto en dos camiones de una vez; el Repartidor no puede planificar", async () => {
    const p = {
      store_id: ctx.store,
      origin_id: ctx.origin,
      mode: "heuristica",
      routes: [
        {
          vehicle_id: ctx.vehicles[0],
          driver_user_id: ctx.driverId,
          dispatch_ids: [ctx.dispatches[0], ctx.dispatches[1]],
          distance_m: 4000,
          duration_s: 1200,
          path: [[-34.4, -58.58], [-34.41, -58.58], [-34.42, -58.58], [-34.4, -58.58]],
          offsets: { [ctx.dispatches[0]!]: 300, [ctx.dispatches[1]!]: 700 },
        },
        { vehicle_id: ctx.vehicles[1], dispatch_ids: [ctx.dispatches[2]] },
      ],
    };
    const denied = await rpc(ctx.driver, "route_plan_confirm", { p });
    expect(denied.error?.message).toMatch(/forbidden_capability/);
    const repeated = await rpc(ctx.owner, "route_plan_confirm", {
      p: { ...p, routes: [p.routes[0], { vehicle_id: ctx.vehicles[1], dispatch_ids: [ctx.dispatches[0]] }] },
    });
    expect(repeated.error?.message).toMatch(/dispatch_repeated/);

    const ok = await rpc(ctx.owner, "route_plan_confirm", { p });
    expect(ok.error).toBeNull();
    ctx.routes = (ok.data as { routes: { id: string; number: number }[] }).routes;
    expect(ctx.routes).toHaveLength(2);
    const { data: rows } = await ctx.owner
      .from("delivery_routes" as never)
      .select("id, status, plan_id, planned_path, planned_duration_s")
      .in("id", ctx.routes.map((r) => r.id));
    const byId = new Map(((rows ?? []) as unknown as { id: string; status: string; plan_id: string; planned_path: unknown[] | null; planned_duration_s: number | null }[]).map((r) => [r.id, r]));
    expect(byId.get(ctx.routes[0]!.id)).toMatchObject({ status: "planificada", planned_duration_s: 1200 });
    expect(byId.get(ctx.routes[0]!.id)!.planned_path).toHaveLength(4);
    expect(byId.get(ctx.routes[1]!.id)).toMatchObject({ status: "borrador" });
    const { data: stops } = await ctx.owner.from("route_stops" as never).select("planned_offset_s").eq("route_id", ctx.routes[0]!.id).order("seq");
    expect(((stops ?? []) as unknown as { planned_offset_s: number }[]).map((s) => s.planned_offset_s)).toEqual([300, 700]);
  });

  it("el Repartidor sale y manda posiciones en lote (idempotente); no escribe la tabla ni en otra hoja", async () => {
    const st = await rpc(ctx.driver, "route_start", { p_route: ctx.routes[0]!.id, p_event: { id: uuid() } });
    expect(st.error).toBeNull();
    ctx.startedAt = Date.now();
    const pts = [
      { id: uuid(), t: iso(ctx.startedAt - 4.5 * 60_000), lat: -34.405, lng: -58.5801, acc: 8, bat: 80 },
      { id: uuid(), t: iso(ctx.startedAt - 4 * 60_000), lat: -34.41, lng: -58.57, acc: 10 },
    ];
    const r1 = await rpc(ctx.driver, "route_positions_push", { p_route: ctx.routes[0]!.id, p_points: pts });
    expect(r1.error).toBeNull();
    expect(r1.data).toMatchObject({ ok: true, accepted: 2, alert: false });
    const dup = await rpc(ctx.driver, "route_positions_push", { p_route: ctx.routes[0]!.id, p_points: pts });
    expect(dup.data).toMatchObject({ accepted: 0 });

    const other = await rpc(ctx.driver, "route_positions_push", { p_route: ctx.routes[1]!.id, p_points: pts });
    expect(other.error?.message).toMatch(/forbidden_capability/);
    const direct = await ctx.driver.from("route_positions" as never).insert({
      id: uuid(), tenant_id: ctx.tenant, route_id: ctx.routes[0]!.id, user_id: ctx.driverId, recorded_at: iso(Date.now()), lat: -34, lng: -58,
    } as never);
    expect(direct.error).not.toBeNull();
    // La dueña no repartidora de la hoja tampoco manda posiciones por él.
    const byOwner = await rpc(ctx.owner, "route_positions_push", { p_route: ctx.routes[0]!.id, p_points: pts });
    expect(byOwner.error?.message).toMatch(/forbidden_capability/);
  });

  it("600 m fuera de la ruta por 5 minutos abre el aviso a dueño y encargado", async () => {
    const r = await rpc(ctx.driver, "route_positions_push", {
      p_route: ctx.routes[0]!.id,
      p_points: [{ id: uuid(), t: iso(ctx.startedAt + 60_000), lat: -34.415, lng: -58.568, acc: 12, spd: 8 }],
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ alert: true, new_alert: true });
    expect((r.data as { off_route_m: number }).off_route_m).toBeGreaterThan(600);
    const { count } = await ctx.admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("target_tenant_id", ctx.tenant)
      .like("title", "Un camión%");
    expect(count).toBe(2);
  });

  it("el Repartidor ve sus posiciones pero no el mapa en vivo, las últimas posiciones ni los avisos", async () => {
    const { data: mine } = await ctx.driver.from("route_positions" as never).select("id");
    expect((mine ?? []).length).toBe(3);
    for (const t of ["route_positions_last", "route_alerts"]) {
      const { data } = await ctx.driver.from(t as never).select("*");
      expect(data ?? [], t).toHaveLength(0);
    }
    const live = await rpc(ctx.driver, "route_live", { p_date: null, p_store: null });
    expect(live.error?.message).toMatch(/forbidden_capability/);
    const cashierLive = await rpc(ctx.cashier, "route_live", { p_date: null, p_store: null });
    expect(cashierLive.error?.message).toMatch(/forbidden_capability/);
    const save = await rpc(ctx.driver, "route_tracking_settings_save", { p: { interval_s: 15 } });
    expect(save.error?.message).toMatch(/forbidden_capability/);
  });

  it("el dueño ve el mapa en vivo, el recorrido y marca visto el aviso", async () => {
    const live = await rpc(ctx.owner, "route_live", { p_date: null, p_store: null });
    expect(live.error).toBeNull();
    const list = live.data as { id: string; last: { off_route_m: number } | null; alert: { id: string } | null; stops: unknown[]; driver: { name: string } | null }[];
    const r = list.find((x) => x.id === ctx.routes[0]!.id)!;
    expect(r.last?.off_route_m).toBeGreaterThan(600);
    expect(r.alert).not.toBeNull();
    expect(r.stops).toHaveLength(2);
    const track = await rpc(ctx.owner, "route_track", { p_route: ctx.routes[0]!.id, p_max: 100 });
    expect((track.data as { count: number }).count).toBe(3);
    const ack = await rpc(ctx.owner, "route_alert_ack", { p_alert: r.alert!.id });
    expect(ack.error).toBeNull();
    const after = await rpc(ctx.owner, "route_live", { p_date: null, p_store: null });
    expect((after.data as { id: string; alert: unknown }[]).find((x) => x.id === ctx.routes[0]!.id)!.alert).toBeNull();
    const saved = await rpc(ctx.owner, "route_tracking_settings_save", { p: { interval_s: 5, deviation_m: 800 } });
    expect(saved.data).toMatchObject({ interval_s: 10, deviation_m: 800, saved: true });
  });

  it("otro negocio no ve posiciones, avisos ni planes, ni manda posiciones", async () => {
    for (const t of ["route_positions", "route_positions_last", "route_alerts", "route_plans", "route_tracking_settings"]) {
      const { data } = await ctx.stranger.from(t as never).select("*").limit(5);
      expect(data ?? [], t).toHaveLength(0);
    }
    const push = await rpc(ctx.stranger, "route_positions_push", { p_route: ctx.routes[0]!.id, p_points: [] });
    expect(push.error).not.toBeNull();
    const track = await rpc(ctx.stranger, "route_track", { p_route: ctx.routes[0]!.id, p_max: 100 });
    expect(track.error).not.toBeNull();
  });

  it("al cerrar la hoja no se aceptan posiciones nuevas, pero sí las que quedaron en la cola antes del cierre", async () => {
    const close = await rpc(ctx.driver, "route_close", { p_route: ctx.routes[0]!.id, p_event: null });
    expect(close.error).toBeNull();
    const late = await rpc(ctx.driver, "route_positions_push", {
      p_route: ctx.routes[0]!.id,
      p_points: [
        { id: uuid(), t: iso(Date.now() - 30_000), lat: -34.41, lng: -58.58 },
        { id: uuid(), t: iso(Date.now() + 10 * 60_000), lat: -34.41, lng: -58.58 },
      ],
    });
    expect(late.error).toBeNull();
    expect(late.data).toMatchObject({ accepted: 1 });
  });
});
