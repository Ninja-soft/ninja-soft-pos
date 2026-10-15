// @vitest-environment node
// =============================================================================
// ADR-139: tipos de garantía extendida con alcance por categoría y producto,
// precio calculado por el servidor dentro de create_sale y vencimiento en
// fecha de Argentina.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// El cajero vende en SU turno, abierto por él. audit_logs es inmutable
// (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { warrantyExpiry } from "@/lib/warranty/pricing";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `g139-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  shift: string;
  electro: string;
  tv: string;
  pilas: string;
  tele: string;
  pila: string;
  celu: string;
  p12: string;
  p24: string;
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

async function newTenant(admin: SupabaseClient, name: string) {
  const t = await admin.from("tenants").insert({ name, slug: `${name}-${STAMP}`.toLowerCase(), status: "active" }).select("id").single();
  if (t.error || !t.data) throw t.error ?? new Error("tenant");
  const id = (t.data as { id: string }).id;
  const { error } = await admin.from("subscription_addons").insert({ tenant_id: id, addon_key: "garantias", status: "active", source: "granted" });
  if (error) throw error;
  return id;
}

const sale = (items: Record<string, unknown>[], amount: number, warranty: number) =>
  rpc(ctx.cashier, "create_sale", {
    p_items: items,
    p_payments: [{ method: "cash", amount }],
    p_extras: warranty > 0 ? [{ kind: "warranty", amount: warranty }] : [],
    p_cash_shift_id: ctx.shift,
  });

describe.skipIf(!enabled)("ADR-139 · garantías extendidas por tipo", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.tenant = await newTenant(admin, "G139A");
    ctx.tenantB = await newTenant(admin, "G139B");

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(owner.id, cashier.id, ownerB.id);

    const cat = async (name: string, parent: string | null) => {
      const r = await admin.from("categories").insert({ tenant_id: ctx.tenant, name: `${name} ${STAMP}`, parent_id: parent }).select("id").single();
      if (r.error || !r.data) throw r.error ?? new Error("categoría");
      return (r.data as { id: string }).id;
    };
    ctx.electro = await cat("Electro", null);
    ctx.tv = await cat("TV", ctx.electro);
    ctx.pilas = await cat("Pilas", ctx.electro);

    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Tele ${STAMP}`, price: 500000, cost: 1, stock: 10, track_stock: false, warranty_months: 12, category_id: ctx.tv },
        { tenant_id: ctx.tenant, name: `Pila ${STAMP}`, price: 1000, cost: 1, stock: 10, track_stock: false, warranty_months: 0, category_id: ctx.pilas },
        { tenant_id: ctx.tenant, name: `Celu ${STAMP}`, price: 300000, cost: 1, stock: 10, track_stock: false, warranty_months: 6, category_id: ctx.electro },
      ])
      .select("id, name");
    if (prods.error || !prods.data) throw prods.error ?? new Error("productos");
    const by = (p: string) => prods.data!.find((x) => x.name.startsWith(p))!.id;
    ctx.tele = by("Tele");
    ctx.pila = by("Pila");
    ctx.celu = by("Celu");

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: (st.data as unknown as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenant, ctx.tenantB].filter(Boolean)) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("sólo el dueño o el encargado configuran, por RPC y con auditoría", async () => {
    const plan = { label: "+12 meses", months: 12, price_pct: 10, terms: "No cubre golpes." };
    const denied = await rpc(ctx.cashier, "warranty_plan_save", { p_plan: plan, p_scopes: [] });
    expect(denied.error?.message).toMatch(/forbidden/);
    const direct = await ctx.owner.from("warranty_plans").insert({ label: "directo", months: 1 } as never);
    expect(direct.error).not.toBeNull();

    const a = await rpc(ctx.owner, "warranty_plan_save", { p_plan: plan, p_scopes: [{ category_id: ctx.pilas, effect: "exclude" }] });
    expect(a.error).toBeNull();
    ctx.p12 = a.data as string;
    const b = await rpc(ctx.owner, "warranty_plan_save", {
      p_plan: { label: "+24 meses", months: 24, price_pct: 18, rounding_step: 100, max_price: 100000, applies_to_all: false },
      p_scopes: [
        { category_id: ctx.electro, effect: "include" },
        { category_id: ctx.tv, effect: "exclude" },
        { product_id: ctx.tele, effect: "include" },
      ],
    });
    expect(b.error).toBeNull();
    ctx.p24 = b.data as string;

    const audit = await ctx.admin.from("audit_logs").select("action").eq("tenant_id", ctx.tenant).eq("entity_type", "warranty_plans");
    expect((audit.data ?? []).filter((r) => (r as { action: string }).action === "warranty_plan_created")).toHaveLength(2);
  });

  it("otro negocio no ve ni toca los tipos ni su alcance", async () => {
    const plans = await ctx.ownerB.from("warranty_plans").select("id");
    expect(plans.data ?? []).toHaveLength(0);
    const scopes = await ctx.ownerB.from("warranty_plan_scopes" as never).select("id");
    expect(scopes.data ?? []).toHaveLength(0);
    const arch = await rpc(ctx.ownerB, "warranty_plan_archive", { p_id: ctx.p12 });
    expect(arch.error?.message).toMatch(/warranty_plan_not_found/);
    const cross = await rpc(ctx.ownerB, "warranty_plan_save", {
      p_plan: { label: "X", months: 12, price_pct: 10 },
      p_scopes: [{ category_id: ctx.electro, effect: "include" }],
    });
    expect(cross.error?.message).toMatch(/warranty_scope_category_not_found/);
  });

  it("la venta guarda la garantía con el precio del servidor y el vencimiento en fecha de Argentina", async () => {
    // Tele x2: el producto gana a la exclusión de TV. 18% de 500.000 = 90.000 c/u.
    const ok = await sale(
      [
        { product_id: ctx.tele, quantity: 2, unit_price: 500000, discount: 0 },
        { product_id: null, name: "Garantía +24 meses", quantity: 1, unit_price: 180000, discount: 0, warranty_plan_id: ctx.p24, warranty_for: 0 },
      ],
      1180000,
      180000,
    );
    expect(ok.error).toBeNull();
    const saleId = (ok.data as { sale_id: string }).sale_id;
    const { data: s } = await ctx.admin.from("sales").select("created_at").eq("id", saleId).single();
    const { data: items } = await ctx.admin
      .from("sale_items")
      .select("product_id, warranty_months, warranty_expires_on, warranty_terms")
      .eq("sale_id", saleId);
    const w = (items ?? []).find((r) => (r as { product_id: string | null }).product_id === null) as unknown as {
      warranty_months: number;
      warranty_expires_on: string;
    };
    expect(w.warranty_months).toBe(24);
    expect(w.warranty_expires_on).toBe(warrantyExpiry((s as { created_at: string }).created_at, 12, 24));
  });

  it("rechaza un precio menor, un producto excluido y un tipo pausado", async () => {
    const cheap = await sale(
      [
        { product_id: ctx.celu, quantity: 1, unit_price: 300000, discount: 0 },
        { product_id: null, name: "Garantía +24 meses", quantity: 1, unit_price: 100, discount: 0, warranty_plan_id: ctx.p24, warranty_for: 0 },
      ],
      300100,
      100,
    );
    expect(cheap.error?.message).toMatch(/warranty_amount_mismatch/);

    const excluded = await sale(
      [
        { product_id: ctx.pila, quantity: 1, unit_price: 1000, discount: 0 },
        { product_id: null, name: "Garantía +12 meses", quantity: 1, unit_price: 100, discount: 0, warranty_plan_id: ctx.p12, warranty_for: 0 },
      ],
      1100,
      100,
    );
    expect(excluded.error?.message).toMatch(/warranty_not_applicable/);

    expect((await rpc(ctx.owner, "warranty_plan_set_active", { p_id: ctx.p12, p_active: false })).error).toBeNull();
    const paused = await sale(
      [
        { product_id: ctx.celu, quantity: 1, unit_price: 300000, discount: 0 },
        { product_id: null, name: "Garantía +12 meses", quantity: 1, unit_price: 30000, discount: 0, warranty_plan_id: ctx.p12, warranty_for: 0 },
      ],
      330000,
      30000,
    );
    expect(paused.error?.message).toMatch(/warranty_plan_inactive/);
  });

  it("archivar es baja lógica: deja de verse en el catálogo pero la fila queda", async () => {
    expect((await rpc(ctx.owner, "warranty_plan_archive", { p_id: ctx.p12 })).error).toBeNull();
    const live = await ctx.owner.from("warranty_plans").select("id").is("deleted_at" as never, null);
    expect((live.data ?? []).map((r) => (r as { id: string }).id)).not.toContain(ctx.p12);
    const row = await ctx.admin.from("warranty_plans").select("id").eq("id", ctx.p12).single();
    expect(row.data).not.toBeNull();
  });
});
