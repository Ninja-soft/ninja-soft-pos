// @vitest-environment node
// =============================================================================
// ADR-109: catálogo maestro por EAN (catalog_items) + ofertas por tienda y
// vendedor (catalog_offers).
//
// Entitlement: un negocio ve un producto si tiene una publicación de tienda en
// alguna tienda de un catálogo activo que compró o recibió; ve las ofertas
// (de todos los vendedores) sólo de esas tiendas. Otro negocio sin catálogo no
// ve nada (ni ficha, ni referencia, ni comparación) y no puede importar. Staff
// interno: sólo en el panel interno (x-ninja-scope). Nadie escribe por REST.
// Import: ficha del maestro, precio de venta 0, atributos con medidas
// primero, fotos a la galería y medidas a bultos.
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

const STAMP = `cmae${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const S1 = `${STAMP.toUpperCase()}_S1`;
const S2 = `${STAMP.toUpperCase()}_S2`;
const S3 = `${STAMP.toUpperCase()}_S3`; // fuera de todo catálogo: sólo comparación
const BASE = `78${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
function ean13(n: number): string {
  const body = `${BASE}${String(n).padStart(4, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
  return body + ((10 - (sum % 10)) % 10);
}
const ACEITE = ean13(1);
const SOLO_S3 = ean13(2);

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: SupabaseClient;
  ownerB: SupabaseClient;
  staff: SupabaseClient;
  staffInternal: SupabaseClient;
  userIds: string[];
  catalog: string;
  offerS1: number;
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
    const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
    if (tuErr) throw tuErr;
  }
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false }, ...(headers ? { global: { headers } } : {}) });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

describe.skipIf(!enabled)("ADR-109 · catálogo maestro y ofertas", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin
      .from("tenants")
      .insert([
        { name: `Maestro A ${STAMP}`, slug: `a-${STAMP}`, status: "active" },
        { name: `Maestro B ${STAMP}`, slug: `b-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (t.error || !t.data) throw t.error ?? new Error("tenants");
    ctx.tenantA = t.data.find((x) => x.slug === `a-${STAMP}`)!.id;
    ctx.tenantB = t.data.find((x) => x.slug === `b-${STAMP}`)!.id;
    const a = await makeUser(admin, `oa-${STAMP}@test.local`, ctx.tenantA, "owner");
    const b = await makeUser(admin, `ob-${STAMP}@test.local`, ctx.tenantB, "owner");
    const st = await makeUser(admin, `st-${STAMP}@test.local`, null, null, { is_internal: true, internal_level: "admin" });
    const si = await makeUser(admin, `si-${STAMP}@test.local`, null, null, { is_internal: true, internal_level: "admin" }, { "x-ninja-scope": "internal" });
    Object.assign(ctx, { ownerA: a.client, ownerB: b.client, staff: st.client, staffInternal: si.client });
    ctx.userIds.push(a.id, b.id, st.id, si.id);

    const stores = await admin.from("catalog_stores").insert([
      { key: S1, name: "Uno" },
      { key: S2, name: "Dos" },
      { key: S3, name: "Tres" },
    ] as never);
    if (stores.error) throw stores.error;
    const cat = await admin.from("catalogs").insert({ key: `${STAMP}-super`, name: "Super", dedupe_by_ean: true, is_active: true } as never).select("id").single();
    if (cat.error || !cat.data) throw cat.error ?? new Error("catalog");
    ctx.catalog = (cat.data as { id: string }).id;
    await admin.from("catalog_store_map").insert([
      { catalog_id: ctx.catalog, store_key: S1 },
      { catalog_id: ctx.catalog, store_key: S2 },
    ] as never);
    await admin.from("tenant_catalog_purchases").insert({ tenant_id: ctx.tenantA, catalog_id: ctx.catalog, source: "granted" } as never);

    const load = async (store: string, rows: Record<string, unknown>[]) => {
      const r = await rpc(admin, "catalog_sync_upsert_products", { p_run: null, p_store: store, p_full: false, p_rows: rows });
      if (r.error) throw new Error(r.error.message);
    };
    await load(S1, [{ ean: ACEITE, titulo: `Aceite ${STAMP} 900 ml`, precio: 2000, disponible: true, estado: "ACTIVO", foto_url: "https://example.test/a.webp" }]);
    await load(S2, [{ ean: ACEITE, titulo: `Aceite ${STAMP} (dos)`, precio: 1800, disponible: true, estado: "ACTIVO" }]);
    await load(S3, [
      { ean: ACEITE, titulo: `Aceite ${STAMP} (tres)`, precio: 1000, disponible: true, estado: "ACTIVO" },
      { ean: SOLO_S3, titulo: `Sólo en S3 ${STAMP}`, precio: 10, disponible: true, estado: "ACTIVO" },
    ]);
    // Otro vendedor en S1 (lo trae el feed maestro; acá directo con service_role).
    const { data: item } = await admin.from("catalog_items").select("id").eq("ean", ACEITE).eq("store_scope", "").single();
    const itemId = (item as { id: number }).id;
    await admin.from("catalog_offers").insert({ item_id: itemId, store_key: S1, vendedor_key: "55", vendedor: "Electro Sur", ean_origen: ACEITE, precio: 1500, disponible: true } as never);
    await admin
      .from("catalog_items")
      .update({
        medidas: { contenido: { valor: 900, unidad: "ml" }, peso_kg: 0.92, alto_cm: 25, ancho_cm: 7.5, profundidad_cm: 7.5 },
        atributos: [{ key: "Origen", value: "Argentina" }],
        fotos: ["https://example.test/a.webp", "https://example.test/b.webp"],
        descripcion: "Aceite de girasol refinado, ideal para cocinar.",
      } as never)
      .eq("id", itemId);
    const { data: off } = await admin.from("catalog_offers").select("id").eq("item_id", itemId).eq("store_key", S1).eq("vendedor_key", "").single();
    ctx.offerS1 = Number((off as { id: number }).id);
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenantA) return;
    await admin.from("tenant_catalog_purchases").delete().in("tenant_id", [ctx.tenantA, ctx.tenantB]);
    await admin.from("catalogs").delete().like("key", `${STAMP}-%`);
    await admin.from("catalog_stores").delete().in("key", [S1, S2, S3]);
    await admin.from("catalog_items").delete().like("ean", `${BASE}%`);
    for (const id of [ctx.tenantA, ctx.tenantB]) await admin.from("tenants").delete().eq("id", id);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("otro negocio sin catálogo no ve nada ni importa", async () => {
    const b = ctx.ownerB;
    expect((await b.from("catalog_items").select("id").like("ean", `${BASE}%`)).data ?? []).toEqual([]);
    expect((await b.from("catalog_offers").select("id").in("store_key", [S1, S2, S3])).data ?? []).toEqual([]);
    expect((await rpc(b, "catalog_price_reference", { p_eans: [ACEITE] })).data).toEqual([]);
    expect((await rpc(b, "catalog_price_compare", { p_ean: ACEITE })).data).toEqual([]);
    const imp = await rpc(b, "import_catalog_product", { p_catalog_id: ctx.catalog, p_catalog_product_id: ctx.offerS1 });
    expect(imp.error?.message).toMatch(/catalog_not_owned/);
  });

  it("el negocio con catálogo ve los productos y ofertas de sus tiendas (todos los vendedores)", async () => {
    const a = ctx.ownerA;
    const items = (await a.from("catalog_items").select("ean").like("ean", `${BASE}%`)).data ?? [];
    expect(items.map((i) => (i as { ean: string }).ean)).toEqual([ACEITE]);
    const stores = new Set(((await a.from("catalog_offers").select("store_key").in("store_key", [S1, S2, S3])).data ?? []).map((o) => (o as { store_key: string }).store_key));
    expect([...stores].sort()).toEqual([S1, S2]);
    const cmp = (await rpc(a, "catalog_price_compare", { p_ean: ACEITE })).data as { store_key: string; vendedor: string; precio: number }[];
    expect(cmp.map((o) => [o.store_key, o.vendedor, Number(o.precio)])).toEqual([
      [S1, "Electro Sur", 1500],
      [S2, "Dos", 1800],
      [S1, "Uno", 2000],
    ]);
    const ref = ((await rpc(a, "catalog_price_reference", { p_eans: [ACEITE] })).data as Record<string, unknown>[])[0]!;
    expect(Number(ref.reference_price)).toBe(1900); // mediana de las tiendas (S1 2000, S2 1800)
    expect(ref.store_count).toBe(2);
    expect(Number(ref.min_price)).toBe(1500);
    expect(ref.min_seller).toBe("Electro Sur");
    expect(ref.seller_count).toBe(3);
    // ADR-118: catalog_product_count devuelve el conteo guardado (lo deja el recuento por lotes).
    await rpc(ctx.admin, "catalog_recount_step", { p_catalog_id: ctx.catalog, p_restart: true, p_limit: 500000 });
    const count = await rpc(a, "catalog_product_count", { p_catalog_id: ctx.catalog });
    expect(Number(count.data)).toBe(1);
  });

  it("nadie escribe el catálogo por REST", async () => {
    const ins = await ctx.staffInternal.from("catalog_items").insert({ ean: "1", titulo: "x" } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.ownerA.from("catalog_offers").update({ precio: 1 } as never).eq("id", ctx.offerS1).select("id");
    expect(upd.data ?? []).toEqual([]);
    const frozen = await ctx.admin.from("catalog_products").insert({ store_key: S1, ean: "1", titulo: "x" } as never);
    expect(frozen.error?.message).toMatch(/catalog_products_frozen/);
  });

  it("staff interno: todo sólo dentro del panel interno; stats de deduplicación", async () => {
    expect((await ctx.staff.from("catalog_items").select("id").like("ean", `${BASE}%`)).data ?? []).toEqual([]);
    expect((await rpc(ctx.staff, "catalog_dedupe_stats")).error?.message).toMatch(/forbidden/);
    const all = (await ctx.staffInternal.from("catalog_items").select("ean").like("ean", `${BASE}%`)).data ?? [];
    expect(all).toHaveLength(2);
    const cmp = (await rpc(ctx.staffInternal, "catalog_price_compare", { p_ean: ACEITE })).data as { store_key: string }[];
    expect(cmp[0]!.store_key).toBe(S3); // la más barata está fuera de los catálogos
    const stats = (await rpc(ctx.staffInternal, "catalog_dedupe_stats")).data as { items: number; tiendas: { key: string; en_catalogo: boolean }[] };
    expect(stats.items).toBeGreaterThanOrEqual(2);
    expect(stats.tiendas.find((t) => t.key === S3)?.en_catalogo).toBe(false);
  });

  it("import: ficha del maestro, precio 0, medidas primero, fotos y bultos", async () => {
    const imp = await rpc(ctx.ownerA, "import_catalog_product", { p_catalog_id: ctx.catalog, p_catalog_product_id: ctx.offerS1 });
    expect(imp.error).toBeNull();
    const productId = (imp.data as { product_id: string }).product_id;
    const { data: p } = await ctx.admin.from("products").select("price, barcode, description, attributes, metadata").eq("id", productId).single();
    const prod = p as { price: number; barcode: string; description: string; attributes: { key: string; value: string }[]; metadata: Record<string, unknown> };
    expect(Number(prod.price)).toBe(0);
    expect(prod.barcode).toBe(ACEITE);
    expect(prod.description).toMatch(/refinado/);
    expect(prod.attributes.map((x) => x.key)).toEqual(["Contenido", "Peso", "Alto", "Ancho", "Profundidad", "Origen"]);
    expect(prod.metadata.catalog_precio_lista).toBeUndefined();
    const { data: imgs } = await ctx.admin.from("product_images").select("url, is_primary").eq("product_id", productId).order("sort");
    expect((imgs ?? []).map((i) => (i as { url: string }).url)).toEqual(["https://example.test/a.webp", "https://example.test/b.webp"]);
    const { data: pk } = await ctx.admin.from("product_packages").select("height_cm, weight_kg").eq("product_id", productId);
    expect((pk ?? []).map((x) => [Number((x as { height_cm: number }).height_cm), Number((x as { weight_kg: number }).weight_kg)])).toEqual([[25, 0.92]]);
    const again = await rpc(ctx.ownerA, "add_catalog_product_to_tenant", { p_catalog_id: ctx.catalog, p_catalog_product_id: ctx.offerS1 });
    expect(again.data).toBe(productId);
    await ctx.admin.from("product_packages").delete().eq("product_id", productId);
    await ctx.admin.from("product_images").delete().eq("product_id", productId);
    await ctx.admin.from("products").delete().eq("id", productId);
  });
});
