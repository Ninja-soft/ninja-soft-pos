// @vitest-environment node
// =============================================================================
// Gestor de Mercado Libre, parte A (H141 · ADR-132, migración
// 20261127100000_ml_gestor_publicaciones): reglas de precio por tipo y
// overrides por producto (aislamiento, gating, rol, auditoría y precio del
// servidor), stock publicable con % y tope, candidatos de la publicación
// rápida y memoria de categorías sólo por service_role.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mlg-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const ML_USER_A = 800000000 + Math.floor(Math.random() * 90_000_000);
const ML_USER_B = ML_USER_A + 1;

type User = { id: string; client: SupabaseClient };
type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const ctx = {} as {
  admin: SupabaseClient;
  tA: string;
  tB: string;
  tC: string;
  ownerA: User;
  viewerA: User;
  cashierA: User;
  ownerB: User;
  ownerC: User;
  userIds: string[];
  storeA: string;
  productA: string;
  listA: string;
  listB: string;
  accA: string;
  accB: string;
  accC: string;
};

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

describe.skipIf(!enabled)("Gestor de Mercado Libre · publicaciones y precios por tipo", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `MLG A ${STAMP}`, slug: `mlga-${STAMP}`, status: "active" },
        { name: `MLG B ${STAMP}`, slug: `mlgb-${STAMP}`, status: "active" },
        { name: `MLG C ${STAMP}`, slug: `mlgc-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tA = rows.find((x) => x.slug === `mlga-${STAMP}`)!.id;
    ctx.tB = rows.find((x) => x.slug === `mlgb-${STAMP}`)!.id;
    ctx.tC = rows.find((x) => x.slug === `mlgc-${STAMP}`)!.id;
    const { error: aErr } = await admin.from("subscription_addons").insert(
      [ctx.tA, ctx.tB].map((tenant) => ({ tenant_id: tenant, addon_key: "mercadolibre", status: "active", source: "granted" })),
    );
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `mlgowa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.viewerA = await makeUser(admin, `mlgvwa-${STAMP}@test.local`, ctx.tA, "viewer");
    ctx.cashierA = await makeUser(admin, `mlgcsa-${STAMP}@test.local`, ctx.tA, "cashier");
    ctx.ownerB = await makeUser(admin, `mlgowb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.ownerC = await makeUser(admin, `mlgowc-${STAMP}@test.local`, ctx.tC, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.viewerA.id, ctx.cashierA.id, ctx.ownerB.id, ctx.ownerC.id);

    const sA = await ctx.ownerA.client.from("stores").insert({ name: "Centro MLG" } as never).select("id").single();
    if (sA.error || !sA.data) throw sA.error ?? new Error("store A");
    ctx.storeA = (sA.data as { id: string }).id;
    const prods = await admin
      .from("products")
      .insert([{ tenant_id: ctx.tA, name: `Yerba MLG ${STAMP}`, sku: `YER-${STAMP}`, barcode: "7790895000997", price: 10000, cost: 5000, stock: 40 }])
      .select("id");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    ctx.productA = (prods.data[0] as { id: string }).id;
    const lists = await admin
      .from("price_lists")
      .insert([
        { tenant_id: ctx.tA, name: `Premium ML ${STAMP}` },
        { tenant_id: ctx.tB, name: `Otra ${STAMP}` },
      ])
      .select("id, tenant_id");
    if (lists.error || !lists.data) throw lists.error ?? new Error("lists");
    ctx.listA = (lists.data as { id: string; tenant_id: string }[]).find((l) => l.tenant_id === ctx.tA)!.id;
    ctx.listB = (lists.data as { id: string; tenant_id: string }[]).find((l) => l.tenant_id === ctx.tB)!.id;

    const accs = await admin
      .from("ml_accounts")
      .insert([
        { tenant_id: ctx.tA, ml_user_id: ML_USER_A, nickname: "MLG_A", site_id: "MLA" },
        { tenant_id: ctx.tB, ml_user_id: ML_USER_B, nickname: "MLG_B", site_id: "MLA" },
        { tenant_id: ctx.tC, ml_user_id: ML_USER_B + 1, nickname: "MLG_C", site_id: "MLA" },
      ])
      .select("id, tenant_id");
    if (accs.error || !accs.data) throw accs.error ?? new Error("accounts");
    const accRows = accs.data as { id: string; tenant_id: string }[];
    ctx.accA = accRows.find((a) => a.tenant_id === ctx.tA)!.id;
    ctx.accB = accRows.find((a) => a.tenant_id === ctx.tB)!.id;
    ctx.accC = accRows.find((a) => a.tenant_id === ctx.tC)!.id;
    const map = await admin
      .from("ml_location_map")
      .insert([{ tenant_id: ctx.tA, account_id: ctx.accA, location_type: "item_stock", store_id: ctx.storeA, reserve_qty: 0 }]);
    if (map.error) throw map.error;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB, ctx.tC]) {
      await admin.from("ml_accounts").delete().eq("tenant_id", t);
      await admin.from("price_lists").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("reglas por tipo: el dueño guarda (auditado); solo lectura, cajero, otro negocio y sin feature no", async () => {
    const rules = [
      { listing_type_id: "gold_special", enabled: true, mode: "markup", markup_pct: 0, default_on: true },
      { listing_type_id: "gold_pro", enabled: true, mode: "markup", markup_pct: 15, rounding: 100, min_price: 0 },
    ];
    const v = await rpc(ctx.viewerA.client, "ml_listing_rules_save", { p_account: ctx.accA, p_rules: rules });
    expect(v.error?.message).toMatch(/forbidden/);
    const c = await rpc(ctx.cashierA.client, "ml_listing_rules_save", { p_account: ctx.accA, p_rules: rules });
    expect(c.error?.message).toMatch(/forbidden/);
    const b = await rpc(ctx.ownerB.client, "ml_listing_rules_save", { p_account: ctx.accA, p_rules: rules });
    expect(b.error?.message).toMatch(/not_found/);
    const nf = await rpc(ctx.ownerC.client, "ml_listing_rules_save", { p_account: ctx.accC, p_rules: rules });
    expect(nf.error?.message).toMatch(/feature_not_in_plan/);
    const listAjena = await rpc(ctx.ownerA.client, "ml_listing_rules_save", {
      p_account: ctx.accA,
      p_rules: [{ listing_type_id: "gold_pro", mode: "price_list", price_list_id: ctx.listB }],
    });
    expect(listAjena.error?.message).toMatch(/invalid_price_list/);
    const ok = await rpc(ctx.ownerA.client, "ml_listing_rules_save", { p_account: ctx.accA, p_rules: rules });
    expect(ok.error).toBeNull();
    const { data: audit } = await ctx.admin.from("audit_logs").select("action").eq("tenant_id", ctx.tA).eq("action", "ml_listing_rules_saved");
    expect(audit).toHaveLength(1);
    // Cada negocio ve sólo sus reglas.
    const mine = await ctx.ownerA.client.from("ml_listing_rules").select("listing_type_id");
    expect((mine.data ?? []).length).toBe(2);
    const other = await ctx.ownerB.client.from("ml_listing_rules").select("listing_type_id");
    expect(other.data ?? []).toHaveLength(0);
  });

  it("nadie escribe reglas, overrides ni memoria por REST", async () => {
    const r = await ctx.ownerA.client
      .from("ml_listing_rules")
      .insert({ tenant_id: ctx.tA, account_id: ctx.accA, listing_type_id: "free" } as never);
    expect(r.error).not.toBeNull();
    const o = await ctx.ownerA.client
      .from("ml_product_listing_prices")
      .insert({ tenant_id: ctx.tA, account_id: ctx.accA, product_id: ctx.productA, listing_type_id: "gold_pro" } as never);
    expect(o.error).not.toBeNull();
    const m = await rpc(ctx.ownerA.client, "ml_category_memory_touch", { p_account: ctx.accA, p_category: "MLA1", p_name: "x", p_attrs: {} });
    expect(m.error).not.toBeNull();
    const vis = await rpc(ctx.ownerA.client, "ml_items_visits_save", { p_account: ctx.accA, p: [] });
    expect(vis.error).not.toBeNull();
    const pf = await rpc(ctx.ownerA.client, "ml_listing_prices_for", { p_account: ctx.accA, p_product: ctx.productA });
    expect(pf.error).not.toBeNull();
  });

  it("vista previa con precios por tipo del servidor; override por producto", async () => {
    const pv = await rpc(ctx.ownerA.client, "ml_product_channel_preview", { p_account: ctx.accA, p_product: ctx.productA });
    expect(pv.error).toBeNull();
    const prices = Object.fromEntries(
      ((pv.data as { listing_prices: Array<{ listing_type_id: string; price: number | null }> }).listing_prices ?? []).map((l) => [l.listing_type_id, l.price]),
    );
    expect(Number(prices.gold_special)).toBe(10000);
    expect(Number(prices.gold_pro)).toBe(11500);

    const ov = await rpc(ctx.ownerA.client, "ml_product_listing_save", {
      p_account: ctx.accA,
      p_product: ctx.productA,
      p: [
        { listing_type_id: "gold_special", mode: "skip" },
        { listing_type_id: "gold_pro", mode: "fixed", fixed_price: 12999 },
      ],
    });
    expect(ov.error).toBeNull();
    const pv2 = await rpc(ctx.ownerA.client, "ml_product_channel_preview", { p_account: ctx.accA, p_product: ctx.productA });
    const p2 = Object.fromEntries(
      ((pv2.data as { listing_prices: Array<{ listing_type_id: string; price: number | null }> }).listing_prices ?? []).map((l) => [l.listing_type_id, l.price]),
    );
    expect(p2.gold_special).toBeNull();
    expect(Number(p2.gold_pro)).toBe(12999);
    const bad = await rpc(ctx.ownerA.client, "ml_product_listing_save", {
      p_account: ctx.accA,
      p_product: ctx.productA,
      p: [{ listing_type_id: "gold_pro", mode: "fixed", fixed_price: 0 }],
    });
    expect(bad.error?.message).toMatch(/invalid_fixed_price/);
    const otherTenant = await rpc(ctx.ownerB.client, "ml_product_listing_save", { p_account: ctx.accB, p_product: ctx.productA, p: [] });
    expect(otherTenant.error?.message).toMatch(/product_not_found/);
    const { data: audit } = await ctx.admin.from("audit_logs").select("action").eq("tenant_id", ctx.tA).eq("action", "ml_product_listing_saved");
    expect((audit ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("stock publicable con % y tope; candidatos por código de barras", async () => {
    const s = await rpc(ctx.ownerA.client, "ml_account_settings_save", { p_account: ctx.accA, p: { reserve_pct: 50, max_qty: 7 } });
    expect(s.error).toBeNull();
    const pv = await rpc(ctx.ownerA.client, "ml_product_channel_preview", { p_account: ctx.accA, p_product: ctx.productA });
    expect((pv.data as { qty: number | null }).qty).toBeLessThanOrEqual(7);
    const bad = await rpc(ctx.ownerA.client, "ml_account_settings_save", { p_account: ctx.accA, p: { reserve_pct: 99 } });
    expect(bad.error?.message).toMatch(/invalid_reserve_pct/);

    const c = await rpc(ctx.ownerA.client, "ml_quick_candidates", { p_account: ctx.accA, p_search: "7790895000997", p_only_unpublished: true });
    expect(c.error).toBeNull();
    expect(((c.data ?? []) as { product_id: string }[]).map((x) => x.product_id)).toEqual([ctx.productA]);
    const b = await rpc(ctx.ownerB.client, "ml_quick_candidates", { p_account: ctx.accA, p_search: "7790895000997" });
    expect(b.error?.message).toMatch(/not_found/);
  });

  it("service_role: memoria por categoría y visitas", async () => {
    const m1 = await rpc(ctx.admin, "ml_category_memory_touch", {
      p_account: ctx.accA,
      p_category: "MLA409408",
      p_name: "Yerba Mate",
      p_attrs: { BRAND: { value_name: "Playadito" } },
    });
    expect(m1.error).toBeNull();
    const mem = await ctx.ownerA.client.from("ml_category_memory").select("category_id, uses, attrs");
    expect(mem.data).toHaveLength(1);
    const memB = await ctx.ownerB.client.from("ml_category_memory").select("category_id");
    expect(memB.data ?? []).toHaveLength(0);
  });
});
