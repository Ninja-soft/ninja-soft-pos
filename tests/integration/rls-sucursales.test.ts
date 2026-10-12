// @vitest-environment node
// =============================================================================
// F17 · H89-H91: sucursales, cajas, personal por sucursal y venta en la
// sucursal del turno (ADR-045).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio M (multi-sucursal habilitada por addon) con Centro y
// Norte, una caja en cada una y turnos abiertos en las dos a la vez; negocio S
// sin la feature (sólo puede tener una sucursal).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `suc-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantM: string;
  tenantS: string;
  owner: SupabaseClient;
  cashierNorte: SupabaseClient;
  cashierNorteId: string;
  manager: SupabaseClient;
  managerId: string;
  ownerS: SupabaseClient;
  userIds: string[];
  product: string;
  centro: string;
  norte: string;
  cajaCentro: string;
  cajaNorte: string;
  shiftCentro: string;
  shiftNorte: string;
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

describe.skipIf(!enabled)("F17 · sucursales, cajas y personal por sucursal", () => {
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
      ["multi_sucursal", "multi_caja"].map((key) => ({
        tenant_id: ctx.tenantM,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantM, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenantM, "cashier");
    const manager = await makeUser(admin, `encargado-${STAMP}@test.local`, ctx.tenantM, "manager");
    const ownerS = await makeUser(admin, `owner-s-${STAMP}@test.local`, ctx.tenantS, "owner");
    ctx.owner = owner.client;
    ctx.cashierNorte = cashier.client;
    ctx.cashierNorteId = cashier.id;
    ctx.manager = manager.client;
    ctx.managerId = manager.id;
    ctx.ownerS = ownerS.client;
    ctx.userIds.push(owner.id, cashier.id, manager.id, ownerS.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenantM, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;
  }, 90_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantM, ctx.tenantS].filter(Boolean)) {
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

  it("H89: el dueño crea dos sucursales con su caja; la primera queda principal", async () => {
    const { data: c, error: e1 } = await ctx.owner
      .from("stores")
      .insert({ name: "Centro", code: "cen" } as never)
      .select("id, is_default, code")
      .single();
    expect(e1).toBeNull();
    const centro = c as unknown as { id: string; is_default: boolean; code: string };
    expect(centro.is_default).toBe(true);
    expect(centro.code).toBe("CEN");
    ctx.centro = centro.id;

    const { data: n, error: e2 } = await ctx.owner
      .from("stores")
      .insert({ name: "Norte", code: "NOR" } as never)
      .select("id, is_default")
      .single();
    expect(e2).toBeNull();
    ctx.norte = (n as unknown as { id: string }).id;
    expect((n as unknown as { is_default: boolean }).is_default).toBe(false);

    const { data: regs, error: e3 } = await ctx.owner
      .from("cash_registers")
      .insert([
        { store_id: ctx.centro, name: "Caja 1" },
        { store_id: ctx.norte, name: "Caja 1" },
      ] as never)
      .select("id, store_id");
    expect(e3).toBeNull();
    const list = regs as unknown as { id: string; store_id: string }[];
    ctx.cajaCentro = list.find((r) => r.store_id === ctx.centro)!.id;
    ctx.cajaNorte = list.find((r) => r.store_id === ctx.norte)!.id;
  });

  it("H89: el cajero no puede crear sucursales (RLS owner/manager)", async () => {
    const { error } = await ctx.cashierNorte.from("stores").insert({ name: "Pirata" } as never);
    expect(error).not.toBeNull();
  });

  it("H89: sin multi_sucursal el servidor rechaza la segunda sucursal", async () => {
    const { error: first } = await ctx.ownerS.from("stores").insert({ name: "Única" } as never);
    expect(first).toBeNull();
    const { error: second } = await ctx.ownerS.from("stores").insert({ name: "Otra" } as never);
    expect(second?.message).toMatch(/feature_not_in_plan: multi_sucursal/);
  });

  it("H89: no se archiva la sucursal principal", async () => {
    const { error } = await ctx.owner
      .from("stores")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", ctx.centro);
    expect(error?.message).toMatch(/store_is_default/);
  });

  it("H90: turnos abiertos en las dos sucursales; cada venta queda en la de su turno", async () => {
    const a = await rpc(ctx.owner, "open_cash_shift", { p_register_id: ctx.cajaCentro, p_opening_amount: 0 });
    expect(a.error).toBeNull();
    ctx.shiftCentro = a.data as string;
    const b = await rpc(ctx.manager, "open_cash_shift", { p_register_id: ctx.cajaNorte, p_opening_amount: 0 });
    expect(b.error).toBeNull();
    ctx.shiftNorte = b.data as string;

    const item = [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }];
    const pay = [{ method: "cash", amount: 100 }];

    const sNorte = await rpc(ctx.owner, "create_sale", {
      p_items: item,
      p_payments: pay,
      p_cash_shift_id: ctx.shiftNorte,
    });
    expect(sNorte.error).toBeNull();
    const saleNorte = (sNorte.data as { sale_id: string }).sale_id;
    const { data: rowN } = await ctx.admin.from("sales").select("store_id, cash_shift_id").eq("id", saleNorte).single();
    expect(rowN).toEqual({ store_id: ctx.norte, cash_shift_id: ctx.shiftNorte });

    // Sin turno explícito: el dueño tiene su propio turno abierto en Centro.
    const sCentro = await rpc(ctx.owner, "create_sale", { p_items: item, p_payments: pay });
    expect(sCentro.error).toBeNull();
    const saleCentro = (sCentro.data as { sale_id: string }).sale_id;
    const { data: rowC } = await ctx.admin.from("sales").select("store_id").eq("id", saleCentro).single();
    expect(rowC?.store_id).toBe(ctx.centro);

    // El movimiento de stock va a la sucursal de la venta.
    const { data: mov } = await ctx.admin
      .from("stock_movements")
      .select("store_id")
      .eq("reference_id", saleNorte)
      .limit(1)
      .maybeSingle();
    if (mov) expect(mov.store_id).toBe(ctx.norte);
  });

  it("H90: con turnos en dos sucursales y ninguno propio, la venta sin turno es ambigua", async () => {
    // El cajero aún no tiene asignación: en multi-sucursal opera en la
    // principal; ahí hay un único turno abierto, así que no es ambiguo.
    const r = await rpc(ctx.cashierNorte, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(r.error).toBeNull();

    // Un encargado sin asignación ve las dos sucursales: con turnos ajenos en
    // ambas (el suyo se cierra antes) tiene que mandar el turno.
    const { data: other } = await ctx.admin
      .from("cash_shifts")
      .update({ opened_by: ctx.cashierNorteId } as never)
      .eq("id", ctx.shiftNorte)
      .select("id");
    expect(other?.length).toBe(1);
    const amb = await rpc(ctx.manager, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(amb.error?.message).toMatch(/shift_ambiguous/);
  });

  it("H91: el cajero asignado a Norte sólo ve ventas y turnos de Norte", async () => {
    const r = await rpc(ctx.owner, "staff_branch_schedule", {
      p_store_id: ctx.norte,
      p_kind: "home",
      p_user_id: ctx.cashierNorteId,
      p_reason: "Base Norte",
    });
    expect(r.error).toBeNull();

    const { data: allowed } = await rpc(ctx.cashierNorte, "user_allowed_store_ids", {});
    expect(allowed).toEqual([ctx.norte]);

    const { data: sales } = await ctx.cashierNorte.from("sales").select("store_id");
    expect((sales ?? []).length).toBeGreaterThan(0);
    expect((sales ?? []).every((s: { store_id: string }) => s.store_id === ctx.norte)).toBe(true);

    const { data: shifts } = await ctx.cashierNorte.from("cash_shifts").select("store_id");
    expect((shifts ?? []).every((s: { store_id: string }) => s.store_id === ctx.norte)).toBe(true);

    // Vender en el turno de Centro no le está permitido.
    const bad = await rpc(ctx.cashierNorte, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: ctx.shiftCentro,
    });
    expect(bad.error?.message).toMatch(/store_not_allowed/);

    // El dueño sigue viendo todo.
    const { data: ownerSales } = await ctx.owner.from("sales").select("store_id");
    const stores = new Set((ownerSales ?? []).map((s: { store_id: string }) => s.store_id));
    expect(stores.has(ctx.centro) && stores.has(ctx.norte)).toBe(true);
  });

  it("H91: cobertura temporal exclusiva programada y cancelación que restaura", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
    const cover = await rpc(ctx.owner, "staff_branch_schedule", {
      p_store_id: ctx.centro,
      p_kind: "cover",
      p_user_id: ctx.cashierNorteId,
      p_from: today,
      p_until: today,
      p_reason: "Cubre a Ana",
    });
    expect(cover.error).toBeNull();
    const { data: during } = await rpc(ctx.cashierNorte, "user_allowed_store_ids", {});
    expect(during).toEqual([ctx.centro]);

    const cancel = await rpc(ctx.owner, "staff_branch_cancel", { p_assignment_id: cover.data, p_reason: "Ya no hace falta" });
    expect(cancel.error).toBeNull();
    expect(cancel.data).toBe("cancelled");
    const { data: after } = await rpc(ctx.cashierNorte, "user_allowed_store_ids", {});
    expect(after).toEqual([ctx.norte]);

    // Queda auditado.
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantM)
      .in("action", ["staff_branch_scheduled", "staff_branch_cancelled"]);
    expect((logs ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("H91: un cajero no puede programar traslados", async () => {
    const r = await rpc(ctx.cashierNorte, "staff_branch_schedule", {
      p_store_id: ctx.centro,
      p_kind: "extra",
      p_user_id: ctx.cashierNorteId,
    });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("H89: no se archiva una sucursal con turno abierto", async () => {
    const { error } = await ctx.owner
      .from("stores")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", ctx.norte);
    expect(error?.message).toMatch(/store_has_open_shift/);
  });
});
