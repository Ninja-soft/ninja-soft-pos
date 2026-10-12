// @vitest-environment node
// =============================================================================
// F17 · H113 a H117 (ADR-051): propiedad de la caja, cierre forzado, guardas
// de cash_shifts y cash_movements, PIN de supervisor por política (token en
// header), estados del personal y auditoría restringida.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio de UNA sucursal con tres cajas (multi_caja por addon),
// dueño, encargado y dos cajeros.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pc-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: User;
  manager: User;
  cashier: User;
  cashier2: User;
  product: string;
  regs: string[];
  shiftOwner: string;
  shiftCashier: string;
  userIds: string[];
};
const ctx = {} as Ctx;

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
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  return { id, email, client: await signIn(email) };
}

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

const item = (price = 100) => [{ product_id: ctx.product, quantity: 1, unit_price: price, discount: 0 }];

describe.skipIf(!enabled)("F17 · personal, propiedad de la caja, PIN y auditoría", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Cajas ${STAMP}`, slug: `pc-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_caja", "auditoria", "descuentos"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.cashier2 = await makeUser(admin, `caj2-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.cashier2.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: regs, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert([1, 2, 3].map((n) => ({ store_id: (store as { id: string }).id, name: `Caja ${n}` })) as never)
      .select("id");
    if (rErr || !regs) throw rErr ?? new Error("registers");
    ctx.regs = (regs as { id: string }[]).map((r) => r.id);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("staff_status_events").delete().eq("tenant_id", ctx.tenant);
    await admin.from("supervisor_auth_tokens").delete().eq("tenant_id", ctx.tenant);
    await admin.from("account_supervisor_pins").delete().eq("tenant_id", ctx.tenant);
    await admin.from("security_settings").delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("H114: cada uno abre su caja; un turno abierto por usuario", async () => {
    const a = await rpc(ctx.owner.client, "open_cash_shift", { p_register_id: ctx.regs[0], p_opening_amount: 1000 });
    expect(a.error).toBeNull();
    ctx.shiftOwner = a.data as string;

    const dup = await rpc(ctx.owner.client, "open_cash_shift", { p_register_id: ctx.regs[1], p_opening_amount: 0 });
    expect(dup.error?.message).toMatch(/user_has_open_shift/);

    const busy = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: ctx.regs[0], p_opening_amount: 0 });
    expect(busy.error?.message).toMatch(/shift_already_open/);

    const b = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: ctx.regs[1], p_opening_amount: 500 });
    expect(b.error).toBeNull();
    ctx.shiftCashier = b.data as string;
  });

  it("H114: nadie vende en el turno de otro; sin turno explícito vende en el propio", async () => {
    const invade = await rpc(ctx.cashier.client, "create_sale", {
      p_items: item(),
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: ctx.shiftOwner,
    });
    expect(invade.error?.message).toMatch(/shift_not_owned/);

    const own = await rpc(ctx.cashier.client, "create_sale", {
      p_items: item(),
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(own.error).toBeNull();
    const saleId = (own.data as { sale_id: string }).sale_id;
    const { data: row } = await ctx.admin.from("sales").select("cash_shift_id").eq("id", saleId).single();
    expect(row?.cash_shift_id).toBe(ctx.shiftCashier);

    // El cajero 2 no abrió caja: no hereda ninguna.
    const none = await rpc(ctx.cashier2.client, "create_sale", {
      p_items: item(),
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(none.error?.message).toMatch(/no_open_shift/);
  });

  it("H114: cash_movements desde el cliente sólo ingreso o retiro en el turno propio, inmutables", async () => {
    const other = await ctx.cashier.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftOwner, type: "expense", amount: 10, reason: "x" } as never);
    expect(other.error?.message).toMatch(/shift_not_owned/);

    const fake = await ctx.cashier.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "sale", amount: 999, payment_method: "cash" } as never);
    expect(fake.error?.message).toMatch(/cash_movement_forbidden/);

    const ok = await ctx.cashier.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "income", amount: 50, reason: "Cambio" } as never)
      .select("id")
      .single();
    expect(ok.error).toBeNull();
    const movId = (ok.data as { id: string }).id;

    const upd = await ctx.cashier.client.from("cash_movements").update({ amount: 1 } as never).eq("id", movId);
    expect(upd.error?.message).toMatch(/cash_movement_immutable/);
    const del = await ctx.cashier.client.from("cash_movements").delete().eq("id", movId);
    expect(del.error?.message).toMatch(/cash_movement_immutable/);
  });

  it("H114: cash_shifts no se crea ni se cierra por REST sobre un turno ajeno", async () => {
    const ins = await ctx.cashier.client
      .from("cash_shifts")
      .insert({ cash_register_id: ctx.regs[2], opening_amount: 0 } as never);
    expect(ins.error).not.toBeNull();

    const close = await rpc(ctx.cashier.client, "close_cash_shift", {
      p_shift_id: ctx.shiftOwner,
      p_closing_amount: 1000,
    });
    expect(close.error?.message).toMatch(/shift_not_owned|shift_not_open/);

    const direct = await ctx.cashier.client
      .from("cash_shifts")
      .update({ opening_amount: 0 } as never)
      .eq("id", ctx.shiftCashier);
    expect(direct.error?.message).toMatch(/shift_immutable/);
  });

  it("H116: retiro sobre el umbral exige PIN; el token del header se usa una sola vez", async () => {
    const save = await rpc(ctx.owner.client, "security_settings_save", {
      p: { pin_policy: { cash_out: { enabled: true, threshold: 50 } } },
    });
    expect(save.error).toBeNull();
    const bad = await rpc(ctx.cashier.client, "security_settings_save", { p: { shared_shift: true } });
    expect(bad.error?.message).toMatch(/forbidden/);

    const small = await ctx.cashier.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "expense", amount: 20, reason: "Bolsas" } as never);
    expect(small.error).toBeNull();
    const big = await ctx.cashier.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "expense", amount: 100, reason: "Proveedor" } as never);
    expect(big.error?.message).toMatch(/supervisor_required:cash_out/);

    const pin = await rpc(ctx.manager.client, "supervisor_set_pin", { p_pin: "4826" });
    expect(pin.error).toBeNull();
    const weak = await rpc(ctx.manager.client, "supervisor_set_pin", { p_pin: "1234" });
    expect(weak.error?.message).toMatch(/weak_pin/);
    const notSup = await rpc(ctx.cashier.client, "supervisor_set_pin", { p_pin: "4826" });
    expect(notSup.error?.message).toMatch(/forbidden/);

    const wrong = await rpc(ctx.cashier.client, "supervisor_authorize", {
      p_action: "cash_out",
      p_supervisor_id: ctx.manager.id,
      p_pin: "0000",
      p_amount: 100,
      p_reason: "Pago a proveedor",
    });
    expect((wrong.data as { error: string }).error).toBe("pin_invalid");

    const good = await rpc(ctx.cashier.client, "supervisor_authorize", {
      p_action: "cash_out",
      p_supervisor_id: ctx.manager.id,
      p_pin: "4826",
      p_amount: 100,
      p_reason: "Pago a proveedor",
    });
    const tok = good.data as { ok: boolean; token: string };
    expect(tok.ok).toBe(true);

    const withToken = await signIn(ctx.cashier.email, { "x-ninja-supervisor-token": tok.token });
    const first = await withToken
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "expense", amount: 100, reason: "Proveedor" } as never);
    expect(first.error).toBeNull();
    const again = await withToken
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "expense", amount: 100, reason: "Proveedor" } as never);
    expect(again.error?.message).toMatch(/supervisor_token_invalid/);

    // Un supervisor por rol no necesita PIN en su propio turno.
    const own = await ctx.owner.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftOwner, type: "expense", amount: 200, reason: "Retiro" } as never);
    expect(own.error).toBeNull();
  });

  it("H116: descuento general sobre el umbral exige PIN", async () => {
    const save = await rpc(ctx.owner.client, "security_settings_save", {
      p: { pin_policy: { cash_out: { enabled: true, threshold: 50 }, discount_over: { enabled: true, threshold: 10 } } },
    });
    expect(save.error).toBeNull();
    const r = await rpc(ctx.cashier.client, "create_sale", {
      p_items: item(100),
      p_payments: [{ method: "cash", amount: 80 }],
      p_discount_total: 20,
    });
    expect(r.error?.message).toMatch(/supervisor_required:discount_over/);
    const ok = await rpc(ctx.cashier.client, "create_sale", {
      p_items: item(100),
      p_payments: [{ method: "cash", amount: 95 }],
      p_discount_total: 5,
    });
    expect(ok.error).toBeNull();
  });

  it("H114: cierre forzado de un turno ajeno sólo por supervisor, con motivo y auditoría", async () => {
    const byCashier = await rpc(ctx.cashier.client, "cash_force_close", {
      p_shift_id: ctx.shiftOwner,
      p_closing_amount: 800,
      p_reason: "Se fue sin cerrar",
    });
    expect(byCashier.error?.message).toMatch(/supervisor_required:shift_force_close/);

    const noReason = await rpc(ctx.manager.client, "cash_force_close", {
      p_shift_id: ctx.shiftCashier,
      p_closing_amount: 0,
      p_reason: "",
    });
    expect(noReason.error?.message).toMatch(/reason_required/);

    const ok = await rpc(ctx.manager.client, "cash_force_close", {
      p_shift_id: ctx.shiftCashier,
      p_closing_amount: 500,
      p_reason: "Cambio de turno sin cierre",
    });
    expect(ok.error).toBeNull();
    const { data: sh } = await ctx.admin.from("cash_shifts").select("status").eq("id", ctx.shiftCashier).single();
    expect(sh?.status).toBe("closed");
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "cash_shift_force_closed");
    expect(logs?.length).toBe(1);
  });

  it("H115: el monitor muestra los turnos abiertos al dueño y sólo el propio al cajero", async () => {
    const mon = await rpc(ctx.owner.client, "cash_monitor");
    expect(mon.error).toBeNull();
    const rows = mon.data as { shift_id: string; opened_by: string; cash_expected: number }[];
    expect(rows.map((r) => r.shift_id)).toContain(ctx.shiftOwner);
    const mine = rows.find((r) => r.shift_id === ctx.shiftOwner)!;
    expect(Number(mine.cash_expected)).toBe(800);

    const c = await rpc(ctx.cashier2.client, "cash_monitor");
    expect(c.data).toEqual([]);
  });

  it("H113: suspensión corta la operación; el encargado no toca al dueño", async () => {
    const bad = await rpc(ctx.manager.client, "staff_set_status", {
      p_user: ctx.owner.id,
      p_profile: null,
      p_kind: "suspension",
      p_reason: "Prueba",
    });
    expect(bad.error?.message).toMatch(/cannot_change_owner/);
    const byCashier = await rpc(ctx.cashier.client, "staff_set_status", {
      p_user: ctx.cashier2.id,
      p_profile: null,
      p_kind: "suspension",
      p_reason: "Prueba",
    });
    expect(byCashier.error?.message).toMatch(/forbidden/);
    const noReason = await rpc(ctx.manager.client, "staff_set_status", {
      p_user: ctx.cashier2.id,
      p_profile: null,
      p_kind: "suspension",
    });
    expect(noReason.error?.message).toMatch(/reason_required/);

    const s = await rpc(ctx.manager.client, "staff_set_status", {
      p_user: ctx.cashier2.id,
      p_profile: null,
      p_kind: "suspension",
      p_reason: "Llegadas tarde",
    });
    expect(s.error).toBeNull();

    const open = await rpc(ctx.cashier2.client, "open_cash_shift", { p_register_id: ctx.regs[2], p_opening_amount: 0 });
    expect(open.error?.message).toMatch(/staff_suspended/);
    const { data: allowed } = await rpc(ctx.cashier2.client, "user_allowed_store_ids");
    expect(allowed).toEqual([]);
    const me = await rpc(ctx.cashier2.client, "my_staff_status");
    expect((me.data as { status: string }).status).toBe("suspended");

    // Empieza hoy: levantarla la cancela y vuelve a operar.
    const end = await rpc(ctx.manager.client, "staff_end_status", { p_event_id: s.data, p_reason: "Se aclaró" });
    expect(end.data).toBe("cancelled");
    const open2 = await rpc(ctx.cashier2.client, "open_cash_shift", { p_register_id: ctx.regs[2], p_opening_amount: 0 });
    expect(open2.error).toBeNull();
    await rpc(ctx.cashier2.client, "close_cash_shift", { p_shift_id: open2.data, p_closing_amount: 0 });
  });

  it("H113: baja revoca el negocio activo y la membresía; reingreso lo restaura", async () => {
    const t = await rpc(ctx.owner.client, "staff_set_status", {
      p_user: ctx.cashier2.id,
      p_profile: null,
      p_kind: "termination",
      p_subtype: "renuncia",
      p_reason: "Renuncia voluntaria",
    });
    expect(t.error).toBeNull();
    const { data: tu } = await ctx.admin
      .from("tenant_users")
      .select("status")
      .eq("tenant_id", ctx.tenant)
      .eq("user_id", ctx.cashier2.id)
      .single();
    expect(tu?.status).toBe("inactive");
    const { data: u } = await ctx.admin.auth.admin.getUserById(ctx.cashier2.id);
    expect((u.user?.app_metadata as { current_tenant_id?: string }).current_tenant_id).toBeUndefined();

    const people = await rpc(ctx.owner.client, "staff_people");
    const p = (people.data as { user_id: string; state: { status: string } }[]).find((x) => x.user_id === ctx.cashier2.id);
    expect(p?.state.status).toBe("terminated");

    const back = await rpc(ctx.owner.client, "staff_rehire", {
      p_user: ctx.cashier2.id,
      p_profile: null,
      p_role: "cashier",
      p_reason: "Vuelve en temporada",
    });
    expect(back.error).toBeNull();
    const { data: u2 } = await ctx.admin.auth.admin.getUserById(ctx.cashier2.id);
    expect((u2.user?.app_metadata as { current_tenant_id?: string }).current_tenant_id).toBe(ctx.tenant);
  });

  it("H117: la auditoría la leen dueño y encargado; el cajero sólo lo propio", async () => {
    const { data: own } = await ctx.cashier.client.from("audit_logs").select("action, actor_user_id");
    expect((own ?? []).every((r: { actor_user_id: string | null }) => r.actor_user_id === ctx.cashier.id)).toBe(true);
    expect((own ?? []).some((r: { action: string }) => r.action === "security_settings_changed")).toBe(false);

    const denied = await rpc(ctx.cashier.client, "audit_log_search", {});
    expect(denied.error?.message).toMatch(/forbidden/);

    const res = await rpc(ctx.owner.client, "audit_log_search", { p_action: "security_settings_changed" });
    expect(res.error).toBeNull();
    expect((res.data as { total: number }).total).toBeGreaterThanOrEqual(1);
  });
});
