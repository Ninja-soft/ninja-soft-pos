// @vitest-environment node
// =============================================================================
// F1.5 — Suite de aislamiento multi-tenant y RLS.
//
// Corre contra un Supabase LOCAL (con las migraciones aplicadas):
//   1. pnpm db:start            (supabase start — necesita Docker)
//   2. pnpm db:reset            (aplica migraciones + seed)
//   3. SUPABASE_TEST_URL=http://127.0.0.1:54321 \
//      SUPABASE_TEST_ANON_KEY=<anon de `supabase status`> \
//      SUPABASE_TEST_SERVICE_KEY=<service_role de `supabase status`> \
//      pnpm test:rls
//
// Sin esas variables la suite SE SALTA (CI y `pnpm test` siguen verdes).
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

// Datos creados en el setup, borrados en el teardown.
const STAMP = `rls-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  productA: string;
  productB: string;
  variantParentA: string;
  priceListA: string;
};
const ctx = {} as Ctx;

async function makeUser(
  admin: SupabaseClient,
  email: string,
  tenantId: string,
  role: string,
): Promise<{ id: string; client: SupabaseClient }> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  // Espejo en public.users (en prod lo hace el trigger de signup; acá directo).
  await admin
    .from("users")
    .upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;

  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (sErr) throw sErr;
  return { id, client };
}

describe.skipIf(!enabled)("RLS — aislamiento multi-tenant", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    // Dos tenants con datos cruzados conocidos.
    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `Tenant A ${STAMP}`, slug: `a-${STAMP}`, status: "active" },
        { name: `Tenant B ${STAMP}`, slug: `b-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants || tenants.length !== 2) throw tErr ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const ownerA = await makeUser(admin, `owner-a-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashierA = await makeUser(admin, `cashier-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerA = ownerA.client;
    ctx.cashierA = cashierA.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(ownerA.id, cashierA.id, ownerB.id);

    const { data: products, error: pErr } = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenantA, name: `Producto A ${STAMP}`, price: 100 },
        { tenant_id: ctx.tenantB, name: `Producto B ${STAMP}`, price: 200 },
      ])
      .select("id");
    if (pErr || !products || products.length !== 2) throw pErr ?? new Error("products");
    ctx.productA = products[0]!.id;
    ctx.productB = products[1]!.id;

    const { error: cErr } = await admin.from("customers").insert([
      { tenant_id: ctx.tenantA, name: `Cliente A ${STAMP}` },
      { tenant_id: ctx.tenantB, name: `Cliente B ${STAMP}` },
    ]);
    if (cErr) throw cErr;

    // H10: producto padre de variantes en el tenant A.
    const { data: parent, error: vpErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenantA, name: `Variante Padre ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (vpErr || !parent) throw vpErr ?? new Error("variant parent");
    ctx.variantParentA = parent.id;
  }, 60_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      // H10: items -> listas -> variantes, antes de borrar products.
      await admin.from("price_list_items").delete().eq("tenant_id", t);
      await admin.from("price_lists").delete().eq("tenant_id", t);
      await admin.from("product_variants").delete().eq("tenant_id", t);
      await admin.from("ticket_templates").delete().eq("tenant_id", t);
      await admin.from("payment_plans").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("customers").delete().eq("tenant_id", t);
      await admin.from("products").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("pos_settings").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Aislamiento de lectura
  // ---------------------------------------------------------------------------

  it("products: el tenant A no ve productos del tenant B", async () => {
    const { data: own } = await ctx.ownerA
      .from("products")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(own?.length).toBeGreaterThan(0);

    const { data: cross } = await ctx.ownerA
      .from("products")
      .select("id")
      .eq("tenant_id", ctx.tenantB);
    expect(cross).toEqual([]);

    const { data: byId } = await ctx.ownerA
      .from("products")
      .select("id")
      .eq("id", ctx.productB);
    expect(byId).toEqual([]);
  });

  it("customers: el tenant A no ve clientes del tenant B (y viceversa)", async () => {
    const { data: crossAB } = await ctx.ownerA
      .from("customers")
      .select("id")
      .eq("tenant_id", ctx.tenantB);
    expect(crossAB).toEqual([]);

    const { data: crossBA } = await ctx.ownerB
      .from("customers")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(crossBA).toEqual([]);
  });

  it("sales: lectura cross-tenant devuelve vacío", async () => {
    const { data, error } = await ctx.ownerA
      .from("sales")
      .select("id")
      .eq("tenant_id", ctx.tenantB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("caja: cash_shifts y cash_movements cross-tenant devuelven vacío", async () => {
    const shifts = await ctx.ownerA
      .from("cash_shifts")
      .select("id")
      .eq("tenant_id", ctx.tenantB);
    expect(shifts.error).toBeNull();
    expect(shifts.data).toEqual([]);

    const movs = await ctx.ownerA
      .from("cash_movements")
      .select("id")
      .eq("tenant_id", ctx.tenantB);
    expect(movs.error).toBeNull();
    expect(movs.data).toEqual([]);
  });

  it("audit_logs: los logs de A no se ven desde B", async () => {
    const { error: insErr } = await ctx.ownerA.from("audit_logs").insert({
      tenant_id: ctx.tenantA,
      entity_type: "test",
      action: `rls_probe_${STAMP}`,
    });
    expect(insErr).toBeNull();

    const { data: fromB } = await ctx.ownerB
      .from("audit_logs")
      .select("id")
      .eq("action", `rls_probe_${STAMP}`);
    expect(fromB).toEqual([]);

    const { data: fromA } = await ctx.ownerA
      .from("audit_logs")
      .select("id")
      .eq("action", `rls_probe_${STAMP}`);
    expect(fromA?.length).toBe(1);
  });

  it("tenants: cada usuario ve solo su(s) tenant(s)", async () => {
    const { data } = await ctx.ownerA.from("tenants").select("id");
    const ids = (data ?? []).map((t) => t.id);
    expect(ids).toContain(ctx.tenantA);
    expect(ids).not.toContain(ctx.tenantB);
  });

  // ---------------------------------------------------------------------------
  // Aislamiento de escritura
  // ---------------------------------------------------------------------------

  it("products: no se puede insertar en el tenant ajeno", async () => {
    const { error } = await ctx.ownerA.from("products").insert({
      tenant_id: ctx.tenantB,
      name: `Intruso ${STAMP}`,
      price: 1,
    });
    expect(error).not.toBeNull();
  });

  it("products: no se puede actualizar un producto ajeno", async () => {
    const { data, error } = await ctx.ownerA
      .from("products")
      .update({ price: 999 })
      .eq("id", ctx.productB)
      .select("id");
    // RLS filtra la fila: no error, pero 0 filas afectadas.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: check } = await ctx.admin
      .from("products")
      .select("price")
      .eq("id", ctx.productB)
      .single();
    expect(Number(check?.price)).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Permisos por rol (owner / cashier)
  // ---------------------------------------------------------------------------

  it("payment_plans: el owner escribe, el cashier no", async () => {
    const { error: ownerErr } = await ctx.ownerA.from("payment_plans").insert({
      tenant_id: ctx.tenantA,
      label: `Plan test ${STAMP}`,
      surcharge_pct: 5,
    });
    expect(ownerErr).toBeNull();

    const { error: cashierErr } = await ctx.cashierA
      .from("payment_plans")
      .insert({
        tenant_id: ctx.tenantA,
        label: `Plan cashier ${STAMP}`,
        surcharge_pct: 5,
      });
    expect(cashierErr).not.toBeNull();
  });

  it("pos_settings: solo el owner escribe (cashier denegado)", async () => {
    const { error: cashierErr } = await ctx.cashierA
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenantA });
    expect(cashierErr).not.toBeNull();

    const { error: ownerErr } = await ctx.ownerA
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenantA });
    expect(ownerErr).toBeNull();
  });

  it("payment_secrets: nadie lee desde el cliente (deny-all)", async () => {
    const { data } = await ctx.ownerA.from("payment_secrets").select("*");
    expect(data ?? []).toEqual([]);
  });

  it("tenant_notes: invisibles para usuarios de tenant (solo staff interno)", async () => {
    const { error: insErr } = await ctx.ownerA.from("tenant_notes").insert({
      tenant_id: ctx.tenantA,
      author_user_id: ctx.userIds[0],
      body: "no debería poder",
    });
    expect(insErr).not.toBeNull();

    const { data } = await ctx.ownerA.from("tenant_notes").select("id");
    expect(data ?? []).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // ticket_templates (H9b): lectura = miembros del tenant; escritura = owner/manager
  // ---------------------------------------------------------------------------

  it("ticket_templates: el owner crea una plantilla en su tenant", async () => {
    const { error } = await ctx.ownerA.from("ticket_templates").insert({
      tenant_id: ctx.tenantA,
      name: `Test ${STAMP}`,
    });
    expect(error).toBeNull();
  });

  it("ticket_templates: el cashier no puede crear plantillas", async () => {
    const { error } = await ctx.cashierA.from("ticket_templates").insert({
      tenant_id: ctx.tenantA,
      name: `Cashier ${STAMP}`,
    });
    expect(error).not.toBeNull();
  });

  it("ticket_templates: el cashier puede leer las plantillas de su tenant", async () => {
    const { data, error } = await ctx.cashierA
      .from("ticket_templates")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("ticket_templates: el owner B no ve las plantillas del tenant A", async () => {
    const { data: cross } = await ctx.ownerB
      .from("ticket_templates")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(cross).toEqual([]);
  });

  it("ticket_templates: el owner A no puede insertar en el tenant ajeno", async () => {
    const { error } = await ctx.ownerA.from("ticket_templates").insert({
      tenant_id: ctx.tenantB,
      name: `Intruso ${STAMP}`,
    });
    expect(error).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // product_variants (H10): lectura = miembros del tenant; escritura = owner/manager
  // ---------------------------------------------------------------------------

  it("product_variants: el owner crea una variante en su tenant", async () => {
    const { error } = await ctx.ownerA.from("product_variants").insert({
      tenant_id: ctx.tenantA,
      product_id: ctx.variantParentA,
      option1: "M",
    });
    expect(error).toBeNull();
  });

  it("product_variants: el cashier no puede crear variantes", async () => {
    const { error } = await ctx.cashierA.from("product_variants").insert({
      tenant_id: ctx.tenantA,
      product_id: ctx.variantParentA,
      option1: "L",
    });
    expect(error).not.toBeNull();
  });

  it("product_variants: el cashier puede leer las variantes de su tenant", async () => {
    const { data, error } = await ctx.cashierA
      .from("product_variants")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("product_variants: el owner B no ve las variantes del tenant A", async () => {
    const { data: byProduct } = await ctx.ownerB
      .from("product_variants")
      .select("id")
      .eq("product_id", ctx.variantParentA);
    expect(byProduct).toEqual([]);

    const { data: byTenant } = await ctx.ownerB
      .from("product_variants")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(byTenant).toEqual([]);
  });

  it("product_variants: el owner A no puede insertar en el tenant ajeno", async () => {
    const { error } = await ctx.ownerA.from("product_variants").insert({
      tenant_id: ctx.tenantB,
      product_id: ctx.variantParentA,
      option1: "XL",
    });
    expect(error).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // price_lists (H10): lectura = miembros del tenant; escritura = owner/manager
  // ---------------------------------------------------------------------------

  it("price_lists: el owner crea una lista en su tenant", async () => {
    const { data, error } = await ctx.ownerA
      .from("price_lists")
      .insert({ tenant_id: ctx.tenantA, name: `Lista ${STAMP}`, channel: "custom" })
      .select("id")
      .single();
    expect(error).toBeNull();
    ctx.priceListA = data!.id;
  });

  it("price_lists: el cashier no puede crear listas", async () => {
    const { error } = await ctx.cashierA.from("price_lists").insert({
      tenant_id: ctx.tenantA,
      name: `Lista cashier ${STAMP}`,
      channel: "custom",
    });
    expect(error).not.toBeNull();
  });

  it("price_lists: el cashier puede leer las listas de su tenant", async () => {
    const { data, error } = await ctx.cashierA
      .from("price_lists")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("price_lists: el owner B no ve las listas del tenant A", async () => {
    const { data: cross } = await ctx.ownerB
      .from("price_lists")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(cross).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // price_list_items (H10): lectura = miembros del tenant; escritura = owner/manager
  // ---------------------------------------------------------------------------

  it("price_list_items: el owner inserta un ítem en su tenant", async () => {
    const { error } = await ctx.ownerA.from("price_list_items").insert({
      tenant_id: ctx.tenantA,
      price_list_id: ctx.priceListA,
      product_id: ctx.variantParentA,
      price: 123,
    });
    expect(error).toBeNull();
  });

  it("price_list_items: el cashier no puede insertar ítems", async () => {
    const { error } = await ctx.cashierA.from("price_list_items").insert({
      tenant_id: ctx.tenantA,
      price_list_id: ctx.priceListA,
      product_id: ctx.variantParentA,
      price: 456,
    });
    expect(error).not.toBeNull();
  });

  it("price_list_items: el owner B no ve los ítems del tenant A", async () => {
    const { data: cross } = await ctx.ownerB
      .from("price_list_items")
      .select("id")
      .eq("tenant_id", ctx.tenantA);
    expect(cross).toEqual([]);
  });
});

describe.skipIf(enabled)("RLS — suite de integración", () => {
  it.skip("se salta: faltan SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_KEY (ver encabezado del archivo)", () => {});
});
