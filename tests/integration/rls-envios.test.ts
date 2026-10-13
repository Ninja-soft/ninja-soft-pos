// @vitest-environment node
// =============================================================================
// Envíos y logística (ADR-103, migraciones 20261110300000 a 20261110300300):
// aislamiento entre negocios, secretos sólo service_role, roles (dueño,
// cajero, viewer según docs/06), gating del plan en la base, idempotencia del
// alta y de la cola, append-only de eventos y auditoría.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
//
// Escenario: negocio A con `envios` y `andreani` (dueño, cajero, viewer) y una
// conexión de Andreani con secretos; negocio B sin la feature (dueño).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `env-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type RpcRes = { data: unknown; error: { message: string } | null };
type Ctx = {
  admin: SupabaseClient;
  anon: SupabaseClient;
  tA: string;
  tB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  viewer: SupabaseClient;
  ownerB: SupabaseClient;
  ownerId: string;
  cashierId: string;
  ownerBId: string;
  userIds: string[];
  storeA: string;
  storeB: string;
  connA: string;
  shipSim: string;
};
const ctx = {} as Ctx;

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;
// Tablas fuera de los tipos generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const from = (c: SupabaseClient, t: string) => (c as any).from(t);

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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const payload = (key: string, over: Record<string, unknown> = {}) => ({
  idempotency_key: key,
  store_id: ctx.storeA,
  provider_key: "simulador",
  service_type: "door",
  recipient: { name: "Ana Gómez", phone: "1155556666" },
  destination: { street: "Av. Alberdi", number: "3000", city: "CABA", province: "CABA", postal_code: "1406" },
  packages: [{ weight_kg: 1.2, length_cm: 30, width_cm: 20, height_cm: 10 }],
  declared_value: 12000,
  quote: { provider_key: "simulador", service_code: "SIM_STD_DOOR", cost: 4800 },
  submit: true,
  ...over,
});

describe.skipIf(!enabled)("Envíos y logística (ADR-103)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `ENV ${STAMP}`, slug: `env-${STAMP}`, status: "active" },
        { name: `ENVB ${STAMP}`, slug: `envb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tA = tenants.data.find((t) => t.slug === `env-${STAMP}`)!.id;
    ctx.tB = tenants.data.find((t) => t.slug === `envb-${STAMP}`)!.id;

    // Inserts multi-fila con TODAS las claves en cada fila (PostgREST).
    const { error: addErr } = await admin.from("subscription_addons").insert(
      ["envios", "andreani"].map((key) => ({ tenant_id: ctx.tA, addon_key: key, status: "active", source: "granted" })),
    );
    if (addErr) throw addErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tA, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tA, "cashier");
    const viewer = await makeUser(admin, `viewer-${STAMP}@test.local`, ctx.tA, "viewer");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tB, "owner");
    Object.assign(ctx, {
      owner: owner.client,
      cashier: cashier.client,
      viewer: viewer.client,
      ownerB: ownerB.client,
      ownerId: owner.id,
      cashierId: cashier.id,
      ownerBId: ownerB.id,
    });
    ctx.userIds.push(owner.id, cashier.id, viewer.id, ownerB.id);

    const sA = await owner.client
      .from("stores")
      .insert({ name: `Centro ${STAMP}`, address: "Thames 100", city: "CABA", province: "CABA", postal_code: "1414" } as never)
      .select("id")
      .single();
    if (sA.error || !sA.data) throw sA.error ?? new Error("store A");
    ctx.storeA = (sA.data as { id: string }).id;
    const sB = await ownerB.client.from("stores").insert({ name: `B ${STAMP}`, postal_code: "1900" } as never).select("id").single();
    if (sB.error || !sB.data) throw sB.error ?? new Error("store B");
    ctx.storeB = (sB.data as { id: string }).id;

    const conn = await from(admin, "shipping_connections")
      .insert({
        tenant_id: ctx.tA,
        store_id: null,
        provider_key: "andreani",
        enabled: true,
        sandbox: true,
        config: { client_number: "CL0003750", contract_door: "400006709" },
        secret_keys: ["password", "username"],
      } as never)
      .select("id")
      .single();
    if (conn.error || !conn.data) throw conn.error ?? new Error("conn");
    ctx.connA = (conn.data as unknown as { id: string }).id;
    const sec = await from(admin, "shipping_secrets").insert({
      tenant_id: ctx.tA,
      connection_id: ctx.connA,
      secrets: { username: "usuario_test", password: "no-se-lee" },
    } as never);
    if (sec.error) throw sec.error;
  }, 60_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB]) {
      await from(admin, "shipping_jobs").delete().eq("tenant_id", t);
      await from(admin, "shipping_secrets").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs y shipment_events son inmutables: si el negocio no se puede
      // borrar, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) await admin.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it("alta idempotente: la misma clave devuelve el mismo envío y un solo trabajo", async () => {
    const a = await rpc(ctx.owner, "shipment_create", { p: payload(`${STAMP}-sim-1`) });
    expect(a.error).toBeNull();
    const s = a.data as { id: string; status: string; replayed: boolean; tenant_id: string; quoted_cost: number };
    expect(s).toMatchObject({ status: "pending", replayed: false, tenant_id: ctx.tA, quoted_cost: 4800 });
    ctx.shipSim = s.id;
    const again = await rpc(ctx.owner, "shipment_create", { p: payload(`${STAMP}-sim-1`) });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ id: s.id, replayed: true });
    const { data: jobs } = await from(ctx.admin, "shipping_jobs").select("id, kind, status").eq("shipment_id", s.id);
    expect(jobs).toEqual([expect.objectContaining({ kind: "create", status: "pending" })]);
  });

  it("validaciones del servidor (destino, bultos, logística sin conectar o esqueleto)", async () => {
    const bad = [
      [payload(`${STAMP}-bad-1`, { destination: { postal_code: "14" } }), /invalid_postal_code/],
      [payload(`${STAMP}-bad-2`, { packages: [] }), /packages_required/],
      [payload(`${STAMP}-bad-3`, { packages: [{ weight_kg: 0, length_cm: 1, width_cm: 1, height_cm: 1 }] }), /invalid_package_weight/],
      [payload(`${STAMP}-bad-4`, { provider_key: "oca" }), /provider_not_available|feature_not_in_plan/],
      [payload(`${STAMP}-bad-5`, { service_type: "branch", destination: { postal_code: "1406" } }), /pickup_point_required/],
      [payload("corta"), /idempotency_key_required/],
    ] as const;
    for (const [p, re] of bad) {
      const r = await rpc(ctx.owner, "shipment_create", { p });
      expect(r.error?.message ?? "").toMatch(re);
    }
  });

  it("cajero crea y cancela lo que no está en la logística; viewer sólo lee", async () => {
    const c = await rpc(ctx.cashier, "shipment_create", { p: payload(`${STAMP}-cash-1`) });
    expect(c.error).toBeNull();
    const id = (c.data as { id: string }).id;
    const cancel = await rpc(ctx.cashier, "shipment_cancel", { p_id: id, p_reason: "se arrepintió", p_local: false });
    expect(cancel.error).toBeNull();
    expect(cancel.data).toMatchObject({ status: "cancelled", cancel_mode: "local_before_carrier" });
    const { data: job } = await from(ctx.admin, "shipping_jobs").select("status, last_error").eq("shipment_id", id).single();
    expect(job).toMatchObject({ status: "failed", last_error: "cancelled_by_user" });

    const v = await rpc(ctx.viewer, "shipment_create", { p: payload(`${STAMP}-view-1`) });
    expect(v.error?.message ?? "").toMatch(/forbidden_read_only/);
    const { data: seen } = await from(ctx.viewer, "shipments").select("id").eq("tenant_id", ctx.tA);
    expect((seen ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("creado en Andreani (no cancela por API): cajero no; dueño sólo con 'cancelar en NinjaSoft'", async () => {
    const c = await rpc(ctx.owner, "shipment_create", {
      p: payload(`${STAMP}-and-1`, { provider_key: "andreani", quote: { provider_key: "andreani", cost: 5000 } }),
    });
    expect(c.error).toBeNull();
    const id = (c.data as { id: string; connection_id: string }).id;
    expect((c.data as { connection_id: string }).connection_id).toBe(ctx.connA);
    await from(ctx.admin, "shipments").update({ external_id: "API1", tracking_number: "3600001", status: "label_ready" } as never).eq("id", id);

    expect((await rpc(ctx.cashier, "shipment_cancel", { p_id: id, p_reason: "motivo" })).error?.message ?? "").toMatch(/forbidden_role/);
    expect((await rpc(ctx.owner, "shipment_cancel", { p_id: id, p_reason: "motivo", p_local: false })).error?.message ?? "").toMatch(
      /carrier_cannot_cancel/,
    );
    const ok = await rpc(ctx.owner, "shipment_cancel", { p_id: id, p_reason: "dirección mal", p_local: true });
    expect(ok.data).toMatchObject({ status: "cancelled", cancel_mode: "local_only" });

    const { data: audit } = await ctx.admin.from("audit_logs").select("action").eq("entity_id", id).order("created_at");
    expect((audit ?? []).map((a: { action: string }) => a.action)).toEqual(["shipment_created", "shipment_cancelled"]);
  });

  it("otro negocio no ve envíos, eventos, trabajos ni conexiones, ni los puede tocar", async () => {
    for (const t of ["shipments", "shipment_events", "shipping_jobs", "shipping_connections"]) {
      const { data } = await from(ctx.ownerB, t).select("id").eq("tenant_id", ctx.tA);
      expect(data ?? [], t).toEqual([]);
    }
    const cancel = await rpc(ctx.ownerB, "shipment_cancel", { p_id: ctx.shipSim, p_reason: "ajeno" });
    expect(cancel.error?.message ?? "").toMatch(/shipment_not_found|feature_not_in_plan/);
    const track = await rpc(ctx.ownerB, "shipment_request_track", { p_id: ctx.shipSim });
    expect(track.error).not.toBeNull();
  });

  it("sin la feature el servidor rechaza aunque se fuerce la llamada", async () => {
    const r = await rpc(ctx.ownerB, "shipment_create", { p: payload(`${STAMP}-b-1`, { store_id: ctx.storeB }) });
    expect(r.error?.message ?? "").toMatch(/feature_not_in_plan: envios/);
    const eff = await rpc(ctx.admin, "shipping_access_check", {
      p_tenant: ctx.tB,
      p_user: ctx.ownerBId,
      p_store: null,
      p_provider: "andreani",
      p_mode: "operate",
    });
    expect(eff.data).toBe("feature_not_in_plan: envios");
  });

  it("secretos: nunca legibles con anon ni con un usuario del negocio", async () => {
    for (const c of [ctx.anon, ctx.owner, ctx.cashier]) {
      const { data, error } = await from(c, "shipping_secrets").select("*");
      expect(error !== null || (data ?? []).length === 0).toBe(true);
    }
    const { data: conn } = await from(ctx.owner, "shipping_connections").select("config, secret_keys").eq("id", ctx.connA).single();
    expect(conn).toMatchObject({ secret_keys: ["password", "username"] });
    expect(JSON.stringify(conn)).not.toContain("no-se-lee");
  });

  it("sin escritura directa: envíos, conexiones, eventos y cola sólo por RPC o service_role", async () => {
    const ins = await from(ctx.owner, "shipments").insert({
      tenant_id: ctx.tA,
      store_id: ctx.storeA,
      idempotency_key: `${STAMP}-direct`,
      recipient: {},
      destination: {},
      packages: [],
    } as never);
    expect(ins.error).not.toBeNull();
    const conn = await from(ctx.owner, "shipping_connections").insert({ tenant_id: ctx.tA, provider_key: "simulador" } as never);
    expect(conn.error).not.toBeNull();
    for (const [fn, args] of [
      ["shipping_jobs_claim", { p_limit: 1, p_worker: "x" }],
      ["shipment_record_events", { p_shipment: ctx.shipSim, p_events: [], p_source: "poll" }],
      ["_shipping_enqueue", { p_tenant: ctx.tA, p_shipment: ctx.shipSim, p_kind: "track", p_delay_seconds: 0 }],
      ["shipping_access_check", { p_tenant: ctx.tA, p_user: ctx.ownerId, p_store: null, p_provider: null, p_mode: "manage" }],
    ] as const) {
      expect((await rpc(ctx.owner, fn, args)).error, fn).not.toBeNull();
    }
  });

  it("roles para conectar logísticas: cajero no; dueño sí; sucursal exige multi_sucursal", async () => {
    const check = (user: string, store: string | null, mode: string, provider = "andreani") =>
      rpc(ctx.admin, "shipping_access_check", { p_tenant: ctx.tA, p_user: user, p_store: store, p_provider: provider, p_mode: mode });
    expect((await check(ctx.cashierId, null, "manage")).data).toBe("forbidden");
    expect((await check(ctx.cashierId, ctx.storeA, "operate")).data).toBeNull();
    expect((await check(ctx.ownerId, null, "manage")).data).toBeNull();
    expect((await check(ctx.ownerId, ctx.storeA, "manage")).data).toBe("feature_not_in_plan: multi_sucursal");
    expect((await check(ctx.ownerId, null, "operate", "pickit")).data).toBe("invalid_provider");
  });

  it("logísticas efectivas de la sucursal: Andreani heredada del negocio y el simulador", async () => {
    const r = await rpc(ctx.owner, "shipping_effective_connections", { p_store: ctx.storeA });
    expect(r.error).toBeNull();
    const keys = (r.data as { provider_key: string; scope: string; in_plan: boolean }[]).map((x) => [x.provider_key, x.scope, x.in_plan]);
    expect(keys).toEqual(expect.arrayContaining([["andreani", "tenant", true], ["simulador", "tenant", true]]));
  });

  it("cola: dos workers en paralelo no toman el mismo trabajo; reintento con espera", async () => {
    const [a, b] = await Promise.all([
      rpc(ctx.admin, "shipping_jobs_claim", { p_limit: 50, p_worker: "w1", p_shipment: ctx.shipSim }),
      rpc(ctx.admin, "shipping_jobs_claim", { p_limit: 50, p_worker: "w2", p_shipment: ctx.shipSim }),
    ]);
    const ids = [...((a.data as { id: string }[]) ?? []), ...((b.data as { id: string }[]) ?? [])].map((j) => j.id);
    expect(ids).toHaveLength(1);
    const fin = await rpc(ctx.admin, "shipping_job_finish", { p_id: ids[0], p_outcome: "retry", p_error: "timeout", p_retry_seconds: 600 });
    expect(fin.data).toBe("pending");
    const again = await rpc(ctx.admin, "shipping_jobs_claim", { p_limit: 5, p_worker: "w3", p_shipment: ctx.shipSim });
    expect(again.data).toEqual([]);
    // Encolar otra vez el mismo tipo no duplica.
    const e1 = await rpc(ctx.admin, "_shipping_enqueue", { p_tenant: ctx.tA, p_shipment: ctx.shipSim, p_kind: "create", p_delay_seconds: 0 });
    expect(e1.data).toBe(ids[0]);
    const { count } = await from(ctx.admin, "shipping_jobs")
      .select("id", { count: "exact", head: true })
      .eq("shipment_id", ctx.shipSim)
      .eq("kind", "create");
    expect(count).toBe(1);
  });

  it("eventos: dedupe, estado normalizado, final no retrocede y append-only", async () => {
    await from(ctx.admin, "shipments").update({ external_id: "SIM-X", tracking_number: "SIM1", status: "label_ready" } as never).eq("id", ctx.shipSim);
    const evs = [
      { status: "picked_up", carrier_status: "SIM_PICKED_UP", occurred_at: "2026-10-13T12:02:00Z", external_event_id: "SIM-X:1" },
      { status: "delivered", carrier_status: "SIM_DELIVERED", occurred_at: "2026-10-13T12:08:00Z", external_event_id: "SIM-X:4" },
    ];
    const r1 = await rpc(ctx.admin, "shipment_record_events", { p_shipment: ctx.shipSim, p_events: evs, p_source: "poll" });
    expect(r1.data).toMatchObject({ inserted: 2, status: "delivered" });
    const r2 = await rpc(ctx.admin, "shipment_record_events", {
      p_shipment: ctx.shipSim,
      p_events: [...evs, { status: "in_transit", carrier_status: "x", occurred_at: "2026-10-14T00:00:00Z" }],
      p_source: "poll",
    });
    expect(r2.data).toMatchObject({ inserted: 1, status: "delivered" });
    const { data: ev } = await from(ctx.owner, "shipment_events").select("id").eq("shipment_id", ctx.shipSim);
    expect((ev ?? []).length).toBeGreaterThanOrEqual(4);
    const upd = await from(ctx.admin, "shipment_events").update({ description: "x" } as never).eq("shipment_id", ctx.shipSim);
    expect(upd.error).not.toBeNull();
  });

  it("polling: encola el seguimiento de los envíos vivos una sola vez por turno", async () => {
    const c = await rpc(ctx.owner, "shipment_create", { p: payload(`${STAMP}-sim-2`) });
    const id = (c.data as { id: string }).id;
    await from(ctx.admin, "shipments")
      .update({ external_id: "SIM-Y", tracking_number: "SIM2", status: "in_transit", next_track_at: new Date(Date.now() - 60_000).toISOString() } as never)
      .eq("id", id);
    const n1 = await rpc(ctx.admin, "shipping_track_schedule", { p_limit: 2000 });
    expect(n1.error).toBeNull();
    expect(Number(n1.data)).toBeGreaterThanOrEqual(1);
    const { data: jobs } = await from(ctx.admin, "shipping_jobs").select("kind, status").eq("shipment_id", id).eq("kind", "track");
    expect(jobs).toHaveLength(1);
    await rpc(ctx.admin, "shipping_track_schedule", { p_limit: 2000 });
    const { data: jobs2 } = await from(ctx.admin, "shipping_jobs").select("id").eq("shipment_id", id).eq("kind", "track");
    expect(jobs2).toHaveLength(1);
  });
});
