// @vitest-environment node
// =============================================================================
// F13 Gastronomía PRO (migraciones 20261105200000 a 20261105200400): mover,
// unir y transferir mesas; relevo de mozo; anulación con motivo de ítems
// enviados; SLA del KDS por estación; lista de espera; rotación de mesas,
// mozos y propinas.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con dueño y mozo-cajero (que abre SU turno de caja y
// cobra en él); negocio B para el aislamiento.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f13-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  waiter: User;
  ownerB: User;
  userIds: string[];
  product: string;
  tables: string[];
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

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
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function openWithItem(tableIdx: number, qty = 1): Promise<{ order: string; item: string }> {
  const o = await rpc(ctx.waiter.client, "open_dining_table", { p_table_id: ctx.tables[tableIdx] });
  if (o.error) throw new Error(o.error.message);
  const order = (o.data as { order_id: string }).order_id;
  const i = await rpc(ctx.waiter.client, "add_table_order_item", {
    p_order_id: order,
    p_product_id: ctx.product,
    p_name: "Milanesa",
    p_qty: qty,
    p_unit_price: 1000,
  });
  if (i.error) throw new Error(i.error.message);
  return { order, item: i.data as string };
}

async function tableRow(idx: number) {
  const { data } = await ctx.admin
    .from("dining_tables")
    .select("status, current_order_id, waiter_user_id")
    .eq("id", ctx.tables[idx]!)
    .single();
  return data as { status: string; current_order_id: string | null; waiter_user_id: string | null };
}

async function auditCount(action: string): Promise<number> {
  const { count } = await ctx.admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenant)
    .eq("action", action);
  return count ?? 0;
}

describe.skipIf(!enabled)("F13 · mesas, anulaciones, KDS, lista de espera y rotación", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `F13 A ${STAMP}`, slug: `fa-${STAMP}`, status: "active" },
        { name: `F13 B ${STAMP}`, slug: `fb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `fa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `fb-${STAMP}`)!.id;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.waiter = await makeUser(admin, `mozo-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.waiter.id, ctx.ownerB.id);

    const { data: prod, error: pErr } = await ctx.owner.client
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Milanesa ${STAMP}`, price: 1000 } as never)
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = (prod as { id: string }).id;

    const { data: area, error: aErr } = await ctx.owner.client
      .from("dining_areas")
      .insert({ name: "Salón", sort: 0 } as never)
      .select("id")
      .single();
    if (aErr || !area) throw aErr ?? new Error("area");
    // Insert multi-fila: todas las claves en cada fila.
    const { data: tbl, error: tErr } = await ctx.owner.client
      .from("dining_tables")
      .insert(
        [1, 2, 3, 4, 5].map((n) => ({
          area_id: (area as { id: string }).id,
          label: String(n),
          capacity: 4,
          sort: n,
        })) as never,
      )
      .select("id, sort")
      .order("sort");
    if (tErr || !tbl) throw tErr ?? new Error("tables");
    ctx.tables = (tbl as { id: string }[]).map((r) => r.id);

    // Caja: el mozo-cajero abre SU turno y cobra en él.
    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: (store as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    const sh = await rpc(ctx.waiter.client, "open_cash_shift", {
      p_register_id: (reg as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
  });

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("mueve el pedido entero a una mesa libre y audita", async () => {
    const { order } = await openWithItem(0);
    const r = await rpc(ctx.waiter.client, "move_table_order", {
      p_order_id: order,
      p_target_table_id: ctx.tables[1],
    });
    expect(r.error).toBeNull();
    expect((r.data as { mode: string }).mode).toBe("moved");
    expect((await tableRow(0)).status).toBe("libre");
    const dst = await tableRow(1);
    expect(dst.status).toBe("ocupada");
    expect(dst.current_order_id).toBe(order);
    const { data: o } = await ctx.admin.from("table_orders").select("waiter_user_id").eq("id", order).single();
    expect((o as { waiter_user_id: string }).waiter_user_id).toBe(ctx.waiter.id);
    expect(await auditCount("table_moved")).toBe(1);
  });

  it("une dos mesas: las líneas pasan y el origen queda cancelado con merged_into", async () => {
    const dstOrder = (await tableRow(1)).current_order_id!;
    const { order: srcOrder } = await openWithItem(2, 2);
    const r = await rpc(ctx.waiter.client, "move_table_order", {
      p_order_id: srcOrder,
      p_target_table_id: ctx.tables[1],
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ mode: "merged", order_id: dstOrder, items_moved: 1 });
    const { data: src } = await ctx.admin
      .from("table_orders")
      .select("status, merged_into, closed_at")
      .eq("id", srcOrder)
      .single();
    expect(src).toMatchObject({ status: "cancelada", merged_into: dstOrder });
    expect((src as { closed_at: string | null }).closed_at).not.toBeNull();
    expect((await tableRow(2)).status).toBe("libre");
    const { count } = await ctx.admin
      .from("table_order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", dstOrder);
    expect(count).toBe(2);
    expect(await auditCount("tables_merged")).toBe(1);
  });

  it("transfiere algunos ítems a una mesa libre (la abre) y rechaza destinos inválidos", async () => {
    const order = (await tableRow(1)).current_order_id!;
    const { data: items } = await ctx.admin.from("table_order_items").select("id").eq("order_id", order);
    const one = (items as { id: string }[])[0]!.id;

    const same = await rpc(ctx.waiter.client, "transfer_table_order_items", {
      p_item_ids: [one],
      p_target_table_id: ctx.tables[1],
    });
    expect(same.error?.message).toMatch(/same_table/);

    await ctx.admin.from("dining_tables").update({ status: "bloqueada" }).eq("id", ctx.tables[4]!);
    const blocked = await rpc(ctx.waiter.client, "transfer_table_order_items", {
      p_item_ids: [one],
      p_target_table_id: ctx.tables[4],
    });
    expect(blocked.error?.message).toMatch(/table_blocked/);
    await ctx.admin.from("dining_tables").update({ status: "libre" }).eq("id", ctx.tables[4]!);

    const ok = await rpc(ctx.waiter.client, "transfer_table_order_items", {
      p_item_ids: [one],
      p_target_table_id: ctx.tables[3],
    });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ items_moved: 1, opened_target: true });
    expect((await tableRow(3)).status).toBe("ocupada");
    expect(await auditCount("items_transferred")).toBe(1);
  });

  it("otro negocio no puede mover pedidos ajenos ni cambiar el mozo a alguien de afuera", async () => {
    const order = (await tableRow(1)).current_order_id!;
    const foreign = await rpc(ctx.ownerB.client, "move_table_order", {
      p_order_id: order,
      p_target_table_id: ctx.tables[0],
    });
    expect(foreign.error?.message).toMatch(/order_not_found|forbidden/);

    const outsider = await rpc(ctx.owner.client, "set_table_waiter", {
      p_table_id: ctx.tables[1],
      p_waiter_user_id: ctx.ownerB.id,
    });
    expect(outsider.error?.message).toMatch(/waiter_not_member/);

    const relevo = await rpc(ctx.owner.client, "set_table_waiter", {
      p_table_id: ctx.tables[1],
      p_waiter_user_id: ctx.owner.id,
    });
    expect(relevo.error).toBeNull();
    const { data: o } = await ctx.admin.from("table_orders").select("waiter_user_id").eq("id", order).single();
    expect((o as { waiter_user_id: string }).waiter_user_id).toBe(ctx.owner.id);
    expect(await auditCount("waiter_changed")).toBe(1);
  });

  it("un ítem enviado sólo baja con anulación: RPC, update y delete directos bloqueados", async () => {
    const order = (await tableRow(3)).current_order_id!;
    const add = await rpc(ctx.waiter.client, "add_table_order_item", {
      p_order_id: order,
      p_product_id: ctx.product,
      p_name: "Milanesa",
      p_qty: 3,
      p_unit_price: 1000,
    });
    expect(add.error).toBeNull();
    const item = add.data as string;
    // Sin enviar: se edita libre.
    expect((await rpc(ctx.waiter.client, "set_table_order_item_qty", { p_item_id: item, p_qty: 2 })).error).toBeNull();

    // Se imprime la comanda: queda enviado.
    const pr = await rpc(ctx.waiter.client, "mark_comanda_printed", { p_order_id: order, p_item_ids: [item] });
    expect(pr.error).toBeNull();

    const viaRpc = await rpc(ctx.waiter.client, "set_table_order_item_qty", { p_item_id: item, p_qty: 1 });
    expect(viaRpc.error?.message).toMatch(/item_sent_use_void/);
    const up = await ctx.waiter.client.from("table_order_items").update({ qty: 1 } as never).eq("id", item);
    expect(up.error?.message).toMatch(/item_sent_use_void/);
    await ctx.waiter.client.from("table_order_items").delete().eq("id", item);
    const { data: still } = await ctx.admin.from("table_order_items").select("qty").eq("id", item).single();
    expect(Number((still as { qty: number }).qty)).toBe(2);
    // Subir sigue permitido.
    expect((await rpc(ctx.waiter.client, "set_table_order_item_qty", { p_item_id: item, p_qty: 3 })).error).toBeNull();

    const noReason = await rpc(ctx.waiter.client, "void_table_order_item", { p_item_id: item, p_qty: 1, p_reason: " " });
    expect(noReason.error?.message).toMatch(/void_reason_required/);
    const tooMuch = await rpc(ctx.waiter.client, "void_table_order_item", { p_item_id: item, p_qty: 9, p_reason: "Demora" });
    expect(tooMuch.error?.message).toMatch(/invalid_qty/);

    const partial = await rpc(ctx.waiter.client, "void_table_order_item", { p_item_id: item, p_qty: 1, p_reason: "Demora" });
    expect(partial.error).toBeNull();
    expect(partial.data).toMatchObject({ removed: false, remaining_qty: 2 });
    const total = await rpc(ctx.waiter.client, "void_table_order_item", {
      p_item_id: item,
      p_qty: null,
      p_reason: "El cliente cambió el pedido",
    });
    expect(total.data).toMatchObject({ removed: true, voided_qty: 2 });
    expect(await auditCount("comanda_item_voided")).toBe(2);

    const voids = await rpc(ctx.waiter.client, "kds_recent_voids", { p_station: null });
    expect((voids.data as unknown[]).length).toBe(2);
    const first = (voids.data as { void_id: string }[])[0]!.void_id;
    expect((await rpc(ctx.waiter.client, "ack_comanda_void", { p_void_id: first })).error).toBeNull();
    const after = await rpc(ctx.waiter.client, "kds_recent_voids", { p_station: null });
    expect((after.data as unknown[]).length).toBe(1);

    // Aislamiento: el otro negocio no ve anulaciones ni puede escribirlas.
    const { data: seenB } = await ctx.ownerB.client.from("table_order_voids").select("id");
    expect(seenB ?? []).toHaveLength(0);
    const insB = await ctx.ownerB.client
      .from("table_order_voids")
      .insert({ order_id: order, item_id: item, name: "x", qty: 1, reason: "xxx" } as never);
    expect(insB.error).not.toBeNull();
  });

  it("SLA del KDS: el dueño guarda, la DB valida la forma y el mozo no puede", async () => {
    const good = await ctx.owner.client
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, kds_sla: { default: { warn: 6, late: 12 }, parrilla: { warn: 15, late: 25 } } } as never, {
        onConflict: "tenant_id",
      });
    expect(good.error).toBeNull();
    const bad = await ctx.owner.client
      .from("pos_settings")
      .update({ kds_sla: { barra: { warn: 10, late: 5 } } } as never)
      .eq("tenant_id", ctx.tenant);
    expect(bad.error?.message).toMatch(/kds_sla/);
    await ctx.waiter.client
      .from("pos_settings")
      .update({ kds_sla: { default: { warn: 1, late: 2 } } } as never)
      .eq("tenant_id", ctx.tenant);
    const { data } = await ctx.admin.from("pos_settings").select("kds_sla").eq("tenant_id", ctx.tenant).single();
    expect((data as { kds_sla: Record<string, unknown> }).kds_sla).toMatchObject({ default: { warn: 6, late: 12 } });
  });

  it("lista de espera: alta multi-fila, aislamiento, estados por RPC y sentar en mesa libre", async () => {
    const { data: rows, error } = await ctx.waiter.client
      .from("dining_waitlist")
      .insert(
        [
          { customer_name: "Ana", customer_phone: "1123456789", party_size: 2, priority: 0, quoted_minutes: 20, status: "esperando" },
          { customer_name: "Beto", customer_phone: null, party_size: 4, priority: 1, quoted_minutes: null, status: "esperando" },
        ] as never,
      )
      .select("id, customer_name");
    expect(error).toBeNull();
    const ana = (rows as { id: string; customer_name: string }[]).find((r) => r.customer_name === "Ana")!.id;

    const sneaky = await ctx.waiter.client
      .from("dining_waitlist")
      .insert({ customer_name: "X", party_size: 1, priority: 0, quoted_minutes: null, customer_phone: null, status: "sentado" } as never);
    expect(sneaky.error).not.toBeNull();

    const { data: seenB } = await ctx.ownerB.client.from("dining_waitlist").select("id");
    expect(seenB ?? []).toHaveLength(0);
    const foreign = await rpc(ctx.ownerB.client, "set_waitlist_status", { p_entry_id: ana, p_status: "cancelado" });
    expect(foreign.error?.message).toMatch(/waitlist_not_found/);

    // Update directo no tiene policy: no cambia nada.
    await ctx.waiter.client.from("dining_waitlist").update({ status: "sentado" } as never).eq("id", ana);
    expect((await rpc(ctx.waiter.client, "set_waitlist_status", { p_entry_id: ana, p_status: "avisado" })).error).toBeNull();

    const busy = await rpc(ctx.waiter.client, "seat_waitlist_entry", { p_entry_id: ana, p_table_id: ctx.tables[1] });
    expect(busy.error?.message).toMatch(/table_not_free/);
    const ok = await rpc(ctx.waiter.client, "seat_waitlist_entry", { p_entry_id: ana, p_table_id: ctx.tables[0] });
    expect(ok.error).toBeNull();
    const orderId = (ok.data as { order_id: string }).order_id;
    const { data: entry } = await ctx.admin
      .from("dining_waitlist")
      .select("status, notified_at, table_order_id")
      .eq("id", ana)
      .single();
    expect(entry).toMatchObject({ status: "sentado", table_order_id: orderId });
    const { data: o } = await ctx.admin.from("table_orders").select("notes").eq("id", orderId).single();
    expect((o as { notes: string }).notes).toMatch(/Lista de espera: Ana/);
    const again = await rpc(ctx.waiter.client, "seat_waitlist_entry", { p_entry_id: ana, p_table_id: ctx.tables[2] });
    expect(again.error?.message).toMatch(/waitlist_closed/);
  });

  it("rotación: cuenta pedida y cobro sellan tiempos; el reporte suma mozo y propina", async () => {
    const order = (await tableRow(1)).current_order_id!;
    expect((await rpc(ctx.waiter.client, "set_table_status", { p_table_id: ctx.tables[1], p_status: "cuenta_pedida" })).error).toBeNull();
    const { data: billed } = await ctx.admin.from("table_orders").select("bill_requested_at").eq("id", order).single();
    expect((billed as { bill_requested_at: string | null }).bill_requested_at).not.toBeNull();

    const { data: lines } = await ctx.admin.from("table_order_items").select("qty").eq("order_id", order);
    const qty = (lines as { qty: number }[]).reduce((a, r) => a + Number(r.qty), 0);
    const total = qty * 1000;
    const sale = await rpc(ctx.waiter.client, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: qty, unit_price: 1000, discount: 0 }],
      p_payments: [{ method: "cash", amount: total + 150 }],
      p_extras: [{ kind: "tip", amount: 150, method: "cash" }],
      p_table_order_id: order,
    });
    expect(sale.error).toBeNull();
    const { data: closed } = await ctx.admin.from("table_orders").select("status, closed_at").eq("id", order).single();
    expect(closed).toMatchObject({ status: "cobrada" });
    expect((closed as { closed_at: string | null }).closed_at).not.toBeNull();

    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const rep = await rpc(ctx.owner.client, "gastro_turnover_report", { p_from: from, p_to: to });
    expect(rep.error).toBeNull();
    const data = rep.data as {
      orders: number;
      tips_total: number;
      by_waiter: { waiter: string; tips: number; orders: number }[];
    };
    expect(data.orders).toBe(1);
    expect(Number(data.tips_total)).toBe(150);
    // El relevo dejó al dueño como mozo del pedido.
    expect(data.by_waiter).toHaveLength(1);
    expect(Number(data.by_waiter[0]!.tips)).toBe(150);

    const repB = await rpc(ctx.ownerB.client, "gastro_turnover_report", { p_from: from, p_to: to });
    expect((repB.data as { orders: number }).orders).toBe(0);
  });
});
