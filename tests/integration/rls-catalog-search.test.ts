// @vitest-environment node
// =============================================================================
// ADR-093 (F4): catalog_search con el índice trigram. Desde ADR-109 lee el
// producto maestro (catalog_items, trigram en titulo) y las publicaciones de
// tienda (catalog_offers); los datos se cargan con la RPC de service_role
// catalog_sync_upsert_products (catalog_products quedó congelada).
//
// La RPC valida lo mismo que la policy catalog_products_read: el negocio actual
// compró o recibió el catálogo y está activo, o es staff interno en el panel
// interno (header x-ninja-scope, ADR-052). Cualquier miembro del negocio
// (también el cajero) puede buscar; otro negocio, un catálogo inactivo o un
// interno fuera del panel interno, no. Límite 1 a 100 y paginación estable.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// Inserts multi-fila con todas las claves en cada fila.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f4cat${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const S1 = `${STAMP.toUpperCase()}_S1`;
const S2 = `${STAMP.toUpperCase()}_S2`;
const S3 = `${STAMP.toUpperCase()}_S3`;
// EAN-13 válidos y únicos por corrida (los inválidos quedan por tienda y no se
// deduplicarían entre S1 y S2).
const BASE = `77${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
function ean13(n: number): string {
  const body = `${BASE}${String(n).padStart(4, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
  return body + ((10 - (sum % 10)) % 10);
}
const E1 = ean13(1);
const E2 = ean13(2);
const E3 = ean13(3);

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  cashier: SupabaseClient;
  ownerB: SupabaseClient;
  staff: SupabaseClient;
  staffInternal: SupabaseClient;
  userIds: string[];
  super_: string;
  ferre: string;
  viejo: string;
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

type Row = { catalog_product_id: number; ean: string; titulo: string; store_key: string; disponible: boolean };
type RpcRes = { data: unknown; error: { message: string } | null };
const search = (c: SupabaseClient, catalog: string, query: string, limit = 30, offset = 0) =>
  c.rpc("catalog_search" as never, {
    p_catalog_id: catalog,
    p_query: query,
    p_limit: limit,
    p_offset: offset,
  } as never) as unknown as Promise<RpcRes>;
const rows = (r: RpcRes) => (r.data ?? []) as Row[];

describe.skipIf(!enabled)("ADR-093 · catalog_search con índice trigram y permisos de la policy", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `F4CAT ${STAMP}`, slug: `a-${STAMP}`, status: "active" },
        { name: `F4CATB ${STAMP}`, slug: `b-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `a-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `b-${STAMP}`)!.id;

    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    const staff = await makeUser(admin, `staff-${STAMP}@test.local`, null, null, {
      is_internal: true,
      internal_level: "admin",
    });
    const staffInternal = await makeUser(
      admin,
      `staffi-${STAMP}@test.local`,
      null,
      null,
      { is_internal: true, internal_level: "admin" },
      { "x-ninja-scope": "internal" },
    );
    ctx.cashier = cashier.client;
    ctx.ownerB = ownerB.client;
    ctx.staff = staff.client;
    ctx.staffInternal = staffInternal.client;
    ctx.userIds.push(cashier.id, ownerB.id, staff.id, staffInternal.id);

    const stores = await admin.from("catalog_stores").insert([
      { key: S1, name: "Uno" },
      { key: S2, name: "Dos" },
      { key: S3, name: "Tres" },
    ] as never);
    if (stores.error) throw stores.error;

    const cats = await admin
      .from("catalogs")
      .insert([
        { key: `${STAMP}-super`, name: "Super", dedupe_by_ean: true, is_active: true },
        { key: `${STAMP}-ferre`, name: "Ferre", dedupe_by_ean: false, is_active: true },
        { key: `${STAMP}-viejo`, name: "Viejo", dedupe_by_ean: false, is_active: false },
      ] as never)
      .select("id, key");
    if (cats.error || !cats.data) throw cats.error ?? new Error("catalogs");
    const byKey = (k: string) => (cats.data as unknown as { id: string; key: string }[]).find((c) => c.key === `${STAMP}-${k}`)!.id;
    ctx.super_ = byKey("super");
    ctx.ferre = byKey("ferre");
    ctx.viejo = byKey("viejo");

    const map = await admin.from("catalog_store_map").insert([
      { catalog_id: ctx.super_, store_key: S1 },
      { catalog_id: ctx.super_, store_key: S2 },
      { catalog_id: ctx.ferre, store_key: S3 },
      { catalog_id: ctx.viejo, store_key: S3 },
    ] as never);
    if (map.error) throw map.error;

    // Super: la misma leche (mismo EAN) en las dos tiendas, más relleno.
    const products: Record<string, unknown>[] = [
      { store_key: S1, ean: E1, titulo: `Leche entera ${STAMP}`, precio: 100, disponible: true },
      { store_key: S2, ean: E1, titulo: `Leche entera ${STAMP} (dos)`, precio: 110, disponible: true },
      { store_key: S1, ean: E2, titulo: `Leche descremada ${STAMP}`, precio: 95, disponible: false },
      { store_key: S3, ean: E3, titulo: `Tornillo ${STAMP} 6mm`, precio: 5, disponible: true },
    ];
    for (let i = 0; i < 45; i++)
      products.push({
        store_key: S3,
        ean: ean13(100 + i),
        titulo: `Clavo ${STAMP} ${String(i).padStart(2, "0")}`,
        precio: 1,
        disponible: true,
      });
    for (const store of [S1, S2, S3]) {
      const up = await admin.rpc("catalog_sync_upsert_products" as never, {
        p_run: null,
        p_store: store,
        p_full: false,
        p_rows: products.filter((x) => x.store_key === store),
      } as never);
      if (up.error) throw up.error;
    }

    const tcp = await admin.from("tenant_catalog_purchases").insert([
      { tenant_id: ctx.tenant, catalog_id: ctx.super_, source: "granted" },
      { tenant_id: ctx.tenant, catalog_id: ctx.ferre, source: "granted" },
      { tenant_id: ctx.tenant, catalog_id: ctx.viejo, source: "granted" },
    ] as never);
    if (tcp.error) throw tcp.error;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("tenant_catalog_purchases").delete().in("tenant_id", [ctx.tenant, ctx.tenantB]);
    await admin.from("catalogs").delete().like("key", `${STAMP}-%`);
    await admin.from("catalog_stores").delete().in("key", [S1, S2, S3]);
    await admin.from("catalog_items").delete().like("ean", `${BASE}%`);
    for (const t of [ctx.tenant, ctx.tenantB]) await admin.from("tenants").delete().eq("id", t);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el cajero del negocio que compró el catálogo busca por título y por EAN", async () => {
    const r = await search(ctx.cashier, ctx.super_, `leche entera ${STAMP}`);
    expect(r.error).toBeNull();
    // dedupe_by_ean: una fila por EAN.
    expect(rows(r).map((x) => x.ean)).toEqual([E1]);

    const all = await search(ctx.cashier, ctx.super_, STAMP);
    expect(all.error).toBeNull();
    // Disponibles primero; el Tornillo es de otra tienda (otro catálogo).
    expect(rows(all).map((x) => x.ean)).toEqual([E1, E2]);

    const ean = await search(ctx.cashier, ctx.ferre, E3);
    expect(ean.error).toBeNull();
    expect(rows(ean).map((x) => x.titulo)).toEqual([`Tornillo ${STAMP} 6mm`]);

    // Comodines del usuario se buscan literales.
    const pct = await search(ctx.cashier, ctx.super_, "%");
    expect(pct.error).toBeNull();
    expect(rows(pct)).toEqual([]);
  });

  it("paginación con límite: páginas sin repetidos y tope de 100", async () => {
    const q = `clavo ${STAMP}`;
    const p1 = await search(ctx.cashier, ctx.ferre, q, 20, 0);
    const p2 = await search(ctx.cashier, ctx.ferre, q, 20, 20);
    const p3 = await search(ctx.cashier, ctx.ferre, q, 20, 40);
    for (const p of [p1, p2, p3]) expect(p.error).toBeNull();
    expect(rows(p1)).toHaveLength(20);
    expect(rows(p2)).toHaveLength(20);
    expect(rows(p3)).toHaveLength(5);
    const ids = [...rows(p1), ...rows(p2), ...rows(p3)].map((x) => x.catalog_product_id);
    expect(new Set(ids).size).toBe(45);
    expect(rows(p1)[0]!.titulo).toBe(`Clavo ${STAMP} 00`);

    const big = await search(ctx.cashier, ctx.ferre, q, 1000, 0);
    expect(big.error).toBeNull();
    expect(rows(big)).toHaveLength(45);
    const neg = await search(ctx.cashier, ctx.ferre, q, 0, -5);
    expect(neg.error).toBeNull();
    expect(rows(neg)).toHaveLength(1);
  });

  it("otro negocio, un catálogo inactivo o inexistente: forbidden", async () => {
    const b = await search(ctx.ownerB, ctx.super_, "leche");
    expect(b.error?.message).toMatch(/forbidden/);
    const inactive = await search(ctx.cashier, ctx.viejo, "clavo");
    expect(inactive.error?.message).toMatch(/forbidden/);
    const none = await search(ctx.cashier, "00000000-0000-0000-0000-000000000000", "x");
    expect(none.error?.message).toMatch(/forbidden/);
  });

  it("staff interno: sólo desde el panel interno (ADR-052), como la policy", async () => {
    const out = await search(ctx.staff, ctx.super_, `leche entera ${STAMP}`);
    expect(out.error?.message).toMatch(/forbidden/);
    const inside = await search(ctx.staffInternal, ctx.super_, `leche entera ${STAMP}`);
    expect(inside.error).toBeNull();
    expect(rows(inside)).toHaveLength(1);
  });

  it("anon no ejecuta la RPC y la tabla sigue cerrada por REST a otros negocios", async () => {
    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    const r = await search(anon, ctx.super_, "leche");
    expect(r.error).not.toBeNull();
    const { data } = await ctx.ownerB.from("catalog_offers").select("id").in("store_key", [S1, S2, S3]);
    expect(data ?? []).toEqual([]);
    const { data: items } = await ctx.ownerB.from("catalog_items").select("id").like("ean", `${BASE}%`);
    expect(items ?? []).toEqual([]);
  });
});
