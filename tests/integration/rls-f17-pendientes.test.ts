// @vitest-environment node
// =============================================================================
// F17 pendientes (ADR-080): RLS por sucursal de cobros y traslados, cierres Z
// con correlativo por sucursal y caja, heartbeat de cajas en el monitor y
// producción por sucursal.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio con Centro (2 cajas), Norte y Sur; un dueño y un cajero
// con base en Norte. Cada uno vende en SU turno, abierto por él.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f17p-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  cashierId: string;
  userIds: string[];
  product: string;
  centro: string;
  norte: string;
  sur: string;
  caja1Centro: string;
  caja2Centro: string;
  cajaNorte: string;
  shiftOwner: string;
  shiftCashier: string;
  saleCentro: string;
  saleNorte: string;
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

const ITEM = (product: string) => [{ product_id: product, quantity: 1, unit_price: 100, discount: 0 }];
const CASH = [{ method: "cash", amount: 100 }];

describe.skipIf(!enabled)("F17 pendientes · sucursales (ADR-080)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `F17P ${STAMP}`, slug: `p-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_sucursal", "multi_caja", "stock_sucursales", "traslados"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.cashierId = cashier.id;
    ctx.userIds.push(owner.id, cashier.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Producto ${STAMP}`, price: 100, cost: 60, stock: 50 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const ids: Record<string, string> = {};
    for (const name of ["Centro", "Norte", "Sur"]) {
      const r = await owner.client.from("stores").insert({ name } as never).select("id").single();
      if (r.error || !r.data) throw r.error ?? new Error(name);
      ids[name] = (r.data as unknown as { id: string }).id;
    }
    ctx.centro = ids.Centro!;
    ctx.norte = ids.Norte!;
    ctx.sur = ids.Sur!;

    const regs = await owner.client
      .from("cash_registers")
      .insert([
        { store_id: ctx.centro, name: "Caja 1" },
        { store_id: ctx.centro, name: "Caja 2" },
        { store_id: ctx.norte, name: "Caja 1" },
        { store_id: ctx.sur, name: "Caja 1" },
      ] as never)
      .select("id, store_id, name");
    if (regs.error || !regs.data) throw regs.error ?? new Error("cajas");
    const list = regs.data as unknown as { id: string; store_id: string; name: string }[];
    ctx.caja1Centro = list.find((r) => r.store_id === ctx.centro && r.name === "Caja 1")!.id;
    ctx.caja2Centro = list.find((r) => r.store_id === ctx.centro && r.name === "Caja 2")!.id;
    ctx.cajaNorte = list.find((r) => r.store_id === ctx.norte)!.id;

    const s = await rpc(owner.client, "staff_branch_schedule", {
      p_store_id: ctx.norte,
      p_kind: "home",
      p_user_id: ctx.cashierId,
      p_reason: "Base Norte",
    });
    if (s.error) throw new Error(s.error.message);

    // Cada uno abre SU caja y vende en SU turno.
    const a = await rpc(owner.client, "open_cash_shift", { p_register_id: ctx.caja1Centro, p_opening_amount: 0 });
    if (a.error) throw new Error(a.error.message);
    ctx.shiftOwner = a.data as string;
    const b = await rpc(cashier.client, "open_cash_shift", { p_register_id: ctx.cajaNorte, p_opening_amount: 0 });
    if (b.error) throw new Error(b.error.message);
    ctx.shiftCashier = b.data as string;

    const sc = await rpc(owner.client, "create_sale", {
      p_items: ITEM(ctx.product),
      p_payments: CASH,
      p_cash_shift_id: ctx.shiftOwner,
    });
    if (sc.error) throw new Error(sc.error.message);
    ctx.saleCentro = (sc.data as { sale_id: string }).sale_id;
    const sn = await rpc(cashier.client, "create_sale", {
      p_items: ITEM(ctx.product),
      p_payments: CASH,
      p_cash_shift_id: ctx.shiftCashier,
    });
    if (sn.error) throw new Error(sn.error.message);
    ctx.saleNorte = (sn.data as { sale_id: string }).sale_id;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("stock_transfers" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("staff_branch_assignments").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── H91: cobros por sucursal ───────────────────────────────────────────────
  it("H91: el cajero de Norte no lee los cobros de Centro aunque consulte la API directo", async () => {
    const { data: mine } = await ctx.cashier.from("payments").select("sale_id");
    const saleIds = new Set((mine ?? []).map((p: { sale_id: string }) => p.sale_id));
    expect(saleIds.has(ctx.saleNorte)).toBe(true);
    expect(saleIds.has(ctx.saleCentro)).toBe(false);

    const { data: direct } = await ctx.cashier.from("payments").select("id").eq("sale_id", ctx.saleCentro);
    expect(direct ?? []).toEqual([]);

    const { data: all } = await ctx.owner.from("payments").select("sale_id");
    const ownerIds = new Set((all ?? []).map((p: { sale_id: string }) => p.sale_id));
    expect(ownerIds.has(ctx.saleCentro) && ownerIds.has(ctx.saleNorte)).toBe(true);
  });

  // ── H91: traslados por sucursal ────────────────────────────────────────────
  it("H91: traslados visibles sólo si el origen o el destino es una sucursal del usuario", async () => {
    const mk = async (number: number, origin: string, dest: string) => {
      const { data, error } = await ctx.admin
        .from("stock_transfers" as never)
        .insert({
          tenant_id: ctx.tenant,
          number,
          origin_store_id: origin,
          dest_store_id: dest,
          status: "in_transit",
          dispatched_at: new Date().toISOString(),
        } as never)
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("transfer");
      const id = (data as unknown as { id: string }).id;
      // Ítem multi-clave: todas las claves en la fila (PostgREST).
      const it = await ctx.admin.from("stock_transfer_items" as never).insert({
        tenant_id: ctx.tenant,
        transfer_id: id,
        product_id: ctx.product,
        variant_id: null,
        product_name: "Producto",
        qty_requested: 5,
        qty_dispatched: 5,
        qty_received: 0,
      } as never);
      if (it.error) throw it.error;
      return id;
    };
    const toNorte = await mk(9001, ctx.centro, ctx.norte);
    const centroSur = await mk(9002, ctx.centro, ctx.sur);

    const { data: seen } = await ctx.cashier.from("stock_transfers" as never).select("id");
    const ids = new Set((seen as unknown as { id: string }[] | null ?? []).map((r) => r.id));
    expect(ids.has(toNorte)).toBe(true);
    expect(ids.has(centroSur)).toBe(false);

    const { data: items } = await ctx.cashier
      .from("stock_transfer_items" as never)
      .select("transfer_id")
      .eq("transfer_id", centroSur);
    expect(items ?? []).toEqual([]);

    // El dueño ve los dos (con el join que usa el reporte de tránsito).
    const { data: lines, error } = await ctx.owner
      .from("stock_transfer_items" as never)
      .select("transfer_id, t:stock_transfers!inner(status)")
      .in("t.status" as never, ["in_transit", "partially_received"] as never)
      .eq("tenant_id" as never, ctx.tenant as never);
    expect(error).toBeNull();
    expect((lines as unknown as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  // ── H97: Z por sucursal y por caja ─────────────────────────────────────────
  it("H97: cierres Z con correlativo del negocio, de la sucursal y de la caja", async () => {
    const c1 = await rpc(ctx.owner, "close_cash_shift", { p_shift_id: ctx.shiftOwner, p_closing_amount: 100 });
    expect(c1.error).toBeNull();
    const c2 = await rpc(ctx.cashier, "close_cash_shift", { p_shift_id: ctx.shiftCashier, p_closing_amount: 100 });
    expect(c2.error).toBeNull();
    const o2 = await rpc(ctx.owner, "open_cash_shift", { p_register_id: ctx.caja2Centro, p_opening_amount: 0 });
    expect(o2.error).toBeNull();
    const c3 = await rpc(ctx.owner, "close_cash_shift", { p_shift_id: o2.data, p_closing_amount: 0 });
    expect(c3.error).toBeNull();

    const { data } = await ctx.admin
      .from("cash_z_closures")
      .select("cash_shift_id, store_id, cash_register_id, z_number, store_z_number, register_z_number")
      .eq("tenant_id", ctx.tenant)
      .order("z_number");
    const rows = data as unknown as {
      cash_shift_id: string;
      store_id: string;
      cash_register_id: string;
      z_number: number;
      store_z_number: number;
      register_z_number: number;
    }[];
    expect(rows.map((r) => r.z_number)).toEqual([1, 2, 3]);
    const byShift = Object.fromEntries(rows.map((r) => [r.cash_shift_id, r]));
    expect(byShift[ctx.shiftOwner]).toMatchObject({ store_id: ctx.centro, cash_register_id: ctx.caja1Centro, store_z_number: 1, register_z_number: 1 });
    // El cajero de Norte sólo ve sus Z (RLS) pero el número del negocio no se repite.
    expect(byShift[ctx.shiftCashier]).toMatchObject({ store_id: ctx.norte, z_number: 2, store_z_number: 1, register_z_number: 1 });
    expect(byShift[o2.data as string]).toMatchObject({ cash_register_id: ctx.caja2Centro, store_z_number: 2, register_z_number: 1 });
  });

  // ── H99: heartbeat ─────────────────────────────────────────────────────────
  it("H99: la caja manda señal saneada; el monitor la muestra; nadie escribe por REST", async () => {
    const reopen = await rpc(ctx.cashier, "open_cash_shift", { p_register_id: ctx.cajaNorte, p_opening_amount: 0 });
    expect(reopen.error).toBeNull();
    const hb = await rpc(ctx.cashier, "register_heartbeat", {
      p_register_id: ctx.cajaNorte,
      p_info: { display: "ok", online: true, browser: "Chrome 129", evil: "<script>", printer: "maybe" },
      p_app_version: "1.2.3",
    });
    expect(hb.error).toBeNull();

    // Una caja de otra sucursal: el cajero de Norte no puede firmar por ella.
    const cross = await rpc(ctx.cashier, "register_heartbeat", { p_register_id: ctx.caja1Centro, p_info: {} });
    expect(cross.error?.message).toMatch(/forbidden/);

    const direct = await ctx.cashier
      .from("register_heartbeats" as never)
      .insert({ cash_register_id: ctx.caja1Centro, tenant_id: ctx.tenant, store_id: ctx.centro } as never);
    expect(direct.error).not.toBeNull();

    const { data: row } = await ctx.admin
      .from("register_heartbeats" as never)
      .select("info, app_version, cash_shift_id, user_id")
      .eq("cash_register_id", ctx.cajaNorte)
      .single();
    const r = row as unknown as { info: Record<string, unknown>; app_version: string; cash_shift_id: string; user_id: string };
    expect(r.info).toEqual({ display: "ok", online: true, browser: "Chrome 129" });
    expect(r.app_version).toBe("1.2.3");
    expect(r.cash_shift_id).toBe(reopen.data);
    expect(r.user_id).toBe(ctx.cashierId);

    const o = await rpc(ctx.owner, "branch_monitor_overview");
    expect(o.error).toBeNull();
    const norte = (o.data as { store_id: string; registers: { id: string; last_ping_at: string | null; shift_open: boolean }[] }[]).find(
      (x) => x.store_id === ctx.norte,
    )!;
    const reg = norte.registers.find((x) => x.id === ctx.cajaNorte)!;
    expect(reg.last_ping_at).not.toBeNull();
    expect(reg.shift_open).toBe(true);
  });

  // ── H94: producción por sucursal ───────────────────────────────────────────
  it("H94: producción en la sucursal elegida; un cajero no produce en una que no ve", async () => {
    const ok = await rpc(ctx.owner, "register_production", {
      p_product_id: ctx.product,
      p_qty: 7,
      p_notes: "tanda",
      p_store_id: ctx.norte,
    });
    expect(ok.error).toBeNull();
    const { data: mov } = await ctx.admin
      .from("stock_movements")
      .select("store_id, reason, delta")
      .eq("product_id", ctx.product)
      .eq("reason", "production")
      .single();
    expect(mov).toMatchObject({ store_id: ctx.norte, delta: 7 });

    const bad = await rpc(ctx.cashier, "register_production", {
      p_product_id: ctx.product,
      p_qty: 1,
      p_store_id: ctx.centro,
    });
    expect(bad.error).not.toBeNull();
  });
});
