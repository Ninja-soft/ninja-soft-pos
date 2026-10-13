// @vitest-environment node
// =============================================================================
// F12 · ADR-082 (migraciones 20261106100000 a 20261106100300): recursos de
// agenda con bloqueo de doble reserva, lista de espera, datos de ejemplo de la
// agenda y métricas de activación del panel interno.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con `agenda_recursos` (add-on otorgado), dueño, cajero
// y solo lectura; negocio B sin recursos; un usuario interno.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `ag-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: User;
  cashier: User;
  viewer: User;
  ownerB: User;
  internal: User;
  internalScoped: SupabaseClient;
  userIds: string[];
  r1: string;
  r2: string;
  service: string;
  prof: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function makeUser(
  admin: SupabaseClient,
  email: string,
  tenantId: string,
  role: string | null,
  appMeta: Record<string, unknown> = {},
): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId, ...appMeta },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (role) {
    const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
    if (tuErr) throw tuErr;
  }
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

// Turno de prueba con TODAS las claves (inserts multi-fila de PostgREST).
const appt = (over: Record<string, unknown>) => ({
  tenant_id: ctx.tenant,
  professional_id: null,
  customer_id: null,
  service_product_id: null,
  service_name: `Corte ${STAMP}`,
  service_price: 1000,
  commission_pct: null,
  starts_at: "2030-01-10T13:00:00Z",
  duration_min: 30,
  status: "reservado",
  notes: null,
  resource_id: null,
  ...over,
});

describe.skipIf(!enabled)("agenda F12 · recursos, lista de espera, demo y activación", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `Ag A ${STAMP}`, slug: `aga-${STAMP}`, status: "active" },
        { name: `Ag B ${STAMP}`, slug: `agb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tenant = rows.find((x) => x.slug === `aga-${STAMP}`)!.id;
    ctx.tenantB = rows.find((x) => x.slug === `agb-${STAMP}`)!.id;

    const { error: aErr } = await admin
      .from("subscription_addons")
      .insert([{ tenant_id: ctx.tenant, addon_key: "agenda_recursos", status: "active", source: "granted" }]);
    if (aErr) throw aErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.viewer = await makeUser(admin, `ver-${STAMP}@test.local`, ctx.tenant, "viewer");
    ctx.ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.internal = await makeUser(admin, `int-${STAMP}@test.local`, ctx.tenantB, null, { is_internal: true, internal_level: "admin" });
    ctx.internalScoped = createClient(URL_!, ANON!, {
      auth: { persistSession: false },
      global: { headers: { "x-ninja-scope": "internal" } },
    });
    const { error: iErr } = await ctx.internalScoped.auth.signInWithPassword({ email: `int-${STAMP}@test.local`, password: PASSWORD });
    if (iErr) throw iErr;
    ctx.userIds.push(ctx.owner.id, ctx.cashier.id, ctx.viewer.id, ctx.ownerB.id, ctx.internal.id);

    const { data: svc, error: pErr } = await ctx.owner.client
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Color ${STAMP}`, price: 15000, track_stock: false, service_duration_min: 90, commission_pct: 30 } as never)
      .select("id")
      .single();
    if (pErr || !svc) throw pErr ?? new Error("service");
    ctx.service = (svc as { id: string }).id;

    const { data: prof, error: prErr } = await ctx.owner.client
      .from("professionals" as never)
      .insert({ tenant_id: ctx.tenant, name: `Ana ${STAMP}`, color: "#ff5a2c", commission_pct: 40 } as never)
      .select("id")
      .single();
    if (prErr || !prof) throw prErr ?? new Error("professional");
    ctx.prof = (prof as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const tenant of [ctx.tenant, ctx.tenantB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", tenant);
      await admin.from("audit_logs").delete().eq("tenant_id", tenant);
      await admin.from("tenants").delete().eq("id", tenant);
    }
    for (const id of ctx.userIds ?? []) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Recursos
  // ---------------------------------------------------------------------------
  it("recursos: el dueño los carga (multi-fila); cajero y solo lectura no; sin la feature, tampoco", async () => {
    const { data, error } = await ctx.owner.client
      .from("agenda_resources" as never)
      .insert([
        { tenant_id: ctx.tenant, name: "Sillón 1", kind: "silla", color: "#94a3b8", is_active: true, sort: 0 },
        { tenant_id: ctx.tenant, name: "Cabina 1", kind: "cabina", color: "#0ea5e9", is_active: true, sort: 1 },
      ] as never)
      .select("id, name");
    expect(error).toBeNull();
    const rows = data as { id: string; name: string }[];
    ctx.r1 = rows.find((r) => r.name === "Sillón 1")!.id;
    ctx.r2 = rows.find((r) => r.name === "Cabina 1")!.id;

    const caj = await ctx.cashier.client
      .from("agenda_resources" as never)
      .insert({ tenant_id: ctx.tenant, name: "Sillón 2", kind: "silla", color: "#94a3b8", is_active: true, sort: 2 } as never);
    expect(caj.error).not.toBeNull();
    const ver = await ctx.viewer.client
      .from("agenda_resources" as never)
      .insert({ tenant_id: ctx.tenant, name: "Sillón 3", kind: "silla", color: "#94a3b8", is_active: true, sort: 3 } as never);
    expect(ver.error).not.toBeNull();
    const sinPlan = await ctx.ownerB.client
      .from("agenda_resources" as never)
      .insert({ tenant_id: ctx.tenantB, name: "Sillón B", kind: "silla", color: "#94a3b8", is_active: true, sort: 0 } as never);
    expect(sinPlan.error).not.toBeNull();

    // El cajero los ve (para agendar); otro negocio no.
    const { data: vis } = await ctx.cashier.client.from("agenda_resources" as never).select("id");
    expect((vis ?? []).length).toBe(2);
    const { data: otro } = await ctx.ownerB.client.from("agenda_resources" as never).select("id").eq("tenant_id", ctx.tenant);
    expect(otro ?? []).toHaveLength(0);
  });

  it("doble reserva: el mismo recurso no se pisa entre turnos activos", async () => {
    const { data: a, error: aErr } = await ctx.cashier.client
      .from("appointments" as never)
      .insert([
        appt({ resource_id: ctx.r1, starts_at: "2030-01-10T13:00:00Z" }),
        appt({ resource_id: ctx.r2, starts_at: "2030-01-10T13:00:00Z" }),
      ] as never)
      .select("id, resource_id");
    expect(aErr).toBeNull();
    const first = (a as { id: string; resource_id: string }[]).find((x) => x.resource_id === ctx.r1)!.id;

    const pisa = await ctx.cashier.client
      .from("appointments" as never)
      .insert(appt({ resource_id: ctx.r1, starts_at: "2030-01-10T13:15:00Z" }) as never);
    expect(pisa.error?.message).toMatch(/resource_busy/);

    const pegado = await ctx.cashier.client
      .from("appointments" as never)
      .insert(appt({ resource_id: ctx.r1, starts_at: "2030-01-10T13:30:00Z" }) as never);
    expect(pegado.error).toBeNull();

    // Mover un turno encima de otro también se bloquea (13:20 pisa al de 13:30).
    const mover = await ctx.cashier.client
      .from("appointments" as never)
      .update({ starts_at: "2030-01-10T13:20:00Z" } as never)
      .eq("id", first);
    expect(mover.error?.message).toMatch(/resource_busy/);

    // Cancelado libera el lugar.
    const cancel = await ctx.cashier.client
      .from("appointments" as never)
      .update({ status: "cancelado", cancel_reason: "test" } as never)
      .eq("id", first);
    expect(cancel.error).toBeNull();
    const libre = await ctx.cashier.client
      .from("appointments" as never)
      .insert(appt({ resource_id: ctx.r1, starts_at: "2030-01-10T12:45:00Z" }) as never);
    expect(libre.error).toBeNull();
  });

  it("un negocio sin la feature no asigna recursos (ni ajenos)", async () => {
    const r = await ctx.ownerB.client
      .from("appointments" as never)
      .insert({ ...appt({ resource_id: ctx.r1 }), tenant_id: ctx.tenantB } as never);
    expect(r.error?.message).toMatch(/feature_not_in_plan: agenda_recursos/);
    // Sin recurso, la agenda de B sigue igual.
    const ok = await ctx.ownerB.client.from("appointments" as never).insert({ ...appt({}), tenant_id: ctx.tenantB } as never);
    expect(ok.error).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Lista de espera
  // ---------------------------------------------------------------------------
  it("lista de espera: recepción anota (multi-fila), solo lectura no, y no se agenda por REST", async () => {
    const base = {
      tenant_id: ctx.tenant,
      customer_id: null,
      phone: "1155550000",
      service_product_id: ctx.service,
      service_name: null,
      professional_id: ctx.prof,
      preferred_date: "2030-01-11",
      preferred_slot: "tarde",
      notes: null,
    };
    const { error } = await ctx.cashier.client
      .from("agenda_waitlist" as never)
      .insert([
        { ...base, customer_name: `Paula ${STAMP}` },
        { ...base, customer_name: `Rocío ${STAMP}` },
      ] as never);
    expect(error).toBeNull();

    const ver = await ctx.viewer.client.from("agenda_waitlist" as never).insert({ ...base, customer_name: "X" } as never);
    expect(ver.error).not.toBeNull();
    const directo = await ctx.cashier.client
      .from("agenda_waitlist" as never)
      .insert({ ...base, customer_name: "Y", status: "agendado" } as never);
    expect(directo.error?.message).toMatch(/use_waitlist_schedule/);
    const sinNombre = await ctx.cashier.client.from("agenda_waitlist" as never).insert({ ...base, customer_name: null } as never);
    expect(sinNombre.error).not.toBeNull();

    const { data: otro } = await ctx.ownerB.client.from("agenda_waitlist" as never).select("id").eq("tenant_id", ctx.tenant);
    expect(otro ?? []).toHaveLength(0);
  });

  it("pasar a turno: crea el turno con el snapshot del servicio, una sola vez", async () => {
    const { data: list } = await ctx.cashier.client
      .from("agenda_waitlist" as never)
      .select("id, customer_name")
      .eq("status", "esperando");
    const entry = (list as { id: string; customer_name: string }[]).find((e) => e.customer_name === `Paula ${STAMP}`)!;

    const ver = await rpc(ctx.viewer.client, "agenda_waitlist_schedule", { p_entry_id: entry.id, p_starts_at: "2030-01-11T18:00:00Z" });
    expect(ver.error?.message).toMatch(/forbidden/);

    const r = await rpc(ctx.cashier.client, "agenda_waitlist_schedule", {
      p_entry_id: entry.id,
      p_starts_at: "2030-01-11T18:00:00Z",
      p_resource_id: ctx.r2,
    });
    expect(r.error).toBeNull();
    const apptId = (r.data as { appointment_id: string }).appointment_id;
    const { data: a } = await ctx.owner.client
      .from("appointments" as never)
      .select("service_name, service_price, duration_min, commission_pct, professional_id, resource_id, notes, status")
      .eq("id", apptId)
      .single();
    const row = a as unknown as Record<string, unknown>;
    expect(row.service_name).toBe(`Color ${STAMP}`);
    expect(Number(row.service_price)).toBe(15000);
    expect(row.duration_min).toBe(90);
    expect(Number(row.commission_pct)).toBe(30);
    expect(row.professional_id).toBe(ctx.prof);
    expect(row.resource_id).toBe(ctx.r2);
    expect(String(row.notes)).toContain(`Paula ${STAMP}`);

    const again = await rpc(ctx.cashier.client, "agenda_waitlist_schedule", { p_entry_id: entry.id, p_starts_at: "2030-01-12T18:00:00Z" });
    expect(again.error?.message).toMatch(/waitlist_entry_closed/);

    // El recurso ya ocupado bloquea el paso a turno (y no deja la entrada agendada).
    const other = (list as { id: string; customer_name: string }[]).find((e) => e.customer_name === `Rocío ${STAMP}`)!;
    const busy = await rpc(ctx.cashier.client, "agenda_waitlist_schedule", {
      p_entry_id: other.id,
      p_starts_at: "2030-01-11T18:30:00Z",
      p_resource_id: ctx.r2,
    });
    expect(busy.error?.message).toMatch(/resource_busy/);
    const { data: still } = await ctx.cashier.client.from("agenda_waitlist" as never).select("status").eq("id", other.id).single();
    expect((still as unknown as { status: string }).status).toBe("esperando");

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .eq("action", "waitlist_scheduled");
    expect((logs ?? []).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Datos de ejemplo
  // ---------------------------------------------------------------------------
  it("datos de ejemplo: sólo dueño o encargado; se cargan una vez y se quitan", async () => {
    const caj = await rpc(ctx.cashier.client, "agenda_demo_seed");
    expect(caj.error?.message).toMatch(/forbidden/);

    const s = await rpc(ctx.owner.client, "agenda_demo_seed");
    expect(s.error).toBeNull();
    expect(s.data).toMatchObject({ seeded: true, appointments: 4, resource: true, waitlist: true });
    const again = await rpc(ctx.owner.client, "agenda_demo_seed");
    expect(again.data).toMatchObject({ seeded: false, already: true });

    const { data: rows } = await ctx.owner.client.from("agenda_demo_rows" as never).select("entity, row_id");
    const demoAppts = (rows as { entity: string; row_id: string }[]).filter((r) => r.entity === "appointments").map((r) => r.row_id);
    expect(demoAppts).toHaveLength(4);
    const { data: otro } = await ctx.ownerB.client.from("agenda_demo_rows" as never).select("id").eq("tenant_id", ctx.tenant);
    expect(otro ?? []).toHaveLength(0);

    const c = await rpc(ctx.owner.client, "agenda_demo_clear");
    expect(c.error).toBeNull();
    expect(c.data).toMatchObject({ appointments_deleted: 4, appointments_kept: 0 });
    const { data: left } = await ctx.owner.client.from("appointments" as never).select("id").in("id", demoAppts);
    expect(left ?? []).toHaveLength(0);
    const { data: profs } = await ctx.owner.client
      .from("professionals" as never)
      .select("id")
      .like("name", "%(ejemplo)")
      .is("deleted_at", null);
    expect(profs ?? []).toHaveLength(0);

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenant)
      .in("action", ["agenda_demo_seeded", "agenda_demo_cleared"]);
    expect((logs ?? []).map((l) => (l as { action: string }).action).sort()).toEqual(["agenda_demo_cleared", "agenda_demo_seeded"]);
  });

  // ---------------------------------------------------------------------------
  // Activación (panel interno)
  // ---------------------------------------------------------------------------
  it("activación: sólo el staff interno desde el panel; refleja el primer cobro del cajero en su turno", async () => {
    const dueño = await rpc(ctx.owner.client, "internal_tenant_activation", { p_tenant: ctx.tenant });
    expect(dueño.error?.message).toMatch(/forbidden/);
    const sinScope = await rpc(ctx.internal.client, "internal_tenant_activation", { p_tenant: ctx.tenant });
    expect(sinScope.error?.message).toMatch(/forbidden/);

    const before = await rpc(ctx.internalScoped, "internal_tenant_activation", { p_tenant: ctx.tenant });
    expect(before.error).toBeNull();
    expect(before.data).toMatchObject({ first_sale_at: null, sales_count: 0 });
    expect((before.data as { appointments_count: number }).appointments_count).toBeGreaterThan(0);

    // El cajero abre SU turno y vende.
    const { data: store, error: sErr } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: reg, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert({ store_id: (store as { id: string }).id, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    const sh = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: (reg as { id: string }).id, p_opening_amount: 0 });
    expect(sh.error).toBeNull();
    const sale = await rpc(ctx.cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.service, quantity: 1, unit_price: 15000, discount: 0 }],
      p_payments: [{ method: "cash", amount: 15000 }],
    });
    expect(sale.error).toBeNull();

    const after = await rpc(ctx.internalScoped, "internal_tenant_activation", { p_tenant: ctx.tenant });
    expect(after.error).toBeNull();
    const d = after.data as { first_sale_at: string | null; sales_count: number; minutes_to_first_sale: number | null };
    expect(d.first_sale_at).not.toBeNull();
    expect(d.sales_count).toBe(1);
    expect(d.minutes_to_first_sale).toBeGreaterThanOrEqual(0);
  });

  it("ninguna policy nueva filtra con is_internal() (ADR-052)", async () => {
    const { data, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });
});
