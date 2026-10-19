// API pública: producto completo con include e ids (ADR-168).
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MAX_LIMIT_WITH_INCLUDE, PRODUCT_INCLUDES, productsQuerySchema } from "@/lib/api-publica/schemas";
import { publicImageUrl, withImageUrls } from "@/lib/api-publica/productImages";
import { demoToken, handleDemo, type DemoRequest } from "@/lib/api/sandboxDemo";
import { DEMO_PRODUCTS, DEMO_VARIANTS } from "@/lib/api/sandboxDataset";
import { API_SCOPES } from "@/lib/api-publica/scopes";
import { MODELS } from "@/lib/api/spec";

const ROOT = path.resolve(__dirname, "..", "..");
const TOKEN = `nsat_${"a".repeat(64)}`;
const UUID_A = "11111111-1111-4111-8111-111111111111";
const ALL = demoToken(API_SCOPES);
const P1 = DEMO_PRODUCTS[0]!.id;
const REMERA = DEMO_PRODUCTS.find((p) => p.has_variants)!.id;

function demo(query: Record<string, string>): { status: number; body: Record<string, any> } {
  const r: DemoRequest = {
    method: "GET",
    path: "/products",
    query: new URLSearchParams(query),
    headers: new Headers({ authorization: `Bearer ${ALL}` }),
    body: "",
  };
  const res = handleDemo(r);
  return { status: res.status, body: res.body as Record<string, any> };
}

describe("validación de include e ids", () => {
  it("acepta los include conocidos, sin repetidos y con espacios", () => {
    const r = productsQuerySchema.safeParse({ include: " images,stock ,images" });
    expect(r.success && r.data.include).toEqual(["images", "stock"]);
  });

  it("rechaza un include desconocido", () => {
    expect(productsQuerySchema.safeParse({ include: "images,precio" }).success).toBe(false);
  });

  it(`con include, limit va hasta ${MAX_LIMIT_WITH_INCLUDE}; sin include, hasta 500`, () => {
    expect(productsQuerySchema.safeParse({ include: "images", limit: "101" }).success).toBe(false);
    expect(productsQuerySchema.safeParse({ include: "images", limit: "100" }).success).toBe(true);
    expect(productsQuerySchema.safeParse({ limit: "500" }).success).toBe(true);
  });

  it("ids: uuid separados por coma, hasta 100, en minúscula", () => {
    const r = productsQuerySchema.safeParse({ ids: `${UUID_A.toUpperCase()},${UUID_A}` });
    expect(r.success && r.data.ids).toEqual([UUID_A]);
    expect(productsQuerySchema.safeParse({ ids: "no-es-un-id" }).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`).join(",");
    expect(productsQuerySchema.safeParse({ ids: many }).success).toBe(false);
  });
});

describe("imágenes con URL pública", () => {
  it("completa la URL desde el path del bucket público y respeta la que ya viene", () => {
    expect(publicImageUrl("t/p/a b.webp", "https://x.supabase.co/")).toBe(
      "https://x.supabase.co/storage/v1/object/public/product-images/t/p/a%20b.webp",
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    const [row] = withImageUrls([
      { id: "p", images: [{ url: null, path: "t/p/1.webp" }, { url: "https://cdn.example/2.webp", path: "t/p/2.webp" }] },
    ]) as { images: { url: string }[] }[];
    expect(row!.images.map((i) => i.url)).toEqual([
      "https://x.supabase.co/storage/v1/object/public/product-images/t/p/1.webp",
      "https://cdn.example/2.webp",
    ]);
    expect(withImageUrls([{ id: "sin imagenes" }])).toEqual([{ id: "sin imagenes" }]);
  });
});

describe("ruta /api/v1/products con la base simulada", () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let reply: unknown;

  beforeEach(() => {
    calls.length = 0;
    reply = { status: 200, body: { data: [], next: null }, rate: { limit: 600, remaining: 599, reset: 30 } };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: reply, error: null };
        },
      }),
    }));
  });

  const get = async (qs: string) => {
    const { GET } = await import("@/app/api/v1/products/route");
    return GET(new Request(`https://x.test/api/v1/products${qs}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  };

  it("sin include ni ids no manda parámetros nuevos (clientes viejos y RPC de siempre)", async () => {
    expect((await get("?limit=10")).status).toBe(200);
    expect(calls[0]!.args).not.toHaveProperty("p_include");
    expect(calls[0]!.args).not.toHaveProperty("p_ids");
  });

  it("pasa include e ids a la RPC y completa las URLs de las imágenes", async () => {
    reply = {
      status: 200,
      body: { data: [{ id: UUID_A, images: [{ url: null, path: "t/p/1.webp" }] }], next: null },
      rate: { limit: 600, remaining: 9, reset: 5 },
    };
    const res = await get(`?ids=${UUID_A}&include=images,stock`);
    expect(res.status).toBe(200);
    expect(calls[0]!.args.p_include).toEqual(["images", "stock"]);
    expect(calls[0]!.args.p_ids).toEqual([UUID_A]);
    const body = (await res.json()) as { data: { images: { url: string }[] }[] };
    expect(body.data[0]!.images[0]!.url).toBe("https://example.supabase.co/storage/v1/object/public/product-images/t/p/1.webp");
  });

  it("include desconocido: 422 sin llamar a la base", async () => {
    const res = await get("?include=foo");
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe("sandbox público: producto completo", () => {
  it("sin include responde igual que antes", () => {
    const r = demo({ ids: P1 });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(Object.keys(DEMO_PRODUCTS[0]!).sort());
  });

  it("con include de todo trae exactamente los campos del modelo Product", () => {
    const r = demo({ ids: P1, include: PRODUCT_INCLUDES.join(",") });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(MODELS.Product.fields.map((f) => f.name).sort());
    expect(r.body.data[0].price_lists.length).toBeGreaterThan(0);
    expect(r.body.data[0].images[0].is_primary).toBe(true);
  });

  it("variantes con stock por sucursal sólo si también se pide stock", () => {
    const sin = demo({ ids: REMERA, include: "variants" }).body.data[0];
    expect(sin.variants).toHaveLength(DEMO_VARIANTS.length);
    expect(sin.variants[0]).not.toHaveProperty("stock_by_store");
    const con = demo({ ids: REMERA, include: "variants,stock" }).body.data[0];
    expect(con.variants[0].stock_by_store.length).toBeGreaterThan(0);
    const total = con.variants.reduce((s: number, v: { stock: number }) => s + v.stock, 0);
    expect(total).toBe(DEMO_PRODUCTS.find((p) => p.id === REMERA)!.stock);
  });

  it("include desconocido o limit alto con include: 422 como en la API real", () => {
    expect(demo({ include: "foo" }).status).toBe(422);
    expect(demo({ include: "images", limit: "200" }).status).toBe(422);
  });
});

describe("migración 20270107100000", () => {
  const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20270107100000_api_producto_completo.sql"), "utf8");

  it("las funciones internas no se exponen y la pública sólo a anon", () => {
    expect(sql).toMatch(/revoke all on function _api_product_full_json\(uuid, products, text\[\]\) from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on function _api_v1_products_list\([^)]*\)\s+from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function api_v1_products_list\([^)]*\) to anon/);
    expect(sql).not.toMatch(/is_internal\(\)/);
  });

  it("todo filtra por el negocio del token", () => {
    for (const t of ["product_images", "product_variants", "product_stock", "price_lists", "categories", "brands"]) {
      expect(sql, t).toMatch(new RegExp(`${t}[\\s\\S]{0,400}tenant_id = p_tenant`));
    }
  });

  it("los precios por lista salen del mismo motor que el POS", () => {
    expect(sql).toMatch(/_resolve_unit_price\(p_tenant, p\.id, null, 1, null, null, l\.id, now\(\), 'none', null\)/);
  });
});
