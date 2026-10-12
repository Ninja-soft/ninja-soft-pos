// @vitest-environment node
// =============================================================================
// F17 · H92/H93 (ADR-049): configuración heredable por sucursal y caja,
// terminales de cobro e impresoras.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio M (multi_sucursal + multi_caja por addon) con Centro y
// Norte, una caja en cada una, un cajero de Norte y un encargado; negocio S sin
// las features.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `cfg-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantM: string;
  tenantS: string;
  owner: SupabaseClient;
  ownerS: SupabaseClient;
  cashier: SupabaseClient;
  cashierId: string;
  userIds: string[];
  product: string;
  centro: string;
  norte: string;
  storeS: string;
  cajaCentro: string;
  cajaNorte: string;
  shiftNorte: string;
  terminalCentro: string;
  terminalNorte: string;
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

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

describe.skipIf(!enabled)("F17 · configuración por sucursal, terminales e impresoras", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `Multi ${STAMP}`, slug: `m-${STAMP}`, status: "active" },
        { name: `Single ${STAMP}`, slug: `s-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantM = tenants[0]!.id;
    ctx.tenantS = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_sucursal", "multi_caja", "mercadopago_point"].map((key) => ({
        tenant_id: ctx.tenantM,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantM, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantM, "cashier");
    const ownerS = await makeUser(admin, `owner-s-${STAMP}@test.local`, ctx.tenantS, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.cashierId = cashier.id;
    ctx.ownerS = ownerS.client;
    ctx.userIds.push(owner.id, cashier.id, ownerS.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenantM, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const { data: c, error: cErr } = await owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (cErr || !c) throw cErr ?? new Error("centro");
    ctx.centro = (c as unknown as { id: string }).id;
    const { data: n, error: nErr } = await owner.client
      .from("stores")
      .insert({ name: "Norte" } as never)
      .select("id")
      .single();
    if (nErr || !n) throw nErr ?? new Error("norte");
    ctx.norte = (n as unknown as { id: string }).id;
    const { data: regs, error: rErr } = await owner.client
      .from("cash_registers")
      .insert([
        { store_id: ctx.centro, name: "Caja 1" },
        { store_id: ctx.norte, name: "Caja 1" },
      ] as never)
      .select("id, store_id");
    if (rErr || !regs) throw rErr ?? new Error("cajas");
    const list = regs as unknown as { id: string; store_id: string }[];
    ctx.cajaCentro = list.find((r) => r.store_id === ctx.centro)!.id;
    ctx.cajaNorte = list.find((r) => r.store_id === ctx.norte)!.id;

    const { data: s, error: sErr } = await ownerS.client
      .from("stores")
      .insert({ name: "Única" } as never)
      .select("id")
      .single();
    if (sErr || !s) throw sErr ?? new Error("store S");
    ctx.storeS = (s as unknown as { id: string }).id;

    const home = await rpc(owner.client, "staff_branch_schedule", {
      p_store_id: ctx.norte,
      p_kind: "home",
      p_user_id: cashier.id,
      p_reason: "Base Norte",
    });
    if (home.error) throw new Error(home.error.message);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantM, ctx.tenantS].filter(Boolean)) {
      await admin.from("config_overrides").delete().eq("tenant_id", t);
      await admin.from("payment_terminals").delete().eq("tenant_id", t);
      await admin.from("printers").delete().eq("tenant_id", t);
      await admin.from("staff_branch_assignments").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("H92: el dueño pisa campos por sucursal; el resto hereda y se ve el origen", async () => {
    const set = await rpc(ctx.owner, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.norte,
      p_domain: "pos_settings",
      p_domain_key: "",
      p_patch: { rounding_multiple: 10, max_discount: { cashier: 5 } },
    });
    expect(set.error).toBeNull();

    const eff = await rpc(ctx.owner, "effective_config", { p_domain: "pos_settings", p_key: "", p_store_id: ctx.norte });
    expect(eff.error).toBeNull();
    const v = eff.data as { value: Record<string, unknown>; sources: Record<string, string> };
    expect(Number(v.value.rounding_multiple)).toBe(10);
    expect(v.sources.rounding_multiple).toBe(`store:${ctx.norte}`);
    expect(v.sources.blind_close ?? "tenant").toBe("tenant");

    const centro = await rpc(ctx.owner, "effective_config", { p_domain: "pos_settings", p_key: "", p_store_id: ctx.centro });
    expect((centro.data as { sources: Record<string, string> }).sources.rounding_multiple ?? "tenant").toBe("tenant");

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantM)
      .eq("action", "config_override_set");
    expect((logs ?? []).length).toBeGreaterThan(0);
  });

  it("H92: whitelist, rol y plan se validan en el servidor", async () => {
    const notAllowed = await rpc(ctx.owner, "config_override_set", {
      p_scope: "register",
      p_scope_id: ctx.cajaNorte,
      p_domain: "pos_settings",
      p_patch: { rounding_multiple: 5 },
    });
    expect(notAllowed.error?.message).toMatch(/field_not_allowed/);

    const cashier = await rpc(ctx.cashier, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.norte,
      p_domain: "pos_settings",
      p_patch: { rounding_multiple: 1 },
    });
    expect(cashier.error?.message).toMatch(/forbidden/);

    const noPlan = await rpc(ctx.ownerS, "config_override_set", {
      p_scope: "store",
      p_scope_id: ctx.storeS,
      p_domain: "pos_settings",
      p_patch: { rounding_multiple: 1 },
    });
    expect(noPlan.error?.message).toMatch(/feature_not_in_plan: multi_sucursal/);

    // Otro negocio no puede apuntar a una sucursal ajena.
    const foreign = await rpc(ctx.ownerS, "effective_config", { p_domain: "pos_settings", p_store_id: ctx.norte });
    expect(foreign.error).not.toBeNull();

    // Escritura directa en la tabla: no hay policy (sólo RPC).
    const direct = await ctx.owner
      .from("config_overrides")
      .insert({ scope: "store", scope_id: ctx.norte, domain: "pos_settings", patch: {} } as never);
    expect(direct.error).not.toBeNull();
  });

  it("H93: medio apagado en la caja de Norte → el servidor rechaza el cobro", async () => {
    const off = await rpc(ctx.owner, "config_override_set", {
      p_scope: "register",
      p_scope_id: ctx.cajaNorte,
      p_domain: "payment_method",
      p_domain_key: "transfer",
      p_patch: { enabled: false },
    });
    expect(off.error).toBeNull();

    const open = await rpc(ctx.owner, "open_cash_shift", { p_register_id: ctx.cajaNorte, p_opening_amount: 0 });
    expect(open.error).toBeNull();
    ctx.shiftNorte = open.data as string;

    const item = [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }];
    const blocked = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "transfer", amount: 100, reference: "op-1" }],
      p_cash_shift_id: ctx.shiftNorte,
    });
    expect(blocked.error?.message).toMatch(/payment_method_disabled_in_store/);

    const ok = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: ctx.shiftNorte,
    });
    expect(ok.error).toBeNull();

    // "Volver a heredar": sin override el medio vuelve a andar.
    const back = await rpc(ctx.owner, "config_override_set", {
      p_scope: "register",
      p_scope_id: ctx.cajaNorte,
      p_domain: "payment_method",
      p_domain_key: "transfer",
      p_clear: ["enabled"],
    });
    expect(back.error).toBeNull();
    const again = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: [{ method: "transfer", amount: 100, reference: "op-2" }],
      p_cash_shift_id: ctx.shiftNorte,
    });
    expect(again.error).toBeNull();
  });

  it("H92: copiar configuración de Norte a Centro", async () => {
    const r = await rpc(ctx.owner, "config_override_copy", {
      p_from_scope: "store",
      p_from_id: ctx.norte,
      p_to_scope: "store",
      p_to_id: ctx.centro,
    });
    expect(r.error).toBeNull();
    const eff = await rpc(ctx.owner, "effective_config", { p_domain: "pos_settings", p_store_id: ctx.centro });
    expect(Number((eff.data as { value: Record<string, unknown> }).value.rounding_multiple)).toBe(10);
  });

  it("H93: terminales por sucursal con RLS y validación para las Edges", async () => {
    const { data, error } = await ctx.owner
      .from("payment_terminals")
      .insert([
        {
          store_id: ctx.centro,
          cash_register_id: ctx.cajaCentro,
          provider_key: "mercadopago_point",
          kind: "point",
          external_id: `PAX_${STAMP}_C`,
          label: "Point Centro",
          is_default: true,
        },
        {
          store_id: ctx.norte,
          cash_register_id: ctx.cajaNorte,
          provider_key: "mercadopago_point",
          kind: "point",
          external_id: `PAX_${STAMP}_N`,
          label: "Point Norte",
          is_default: true,
        },
      ] as never)
      .select("id, store_id");
    expect(error).toBeNull();
    const rows = data as unknown as { id: string; store_id: string }[];
    ctx.terminalCentro = rows.find((r) => r.store_id === ctx.centro)!.id;
    ctx.terminalNorte = rows.find((r) => r.store_id === ctx.norte)!.id;

    // Caja de otra sucursal: rechazado por el trigger.
    const bad = await ctx.owner.from("payment_terminals").insert({
      store_id: ctx.centro,
      cash_register_id: ctx.cajaNorte,
      provider_key: "mercadopago_point",
      kind: "point",
      external_id: `PAX_${STAMP}_X`,
      label: "Mal",
    } as never);
    expect(bad.error?.message).toMatch(/register_store_mismatch/);

    // El cajero de Norte sólo ve las de Norte y no puede crear.
    const { data: seen } = await ctx.cashier.from("payment_terminals").select("store_id");
    expect((seen ?? []).every((t: { store_id: string }) => t.store_id === ctx.norte)).toBe(true);
    expect((seen ?? []).length).toBe(1);
    const ins = await ctx.cashier.from("payment_terminals").insert({
      store_id: ctx.norte,
      provider_key: "nave_point",
      kind: "point",
      external_id: "999",
      label: "Pirata",
    } as never);
    expect(ins.error).not.toBeNull();

    // terminal_for_user (service_role, como las Edges).
    const okN = await rpc(ctx.admin, "terminal_for_user", {
      p_tenant: ctx.tenantM,
      p_user: ctx.cashierId,
      p_terminal: ctx.terminalNorte,
      p_store: ctx.norte,
    });
    expect((okN.data as unknown[]).length).toBe(1);
    const noC = await rpc(ctx.admin, "terminal_for_user", {
      p_tenant: ctx.tenantM,
      p_user: ctx.cashierId,
      p_terminal: ctx.terminalCentro,
      p_store: null,
    });
    expect((noC.data as unknown[]).length).toBe(0);

    // Las funciones internas no están expuestas al usuario.
    const hidden = await rpc(ctx.owner, "terminal_for_user", {
      p_tenant: ctx.tenantM,
      p_user: ctx.cashierId,
      p_terminal: ctx.terminalNorte,
    });
    expect(hidden.error).not.toBeNull();
  });

  it("Impresoras: alta por sucursal, prueba registrada y RLS por sucursal", async () => {
    const { data, error } = await ctx.owner
      .from("printers")
      .insert({ store_id: ctx.norte, cash_register_id: ctx.cajaNorte, name: "Térmica Norte", kind: "thermal_80" } as never)
      .select("id")
      .single();
    expect(error).toBeNull();
    const id = (data as unknown as { id: string }).id;
    const test = await rpc(ctx.cashier, "printer_mark_test", { p_printer_id: id, p_ok: true });
    expect(test.error).toBeNull();
    const { data: row } = await ctx.admin.from("printers").select("last_test_ok").eq("id", id).single();
    expect(row?.last_test_ok).toBe(true);

    const { data: c } = await ctx.owner
      .from("printers")
      .insert({ store_id: ctx.centro, name: "A4 Centro", kind: "a4" } as never)
      .select("id")
      .single();
    const centroPrinter = (c as unknown as { id: string }).id;
    const denied = await rpc(ctx.cashier, "printer_mark_test", { p_printer_id: centroPrinter, p_ok: true });
    expect(denied.error?.message).toMatch(/forbidden|printer_not_found/);
  });

  it("ADR-052: las tablas nuevas no abren otros negocios con is_internal()", async () => {
    const { data, error } = await rpc(ctx.admin, "rls_internal_scope_leaks", {});
    // La función la agrega fix/sucursales-tenant; sin ella no hay qué medir.
    if (error) return;
    const mine = new Set(["config_overrides", "store_groups", "payment_terminals", "printers"]);
    expect((data as { tablename: string }[]).filter((r) => mine.has(r.tablename))).toEqual([]);
  });
});
