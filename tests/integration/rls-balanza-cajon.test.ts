// @vitest-environment node
// =============================================================================
// ADR-063: balanza y cajón. Equipos por caja (register_hardware), política
// del cajón por negocio / sucursal (pos_settings + overrides) y la RPC
// cash_drawer_open que decide, pide PIN, registra y audita cada apertura.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con una sucursal y dos cajas (dueña, encargado y
// cajera con su turno abierto en la Caja 1) y negocio B (otro dueño) para el
// aislamiento.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `bc-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  store: string;
  regs: string[];
  product: string;
  printer: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  shift: string;
  userIds: string[];
};

async function signIn(email: string, headers?: Record<string, string>) {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

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
  return { id, email, client: await signIn(email) };
}

type RpcOut = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcOut>;
const res = (r: RpcOut) => r.data as { allowed: boolean; denied_reason: string | null; event_id: string; supervisor_id: string | null };

async function setPolicy(noSale: "allow" | "pin" | "deny", openOnCash = true) {
  const { error } = await ctx.owner.client
    .from("pos_settings")
    .upsert({ tenant_id: ctx.tenant, drawer_no_sale: noSale, drawer_open_on_cash: openOnCash } as never, {
      onConflict: "tenant_id",
    });
  if (error) throw error;
}

describe.skipIf(!enabled)("ADR-063 · balanza y cajón", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    for (const [k, name] of [
      ["tenant", "Cajon A"],
      ["tenantB", "Cajon B"],
    ] as const) {
      const { data, error } = await admin
        .from("tenants")
        .insert({ name: `${name} ${STAMP}`, slug: `${name.toLowerCase().replace(" ", "-")}-${STAMP}`, status: "active" })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("tenant");
      ctx[k] = data.id;
    }
    await admin
      .from("subscription_addons")
      .insert({ tenant_id: ctx.tenant, addon_key: "multi_caja", status: "active", source: "granted" });

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    ctx.store = (store as { id: string }).id;
    const { data: regs, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert([1, 2].map((n) => ({ store_id: ctx.store, name: `Caja ${n}` })) as never)
      .select("id");
    if (rErr || !regs) throw rErr ?? new Error("registers");
    ctx.regs = (regs as { id: string }[]).map((r) => r.id);

    const { data: prod } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Queso ${STAMP}`, price: 100 })
      .select("id")
      .single();
    ctx.product = (prod as { id: string }).id;

    const { data: pr, error: prErr } = await ctx.owner.client
      .from("printers")
      .insert({ store_id: ctx.store, cash_register_id: ctx.regs[0], name: "Térmica caja 1", kind: "thermal_80", connection: "usb" } as never)
      .select("id")
      .single();
    if (prErr || !pr) throw prErr ?? new Error("printer");
    ctx.printer = (pr as { id: string }).id;

    const open = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: ctx.regs[0], p_opening_amount: 1000 });
    if (open.error) throw new Error(open.error.message);
    ctx.shift = open.data as string;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenant, ctx.tenantB].filter(Boolean)) {
      await admin.from("cash_drawer_events").delete().eq("tenant_id", t);
      await admin.from("register_hardware").delete().eq("tenant_id", t);
      await admin.from("supervisor_auth_tokens").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("equipos por caja: sólo dueño o encargado, forma validada e impresora de la sucursal", async () => {
    const drawer = { has_drawer: true, printer_id: ctx.printer, transport: "webserial", pin: 2, on_ms: 120, off_ms: 240 };
    const cashier = await rpc(ctx.cashier.client, "register_hardware_set", { p_register_id: ctx.regs[0], p_drawer: drawer });
    expect(cashier.error?.message).toMatch(/forbidden/);

    const bad = await rpc(ctx.manager.client, "register_hardware_set", {
      p_register_id: ctx.regs[0],
      p_drawer: { ...drawer, pin: 7 },
    });
    expect(bad.error?.message).toMatch(/invalid_drawer/);
    const badScale = await rpc(ctx.manager.client, "register_hardware_set", {
      p_register_id: ctx.regs[0],
      p_scale: { enabled: true, transport: "bridge" },
    });
    expect(badScale.error?.message).toMatch(/invalid_scale/);

    // La impresora de la Caja 1 no sirve para la Caja 2.
    const other = await rpc(ctx.manager.client, "register_hardware_set", { p_register_id: ctx.regs[1], p_drawer: drawer });
    expect(other.error?.message).toMatch(/printer_not_found/);

    const ok = await rpc(ctx.manager.client, "register_hardware_set", {
      p_register_id: ctx.regs[0],
      p_scale: { enabled: true, model: "Systel Cuora", transport: "simulator", protocol: "systel", mode: "poll", poll_command: "\\x05" },
      p_drawer: drawer,
    });
    expect(ok.error).toBeNull();
    expect((ok.data as { drawer: { printer_id: string } }).drawer.printer_id).toBe(ctx.printer);

    // Nadie escribe la tabla directo.
    const direct = await ctx.owner.client
      .from("register_hardware")
      .update({ drawer: { has_drawer: false } } as never)
      .eq("cash_register_id", ctx.regs[0])
      .select("cash_register_id");
    expect((direct.data as unknown[] | null)?.length ?? 0).toBe(0);

    // La cajera lee los equipos de su sucursal; el otro negocio no ve nada.
    const mine = await ctx.cashier.client.from("register_hardware").select("cash_register_id");
    expect((mine.data ?? []).length).toBe(1);
    const foreign = await ctx.ownerB.client.from("register_hardware").select("cash_register_id");
    expect(foreign.data ?? []).toEqual([]);

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "register_hardware_changed");
    expect((audit ?? []).length).toBe(1);
  });

  it("política y config heredable: whitelist y valores cerrados", async () => {
    const bad = await ctx.owner.client
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, drawer_no_sale: "a_veces" } as never, { onConflict: "tenant_id" });
    expect(bad.error).not.toBeNull();
    const badLabel = await ctx.owner.client
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, scale_label: { prefixes: ["30"], code_digits: 5, embed: "price", decimals: 0 } } as never, {
        onConflict: "tenant_id",
      });
    expect(badLabel.error).not.toBeNull();
    // Por caja no se pisa la política (es de la sucursal).
    const reg = await rpc(ctx.owner.client, "config_override_set", {
      p_scope: "register",
      p_scope_id: ctx.regs[0],
      p_domain: "pos_settings",
      p_patch: { drawer_no_sale: "allow" },
    });
    expect(reg.error?.message).toMatch(/field_not_allowed|feature_not_in_plan/);
  });

  it("sin venta: motivo obligatorio, sin turno, permitido y prohibido", async () => {
    await setPolicy("allow");
    const noReason = await rpc(ctx.cashier.client, "cash_drawer_open", { p_register_id: ctx.regs[0], p_kind: "no_sale" });
    expect(noReason.error?.message).toMatch(/reason_required/);

    const ok = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "no_sale",
      p_reason: "Dar cambio",
    });
    expect(ok.error).toBeNull();
    expect(res(ok)).toMatchObject({ allowed: true, denied_reason: null });

    // Caja 2 sin turno abierto.
    const noShift = await rpc(ctx.manager.client, "cash_drawer_open", {
      p_register_id: ctx.regs[1],
      p_kind: "no_sale",
      p_reason: "Dar cambio",
    });
    expect(res(noShift)).toMatchObject({ allowed: false, denied_reason: "no_shift" });

    // El encargado no opera el turno de la cajera.
    const notOwner = await rpc(ctx.manager.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "no_sale",
      p_reason: "Dar cambio",
    });
    expect(res(notOwner)).toMatchObject({ allowed: false, denied_reason: "shift_not_owned" });

    await setPolicy("deny");
    const denied = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "no_sale",
      p_reason: "Dar cambio",
    });
    expect(res(denied)).toMatchObject({ allowed: false, denied_reason: "policy_deny" });
  });

  it("sin venta con PIN: pide supervisor y acepta el token de 'abrir_cajon'", async () => {
    await setPolicy("pin");
    const ask = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "no_sale",
      p_reason: "Guardar un vale",
    });
    expect(ask.error?.message).toMatch(/supervisor_required:abrir_cajon/);

    const { data: tok, error: tErr } = await ctx.admin
      .from("supervisor_auth_tokens")
      .insert({
        tenant_id: ctx.tenant,
        action: "abrir_cajon",
        supervisor_id: ctx.manager.id,
        requested_by: ctx.cashier.id,
        reason: "Guardar un vale",
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (tErr || !tok) throw tErr ?? new Error("token");
    const withToken = await signIn(ctx.cashier.email, { "x-ninja-supervisor-token": (tok as { id: string }).id });
    const ok = await rpc(withToken, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "no_sale",
      p_reason: "Guardar un vale",
    });
    expect(ok.error).toBeNull();
    expect(res(ok)).toMatchObject({ allowed: true, supervisor_id: ctx.manager.id });
    // El token es de un solo uso.
    const again = await rpc(withToken, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "no_sale",
      p_reason: "Guardar un vale",
    });
    expect(again.error?.message).toMatch(/supervisor_token_invalid/);
  });

  it("al cobrar: venta del turno con efectivo, una sola vez", async () => {
    await setPolicy("deny", true);
    const sale = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(sale.error).toBeNull();
    const saleId = (sale.data as { sale_id: string }).sale_id;
    const first = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "sale",
      p_sale_id: saleId,
    });
    expect(res(first)).toMatchObject({ allowed: true });
    const twice = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "sale",
      p_sale_id: saleId,
    });
    expect(res(twice)).toMatchObject({ allowed: false, denied_reason: "already_opened" });
    const fake = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "sale",
      p_sale_id: ctx.product,
    });
    expect(res(fake)).toMatchObject({ allowed: false, denied_reason: "sale_not_cash" });

    await setPolicy("deny", false);
    const off = await rpc(ctx.cashier.client, "cash_drawer_open", {
      p_register_id: ctx.regs[0],
      p_kind: "sale",
      p_sale_id: saleId,
    });
    expect(res(off)).toMatchObject({ allowed: false, denied_reason: "policy_off" });
  });

  it("prueba de hardware: sólo dueño o encargado; caja sin cajón", async () => {
    const cashier = await rpc(ctx.cashier.client, "cash_drawer_open", { p_register_id: ctx.regs[0], p_kind: "test" });
    expect(res(cashier)).toMatchObject({ allowed: false, denied_reason: "forbidden" });
    const manager = await rpc(ctx.manager.client, "cash_drawer_open", { p_register_id: ctx.regs[0], p_kind: "test" });
    expect(res(manager)).toMatchObject({ allowed: true });

    await rpc(ctx.manager.client, "register_hardware_set", {
      p_register_id: ctx.regs[1],
      p_drawer: { has_drawer: false, transport: "none" },
    });
    const none = await rpc(ctx.manager.client, "cash_drawer_open", { p_register_id: ctx.regs[1], p_kind: "test" });
    expect(res(none)).toMatchObject({ allowed: false, denied_reason: "no_drawer" });

    // Otro negocio no puede pedir el cajón de esta caja.
    const foreign = await rpc(ctx.ownerB.client, "cash_drawer_open", { p_register_id: ctx.regs[0], p_kind: "test" });
    expect(foreign.error?.message).toMatch(/register_not_found/);
  });

  it("bitácora: cada pedido queda registrado y auditado; lectura por rol; sin escritura directa", async () => {
    const all = await ctx.manager.client.from("cash_drawer_events").select("id, user_id, allowed, kind");
    const rows = (all.data ?? []) as { user_id: string; allowed: boolean; kind: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.some((r) => !r.allowed)).toBe(true);

    // La cajera ve sólo los suyos.
    const own = await ctx.cashier.client.from("cash_drawer_events").select("user_id");
    expect(((own.data ?? []) as { user_id: string }[]).every((r) => r.user_id === ctx.cashier.id)).toBe(true);
    const foreign = await ctx.ownerB.client.from("cash_drawer_events").select("id");
    expect(foreign.data ?? []).toEqual([]);

    const insert = await ctx.cashier.client.from("cash_drawer_events").insert({
      store_id: ctx.store,
      cash_register_id: ctx.regs[0],
      kind: "no_sale",
      allowed: true,
    } as never);
    expect(insert.error).not.toBeNull();

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action, after_data")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["cash_drawer_opened", "cash_drawer_denied"]);
    const auditRows = (audit ?? []) as { action: string; after_data: { kind: string } }[];
    expect(auditRows.length).toBe(rows.length);
    expect(auditRows.some((a) => a.action === "cash_drawer_denied")).toBe(true);
  });
});
