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

    // Gating server-side (mig. 20260608410000): los triggers de price_lists /
    // price_list_items exigen la feature 'listas_precios' (is_basic=false). Sin
    // plan/addon, tenant_has_feature_for(...) → false y todo INSERT/UPDATE en esas
    // tablas se rechaza con check_violation (23514). Esta suite valida AISLAMIENTO
    // y permisos por rol de price_lists, no el gating por plan, así que habilitamos
    // la feature en ambos tenants vía addon activo (paso 2 de la cadena de
    // resolución), sin montar un plan/suscripción. Se hace con el admin
    // (service_role, saltea RLS); se limpia en el teardown.
    // Ídem para el resto de features de escritura gateadas server-side
    // (mig. 20260609100000: ticket_templates → tickets_pro, customer_groups →
    // grupos_clientes, tenant_branding → personalizacion_marca,
    // product_variants → variantes). Esta suite valida AISLAMIENTO, no el
    // gating por plan: se habilitan todas vía addon activo.
    const GATED_FEATURES = [
      "listas_precios",
      "tickets_pro",
      "grupos_clientes",
      "personalizacion_marca",
      "variantes",
      // Cuenta corriente v2 (bloque "cuenta corriente" al final de la suite).
      "cuenta_corriente",
      "cc_punitorios",
      "cc_cobranza",
      // Conciliación de tarjetas (bloque al final de la suite).
      "conciliacion_tarjetas",
    ];
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      [ctx.tenantA, ctx.tenantB].flatMap((t) =>
        GATED_FEATURES.map((key) => ({
          tenant_id: t,
          addon_key: key,
          status: "active",
          source: "granted",
        })),
      ),
    );
    if (addonErr) throw addonErr;

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
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
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

  // ---------------------------------------------------------------------------
  // Cuenta corriente v2 (migraciones 20261011200000..180200): cargo con cuotas,
  // ledger sólo por RPC, cobro con caja + recibo + idempotencia, aging y
  // reversa al anular.
  // ---------------------------------------------------------------------------
  describe("cuenta corriente v2", () => {
    const acc = {} as { customer: string; saleId: string; paymentId: string };

    beforeAll(async () => {
      const { admin } = ctx;
      const { data: store, error: sErr } = await admin
        .from("stores")
        .insert({ tenant_id: ctx.tenantA, name: `Local ${STAMP}`, is_default: true })
        .select("id")
        .single();
      if (sErr || !store) throw sErr ?? new Error("store");
      const { data: reg, error: rErr } = await admin
        .from("cash_registers")
        .insert({ tenant_id: ctx.tenantA, store_id: store.id, name: `Caja ${STAMP}` })
        .select("id")
        .single();
      if (rErr || !reg) throw rErr ?? new Error("register");
      const { error: shErr } = await ctx.ownerA.rpc("open_cash_shift" as never, {
        p_register_id: reg.id,
        p_opening_amount: 0,
      } as never);
      if (shErr) throw shErr;
      const { data: cust, error: cErr } = await admin
        .from("customers")
        .insert({ tenant_id: ctx.tenantA, name: `Cliente CC ${STAMP}` })
        .select("id")
        .single();
      if (cErr || !cust) throw cErr ?? new Error("customer");
      acc.customer = cust.id;
    }, 60_000);

    it("config: el owner guarda la config (cuotas habilitadas); el cashier no", async () => {
      const cfg = { terms: { mode: "days", days: 30 }, installments: { enabled: true, max: 3 } };
      const { error: cashierErr } = await ctx.cashierA.rpc("account_save_settings" as never, {
        p_config: cfg,
      } as never);
      expect(cashierErr).not.toBeNull();
      const { error } = await ctx.ownerA.rpc("account_save_settings" as never, { p_config: cfg } as never);
      expect(error).toBeNull();
      const { error: badErr } = await ctx.ownerA.rpc("account_save_settings" as never, {
        p_config: { terms: { cutoff_day: 40 } },
      } as never);
      expect(badErr).not.toBeNull();
    });

    it("venta a cuenta en 2 cuotas → 2 cargos con vencimiento", async () => {
      const { data, error } = await ctx.ownerA.rpc("create_sale" as never, {
        p_items: [{ product_id: ctx.productA, quantity: 1, unit_price: 100, discount: 0 }],
        p_payments: [{ method: "account", amount: 100, reference: JSON.stringify({ installments: 2 }) }],
        p_customer_id: acc.customer,
      } as never);
      expect(error).toBeNull();
      acc.saleId = (data as unknown as { sale_id: string }).sale_id;

      const { data: movs } = await ctx.ownerA
        .from("customer_account_movements")
        .select("kind, delta, installment_no, installments, due_date")
        .eq("customer_id", acc.customer)
        .order("installment_no");
      expect(movs?.length).toBe(2);
      expect(movs!.map((m) => Number(m.delta))).toEqual([50, 50]);
      expect(movs!.every((m) => m.kind === "charge" && m.installments === 2 && m.due_date)).toBe(true);
    });

    it("ledger: nadie inserta directo (sólo RPC)", async () => {
      const { error } = await ctx.ownerA.from("customer_account_movements").insert({
        customer_id: acc.customer,
        delta: -10,
        reason: "intento directo",
      } as never);
      expect(error).not.toBeNull();
    });

    it("account_collect: cobro en efectivo con recibo, imputación FIFO y caja; idempotente", async () => {
      const args = {
        p_customer_id: acc.customer,
        p_amount: 30,
        p_method: "cash",
        p_allocations: null,
        p_idempotency_key: `k-${STAMP}`,
        p_note: null,
      };
      const { data, error } = await ctx.cashierA.rpc("account_collect" as never, args as never);
      expect(error).toBeNull();
      const res = data as unknown as {
        payment_id: string;
        receipt_no: number;
        balance: number;
        allocations: { amount: number }[];
      };
      acc.paymentId = res.payment_id;
      expect(res.receipt_no).toBe(1);
      expect(Number(res.balance)).toBe(70);
      expect(res.allocations.reduce((a, x) => a + Number(x.amount), 0)).toBe(30);

      const again = await ctx.cashierA.rpc("account_collect" as never, args as never);
      expect((again.data as unknown as { payment_id: string }).payment_id).toBe(res.payment_id);

      const { data: cm } = await ctx.ownerA
        .from("cash_movements")
        .select("type, amount, payment_method")
        .eq("reference_id", res.payment_id);
      expect(cm?.length).toBe(1);
      expect(cm![0]!.type).toBe("income");
      expect(Number(cm![0]!.amount)).toBe(30);
    });

    it("account_aging: deuda por vencimiento server-side; B no ve a A", async () => {
      const { data, error } = await ctx.ownerA.rpc("account_aging" as never, {} as never);
      expect(error).toBeNull();
      const res = data as unknown as { totals: { total: number }; customers: { customer_id: string }[] };
      expect(Number(res.totals.total)).toBe(70);
      expect(res.customers.map((c) => c.customer_id)).toContain(acc.customer);

      const { data: fromB } = await ctx.ownerB.rpc("account_statement" as never, {
        p_customer_id: acc.customer,
      } as never);
      expect(fromB).toBeNull();
    });

    it("account_adjust: el cashier no puede ajustar", async () => {
      const { error } = await ctx.cashierA.rpc("account_adjust" as never, {
        p_customer_id: acc.customer,
        p_kind: "adjust_credit",
        p_amount: 10,
        p_reason: "test",
      } as never);
      expect(error).not.toBeNull();
    });

    it("anular la venta revierte la deuda (lo cobrado queda a favor)", async () => {
      const { error } = await ctx.ownerA.rpc("void_sale" as never, {
        p_sale_id: acc.saleId,
        p_reason: "test",
      } as never);
      expect(error).toBeNull();
      const { data } = await ctx.ownerA.rpc("account_statement" as never, {
        p_customer_id: acc.customer,
      } as never);
      const st = data as unknown as { balance: number; open_items: unknown[] };
      expect(Number(st.balance)).toBe(-30);
      expect(st.open_items).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Conciliación de tarjetas (ADR-043): sólo por RPC, owner/manager, tenant propio.
  // ---------------------------------------------------------------------------
  describe("conciliación de tarjetas", () => {
    const rec = {} as { paymentA: string; cashPaymentA: string };

    beforeAll(async () => {
      const { admin } = ctx;
      const { data: store, error: sErr } = await admin
        .from("stores")
        .insert({ tenant_id: ctx.tenantA, name: `Local conciliación ${STAMP}` })
        .select("id")
        .single();
      if (sErr || !store) throw sErr ?? new Error("store");
      const { data: sale, error: saleErr } = await admin
        .from("sales")
        .insert({ tenant_id: ctx.tenantA, store_id: store.id, number: 990001, subtotal: 300, total: 300 })
        .select("id")
        .single();
      if (saleErr || !sale) throw saleErr ?? new Error("sale");
      const { data: pays, error: pErr } = await admin
        .from("payments")
        .insert([
          {
            tenant_id: ctx.tenantA,
            sale_id: sale.id,
            method: "debit",
            amount: 200,
            card_voucher: { lote: "12", cupon: "345", autorizacion: "A1", marca: "Visa", comercio: "111" },
          },
          // Inserts de varias filas: PostgREST manda null en la columna que falta.
          { tenant_id: ctx.tenantA, sale_id: sale.id, method: "other", amount: 100, card_voucher: {} },
        ] as never)
        .select("id, method");
      if (pErr || !pays) throw pErr ?? new Error("payments");
      const list = pays as unknown as { id: string; method: string }[];
      rec.paymentA = list.find((p) => p.method === "debit")!.id;
      rec.cashPaymentA = list.find((p) => p.method === "other")!.id;
    }, 60_000);

    const call = (client: SupabaseClient, ids: string[], reconciled: boolean) =>
      client.rpc("set_payments_reconciled" as never, { p_payment_ids: ids, p_reconciled: reconciled } as never);

    it("el cashier no puede conciliar", async () => {
      const { error } = await call(ctx.cashierA, [rec.paymentA], true);
      expect(error).not.toBeNull();
    });

    it("el owner B no puede conciliar pagos del tenant A", async () => {
      const { error } = await call(ctx.ownerB, [rec.paymentA], true);
      expect(error).not.toBeNull();
    });

    it("sólo pagos de tarjeta: un pago que no es de tarjeta hace fallar todo el pedido", async () => {
      const { error } = await call(ctx.ownerA, [rec.paymentA, rec.cashPaymentA], true);
      expect(error).not.toBeNull();
      const { data } = await ctx.admin.from("payments").select("reconciled_at" as never).eq("id", rec.paymentA).single();
      expect((data as unknown as { reconciled_at: string | null }).reconciled_at).toBeNull();
    });

    it("nadie cambia la conciliación con UPDATE directo", async () => {
      const { error } = await ctx.ownerA
        .from("payments")
        .update({ reconciled_at: new Date().toISOString() } as never)
        .eq("id", rec.paymentA);
      expect(error).not.toBeNull();
    });

    it("el owner concilia y desconcilia, con auditoría", async () => {
      const { data, error } = await call(ctx.ownerA, [rec.paymentA], true);
      expect(error).toBeNull();
      expect((data as unknown as { updated: number }).updated).toBe(1);

      const again = await call(ctx.ownerA, [rec.paymentA], true);
      expect((again.data as unknown as { updated: number }).updated).toBe(0);

      const { data: row } = await ctx.ownerA
        .from("payments")
        .select("reconciled_at, reconciled_by" as never)
        .eq("id", rec.paymentA)
        .single();
      expect((row as unknown as { reconciled_at: string | null }).reconciled_at).not.toBeNull();

      const undo = await call(ctx.ownerA, [rec.paymentA], false);
      expect(undo.error).toBeNull();
      expect((undo.data as unknown as { updated: number }).updated).toBe(1);

      const { data: logs } = await ctx.admin
        .from("audit_logs")
        .select("action")
        .eq("tenant_id", ctx.tenantA)
        .in("action", ["payments_reconciled", "payments_unreconciled"]);
      expect(logs?.map((l) => l.action).sort()).toEqual(["payments_reconciled", "payments_unreconciled"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Stock por sucursal y traslados (F17 · H94 + H95, ADR-046)
  // ---------------------------------------------------------------------------
  describe("stock por sucursal y traslados", () => {
    const st = {} as { s1: string; s2: string; transfer: string };

    beforeAll(async () => {
      const { admin } = ctx;
      const { error: aErr } = await admin.from("subscription_addons").insert(
        ["multi_sucursal", "stock_sucursales", "traslados"].map((key) => ({
          tenant_id: ctx.tenantA,
          addon_key: key,
          status: "active",
          source: "granted",
        })),
      );
      if (aErr) throw aErr;
      const { data: stores, error: sErr } = await admin
        .from("stores")
        .insert([
          { tenant_id: ctx.tenantA, name: `Centro ${STAMP}` },
          { tenant_id: ctx.tenantA, name: `Norte ${STAMP}` },
        ])
        .select("id");
      if (sErr || !stores || stores.length !== 2) throw sErr ?? new Error("stores");
      st.s1 = stores[0]!.id;
      st.s2 = stores[1]!.id;
    }, 60_000);

    afterAll(async () => {
      const { admin } = ctx;
      await admin.from("stock_transfers" as never).delete().eq("tenant_id", ctx.tenantA);
      await admin.from("stock_movements").delete().eq("product_id", ctx.productA);
      await admin.from("product_stock" as never).delete().eq("tenant_id", ctx.tenantA);
    }, 60_000);

    it("ajuste por sucursal: owner sí, cashier no; B no ve el saldo de A", async () => {
      const { data, error } = await ctx.ownerA.rpc("adjust_store_stock" as never, {
        p_store_id: st.s1,
        p_product_id: ctx.productA,
        p_variant_id: null,
        p_qty: 10,
        p_mode: "delta",
        p_reason: "purchase",
        p_notes: null,
      } as never);
      expect(error).toBeNull();
      expect(Number(data)).toBe(10);

      const { error: cashierErr } = await ctx.cashierA.rpc("adjust_store_stock" as never, {
        p_store_id: st.s1,
        p_product_id: ctx.productA,
        p_variant_id: null,
        p_qty: 1,
        p_mode: "delta",
        p_reason: "purchase",
        p_notes: null,
      } as never);
      expect(cashierErr).not.toBeNull();

      const { data: own } = await ctx.ownerA
        .from("product_stock" as never)
        .select("qty")
        .eq("store_id", st.s1)
        .eq("product_id", ctx.productA);
      expect((own as unknown as { qty: number }[])?.length).toBe(1);

      const { data: cross } = await ctx.ownerB
        .from("product_stock" as never)
        .select("id")
        .eq("product_id", ctx.productA);
      expect(cross ?? []).toEqual([]);
    });

    it("product_stock: nadie escribe directo (sólo movimientos y RPC)", async () => {
      const { error } = await ctx.ownerA.from("product_stock" as never).insert({
        tenant_id: ctx.tenantA,
        store_id: st.s2,
        product_id: ctx.productA,
        qty: 999,
      } as never);
      expect(error).not.toBeNull();
    });

    it("traslado completo con faltante: el stock y el total cuadran", async () => {
      const { data: id, error: saveErr } = await ctx.ownerA.rpc("transfer_save" as never, {
        p_id: null,
        p_origin: st.s1,
        p_dest: st.s2,
        p_scheduled_for: null,
        p_notes: "test",
        p_items: [{ product_id: ctx.productA, qty: 4 }],
        p_carrier: null,
      } as never);
      expect(saveErr).toBeNull();
      st.transfer = id as unknown as string;

      const { data: status } = await ctx.ownerA.rpc("transfer_submit" as never, { p_id: st.transfer } as never);
      expect(status).toBe("scheduled");
      const { error: dErr } = await ctx.ownerA.rpc("transfer_dispatch" as never, {
        p_id: st.transfer,
        p_items: null,
        p_notes: null,
      } as never);
      expect(dErr).toBeNull();

      const { data: items } = await ctx.ownerA
        .from("stock_transfer_items" as never)
        .select("id")
        .eq("transfer_id", st.transfer);
      const itemId = (items as unknown as { id: string }[])[0]!.id;
      const { data: rec, error: rErr } = await ctx.cashierA.rpc("transfer_receive" as never, {
        p_id: st.transfer,
        p_items: [{ item_id: itemId, qty: 3, reason: "faltante" }],
        p_close: true,
        p_notes: null,
      } as never);
      expect(rErr).toBeNull();
      expect(rec).toBe("received");

      const { data: rows } = await ctx.ownerA
        .from("product_stock" as never)
        .select("store_id, qty")
        .eq("product_id", ctx.productA);
      const byStore = Object.fromEntries(
        (rows as unknown as { store_id: string; qty: number }[]).map((r) => [r.store_id, Number(r.qty)]),
      );
      expect(byStore[st.s1]).toBe(6);
      expect(byStore[st.s2]).toBe(3);
      // Invariante: el total consolidado es la suma de las sucursales (la venta
      // del bloque de cuenta corriente cae en la sucursal principal).
      const { data: prod } = await ctx.ownerA.from("products").select("stock").eq("id", ctx.productA).single();
      const sum = Object.values(byStore).reduce((t, q) => t + q, 0);
      expect(Number(prod?.stock)).toBe(sum);
    });

    it("traslados: B no ve ni opera los de A, y sin plan se rechaza", async () => {
      const { data: cross } = await ctx.ownerB
        .from("stock_transfers" as never)
        .select("id")
        .eq("id", st.transfer);
      expect(cross ?? []).toEqual([]);
      const { error } = await ctx.ownerB.rpc("transfer_cancel" as never, {
        p_id: st.transfer,
        p_reason: "x",
      } as never);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/feature_not_in_plan|transfer_not_found/);
    });
  });
});

describe.skipIf(enabled)("RLS — suite de integración", () => {
  it.skip("se salta: faltan SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_KEY (ver encabezado del archivo)", () => {});
});
