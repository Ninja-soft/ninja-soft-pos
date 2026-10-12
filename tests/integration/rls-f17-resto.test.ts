// @vitest-environment node
// =============================================================================
// F17 resto (ADR-057): credenciales y planes por sucursal, plantilla de
// sucursal, sucursal de alta del cliente, comparativo y monitor de sucursales.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio con Centro y Norte (multi_sucursal + multi_caja por
// addon), un dueño, un encargado y un cajero con base en Norte.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f17r-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  manager: SupabaseClient;
  cashier: SupabaseClient;
  managerId: string;
  cashierId: string;
  userIds: string[];
  product: string;
  centro: string;
  norte: string;
  cajaNorte: string;
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
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

const FROM = new Date(Date.now() - 86_400_000).toISOString();
const TO = new Date(Date.now() + 86_400_000).toISOString();

const plan = (store: string | null, code: string, pct: number, active = true) => ({
  provider_key: "payway",
  code,
  label: code,
  base: "credito",
  brand: "visa",
  installments: Number(code.replace(/\D/g, "")) || 1,
  surcharge_pct: pct,
  is_active: active,
  ...(store ? { store_id: store } : {}),
});

describe.skipIf(!enabled)("F17 resto · sucursales (ADR-057)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `F17 ${STAMP}`, slug: `f-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_sucursal", "multi_caja"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenant, "manager");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.owner = owner.client;
    ctx.manager = manager.client;
    ctx.cashier = cashier.client;
    ctx.managerId = manager.id;
    ctx.cashierId = cashier.id;
    ctx.userIds.push(owner.id, manager.id, cashier.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Producto ${STAMP}`, price: 100, cost: 60 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const c = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (c.error || !c.data) throw c.error ?? new Error("centro");
    ctx.centro = (c.data as unknown as { id: string }).id;
    const n = await owner.client.from("stores").insert({ name: "Norte" } as never).select("id").single();
    if (n.error || !n.data) throw n.error ?? new Error("norte");
    ctx.norte = (n.data as unknown as { id: string }).id;

    const regs = await owner.client
      .from("cash_registers")
      .insert([
        { store_id: ctx.centro, name: "Caja 1" },
        { store_id: ctx.norte, name: "Caja 1" },
      ] as never)
      .select("id, store_id");
    if (regs.error || !regs.data) throw regs.error ?? new Error("cajas");
    const list = regs.data as unknown as { id: string; store_id: string }[];
    ctx.cajaNorte = list.find((r) => r.store_id === ctx.norte)!.id;

    for (const userId of [ctx.managerId, ctx.cashierId]) {
      const s = await rpc(owner.client, "staff_branch_schedule", {
        p_store_id: ctx.norte,
        p_kind: "home",
        p_user_id: userId,
        p_reason: "Base Norte",
      });
      if (s.error) throw new Error(s.error.message);
    }

    // El cajero abre su caja en Norte y vende con un cliente nuevo.
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: ctx.cajaNorte, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("staff_branch_assignments").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── 1) Credenciales por sucursal ─────────────────────────────────────────
  it("credenciales: una del negocio y una por sucursal, nunca legibles por el cliente", async () => {
    const a = await ctx.admin
      .from("payment_secrets")
      .insert({ tenant_id: ctx.tenant, provider_key: "gocuotas", secrets: { api_key: "negocio" } } as never);
    expect(a.error).toBeNull();
    const b = await ctx.admin
      .from("payment_secrets")
      .insert({ tenant_id: ctx.tenant, provider_key: "gocuotas", store_id: ctx.norte, secrets: { api_key: "norte" } } as never);
    expect(b.error).toBeNull();
    const dup = await ctx.admin
      .from("payment_secrets")
      .insert({ tenant_id: ctx.tenant, provider_key: "gocuotas", secrets: { api_key: "otra" } } as never);
    expect(dup.error).not.toBeNull();

    const read = await ctx.owner.from("payment_secrets" as never).select("secrets");
    expect((read.data as unknown[] | null)?.length ?? 0).toBe(0);

    const scopes = await rpc(ctx.owner, "payment_secret_scopes");
    expect(scopes.error).toBeNull();
    const rows = scopes.data as { provider_key: string; store_id: string | null; keys: string[] }[];
    expect(rows.filter((r) => r.provider_key === "gocuotas").map((r) => r.store_id).sort()).toEqual(
      [ctx.norte, null].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain("norte\"");

    const cashier = await rpc(ctx.cashier, "payment_secret_scopes");
    expect(cashier.error?.message).toMatch(/forbidden/);
  });

  it("credenciales: una sucursal de otro negocio no se puede usar", async () => {
    const other = await ctx.admin
      .from("payment_secrets")
      .insert({
        tenant_id: ctx.tenant,
        provider_key: "payway",
        store_id: "00000000-0000-0000-0000-000000000001",
        secrets: { site: "x" },
      } as never);
    expect(other.error).not.toBeNull();
  });

  // ── 2) Planes por sucursal ───────────────────────────────────────────────
  it("planes: la sucursal pisa y oculta los del negocio", async () => {
    const t = await ctx.owner.from("payment_plans").insert([plan(null, "credito_visa_3c", 10), plan(null, "credito_visa_6c", 20)] as never);
    expect(t.error).toBeNull();
    const nb = await ctx.owner
      .from("payment_plans")
      .insert([plan(ctx.norte, "credito_visa_3c", 0), plan(ctx.norte, "credito_visa_6c", 20, false)] as never);
    expect(nb.error).toBeNull();

    const norte = await rpc(ctx.cashier, "effective_payment_plans", { p_store_id: ctx.norte });
    expect(norte.error).toBeNull();
    const rows = norte.data as { code: string; surcharge_pct: number; store_id: string | null }[];
    expect(rows.map((r) => r.code)).toEqual(["credito_visa_3c"]);
    expect(Number(rows[0]!.surcharge_pct)).toBe(0);

    const centro = await rpc(ctx.cashier, "effective_payment_plans", { p_store_id: ctx.centro });
    expect((centro.data as unknown[]).length).toBe(2);
  });

  it("planes: un encargado de Norte no carga planes para Centro; un cajero no carga planes", async () => {
    const m = await ctx.manager.from("payment_plans").insert([plan(ctx.centro, "credito_visa_12c", 30)] as never);
    expect(m.error).not.toBeNull();
    const okN = await ctx.manager.from("payment_plans").insert([plan(ctx.norte, "credito_visa_12c", 30)] as never);
    expect(okN.error).toBeNull();
    const c = await ctx.cashier.from("payment_plans").insert([plan(ctx.norte, "credito_visa_18c", 30)] as never);
    expect(c.error).not.toBeNull();
  });

  // ── 3) Plantilla y copia ─────────────────────────────────────────────────
  it("copiar configuración y plantillas: dueño sí, cajero no, auditado", async () => {
    const set = await rpc(ctx.owner, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.norte,
      p_domain: "pos_settings",
      p_domain_key: "",
      p_patch: { rounding_multiple: 10 },
      p_clear: [],
    });
    expect(set.error).toBeNull();

    const s = await ctx.owner.from("stores").insert({ name: "Sur" } as never).select("id").single();
    expect(s.error).toBeNull();
    const sur = (s.data as unknown as { id: string }).id;

    const denied = await rpc(ctx.cashier, "store_copy_setup", { p_target: sur, p_from_store: ctx.norte });
    expect(denied.error?.message).toMatch(/forbidden/);

    const copy = await rpc(ctx.owner, "store_copy_setup", {
      p_target: sur,
      p_from_store: ctx.norte,
      p_parts: ["config", "plans"],
    });
    expect(copy.error).toBeNull();
    expect((copy.data as { overrides: number; plans: number }).overrides).toBe(1);
    expect((copy.data as { overrides: number; plans: number }).plans).toBeGreaterThanOrEqual(2);

    const tpl = await rpc(ctx.owner, "store_template_save", {
      p_name: `Plantilla ${STAMP}`,
      p_from_store: ctx.norte,
      p_parts: ["config"],
    });
    expect(tpl.error).toBeNull();
    const list = await ctx.owner.from("store_templates" as never).select("id, name").eq("tenant_id", ctx.tenant);
    expect((list.data as unknown[]).length).toBe(1);

    const audit = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["store_setup_copied", "store_template_saved"]);
    expect((audit.data ?? []).length).toBe(2);
  });

  // ── 4) Clientes con sucursal de alta ─────────────────────────────────────
  it("clientes: el alta queda en la sucursal del turno y no se puede forzar otra", async () => {
    const a = await ctx.cashier.from("customers").insert({ name: `Cliente ${STAMP}` } as never).select("id, store_id_alta" as never).single();
    expect(a.error).toBeNull();
    expect((a.data as unknown as { store_id_alta: string }).store_id_alta).toBe(ctx.norte);

    const b = await ctx.cashier
      .from("customers")
      .insert({ name: `Forzado ${STAMP}`, store_id_alta: ctx.centro } as never)
      .select("id, store_id_alta" as never)
      .single();
    expect(b.error).toBeNull();
    expect((b.data as unknown as { store_id_alta: string }).store_id_alta).toBe(ctx.norte);
    const customer = (b.data as unknown as { id: string }).id;

    const sale = await rpc(ctx.cashier, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 100 }],
      p_customer_id: customer,
    });
    expect(sale.error).toBeNull();

    const stats = await rpc(ctx.owner, "customer_branch_stats", { p_customer: customer });
    expect(stats.error).toBeNull();
    const byStore = (stats.data as { by_store: { store_id: string; count: number }[] }).by_store;
    expect(byStore).toHaveLength(1);
    expect(byStore[0]!.store_id).toBe(ctx.norte);
  });

  // ── 5) Comparativo ───────────────────────────────────────────────────────
  it("comparativo: el dueño compara, el encargado de Norte no ve Centro", async () => {
    const all = await rpc(ctx.owner, "branch_compare_report", { p_from: FROM, p_to: TO });
    expect(all.error).toBeNull();
    const stores = (all.data as { stores: { store_id: string; total: number }[] }).stores;
    expect(stores.map((s) => s.store_id)).toEqual(expect.arrayContaining([ctx.centro, ctx.norte]));
    expect(Number(stores.find((s) => s.store_id === ctx.norte)!.total)).toBe(100);

    const denied = await rpc(ctx.manager, "branch_compare_report", { p_from: FROM, p_to: TO, p_store_ids: [ctx.centro] });
    expect(denied.error?.message).toMatch(/forbidden/);

    const own = await rpc(ctx.manager, "branch_compare_report", { p_from: FROM, p_to: TO });
    expect(own.error).toBeNull();
    const ids = (own.data as { stores: { store_id: string }[] }).stores.map((s) => s.store_id);
    expect(ids).not.toContain(ctx.centro);
  });

  // ── 6) Monitor de sucursales ─────────────────────────────────────────────
  it("monitor: dueño ve todas, encargado las suyas, cajero no", async () => {
    const o = await rpc(ctx.owner, "branch_monitor_overview");
    expect(o.error).toBeNull();
    const rows = o.data as { store_id: string; registers_open: number; sales_today_count: number }[];
    const norte = rows.find((r) => r.store_id === ctx.norte)!;
    expect(norte.registers_open).toBe(1);
    expect(norte.sales_today_count).toBe(1);

    const m = await rpc(ctx.manager, "branch_monitor_overview");
    expect(m.error).toBeNull();
    expect((m.data as { store_id: string }[]).map((r) => r.store_id)).not.toContain(ctx.centro);

    const c = await rpc(ctx.cashier, "branch_monitor_overview");
    expect(c.error?.message).toMatch(/forbidden/);
  });

  it("sin multi_sucursal: no se cargan planes de sucursal ni se compara", async () => {
    await ctx.admin
      .from("subscription_addons")
      .update({ status: "cancelled" } as never)
      .eq("tenant_id", ctx.tenant)
      .eq("addon_key", "multi_sucursal");
    const p = await ctx.owner.from("payment_plans").insert([plan(ctx.norte, "credito_visa_24c", 40)] as never);
    expect(p.error).not.toBeNull();
    const r = await rpc(ctx.owner, "branch_compare_report", { p_from: FROM, p_to: TO, p_store_ids: [ctx.centro, ctx.norte] });
    expect(r.error?.message).toMatch(/feature_not_in_plan/);
    const eff = await rpc(ctx.owner, "effective_payment_plans", { p_store_id: ctx.norte });
    expect((eff.data as { store_id: string | null }[]).every((x) => x.store_id === null)).toBe(true);
  });
});
