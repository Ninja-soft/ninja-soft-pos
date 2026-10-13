// @vitest-environment node
// =============================================================================
// F13 Gastronomía PRO, ronda 2 (ADR-097, migraciones 20261109600000 a
// 20261109600300): ticket separado por comensal y partes iguales, prioridad y
// cursos en el KDS, anulación con motivo de ítems de delivery y aviso
// automático a la lista de espera.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
//
// Escenario: negocio A con dueño y mozo-cajero (abre SU turno de caja y cobra
// en él); negocio B para el aislamiento. audit_logs es inmutable (ADR-083): el
// test no lo borra.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f13r2-${Math.random().toString(36).slice(2, 8)}`;
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
  mila: string;
  flan: string;
  tables: string[];
  shift: string;
  order: string;
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

async function addItem(order: string, product: string, name: string, qty: number, price: number, extra = {}) {
  const r = await rpc(ctx.waiter.client, "add_table_order_item", {
    p_order_id: order,
    p_product_id: product,
    p_name: name,
    p_qty: qty,
    p_unit_price: price,
    ...extra,
  });
  if (r.error) throw new Error(r.error.message);
  return r.data as string;
}

async function chargeChild(child: string, lines: { product: string; qty: number; price: number }[]) {
  const total = lines.reduce((a, l) => a + Math.round(l.qty * l.price * 100) / 100, 0);
  return rpc(ctx.waiter.client, "create_sale", {
    p_items: lines.map((l) => ({ product_id: l.product, quantity: l.qty, unit_price: l.price, discount: 0 })),
    p_payments: [{ method: "cash", amount: total }],
    p_table_order_id: child,
    p_cash_shift_id: ctx.shift,
  });
}

async function auditCount(action: string): Promise<number> {
  const { count } = await ctx.admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenant)
    .eq("action", action);
  return count ?? 0;
}

describe.skipIf(!enabled)("F13 ronda 2 · cuenta por comensal, KDS, delivery y lista de espera", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `F13R2 A ${STAMP}`, slug: `ra-${STAMP}`, status: "active" },
        { name: `F13R2 B ${STAMP}`, slug: `rb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `ra-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `rb-${STAMP}`)!.id;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.waiter = await makeUser(admin, `mozo-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.waiter.id, ctx.ownerB.id);

    // Insert multi-fila: todas las claves en cada fila.
    const { data: prods, error: pErr } = await ctx.owner.client
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Milanesa ${STAMP}`, price: 1000 },
        { tenant_id: ctx.tenant, name: `Flan ${STAMP}`, price: 500 },
      ] as never)
      .select("id, name");
    if (pErr || !prods) throw pErr ?? new Error("products");
    const list = prods as { id: string; name: string }[];
    ctx.mila = list.find((p) => p.name.startsWith("Milanesa"))!.id;
    ctx.flan = list.find((p) => p.name.startsWith("Flan"))!.id;

    const { data: area, error: aErr } = await ctx.owner.client
      .from("dining_areas")
      .insert({ name: "Salón", sort: 0 } as never)
      .select("id")
      .single();
    if (aErr || !area) throw aErr ?? new Error("area");
    const { data: tbl, error: tErr } = await ctx.owner.client
      .from("dining_tables")
      .insert(
        [1, 2, 3].map((n) => ({
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
    // El mozo-cajero abre SU turno y cobra en él.
    const sh = await rpc(ctx.waiter.client, "open_cash_shift", {
      p_register_id: (reg as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 60_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar por
    // sus auditorías, queda (datos de prueba con sello único).
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("cobra al comensal 2 en su propio ticket y la mesa sigue abierta", async () => {
    const o = await rpc(ctx.waiter.client, "open_dining_table", { p_table_id: ctx.tables[0] });
    expect(o.error).toBeNull();
    ctx.order = (o.data as { order_id: string }).order_id;
    const mila = await addItem(ctx.order, ctx.mila, "Milanesa", 3, 1000);
    const flan = await addItem(ctx.order, ctx.flan, "Flan", 1, 500);
    expect((await rpc(ctx.waiter.client, "mark_comanda_printed", { p_order_id: ctx.order, p_item_ids: [mila] })).error).toBeNull();

    const foreign = await rpc(ctx.ownerB.client, "set_table_items_diner", { p_item_ids: [flan], p_diner: 2 });
    expect(foreign.error?.message).toMatch(/item_not_found|forbidden/);
    expect((await rpc(ctx.waiter.client, "set_table_items_diner", { p_item_ids: [flan], p_diner: 2 })).error).toBeNull();

    const split = await rpc(ctx.waiter.client, "split_table_order", {
      p_order_id: ctx.order,
      p_lines: [{ item_id: flan, qty: null }],
      p_label: "Comensal 2",
    });
    expect(split.error).toBeNull();
    const child = (split.data as { order_id: string }).order_id;
    const sale = await chargeChild(child, [{ product: ctx.flan, qty: 1, price: 500 }]);
    expect(sale.error).toBeNull();

    const { data: tbl } = await ctx.admin.from("dining_tables").select("status, current_order_id").eq("id", ctx.tables[0]!).single();
    expect(tbl).toMatchObject({ status: "ocupada", current_order_id: ctx.order });
    const { data: ch } = await ctx.admin.from("table_orders").select("status, parent_order_id, split_label").eq("id", child).single();
    expect(ch).toMatchObject({ status: "cobrada", parent_order_id: ctx.order, split_label: "Comensal 2" });
    expect(await auditCount("table_split")).toBe(1);
  });

  it("parte igual con un ítem enviado: la línea se parte y conserva el precio", async () => {
    const { data: lines } = await ctx.admin.from("table_order_items").select("id, qty").eq("order_id", ctx.order);
    const mila = (lines as { id: string; qty: number }[])[0]!;
    // Sigue valiendo la regla de ADR-081: lo enviado no baja sin anulación.
    const down = await rpc(ctx.waiter.client, "set_table_order_item_qty", { p_item_id: mila.id, p_qty: 1 });
    expect(down.error?.message).toMatch(/item_sent_use_void/);

    const split = await rpc(ctx.waiter.client, "split_table_order", {
      p_order_id: ctx.order,
      p_lines: [{ item_id: mila.id, qty: 1.5 }],
      p_label: "Parte 1 de 2",
    });
    expect(split.error).toBeNull();
    const child = (split.data as { order_id: string }).order_id;
    const { data: after } = await ctx.admin.from("table_order_items").select("qty").eq("id", mila.id).single();
    expect(Number((after as { qty: number }).qty)).toBe(1.5);
    const sale = await chargeChild(child, [{ product: ctx.mila, qty: 1.5, price: 1000 }]);
    expect(sale.error).toBeNull();
  });

  it("con una cuenta separada abierta no se cancela ni se cobra el padre; deshacer la devuelve", async () => {
    const { data: lines } = await ctx.admin.from("table_order_items").select("id").eq("order_id", ctx.order);
    const id = (lines as { id: string }[])[0]!.id;
    const split = await rpc(ctx.waiter.client, "split_table_order", {
      p_order_id: ctx.order,
      p_lines: [{ item_id: id, qty: 0.5 }],
      p_label: "Parte 2 de 3",
    });
    expect(split.error).toBeNull();
    const child = (split.data as { order_id: string }).order_id;

    expect((await rpc(ctx.waiter.client, "cancel_table_order", { p_order_id: ctx.order })).error?.message).toMatch(
      /order_has_open_splits/,
    );
    expect((await rpc(ctx.waiter.client, "cancel_table_order", { p_order_id: child })).error?.message).toMatch(
      /split_use_unsplit/,
    );
    const parentSale = await chargeChild(ctx.order, [{ product: ctx.mila, qty: 1, price: 1000 }]);
    expect(parentSale.error?.message).toMatch(/order_has_open_splits/);

    const foreign = await rpc(ctx.ownerB.client, "unsplit_table_order", { p_split_id: child });
    expect(foreign.error?.message).toMatch(/order_not_found|forbidden/);
    const undo = await rpc(ctx.waiter.client, "unsplit_table_order", { p_split_id: child });
    expect(undo.error).toBeNull();
    expect(await auditCount("table_split_undone")).toBe(1);
  });

  it("la última cuenta cierra el padre, libera la mesa y la rotación cuenta una visita", async () => {
    const { data: lines } = await ctx.admin.from("table_order_items").select("id, qty, unit_price").eq("order_id", ctx.order);
    const rows = lines as { id: string; qty: number; unit_price: number }[];
    const split = await rpc(ctx.waiter.client, "split_table_order", {
      p_order_id: ctx.order,
      p_lines: rows.map((r) => ({ item_id: r.id, qty: null })),
      p_label: "Parte 2 de 2",
    });
    expect(split.error).toBeNull();
    const child = (split.data as { order_id: string }).order_id;
    const qty = rows.reduce((a, r) => a + Number(r.qty), 0);
    const sale = await chargeChild(child, [{ product: ctx.mila, qty, price: 1000 }]);
    expect(sale.error).toBeNull();

    const { data: parent } = await ctx.admin.from("table_orders").select("status, closed_at").eq("id", ctx.order).single();
    expect((parent as { status: string }).status).toBe("cobrada");
    const { data: tbl } = await ctx.admin.from("dining_tables").select("status").eq("id", ctx.tables[0]!).single();
    expect((tbl as { status: string }).status).toBe("libre");
    expect(await auditCount("table_split_closed")).toBe(1);

    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const rep = await rpc(ctx.owner.client, "gastro_turnover_report", { p_from: from, p_to: to });
    expect((rep.data as { orders: number }).orders).toBe(1);
  });

  it("prioridad urgente y cursos en espera en el KDS; marchar dispara el curso", async () => {
    const o = await rpc(ctx.waiter.client, "open_dining_table", { p_table_id: ctx.tables[1] });
    const order = (o.data as { order_id: string }).order_id;
    await addItem(order, ctx.mila, "Milanesa", 1, 1000);
    await addItem(order, ctx.flan, "Flan", 2, 500, { p_course: 3, p_hold: true });

    expect((await rpc(ctx.waiter.client, "set_order_priority", { p_source: "mesa", p_order_id: order, p_priority: "x" })).error?.message).toMatch(
      /invalid_priority/,
    );
    expect((await rpc(ctx.ownerB.client, "set_order_priority", { p_source: "mesa", p_order_id: order, p_priority: "urgente" })).error?.message).toMatch(
      /order_not_open|forbidden/,
    );
    expect((await rpc(ctx.waiter.client, "set_order_priority", { p_source: "mesa", p_order_id: order, p_priority: "urgente" })).error).toBeNull();
    expect(await auditCount("order_priority_changed")).toBe(1);

    const kds = await rpc(ctx.waiter.client, "kds_tickets", { p_station: null });
    const mine = (kds.data as { order_id: string; priority: string }[]).filter((r) => r.order_id === order);
    expect(mine.length).toBe(1);
    expect(mine[0]!.priority).toBe("urgente");

    const held = await rpc(ctx.waiter.client, "kds_held_courses", { p_station: null });
    expect((held.data as { order_id: string; course: number; held: number }[]).find((h) => h.order_id === order)).toMatchObject({
      course: 3,
      held: 1,
    });
    const heldB = await rpc(ctx.ownerB.client, "kds_held_courses", { p_station: null });
    expect((heldB.data as unknown[]) ?? []).toHaveLength(0);

    expect((await rpc(ctx.waiter.client, "fire_table_order_course", { p_order_id: order, p_course: 3 })).error).toBeNull();
    const after = await rpc(ctx.waiter.client, "kds_held_courses", { p_station: null });
    expect((after.data as { order_id: string }[]).filter((h) => h.order_id === order)).toHaveLength(0);

    const comanda = await rpc(ctx.waiter.client, "comanda_items", { p_order_id: order, p_only_new: false });
    expect((comanda.data as { priority: string }[])[0]!.priority).toBe("urgente");
  });

  it("delivery: un ítem enviado sólo baja con anulación; delete directo no borra", async () => {
    const d = await rpc(ctx.waiter.client, "create_delivery_order", {
      p_channel: "telefono",
      p_order_type: "takeaway",
      p_customer_name: "Juan",
    });
    expect(d.error).toBeNull();
    const order = (d.data as { order_id: string }).order_id;
    const add = await rpc(ctx.waiter.client, "add_delivery_order_item", {
      p_order_id: order,
      p_product_id: ctx.mila,
      p_name: "Milanesa",
      p_qty: 3,
      p_unit_price: 1000,
    });
    expect(add.error).toBeNull();
    const item = add.data as string;
    expect((await rpc(ctx.waiter.client, "mark_delivery_comanda_printed", { p_order_id: order, p_item_ids: [item] })).error).toBeNull();

    expect((await rpc(ctx.waiter.client, "set_delivery_order_item_qty", { p_item_id: item, p_qty: 1 })).error?.message).toMatch(
      /item_sent_use_void/,
    );
    const up = await ctx.waiter.client.from("delivery_order_items").update({ qty: 1 } as never).eq("id", item);
    expect(up.error?.message).toMatch(/item_sent_use_void/);
    await ctx.waiter.client.from("delivery_order_items").delete().eq("id", item);
    const { data: still } = await ctx.admin.from("delivery_order_items").select("qty").eq("id", item).single();
    expect(Number((still as { qty: number }).qty)).toBe(3);

    expect((await rpc(ctx.waiter.client, "void_delivery_order_item", { p_item_id: item, p_qty: 1, p_reason: " " })).error?.message).toMatch(
      /void_reason_required/,
    );
    const v = await rpc(ctx.waiter.client, "void_delivery_order_item", { p_item_id: item, p_qty: 1, p_reason: "Se quemó" });
    expect(v.error).toBeNull();
    expect(v.data).toMatchObject({ removed: false, remaining_qty: 2 });
    expect(await auditCount("delivery_item_voided")).toBe(1);

    const voids = await rpc(ctx.waiter.client, "kds_recent_voids", { p_station: null });
    const dv = (voids.data as { source: string; void_id: string }[]).filter((x) => x.source === "delivery");
    expect(dv).toHaveLength(1);
    expect((await rpc(ctx.waiter.client, "ack_comanda_void", { p_void_id: dv[0]!.void_id })).error).toBeNull();

    // Aislamiento: el otro negocio no ve ni escribe anulaciones.
    const { data: seenB } = await ctx.ownerB.client.from("delivery_order_voids").select("id");
    expect(seenB ?? []).toHaveLength(0);
    const insB = await ctx.ownerB.client
      .from("delivery_order_voids")
      .insert({ tenant_id: ctx.tenantB, order_id: order, item_id: item, name: "x", qty: 1, reason: "xxxx" } as never);
    expect(insB.error).not.toBeNull();
    const insA = await ctx.waiter.client
      .from("delivery_order_voids")
      .insert({ tenant_id: ctx.tenant, order_id: order, item_id: item, name: "x", qty: 1, reason: "xxxx" } as never);
    expect(insA.error).not.toBeNull();
  });

  it("lista de espera: al liberarse una mesa queda un aviso pendiente y se registra el envío", async () => {
    const { data: rows, error } = await ctx.waiter.client
      .from("dining_waitlist")
      .insert(
        [
          { customer_name: "Ana", customer_phone: "1155556666", party_size: 2, priority: 0, quoted_minutes: 15, status: "esperando" },
          { customer_name: "Beto", customer_phone: null, party_size: 8, priority: 1, quoted_minutes: null, status: "esperando" },
        ] as never,
      )
      .select("id, customer_name");
    expect(error).toBeNull();
    const ana = (rows as { id: string; customer_name: string }[]).find((r) => r.customer_name === "Ana")!.id;
    const beto = (rows as { id: string; customer_name: string }[]).find((r) => r.customer_name === "Beto")!.id;

    const o = await rpc(ctx.waiter.client, "open_dining_table", { p_table_id: ctx.tables[2] });
    const order = (o.data as { order_id: string }).order_id;
    expect((await rpc(ctx.waiter.client, "cancel_table_order", { p_order_id: order })).error).toBeNull();

    const { data: notices } = await ctx.waiter.client
      .from("dining_waitlist_notices")
      .select("id, entry_id, status, origin, message, table_label");
    const list = notices as { id: string; entry_id: string; status: string; origin: string; message: string }[];
    // Beto (8 personas) no entra en una mesa de 4: el aviso es para Ana.
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ entry_id: ana, status: "pendiente", origin: "mesa_libre" });
    expect(list[0]!.message).toMatch(/Hola Ana, tu mesa/);

    // Sin escritura directa ni acceso de otro negocio.
    const direct = await ctx.waiter.client
      .from("dining_waitlist_notices")
      .insert({ tenant_id: ctx.tenant, entry_id: ana, origin: "manual", message: "x" } as never);
    expect(direct.error).not.toBeNull();
    const { data: seenB } = await ctx.ownerB.client.from("dining_waitlist_notices").select("id");
    expect(seenB ?? []).toHaveLength(0);
    expect((await rpc(ctx.ownerB.client, "mark_waitlist_notice_sent", { p_notice_id: list[0]!.id })).error?.message).toMatch(
      /notice_not_found|forbidden/,
    );

    const sent = await rpc(ctx.waiter.client, "mark_waitlist_notice_sent", { p_notice_id: list[0]!.id });
    expect(sent.error).toBeNull();
    expect((sent.data as { phone: string }).phone).toBe("1155556666");
    const { data: entry } = await ctx.admin.from("dining_waitlist").select("status, notified_at").eq("id", ana).single();
    expect((entry as { status: string }).status).toBe("avisado");
    expect((await rpc(ctx.waiter.client, "mark_waitlist_notice_sent", { p_notice_id: list[0]!.id })).error?.message).toMatch(/notice_closed/);

    const manual = await rpc(ctx.waiter.client, "notify_waitlist_entry", { p_entry_id: beto, p_table_id: null });
    expect(manual.error).toBeNull();
    expect(await auditCount("waitlist_notified")).toBe(2);
    expect(await auditCount("waitlist_notice_created")).toBe(1);
  });
});
