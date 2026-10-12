// @vitest-environment node
// =============================================================================
// ADR-054: reglas del cupón del posnet offline validadas en el servidor
// (trigger payments_card_voucher) y heredables por caja (config_overrides).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `posnet-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  /** Encargado: abre la Caja 2 (cada usuario opera sólo su turno, ADR-051). */
  manager: SupabaseClient;
  userIds: string[];
  product: string;
  store: string;
  caja1: string;
  caja2: string;
  shift1: string;
  shift2: string;
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

function sale(shift: string, card_voucher?: Record<string, unknown>, method = "credit") {
  // La venta la hace quien abrió el turno (caja propia, ADR-051).
  const client = shift === ctx.shift2 ? ctx.manager : ctx.owner;
  return rpc(client, "create_sale", {
    p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
    p_payments: [{ method, amount: 100, ...(card_voucher ? { card_voucher } : {}) }],
    p_cash_shift_id: shift,
  });
}

describe.skipIf(!enabled)("ADR-054 · cupón del posnet offline validado en el servidor", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Posnet ${STAMP}`, slug: `p-${STAMP}`, status: "active" })
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
    ctx.owner = owner.client;
    ctx.userIds.push(owner.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const { data: s, error: sErr } = await owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !s) throw sErr ?? new Error("store");
    ctx.store = (s as unknown as { id: string }).id;
    const { data: regs, error: rErr } = await owner.client
      .from("cash_registers")
      .insert([
        { store_id: ctx.store, name: "Caja 1" },
        { store_id: ctx.store, name: "Caja 2" },
      ] as never)
      .select("id, name");
    if (rErr || !regs) throw rErr ?? new Error("cajas");
    const list = regs as unknown as { id: string; name: string }[];
    ctx.caja1 = list.find((r) => r.name === "Caja 1")!.id;
    ctx.caja2 = list.find((r) => r.name === "Caja 2")!.id;

    const o1 = await rpc(owner.client, "open_cash_shift", { p_register_id: ctx.caja1, p_opening_amount: 0 });
    if (o1.error) throw new Error(o1.error.message);
    ctx.shift1 = o1.data as string;
    const manager = await makeUser(admin, `manager-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.manager = manager.client;
    ctx.userIds.push(manager.id);
    const o2 = await rpc(manager.client, "open_cash_shift", { p_register_id: ctx.caja2, p_opening_amount: 0 });
    if (o2.error) throw new Error(o2.error.message);
    ctx.shift2 = o2.data as string;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("config_overrides").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("sin reglas: la tarjeta sin cupón se registra como siempre", async () => {
    const r = await sale(ctx.shift1);
    expect(r.error).toBeNull();
  });

  it("require_card_voucher (H27) ahora lo exige también el servidor", async () => {
    const up = await ctx.owner
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, require_card_voucher: true } as never, { onConflict: "tenant_id" });
    expect(up.error).toBeNull();
    const bad = await sale(ctx.shift1, { lote: "", cupon: "", autorizacion: "" }, "debit");
    expect(bad.error?.message).toMatch(/card_voucher_required/);
    const ok = await sale(ctx.shift1, { lote: "1", cupon: "22", autorizacion: "A1B2" }, "debit");
    expect(ok.error).toBeNull();
    // Efectivo no se toca.
    expect((await sale(ctx.shift1, undefined, "cash")).error).toBeNull();
    await ctx.owner
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, require_card_voucher: false } as never, { onConflict: "tenant_id" });
  });

  it("reglas por adquirente: obligatorio y formato", async () => {
    const rules = {
      fields: { ultimos4: { required: true } },
      by_acquirer: { payway: { lote: { ask: true, required: true, type: "numeric", min: 3, max: 3 } } },
    };
    const up = await ctx.owner
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, card_voucher_rules: rules } as never, { onConflict: "tenant_id" });
    expect(up.error).toBeNull();

    const noLast4 = await sale(ctx.shift1, { lote: "123", cupon: "", autorizacion: "", adquirente: "payway" });
    expect(noLast4.error?.message).toMatch(/card_voucher_required: ultimos4/);
    const shortLote = await sale(ctx.shift1, { lote: "12", cupon: "", autorizacion: "", ultimos4: "4242", adquirente: "payway" });
    expect(shortLote.error?.message).toMatch(/card_voucher_invalid: lote/);
    const noLote = await sale(ctx.shift1, { lote: "", cupon: "", autorizacion: "", ultimos4: "4242", adquirente: "payway" });
    expect(noLote.error?.message).toMatch(/card_voucher_required: lote/);
    // Otro adquirente: el lote de Payway no aplica.
    const getnet = await sale(ctx.shift1, { lote: "", cupon: "", autorizacion: "", ultimos4: "4242", adquirente: "getnet" });
    expect(getnet.error).toBeNull();
    const badAcq = await sale(ctx.shift1, { lote: "", cupon: "", autorizacion: "", ultimos4: "4242", adquirente: "visa" });
    expect(badAcq.error?.message).toMatch(/card_voucher_invalid: adquirente/);

    // Terminal integrada (ADR-053): las reglas del posnet no aplican; la valida
    // payments_terminal_tx contra terminal_transactions (acá, un id falso).
    const integrated = await sale(ctx.shift1, {
      lote: "",
      cupon: "",
      autorizacion: "",
      adquirente: "payway",
      origen: "terminal",
      terminal_tx: "00000000-0000-0000-0000-000000000000",
    });
    expect(integrated.error?.message ?? "").not.toMatch(/card_voucher_(required|invalid)/);
    expect(integrated.error?.message).toMatch(/terminal_tx|terminal_integrada/);

    const ok = await sale(ctx.shift1, { lote: "123", cupon: "", autorizacion: "", ultimos4: "4242", adquirente: "payway" });
    expect(ok.error).toBeNull();
    const saleId = (ok.data as { sale_id: string }).sale_id;
    const { data: pay } = await ctx.admin.from("payments").select("card_voucher").eq("sale_id", saleId).single();
    expect((pay?.card_voucher as Record<string, unknown>).adquirente).toBe("payway");
  });

  it("forma inválida: la rechaza la tabla y la configuración heredable", async () => {
    const bad = await ctx.owner
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, card_voucher_rules: { fields: { lote: { max: 99 } } } } as never, {
        onConflict: "tenant_id",
      });
    expect(bad.error).not.toBeNull();
    const ov = await rpc(ctx.owner, "config_override_set", {
      p_scope: "register",
      p_scope_id: ctx.caja2,
      p_domain: "pos_settings",
      p_patch: { card_voucher_rules: { pin: true } },
    });
    expect(ov.error?.message).toMatch(/invalid_key/);
  });

  it("la caja hereda o pisa las reglas (config_overrides)", async () => {
    const ov = await rpc(ctx.owner, "config_override_set", {
      p_scope: "register",
      p_scope_id: ctx.caja2,
      p_domain: "pos_settings",
      p_patch: { card_voucher_rules: { fields: { autorizacion: { required: true, min: 6, max: 6 } } } },
    });
    expect(ov.error).toBeNull();
    // Caja 2 pisa `fields` entero: ya no exige últimos 4, sí la autorización.
    const c2bad = await sale(ctx.shift2, { lote: "", cupon: "", autorizacion: "ABC", adquirente: "getnet" });
    expect(c2bad.error?.message).toMatch(/card_voucher_invalid: autorizacion/);
    const c2ok = await sale(ctx.shift2, { lote: "", cupon: "", autorizacion: "ABC123", adquirente: "getnet" });
    expect(c2ok.error).toBeNull();
    // Caja 1 sigue con las del negocio.
    const c1 = await sale(ctx.shift1, { lote: "", cupon: "", autorizacion: "ABC123", adquirente: "getnet" });
    expect(c1.error?.message).toMatch(/card_voucher_required: ultimos4/);
  });
});
