// @vitest-environment node
// =============================================================================
// ADR-107: sincronización del catálogo Tiendita desde el feed del scraper.
//
// catalog_sync_runs: sólo lectura para staff interno en el panel interno
// ((select internal_scope()), header x-ninja-scope); nadie escribe por REST.
// Las RPC de la sync son sólo de service_role (la Edge catalog_sync). Con
// service_role: alta sola de tiendas nuevas, upsert por (tienda, EAN),
// faltantes no disponibles (sin borrar), una sola corrida abierta, auditoría
// de la manual y cierre con notify_catalog_update server-side.
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

const STAMP = `csync${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const STORE = `${STAMP.toUpperCase()}_S1`;
const STORE_NEW = `${STAMP.toUpperCase()}_S2`;

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  staff: SupabaseClient;
  staffInternal: SupabaseClient;
  staffId: string;
  userIds: string[];
  runs: string[];
  catalog: string;
};
const ctx = {} as Ctx;

async function makeUser(
  admin: SupabaseClient,
  email: string,
  tenantId: string | null,
  role: string | null,
  meta: Record<string, unknown> = {},
  headers?: Record<string, string>,
) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: tenantId ? { current_tenant_id: tenantId, ...meta } : meta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (tenantId && role) {
    const { error: tuErr } = await admin
      .from("tenant_users")
      .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
    if (tuErr) throw tuErr;
  }
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const row = (ean: string, extra: Record<string, unknown> = {}) => ({
  ean,
  titulo: `Producto ${ean}`,
  precio: 100,
  precio_lista: 120,
  marca: "M",
  categoria_path: "A > B",
  foto_url: "https://example.test/f.webp",
  disponible: true,
  estado: "ACTIVO",
  id_origen: `id-${ean}`,
  descripcion: null,
  atributos: [{ key: "Contenido", value: "1 kg" }],
  ...extra,
});

describe.skipIf(!enabled)("ADR-107 · sync del catálogo Tiendita", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.runs = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Sync ${STAMP}`, slug: `sync-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id as string;

    const owner = await makeUser(admin, `own-${STAMP}@test.local`, ctx.tenant, "owner");
    const staff = await makeUser(admin, `stf-${STAMP}@test.local`, null, null, { is_internal: true, internal_level: "admin" });
    const staffInternal = await makeUser(
      admin,
      `sti-${STAMP}@test.local`,
      null,
      null,
      { is_internal: true, internal_level: "admin" },
      { "x-ninja-scope": "internal" },
    );
    ctx.owner = owner.client;
    ctx.staff = staff.client;
    ctx.staffInternal = staffInternal.client;
    ctx.staffId = staffInternal.id;
    ctx.userIds.push(owner.id, staff.id, staffInternal.id);

    // Sin corridas abiertas de otras suites (una sola abierta a la vez).
    await admin.from("catalog_sync_runs").update({ status: "error", finished_at: new Date().toISOString() }).eq("status", "running");

    const { error: sErr } = await admin.from("catalog_stores").insert({ key: STORE, name: "Tienda test" });
    if (sErr) throw sErr;
    const { data: cat, error: cErr } = await admin
      .from("catalogs")
      .insert({ key: `cat-${STAMP}`, name: `Catálogo ${STAMP}`, is_active: true })
      .select("id")
      .single();
    if (cErr || !cat) throw cErr ?? new Error("catalog");
    ctx.catalog = cat.id as string;
    await admin.from("catalog_store_map").insert({ catalog_id: ctx.catalog, store_key: STORE });
    // Producto "viejo" cargado por Excel: no vendrá en el feed.
    await admin.from("catalog_products").insert({ store_key: STORE, ean: `${STAMP}-old`, titulo: "Viejo", disponible: true, estado: "ACTIVO" });
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    if (ctx.runs.length) {
      await admin.from("audit_logs").delete().in("entity_id", ctx.runs);
      await admin.from("catalog_sync_runs").delete().in("id", ctx.runs);
    }
    await admin.from("catalog_store_map").delete().eq("catalog_id", ctx.catalog);
    await admin.from("catalogs").delete().eq("id", ctx.catalog);
    await admin.from("catalog_products").delete().in("store_key", [STORE, STORE_NEW]);
    await admin.from("catalog_stores").delete().in("key", [STORE, STORE_NEW]);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("sync completa con service_role: tiendas nuevas, upsert, faltantes y cierre", async () => {
    const { admin } = ctx;

    const enq = await rpc(admin, "catalog_sync_enqueue", { p_trigger: "manual", p_user: ctx.staffId, p_full: false });
    expect(enq.error).toBeNull();
    const runId = enq.data as string;
    ctx.runs.push(runId);
    // Una sola corrida abierta: un segundo pedido devuelve la misma.
    const again = await rpc(admin, "catalog_sync_enqueue", { p_trigger: "cron" });
    expect(again.data).toBe(runId);
    // La manual queda auditada.
    const { data: audit } = await admin
      .from("audit_logs")
      .select("action, actor_user_id")
      .eq("entity_id", runId)
      .eq("action", "catalog_sync_requested");
    expect(audit?.length).toBe(1);
    expect(audit?.[0]?.actor_user_id).toBe(ctx.staffId);

    const claim = await rpc(admin, "catalog_sync_claim", { p_run: null, p_lease_seconds: 170 });
    expect((claim.data as unknown[]).length).toBe(1);
    const claim2 = await rpc(admin, "catalog_sync_claim", { p_run: null, p_lease_seconds: 170 });
    expect((claim2.data as unknown[]).length).toBe(0);

    const stores = await rpc(admin, "catalog_sync_upsert_stores", {
      p_stores: [
        { key: STORE, name: "Otro nombre", logo_url: "https://feed/logo1.png" },
        { key: STORE_NEW, name: "Tienda nueva", logo_url: "https://feed/logo2.png" },
      ],
    });
    expect(stores.error).toBeNull();
    expect(stores.data).toBe(1);
    const { data: st } = await admin.from("catalog_stores").select("key, name, logo_url").in("key", [STORE, STORE_NEW]).order("key");
    expect(st).toEqual([
      { key: STORE, name: "Tienda test", logo_url: "https://feed/logo1.png" },
      { key: STORE_NEW, name: "Tienda nueva", logo_url: "https://feed/logo2.png" },
    ]);

    const up = await rpc(admin, "catalog_sync_upsert_products", {
      p_run: runId,
      p_store: STORE,
      p_full: true,
      p_rows: [row(`${STAMP}-1`), row(`${STAMP}-2`, { disponible: false, estado: "FALTANTE_EN_ULTIMA_CORRIDA" })],
    });
    expect(up.error).toBeNull();
    expect(up.data).toMatchObject({ nuevos: 2, actualizados: 0, faltantes: 1 });

    const fin = await rpc(admin, "catalog_sync_finish_store", { p_run: runId, p_store: STORE, p_full: true });
    expect(fin.error).toBeNull();
    expect(fin.data).toMatchObject({ marcados: 1, product_count: 3 });
    const { data: old } = await admin
      .from("catalog_products")
      .select("disponible, estado")
      .eq("store_key", STORE)
      .eq("ean", `${STAMP}-old`)
      .single();
    expect(old).toEqual({ disponible: false, estado: "FALTANTE_EN_FEED" });

    await admin
      .from("catalog_sync_runs")
      .update({ stores: { [STORE]: { label: "Tienda test", done: true, error: null } } })
      .eq("id", runId);
    const close = await rpc(admin, "catalog_sync_finalize", { p_run: runId });
    expect(close.error).toBeNull();
    expect(close.data).toMatchObject({ status: "ok", catalogos: 1 });
    const { data: cat } = await admin.from("catalogs").select("product_count").eq("id", ctx.catalog).single();
    expect(Number(cat?.product_count)).toBe(3);
  });

  it("lectura: sólo staff interno en el panel interno", async () => {
    const internal = await ctx.staffInternal.from("catalog_sync_runs").select("id").in("id", ctx.runs);
    expect(internal.error).toBeNull();
    expect(internal.data?.length).toBe(ctx.runs.length);

    const outOfScope = await ctx.staff.from("catalog_sync_runs").select("id").in("id", ctx.runs);
    expect(outOfScope.data ?? []).toEqual([]);

    const owner = await ctx.owner.from("catalog_sync_runs").select("id").in("id", ctx.runs);
    expect(owner.data ?? []).toEqual([]);
  });

  it("nadie escribe por REST, ni siquiera el staff interno", async () => {
    const ins = await ctx.staffInternal.from("catalog_sync_runs").insert({ trigger: "manual" }).select("id");
    expect(ins.error).not.toBeNull();
    const upd = await ctx.staffInternal.from("catalog_sync_runs").update({ status: "ok" }).in("id", ctx.runs).select("id");
    expect(upd.data ?? []).toEqual([]);
  });

  it("las RPC de la sync son sólo de service_role", async () => {
    for (const c of [ctx.staffInternal, ctx.owner]) {
      const enq = await rpc(c, "catalog_sync_enqueue", { p_trigger: "manual" });
      expect(enq.error).not.toBeNull();
      const up = await rpc(c, "catalog_sync_upsert_products", {
        p_run: ctx.runs[0],
        p_store: STORE,
        p_full: true,
        p_rows: [row(`${STAMP}-x`)],
      });
      expect(up.error).not.toBeNull();
    }
    const { data } = await ctx.admin.from("catalog_products").select("id").eq("ean", `${STAMP}-x`);
    expect(data ?? []).toEqual([]);
  });

  it("notify_catalog_update: un dueño de negocio no la puede llamar", async () => {
    const res = await rpc(ctx.owner, "notify_catalog_update", { p_catalog_id: ctx.catalog });
    expect(res.error).not.toBeNull();
  });
});
