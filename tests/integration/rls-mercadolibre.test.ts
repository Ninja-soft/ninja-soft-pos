// @vitest-environment node
// =============================================================================
// Mercado Libre MVP (H87 · ADR-104, migraciones 20261110400000 a
// 20261110400300): aislamiento entre negocios, gating, webhook idempotente,
// orden -> venta sin duplicar, cancelación que revierte, lock del token y
// cola con coalescing.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
//
// Escenario: negocios A y B con `mercadolibre` (add-on), C sin la feature.
// La ingesta de órdenes la hace el worker con service_role (como en prod).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `ml-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const ML_USER_A = 700000000 + Math.floor(Math.random() * 90_000_000);
const ML_USER_B = ML_USER_A + 1;
const ORDER_ID = String(2_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tA: string;
  tB: string;
  tC: string;
  ownerA: User;
  viewerA: User;
  ownerB: User;
  ownerC: User;
  userIds: string[];
  storeA: string;
  productA: string;
  accA: string;
  accB: string;
  itemA: string;
  saleId: string;
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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

function pack(status: string) {
  return {
    pack_key: ORDER_ID,
    pack_id: null,
    orders: [
      {
        ml_order_id: ORDER_ID,
        status,
        status_detail: null,
        tags: status === "paid" ? ["paid"] : ["not_paid"],
        date_created: "2026-10-13T12:00:00.000-03:00",
        date_closed: "2026-10-13T12:00:05.000-03:00",
        last_updated: status === "paid" ? "2026-10-13T12:00:06.000-03:00" : "2026-10-13T13:00:00.000-03:00",
        total_amount: 3000,
        paid_amount: 3000,
        currency: "ARS",
        fraud_risk: false,
        cancel_detail: status === "cancelled" ? { group: "buyer", code: "buyer_cancel", requested_by: "buyer" } : null,
        buyer: { id: "123456", nickname: "COMPRADOR_TEST" },
        shipment_id: null,
        sale_fee_total: 391,
        lines: [
          {
            ml_order_id: ORDER_ID,
            ml_item_id: `MLA${ML_USER_A}`,
            ml_variation_id: null,
            title: "Remera ML",
            seller_sku: `REM-${STAMP}`,
            quantity: 2,
            unit_price: 1500,
            sale_fee: 195.5,
          },
        ],
      },
    ],
    shipment: null,
    billing: null,
  };
}

async function stockOf(productId: string): Promise<number> {
  const { data } = await ctx.admin.from("products").select("stock").eq("id", productId).single();
  return Number((data as { stock: number }).stock);
}

describe.skipIf(!enabled)("Mercado Libre · aislamiento, ventas idempotentes y gating", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `ML A ${STAMP}`, slug: `mla-${STAMP}`, status: "active" },
        { name: `ML B ${STAMP}`, slug: `mlb-${STAMP}`, status: "active" },
        { name: `ML C ${STAMP}`, slug: `mlc-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tA = rows.find((x) => x.slug === `mla-${STAMP}`)!.id;
    ctx.tB = rows.find((x) => x.slug === `mlb-${STAMP}`)!.id;
    ctx.tC = rows.find((x) => x.slug === `mlc-${STAMP}`)!.id;

    // Insert multi-fila: todas las claves en cada fila.
    const { error: aErr } = await admin.from("subscription_addons").insert(
      [ctx.tA, ctx.tB].map((tenant) => ({ tenant_id: tenant, addon_key: "mercadolibre", status: "active", source: "granted" })),
    );
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `mlowa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.viewerA = await makeUser(admin, `mlvwa-${STAMP}@test.local`, ctx.tA, "viewer");
    ctx.ownerB = await makeUser(admin, `mlowb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.ownerC = await makeUser(admin, `mlowc-${STAMP}@test.local`, ctx.tC, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.viewerA.id, ctx.ownerB.id, ctx.ownerC.id);

    const sA = await ctx.ownerA.client.from("stores").insert({ name: "Centro ML" } as never).select("id").single();
    if (sA.error || !sA.data) throw sA.error ?? new Error("store A");
    ctx.storeA = (sA.data as { id: string }).id;

    const prods = await admin
      .from("products")
      .insert([{ tenant_id: ctx.tA, name: `Remera ML ${STAMP}`, sku: `REM-${STAMP}`, price: 1500, cost: 700, stock: 10 }])
      .select("id");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    ctx.productA = (prods.data[0] as { id: string }).id;

    // Cuentas conectadas (lo que deja ml_oauth_callback): todas las claves.
    const accs = await admin
      .from("ml_accounts")
      .insert([
        { tenant_id: ctx.tA, ml_user_id: ML_USER_A, nickname: "VENDEDOR_A", site_id: "MLA", invoice_mode: "manual" },
        { tenant_id: ctx.tB, ml_user_id: ML_USER_B, nickname: "VENDEDOR_B", site_id: "MLA", invoice_mode: "manual" },
      ])
      .select("id, tenant_id");
    if (accs.error || !accs.data) throw accs.error ?? new Error("accounts");
    ctx.accA = (accs.data as { id: string; tenant_id: string }[]).find((a) => a.tenant_id === ctx.tA)!.id;
    ctx.accB = (accs.data as { id: string; tenant_id: string }[]).find((a) => a.tenant_id === ctx.tB)!.id;
    const map = await admin.from("ml_location_map").insert([
      { tenant_id: ctx.tA, account_id: ctx.accA, location_type: "item_stock", store_id: ctx.storeA, reserve_qty: 0 },
    ]);
    if (map.error) throw map.error;
    const tok = await admin.from("ml_tokens").insert([
      { account_id: ctx.accA, tenant_id: ctx.tA, access_token: "AT-A", refresh_token: "RT-A", expires_at: new Date(Date.now() + 3600_000).toISOString() },
    ]);
    if (tok.error) throw tok.error;

    const item = await rpc(admin, "ml_item_upsert", {
      p_account: ctx.accA,
      p: { ml_item_id: `MLA${ML_USER_A}`, title: "Remera ML", status: "active", price: 1500, available_quantity: 10, has_variations: false },
    });
    if (item.error) throw new Error(item.error.message);
    ctx.itemA = item.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB, ctx.tC]) {
      await admin.from("ml_accounts").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar, queda.
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el dueño vincula; solo lectura no; un negocio sin la feature tampoco", async () => {
    const v = await rpc(ctx.viewerA.client, "ml_item_link", { p_item: ctx.itemA, p_variation: null, p_product: ctx.productA, p_variant: null });
    expect(v.error?.message).toMatch(/forbidden/);
    const c = await rpc(ctx.ownerC.client, "ml_item_link", { p_item: ctx.itemA, p_variation: null, p_product: ctx.productA, p_variant: null });
    expect(c.error?.message).toMatch(/feature_not_in_plan/);
    const b = await rpc(ctx.ownerB.client, "ml_item_link", { p_item: ctx.itemA, p_variation: null, p_product: ctx.productA, p_variant: null });
    expect(b.error?.message).toMatch(/item_not_found/);
    const ok = await rpc(ctx.ownerA.client, "ml_item_link", { p_item: ctx.itemA, p_variation: null, p_product: ctx.productA, p_variant: null });
    expect(ok.error).toBeNull();
    // El vínculo encola un push de stock y otro de precio (coalescing por publicación).
    const { data: jobs } = await ctx.ownerA.client.from("ml_sync_jobs").select("kind, status").eq("account_id", ctx.accA);
    expect(((jobs ?? []) as { kind: string }[]).map((j) => j.kind).sort()).toEqual(["price_push", "stock_push"]);
  });

  it("nadie escribe por REST ni lee tokens", async () => {
    const ins = await ctx.ownerA.client.from("ml_accounts").insert({ tenant_id: ctx.tA, ml_user_id: 1, nickname: "x" } as never);
    expect(ins.error).not.toBeNull();
    const tok = await ctx.ownerA.client.from("ml_tokens").select("access_token");
    expect(tok.error).not.toBeNull();
    const st = await ctx.ownerA.client.from("ml_oauth_states").select("state");
    expect(st.error).not.toBeNull();
  });

  it("webhook duplicado se guarda una sola vez; usuario desconocido se descarta", async () => {
    const n = {
      dedupe_key: `${STAMP}-0000-notif`,
      notification_id: `${STAMP}-0000-notif`,
      topic: "orders_v2",
      resource: `/orders/${ORDER_ID}`,
      user_id: String(ML_USER_A),
      attempts: 1,
      sent: "2026-10-13T16:19:20.129Z",
      actions: [],
      source: "webhook",
      handled: true,
    };
    const r1 = await rpc(ctx.admin, "ml_notification_ingest", { p: n });
    const r2 = await rpc(ctx.admin, "ml_notification_ingest", { p: { ...n, attempts: 2 } });
    expect([r1.data, r2.data]).toEqual(["stored", "duplicate"]);
    const { count } = await ctx.admin.from("ml_notifications").select("id", { count: "exact", head: true }).eq("dedupe_key", n.dedupe_key);
    expect(count).toBe(1);
    const r3 = await rpc(ctx.admin, "ml_notification_ingest", { p: { ...n, dedupe_key: `${STAMP}-x`, user_id: "1" } });
    expect(r3.data).toBe("unknown_user");
    // Claim con lock: la misma notificación no la toman dos workers.
    const c1 = await rpc(ctx.admin, "ml_notifications_claim", { p_limit: 200 });
    const c2 = await rpc(ctx.admin, "ml_notifications_claim", { p_limit: 200 });
    const mine = (x: RpcRes) => ((x.data ?? []) as { dedupe_key: string }[]).filter((r) => r.dedupe_key === n.dedupe_key).length;
    expect(mine(c1) + mine(c2)).toBe(1);
  });

  it("una orden pagada crea UNA venta aunque llegue tres veces, sin caja y con stock una sola vez", async () => {
    const before = await stockOf(ctx.productA);
    const r = await Promise.all([1, 2, 3].map(() => rpc(ctx.admin, "ml_ingest_pack", { p_account: ctx.accA, p: pack("paid") })));
    for (const x of r) expect(x.error).toBeNull();
    const decisions = r.map((x) => (x.data as { decision: string }).decision).sort();
    expect(decisions).toEqual(["create_sale", "noop", "noop"]);
    const { data: sales } = await ctx.admin.from("sales").select("id, total, channel, status, cash_shift_id").eq("tenant_id", ctx.tA).eq("channel_ref", ORDER_ID);
    expect(sales).toHaveLength(1);
    const sale = (sales as { id: string; total: number; channel: string; cash_shift_id: string | null }[])[0]!;
    ctx.saleId = sale.id;
    expect(sale).toMatchObject({ channel: "mercadolibre", cash_shift_id: null });
    expect(Number(sale.total)).toBe(3000);
    expect(await stockOf(ctx.productA)).toBe(before - 2);
    const { data: pays } = await ctx.admin.from("payments").select("method, amount").eq("sale_id", sale.id);
    expect(pays).toEqual([{ method: "mercadolibre", amount: 3000 }]);
    const { count: cash } = await ctx.admin.from("cash_movements").select("id", { count: "exact", head: true }).eq("reference_id", sale.id);
    expect(cash).toBe(0);
    const { data: ord } = await ctx.ownerA.client.from("ml_orders").select("sale_id, sale_fee_total, invoice_status").eq("ml_order_id", ORDER_ID);
    expect(ord).toEqual([{ sale_id: sale.id, sale_fee_total: 391, invoice_status: "pending" }]);
    // La venta encoló el push de stock (coalescing: un solo pendiente).
    const { count: pend } = await ctx.admin
      .from("ml_sync_jobs")
      .select("id", { count: "exact", head: true })
      .eq("dedupe_key", `stock_push:${ctx.itemA}`)
      .eq("status", "pending");
    expect(pend).toBe(1);
  });

  it("el stock que se publica es el de la sucursal de la cuenta", async () => {
    const { data } = await rpc(ctx.admin, "ml_item_stock_snapshot", { p_item: ctx.itemA });
    const snap = data as { push_enabled: boolean; links: { qty: number }[] };
    expect(snap.push_enabled).toBe(true);
    expect(snap.links[0]!.qty).toBe(await stockOf(ctx.productA));
  });

  it("otro negocio no ve las cuentas, órdenes ni la venta", async () => {
    const accs = await ctx.ownerB.client.from("ml_accounts").select("id");
    expect(((accs.data ?? []) as { id: string }[]).map((a) => a.id)).toEqual([ctx.accB]);
    const ords = await ctx.ownerB.client.from("ml_orders").select("id");
    expect(ords.data ?? []).toHaveLength(0);
    const sale = await ctx.ownerB.client.from("sales").select("id").eq("id", ctx.saleId);
    expect(sale.data ?? []).toHaveLength(0);
    const ownA = await ctx.ownerA.client.from("ml_orders").select("id");
    expect(ownA.data ?? []).toHaveLength(1);
  });

  it("la cancelación en ML anula la venta y devuelve el stock (una sola vez)", async () => {
    const before = await stockOf(ctx.productA);
    const r1 = await rpc(ctx.admin, "ml_ingest_pack", { p_account: ctx.accA, p: pack("cancelled") });
    const r2 = await rpc(ctx.admin, "ml_ingest_pack", { p_account: ctx.accA, p: pack("cancelled") });
    expect(r1.error).toBeNull();
    expect((r1.data as { decision: string; reverted: number }).reverted).toBe(1);
    expect((r2.data as { reverted: number }).reverted).toBe(0);
    expect(await stockOf(ctx.productA)).toBe(before + 2);
    const { data } = await ctx.admin.from("sales").select("status, void_reason").eq("id", ctx.saleId).single();
    expect(data).toMatchObject({ status: "voided", void_reason: "Cancelada en Mercado Libre" });
    // Un estado viejo ("paid") que llega tarde no resucita la orden.
    const late = await rpc(ctx.admin, "ml_ingest_pack", { p_account: ctx.accA, p: pack("paid") });
    expect((late.data as { decision: string }).decision).toBe("cancel");
  });

  it("el lock de renovación del token lo toma uno solo", async () => {
    const l1 = await rpc(ctx.admin, "ml_token_lock", { p_account: ctx.accA, p_lock: crypto.randomUUID(), p_seconds: 30 });
    const l2 = await rpc(ctx.admin, "ml_token_lock", { p_account: ctx.accA, p_lock: crypto.randomUUID(), p_seconds: 30 });
    expect((l1.data as unknown[]).length).toBe(1);
    expect((l2.data as unknown[]).length).toBe(0);
    await rpc(ctx.admin, "ml_token_fail", { p_account: ctx.accA, p_lock: null, p_code: "invalid_grant", p_message: "revocado" });
    const { data } = await ctx.ownerA.client.from("ml_accounts").select("status").eq("id", ctx.accA).single();
    expect(data).toMatchObject({ status: "reauth_required" });
  });

  it("límite de llamadas: el bucket se crea y descuenta", async () => {
    const r = await rpc(ctx.admin, "ml_rate_take", { p_account: ctx.accA, p_family: "stock", p_cost: 1 });
    expect(r.data).toBe(0);
    await rpc(ctx.admin, "ml_rate_block", { p_account: ctx.accA, p_family: "stock", p_ms: 5000 });
    const w = await rpc(ctx.admin, "ml_rate_take", { p_account: ctx.accA, p_family: "stock", p_cost: 1 });
    expect(Number(w.data)).toBeGreaterThan(1000);
  });

  it("los clientes no ejecutan las RPC del worker", async () => {
    const r = await rpc(ctx.ownerA.client, "ml_ingest_pack", { p_account: ctx.accA, p: pack("paid") });
    expect(r.error).not.toBeNull();
    const n = await rpc(ctx.ownerA.client, "ml_notification_ingest", { p: {} });
    expect(n.error).not.toBeNull();
  });
});
