// @vitest-environment node
// =============================================================================
// ADR-165 · F22 · H148 (L5 de ADR-149): expedición robusta contra RLS y RPC
// reales. Escaneo obligatorio al armar y al cargar (con cruce registrado),
// rotura al armar, entrega en la calle con 1 roto y 1 rechazado (stock,
// merma y entrega hija correctos), resolver lo rechazado, pedir stock a otra
// sucursal (vuelve sola al recibir el traslado) y aislamiento: el
// Repartidor y otro negocio no leen controles, lecturas ni roturas.
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

const STAMP = `adr165-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const DRIVER_ROLE = "00000000-0000-4000-8000-0000000000a7";

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) => c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
const uuid = () => crypto.randomUUID();

const ctx = {} as {
  admin: SupabaseClient;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  driver: SupabaseClient;
  stranger: SupabaseClient;
  driverId: string;
  userIds: string[];
  tenant: string;
  other: string;
  s1: string;
  s2: string;
  shift: string;
  cust: string;
  p: Record<"mesa" | "silla" | "lamp" | "vaso" | "otro", string>;
  da: string;
  db: string;
  items: Record<string, string>;
  route: string;
  stop: string;
};

async function makeUser(email: string, tenantId: string, role: string, roleId: string | null = null) {
  const { data, error } = await ctx.admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, app_metadata: { current_tenant_id: tenantId } });
  if (error) throw error;
  const id = data.user!.id;
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await ctx.admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active", role_id: roleId });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  ctx.userIds.push(id);
  return { id, client };
}

async function stock(store: string, product: string): Promise<number> {
  const { data } = await ctx.admin.from("product_stock").select("qty").eq("store_id", store).eq("product_id", product).is("variant_id", null).maybeSingle();
  return Number((data as { qty?: number } | null)?.qty ?? 0);
}

describe.skipIf(!enabled)("ADR-165 · L5: expedición robusta (RLS + RPC + stock reales)", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const t = await ctx.admin.from("tenants").insert({ name: `ADR165 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error) throw t.error;
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await ctx.admin.from("tenants").insert({ name: `ADR165 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error) throw t2.error;
    ctx.other = (t2.data as { id: string }).id;
    const { error: addErr } = await ctx.admin.from("subscription_addons").insert(
      ["pedidos_despacho", "entregas_remitos", "depositos", "direcciones_geo", "reparto_propio", "multi_sucursal", "traslados", "stock_sucursales"].map((k) => ({
        tenant_id: ctx.tenant,
        addon_key: k,
        status: "active",
        source: "granted",
      })),
    );
    if (addErr) throw addErr;
    const owner = await makeUser(`owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(`cajera-${STAMP}@test.local`, ctx.tenant, "cashier");
    const driver = await makeUser(`chofer-${STAMP}@test.local`, ctx.tenant, "cashier", DRIVER_ROLE);
    const stranger = await makeUser(`otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, driver: driver.client, stranger: stranger.client, driverId: driver.id });

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error) throw st.error;
    ctx.s1 = (st.data as unknown as { id: string }).id;
    const st2 = await owner.client.from("stores").insert({ name: "Norte" } as never).select("id").single();
    if (st2.error) throw st2.error;
    ctx.s2 = (st2.data as unknown as { id: string }).id;
    await ctx.admin.from("pos_settings").upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });

    const prods = await ctx.admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Mesa ${STAMP}`, price: 1000, cost: 500, stock: 0, track_stock: true, barcode: `${STAMP}-1`, sku: `M-${STAMP}` },
        { tenant_id: ctx.tenant, name: `Silla ${STAMP}`, price: 500, cost: 200, stock: 0, track_stock: true, barcode: `${STAMP}-2`, sku: `S-${STAMP}` },
        { tenant_id: ctx.tenant, name: `Lampara ${STAMP}`, price: 300, cost: 100, stock: 0, track_stock: true, sku: `L-${STAMP}` },
        { tenant_id: ctx.tenant, name: `Vaso ${STAMP}`, price: 100, cost: 40, stock: 0, track_stock: true, barcode: `${STAMP}-4`, sku: `V-${STAMP}` },
        { tenant_id: ctx.tenant, name: `Otro ${STAMP}`, price: 100, cost: 40, stock: 0, track_stock: true, barcode: `${STAMP}-9`, sku: `O-${STAMP}` },
      ])
      .select("id, name");
    if (prods.error) throw prods.error;
    const by = (n: string) => (prods.data as { id: string; name: string }[]).find((x) => x.name.startsWith(n))!.id;
    ctx.p = { mesa: by("Mesa"), silla: by("Silla"), lamp: by("Lampara"), vaso: by("Vaso"), otro: by("Otro") };
    for (const [store, prod, qty] of [
      [ctx.s1, ctx.p.mesa, 10],
      [ctx.s1, ctx.p.silla, 10],
      [ctx.s1, ctx.p.lamp, 10],
      [ctx.s2, ctx.p.vaso, 5],
    ] as const) {
      const r = await rpc(ctx.admin, "transfer_move_stock", { p_tenant: ctx.tenant, p_store: store, p_product: prod, p_variant: null, p_delta: qty, p_reason: "adjustment", p_transfer: null, p_notes: "test" });
      if (r.error) throw new Error(r.error.message);
    }
    const c = await ctx.admin.from("customers").insert({ tenant_id: ctx.tenant, name: `Ana ${STAMP}`, phone: "1155550000" }).select("id").single();
    if (c.error) throw c.error;
    ctx.cust = (c.data as { id: string }).id;
    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.s1, name: "Caja" } as never).select("id").single();
    if (reg.error) throw reg.error;
    const sh = await rpc(ctx.owner, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;

    const sell = async (lines: [string, number, number][]) => {
      const r = await rpc(ctx.owner, "pos_sale_create_fulfilled", {
        p_sale: {
          p_items: lines.map(([id, q, price]) => ({ product_id: id, quantity: q, unit_price: price, discount: 0 })),
          p_payments: [{ method: "cash", amount: lines.reduce((a, [, q, pr]) => a + q * pr, 0) }],
          p_cash_shift_id: ctx.shift,
          p_customer_id: ctx.cust,
        },
        p_plan: { deliveries: [{ mode: "envio", ship_address: "Belgrano 50, Tigre", items: lines.map(([id, q]) => ({ product_id: id, qty: q })) }] },
      });
      if (r.error) throw new Error(r.error.message);
      return (r.data as { deliveries: { id: string; mode: string }[] }).deliveries.find((d) => d.mode === "envio")!.id;
    };
    ctx.da = await sell([
      [ctx.p.mesa, 2, 1000],
      [ctx.p.silla, 2, 500],
      [ctx.p.lamp, 1, 300],
    ]);
    ctx.db = await sell([[ctx.p.vaso, 1, 100]]);
    const { data: its } = await ctx.admin.from("dispatch_items").select("id, product_id").in("dispatch_id", [ctx.da, ctx.db]);
    ctx.items = Object.fromEntries((its as { id: string; product_id: string }[]).map((i) => [i.product_id, i.id]));
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of ["dispatch_scan_log", "dispatch_item_checks", "dispatch_damages", "delivery_events", "route_stop_dispatches", "route_stops", "dispatch_items", "dispatches", "delivery_routes", "vehicles", "stock_transfer_items", "stock_transfers", "logistics_settings"]) {
      await admin.from(t as never).delete().eq("tenant_id", ctx.tenant);
    }
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("escaneo obligatorio al armar: no pasa a Listo sin completar; el cruce queda registrado", async () => {
    const s = await rpc(ctx.owner, "expedition_settings_save", { p: { scan_on_pick: "obligatorio", scan_on_load: "obligatorio", scan_on_deliver: "opcional" } });
    expect(s.error).toBeNull();
    const deny = await rpc(ctx.cashier, "expedition_settings_save", { p: { scan_on_pick: "no" } });
    expect(deny.error?.message).toMatch(/forbidden_capability/);
    expect((await rpc(ctx.owner, "dispatch_advance", { p_id: ctx.da, p_to: "armando" })).error).toBeNull();
    expect((await rpc(ctx.owner, "dispatch_advance", { p_id: ctx.da, p_to: "listo" })).error?.message).toMatch(/pick_scan_incomplete/);
    const sc = (code: string, qty = 1) => rpc(ctx.cashier, "dispatch_scan", { p: { id: uuid(), stage: "armado", dispatch_id: ctx.da, code, qty } });
    expect(((await sc(`${STAMP}-1`, 2)).data as { result: string }).result).toBe("ok");
    const cross = (await sc(`${STAMP}-4`)).data as { result: string; other_dispatch_number: number };
    expect(cross.result).toBe("cruce");
    expect(((await sc(`${STAMP}-9`)).data as { result: string }).result).toBe("ajeno");
    await sc(`${STAMP}-2`, 2);
    await sc(`L-${STAMP}`);
    expect((await rpc(ctx.owner, "dispatch_advance", { p_id: ctx.da, p_to: "listo" })).error).toBeNull();
    const { data: log } = await ctx.owner.from("dispatch_scan_log" as never).select("result").eq("dispatch_id", ctx.da);
    expect(((log ?? []) as { result: string }[]).map((r) => r.result).sort()).toEqual(["ajeno", "cruce", "ok", "ok", "ok"].sort());
  });

  it("rotura al armar: merma de 1 silla con foto y la entrega sigue igual", async () => {
    const before = await stock(ctx.s1, ctx.p.silla);
    const noPhoto = await rpc(ctx.owner, "dispatch_damage_report", { p: { dispatch_id: ctx.da, reason: "roto", items: [{ item_id: ctx.items[ctx.p.silla], qty: 1 }] } });
    expect(noPhoto.error?.message).toMatch(/damage_photo_required/);
    const bad = await rpc(ctx.owner, "dispatch_damage_report", {
      p: { dispatch_id: ctx.da, reason: "roto", photo_paths: [`${ctx.tenant}/routes/${uuid()}/x.webp`], items: [{ item_id: ctx.items[ctx.p.silla], qty: 1 }] },
    });
    expect(bad.error?.message).toMatch(/invalid_media_path/);
    const ok = await rpc(ctx.owner, "dispatch_damage_report", {
      p: { dispatch_id: ctx.da, reason: "roto", note: "Se cayó", photo_paths: [`${ctx.tenant}/dispatches/${ctx.da}/rotura.webp`], items: [{ item_id: ctx.items[ctx.p.silla], qty: 1 }] },
    });
    expect(ok.error).toBeNull();
    expect(await stock(ctx.s1, ctx.p.silla)).toBe(before - 1);
    const { data: it } = await ctx.owner.from("dispatch_items").select("qty").eq("id", ctx.items[ctx.p.silla]).single();
    expect(Number((it as { qty: number }).qty)).toBe(2);
  });

  it("carga obligatoria y entrega con 1 roto y 1 rechazado: stock, merma e hija correctos", async () => {
    const v = await rpc(ctx.owner, "vehicle_save", { p_id: null, p: { name: "Camión", kind: "camion", plate: "AB123CD" } });
    const r = await rpc(ctx.owner, "delivery_route_save", { p_id: null, p: { store_id: ctx.s1, vehicle_id: (v.data as { id: string }).id, driver_user_id: ctx.driverId } });
    ctx.route = (r.data as { id: string }).id;
    await rpc(ctx.owner, "route_add_dispatches", { p_route: ctx.route, p_dispatch_ids: [ctx.da] });
    await rpc(ctx.owner, "route_set_status", { p_route: ctx.route, p_to: "planificada" });
    const { data: rsd } = await ctx.owner.from("route_stop_dispatches" as never).select("stop_id").eq("route_id", ctx.route).single();
    ctx.stop = (rsd as unknown as { stop_id: string }).stop_id;

    expect((await rpc(ctx.driver, "route_start", { p_route: ctx.route, p_event: null })).error?.message).toMatch(/load_scan_incomplete/);
    const items = await rpc(ctx.driver, "route_items", { p_route: ctx.route });
    expect(items.error).toBeNull();
    for (const [code, qty] of [[`${STAMP}-1`, 2], [`${STAMP}-2`, 2], [`L-${STAMP}`, 1]] as const) {
      const x = await rpc(ctx.driver, "dispatch_scan", { p: { id: uuid(), stage: "carga", route_id: ctx.route, code, qty } });
      expect(x.error).toBeNull();
    }
    expect((await rpc(ctx.driver, "route_start", { p_route: ctx.route, p_event: { id: uuid() } })).error).toBeNull();

    const before = { mesa: await stock(ctx.s1, ctx.p.mesa), silla: await stock(ctx.s1, ctx.p.silla), lamp: await stock(ctx.s1, ctx.p.lamp) };
    const ev = {
      id: uuid(),
      route_id: ctx.route,
      stop_id: ctx.stop,
      lat: -34.42,
      lng: -58.58,
      received_by_name: "Ana",
      signature_path: `${ctx.tenant}/routes/${ctx.route}/firma.png`,
      damage_reason: "roto",
      damage_photo_paths: [`${ctx.tenant}/routes/${ctx.route}/rotura.webp`],
      foreign_codes: [`${STAMP}-4`],
      dispatches: [
        {
          dispatch_id: ctx.da,
          items: [
            { item_id: ctx.items[ctx.p.mesa], delivered: 2 },
            { item_id: ctx.items[ctx.p.silla], delivered: 1, damaged: 1 },
            { item_id: ctx.items[ctx.p.lamp], delivered: 0, rejected: 1 },
          ],
        },
      ],
    };
    const res = await rpc(ctx.driver, "delivery_items_record", { p: ev });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ ok: true, stop_status: "parcial" });
    expect((await rpc(ctx.driver, "delivery_items_record", { p: ev })).data).toMatchObject({ duplicate: true });

    // La venta ya había descontado todo: sólo la merma de la silla rota.
    expect(await stock(ctx.s1, ctx.p.mesa)).toBe(before.mesa);
    expect(await stock(ctx.s1, ctx.p.silla)).toBe(before.silla - 1);
    expect(await stock(ctx.s1, ctx.p.lamp)).toBe(before.lamp);
    const { data: d } = await ctx.owner.from("dispatches" as never).select("status, delivery_result, issue_open, issue_summary").eq("id", ctx.da).single();
    expect(d).toMatchObject({ status: "entregado", delivery_result: "parcial", issue_open: true, issue_summary: "1 roto, 1 rechazado" });
    const { data: child } = await ctx.owner.from("dispatches" as never).select("id, status, items:dispatch_items(product_id, qty)").eq("parent_dispatch_id", ctx.da);
    const ch = (child ?? []) as unknown as { status: string; items: { product_id: string; qty: number }[] }[];
    expect(ch).toHaveLength(1);
    expect(ch[0]!.status).toBe("pendiente");
    expect(ch[0]!.items.map((i) => [i.product_id, Number(i.qty)])).toEqual([[ctx.p.silla, 1]]);
    const { count } = await ctx.owner.from("dispatch_damages" as never).select("id", { count: "exact", head: true }).eq("dispatch_id", ctx.da);
    expect(count).toBe(2);
  });

  it("lo rechazado se resuelve con nota", async () => {
    expect((await rpc(ctx.owner, "dispatch_issue_resolve", { p: { dispatch_id: ctx.da, action: "resuelto" } })).error?.message).toMatch(/note_required/);
    const r = await rpc(ctx.owner, "dispatch_issue_resolve", { p: { dispatch_id: ctx.da, action: "resuelto", note: "Devolución hecha" } });
    expect(r.data).toMatchObject({ ok: true, issue_open: false });
  });

  it("pedir stock a otra sucursal: la cajera no, el dueño sí; al recibir deja de esperar", async () => {
    const st = await rpc(ctx.owner, "dispatch_stock_status", { p_dispatch: ctx.db });
    const item = (st.data as { items: { item_id: string; shortage: number; stores: { store_id: string }[] }[] }).items[0]!;
    expect(item.shortage).toBe(1);
    expect(item.stores.map((s) => s.store_id)).toEqual([ctx.s2]);
    const body = { p: { dispatch_id: ctx.db, origin_store_id: ctx.s2, items: [{ item_id: item.item_id, qty: 1 }] } };
    expect((await rpc(ctx.cashier, "dispatch_request_stock", body)).error?.message).toMatch(/forbidden/);
    const ok = await rpc(ctx.owner, "dispatch_request_stock", body);
    expect(ok.error).toBeNull();
    const tid = (ok.data as { transfer_id: string }).transfer_id;
    const { data: ti } = await ctx.owner.from("stock_transfer_items").select("id, qty_requested").eq("transfer_id", tid);
    const lines = (ti as { id: string; qty_requested: number }[]).map((i) => ({ item_id: i.id, qty: i.qty_requested }));
    expect((await rpc(ctx.owner, "transfer_dispatch", { p_id: tid, p_items: lines, p_notes: null })).error).toBeNull();
    expect((await rpc(ctx.owner, "transfer_receive", { p_id: tid, p_items: lines, p_close: true, p_notes: null })).error).toBeNull();
    const { data: d } = await ctx.owner.from("dispatches" as never).select("awaiting_transfer_id, stock_arrived_at").eq("id", ctx.db).single();
    expect((d as unknown as { awaiting_transfer_id: string | null }).awaiting_transfer_id).toBeNull();
    expect((d as unknown as { stock_arrived_at: string | null }).stock_arrived_at).not.toBeNull();
    expect(await stock(ctx.s1, ctx.p.vaso)).toBe(0);
  });

  it("el Repartidor y otro negocio no leen controles, lecturas ni roturas", async () => {
    for (const c of [ctx.driver, ctx.stranger]) {
      for (const t of ["dispatch_item_checks", "dispatch_scan_log", "dispatch_damages"]) {
        const { data } = await c.from(t as never).select("id").limit(5);
        expect(data ?? [], t).toHaveLength(0);
      }
    }
    const x = await rpc(ctx.stranger, "dispatch_scan", { p: { id: uuid(), stage: "armado", dispatch_id: ctx.db, code: `${STAMP}-4` } });
    expect(x.error?.message).toMatch(/dispatch_not_found/);
    const y = await rpc(ctx.stranger, "route_items", { p_route: ctx.route });
    expect(y.error?.message).toMatch(/route_not_found/);
    const ins = await ctx.owner.from("dispatch_damages" as never).insert({ dispatch_id: ctx.da } as never);
    expect(ins.error).not.toBeNull();
  });
});
