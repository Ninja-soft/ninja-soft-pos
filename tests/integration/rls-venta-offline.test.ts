// @vitest-environment node
// =============================================================================
// ADR-077: venta offline. sync_offline_sale (idempotente por client_sale_id,
// wrapper de create_sale), conflictos (precio cambiado, stock negativo),
// "requiere revisión" sin perder la venta, revisión del dueño y RLS de la
// bandeja offline_sales.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `off-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  cashier2: User;
  ownerB: User;
  userIds: string[];
  product: string;
  tracked: string;
  ownerShift: string;
  cashierShift: string;
  shiftB: string;
};
const ctx = {} as Ctx;

type Res = { data: unknown; error: { message: string; code?: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<Res>;

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

type OfflineResult = {
  id: string;
  status: string;
  sale_id: string | null;
  sale_number: number | null;
  conflicts: { kind: string; product_id?: string; expected?: number; received?: number }[];
  reasons: string[];
  error: string | null;
  duplicate: boolean;
};

function offlineSale(
  shift: string,
  opts: { price?: number; product?: string; qty?: number; method?: string; extra?: Record<string, unknown> } = {},
) {
  const price = opts.price ?? 100;
  const qty = opts.qty ?? 1;
  return {
    items: [{ product_id: opts.product ?? ctx.product, quantity: qty, unit_price: price, discount: 0 }],
    payments: [{ method: opts.method ?? "cash", amount: price * qty }],
    discount_total: 0,
    customer_id: null,
    notes: null,
    extras: [],
    promo_discount: 0,
    promo_id: null,
    promo_name: null,
    cash_shift_id: shift,
    ...opts.extra,
  };
}

function sync(u: User, id: string, sale: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  return rpc(u.client, "sync_offline_sale", {
    p_client_sale_id: id,
    p_sale: sale,
    p_meta: { sold_at: new Date().toISOString(), user_id: u.id, integrity: "ok", ...meta },
  });
}

describe.skipIf(!enabled)("ADR-077 · venta offline: sync_offline_sale, revisión y RLS", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Off A ${STAMP}`, slug: `oa-${STAMP}`, status: "active" },
        { name: `Off B ${STAMP}`, slug: `ob-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `oa-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `ob-${STAMP}`)!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_sucursal", "multi_caja"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.cashier2 = await makeUser(admin, `caj2-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.cashier2.id, ctx.ownerB.id);

    // Insert multi-fila con TODAS las claves en cada fila.
    const { data: prods, error: pErr } = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Libre ${STAMP}`, price: 100, track_stock: false, stock: 0, allow_negative: null },
        { tenant_id: ctx.tenant, name: `Con stock ${STAMP}`, price: 100, track_stock: true, stock: 0, allow_negative: false },
      ])
      .select("id, name");
    if (pErr || !prods) throw pErr ?? new Error("products");
    const plist = prods as { id: string; name: string }[];
    ctx.product = plist.find((p) => p.name.startsWith("Libre"))!.id;
    ctx.tracked = plist.find((p) => p.name.startsWith("Con stock"))!.id;

    const { data: s, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !s) throw sErr ?? new Error("store");
    const store = (s as { id: string }).id;
    const { data: regs, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert([
        { store_id: store, name: "Caja 1" },
        { store_id: store, name: "Caja 2" },
      ] as never)
      .select("id, name");
    if (rErr || !regs) throw rErr ?? new Error("cajas");
    const list = regs as { id: string; name: string }[];
    const o1 = await rpc(ctx.owner.client, "open_cash_shift", {
      p_register_id: list.find((r) => r.name === "Caja 1")!.id,
      p_opening_amount: 0,
    });
    if (o1.error) throw new Error(o1.error.message);
    ctx.ownerShift = o1.data as string;
    // El cajero abre SU turno (caja propia, ADR-051).
    const o2 = await rpc(ctx.cashier.client, "open_cash_shift", {
      p_register_id: list.find((r) => r.name === "Caja 2")!.id,
      p_opening_amount: 0,
    });
    if (o2.error) throw new Error(o2.error.message);
    ctx.cashierShift = o2.data as string;

    // Negocio B con su turno.
    const { data: sb, error: sbErr } = await ctx.ownerB.client
      .from("stores")
      .insert({ name: "B" } as never)
      .select("id")
      .single();
    if (sbErr || !sb) throw sbErr ?? new Error("store B");
    const { data: rb, error: rbErr } = await ctx.ownerB.client
      .from("cash_registers")
      .insert({ store_id: (sb as { id: string }).id, name: "Caja B" } as never)
      .select("id")
      .single();
    if (rbErr || !rb) throw rbErr ?? new Error("caja B");
    const ob = await rpc(ctx.ownerB.client, "open_cash_shift", {
      p_register_id: (rb as { id: string }).id,
      p_opening_amount: 0,
    });
    if (ob.error) throw new Error(ob.error.message);
    ctx.shiftB = ob.data as string;

    // Sin venta en negativo: offline igual se vende y queda el conflicto.
    const up = await ctx.owner.client
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: false } as never, { onConflict: "tenant_id" });
    if (up.error) throw up.error;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el cajero sincroniza en su propio turno y la venta queda marcada offline", async () => {
    const id = randomUUID();
    const soldAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await sync(ctx.cashier, id, offlineSale(ctx.cashierShift), { sold_at: soldAt });
    expect(r.error).toBeNull();
    const res = r.data as OfflineResult;
    expect(res.status).toBe("synced");
    expect(res.duplicate).toBe(false);
    expect(res.conflicts).toEqual([]);
    const { data: sale } = await ctx.admin
      .from("sales")
      .select("id, cash_shift_id, offline_client_id, offline_sold_at, total")
      .eq("id", res.sale_id!)
      .single();
    const s = sale as { cash_shift_id: string; offline_client_id: string; offline_sold_at: string; total: number };
    expect(s.cash_shift_id).toBe(ctx.cashierShift);
    expect(s.offline_client_id).toBe(id);
    expect(new Date(s.offline_sold_at).toISOString()).toBe(soldAt);
    expect(Number(s.total)).toBe(100);
  });

  it("idempotente: el reenvío devuelve la misma venta sin duplicarla", async () => {
    const id = randomUUID();
    const first = await sync(ctx.cashier, id, offlineSale(ctx.cashierShift));
    const again = await sync(ctx.cashier, id, offlineSale(ctx.cashierShift, { price: 999 }));
    expect(first.error).toBeNull();
    expect(again.error).toBeNull();
    const a = first.data as OfflineResult;
    const b = again.data as OfflineResult;
    expect(b.duplicate).toBe(true);
    expect(b.sale_id).toBe(a.sale_id);
    const { count } = await ctx.admin
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenant)
      .eq("offline_client_id", id);
    expect(count).toBe(1);
    const { count: rows } = await ctx.admin
      .from("offline_sales")
      .select("id", { count: "exact", head: true })
      .eq("client_sale_id", id);
    expect(rows).toBe(1);
  });

  it("precio cambiado: se respeta el cobrado, queda el conflicto y se audita", async () => {
    const r = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift, { price: 80 }));
    expect(r.error).toBeNull();
    const res = r.data as OfflineResult;
    expect(res.status).toBe("synced");
    expect(res.conflicts).toEqual([
      expect.objectContaining({ kind: "price_changed", product_id: ctx.product, expected: 100, received: 80 }),
    ]);
    const { data: items } = await ctx.admin
      .from("sale_items")
      .select("unit_price, list_price")
      .eq("sale_id", res.sale_id!);
    expect(items).toEqual([expect.objectContaining({ unit_price: 80, list_price: 100 })]);
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, entity_id")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "offline_sale_conflicts")
      .eq("entity_id", res.sale_id!);
    expect(logs).toHaveLength(1);
  });

  it("sin stock y sin venta en negativo: offline se vende igual y queda marcado", async () => {
    const r = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift, { product: ctx.tracked, qty: 2 }));
    expect(r.error).toBeNull();
    const res = r.data as OfflineResult;
    expect(res.status).toBe("synced");
    expect(res.conflicts.map((c) => c.kind)).toContain("negative_stock");
    const { data: p } = await ctx.admin.from("products").select("stock").eq("id", ctx.tracked).single();
    expect(Number((p as { stock: number }).stock)).toBe(-2);
    // create_sale normal (online) sigue rechazando sin stock.
    const online = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.tracked, quantity: 1, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: ctx.cashierShift,
    });
    expect(online.error?.message).toMatch(/insufficient_stock/);
    // Y con precio distinto, price_mismatch como siempre.
    const mismatch = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 80, discount: 0 }],
      p_payments: [{ method: "cash", amount: 80 }],
      p_cash_shift_id: ctx.cashierShift,
    });
    expect(mismatch.error?.message).toMatch(/price_mismatch/);
  });

  it("turno ajeno del mismo negocio: no se registra y queda en revisión (no se pierde)", async () => {
    const r = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.ownerShift));
    expect(r.error).toBeNull();
    const res = r.data as OfflineResult;
    expect(res.status).toBe("needs_review");
    expect(res.sale_id).toBeNull();
    expect(res.reasons).toEqual(["sale_rejected"]);
    expect(res.error).toMatch(/shift_not_owned/);
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("id")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "offline_sale_needs_review")
      .eq("entity_id", res.id);
    expect(logs).toHaveLength(1);
  });

  it("turno de otro negocio: rechazo duro, nada guardado", async () => {
    const id = randomUUID();
    const r = await sync(ctx.cashier, id, offlineSale(ctx.shiftB));
    expect(r.error?.message).toMatch(/shift_not_found/);
    const { count } = await ctx.admin
      .from("offline_sales")
      .select("id", { count: "exact", head: true })
      .eq("client_sale_id", id);
    expect(count).toBe(0);
  });

  it("otro usuario no puede mandar ventas a nombre del cajero", async () => {
    const r = await sync(ctx.cashier2, randomUUID(), offlineSale(ctx.cashierShift), { user_id: ctx.cashier.id });
    expect(r.error?.message).toMatch(/offline_user_mismatch/);
  });

  it("medios no permitidos offline y política: van a revisión con el motivo", async () => {
    const qr = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift, { method: "qr" }));
    expect((qr.data as OfflineResult).status).toBe("needs_review");
    expect((qr.data as OfflineResult).reasons).toContain("method_not_allowed_offline");

    const tampered = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift), { integrity: "failed" });
    expect((tampered.data as OfflineResult).reasons).toContain("integrity_failed");

    const old = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift), {
      sold_at: new Date(Date.now() - 72 * 3_600_000).toISOString(),
    });
    expect((old.data as OfflineResult).reasons).toContain("too_old");
  });

  it("política del dueño: el cajero no la cambia; el monto máximo manda a revisión", async () => {
    const denied = await rpc(ctx.cashier.client, "offline_policy_save", { p_policy: { max_amount: 1 } });
    expect(denied.error?.message).toMatch(/forbidden/);
    const bad = await rpc(ctx.owner.client, "offline_policy_save", { p_policy: { max_sales: 0 } });
    expect(bad.error?.message).toMatch(/offline_policy_max_sales/);
    const ok = await rpc(ctx.owner.client, "offline_policy_save", { p_policy: { max_amount: 150 } });
    expect(ok.error).toBeNull();

    const r = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift, { qty: 2 }));
    const res = r.data as OfflineResult;
    expect(res.status).toBe("needs_review");
    expect(res.reasons).toEqual(["over_amount_limit"]);

    // El cajero no resuelve.
    const cashierTry = await rpc(ctx.cashier.client, "offline_sale_resolve", { p_id: res.id, p_action: "retry" });
    expect(cashierTry.error?.message).toMatch(/forbidden/);

    // El dueño la registra en su caja (aprueba el monto).
    const retry = await rpc(ctx.owner.client, "offline_sale_resolve", {
      p_id: res.id,
      p_action: "retry",
      p_cash_shift_id: ctx.ownerShift,
    });
    expect(retry.error).toBeNull();
    const done = retry.data as OfflineResult;
    expect(done.status).toBe("synced");
    const { data: sale } = await ctx.admin.from("sales").select("cash_shift_id").eq("id", done.sale_id!).single();
    expect((sale as { cash_shift_id: string }).cash_shift_id).toBe(ctx.ownerShift);

    await rpc(ctx.owner.client, "offline_policy_save", { p_policy: {} });
  });

  it("descartar exige motivo y queda auditado", async () => {
    const r = await sync(ctx.cashier, randomUUID(), offlineSale(ctx.cashierShift, { method: "account" }));
    const res = r.data as OfflineResult;
    expect(res.status).toBe("needs_review");
    const noNote = await rpc(ctx.owner.client, "offline_sale_resolve", { p_id: res.id, p_action: "discard" });
    expect(noNote.error?.message).toMatch(/note_required/);
    const d = await rpc(ctx.owner.client, "offline_sale_resolve", {
      p_id: res.id,
      p_action: "discard",
      p_note: "Cobrada dos veces, se devolvió",
    });
    expect(d.error).toBeNull();
    expect((d.data as OfflineResult).status).toBe("discarded");
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("reason")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "offline_sale_discard")
      .eq("entity_id", res.id);
    expect(logs).toEqual([{ reason: "Cobrada dos veces, se devolvió" }]);
  });

  it("RLS: el cajero ve sólo las suyas, el dueño todas y otro negocio ninguna; nadie escribe directo", async () => {
    await sync(ctx.cashier2, randomUUID(), offlineSale(ctx.cashierShift));
    const mine = await ctx.cashier.client.from("offline_sales" as never).select("submitted_by");
    expect(mine.error).toBeNull();
    const mineRows = mine.data as unknown as { submitted_by: string }[];
    expect(mineRows.length).toBeGreaterThan(0);
    expect(mineRows.every((r) => r.submitted_by === ctx.cashier.id)).toBe(true);

    const all = await ctx.owner.client.from("offline_sales" as never).select("submitted_by");
    const allRows = all.data as unknown as { submitted_by: string }[];
    expect(allRows.some((r) => r.submitted_by === ctx.cashier2.id)).toBe(true);
    expect(allRows.length).toBeGreaterThan(mineRows.length);

    const other = await ctx.ownerB.client.from("offline_sales" as never).select("id");
    expect(other.data).toEqual([]);

    const ins = await ctx.owner.client.from("offline_sales" as never).insert({
      tenant_id: ctx.tenant,
      client_sale_id: randomUUID(),
      payload: {},
      sold_at: new Date().toISOString(),
      status: "synced",
    } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.owner.client
      .from("offline_sales" as never)
      .update({ status: "resolved" } as never)
      .eq("tenant_id", ctx.tenant)
      .select("id");
    expect(upd.error !== null || (upd.data as unknown[]).length === 0).toBe(true);
  });
});
