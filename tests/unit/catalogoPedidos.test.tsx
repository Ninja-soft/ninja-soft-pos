// =============================================================================
// H10 · ADR-130: carrito y pedido del catálogo público.
// Lógica pura (precio de la lista, carrito con tope de disponible,
// conciliación, validación, payload sin precios, token, seguimiento), espejos
// contra el SQL de la migración, contratos de la migración (gating, grants,
// rate limit, honeypot, sin is_internal) y la vidriera (agregar y carrito).
// =============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_QTY,
  TOKEN_RE,
  addToCart,
  buildOrderPayload,
  cartKey,
  cartTotals,
  catalogOrderErrorMessage,
  catalogUnitPrice,
  enabledCatalogDeliveryTypes,
  errorNeedsRefresh,
  newTrackingToken,
  priceRange,
  productOrderable,
  qtyCap,
  readStoredCart,
  reconcileCart,
  setCartQty,
  stageIndex,
  trackingHeadline,
  trackingPath,
  trackingStage,
  validateCheckout,
  type CartItem,
  type Catalog,
  type CatalogOrdering,
  type CatalogProduct,
  type CheckoutForm,
} from "@/lib/catalog/publicOrder";
import { DEFAULT_ORDER_CONFIG, orderConfig } from "@/lib/orders/logic";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: vi.fn(async () => ({ data: { ok: true, number: 1 }, error: null })) }),
}));
import { CatalogStorefront } from "@/components/catalog/public/CatalogStorefront";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const MAIN = readFileSync(join(MIG_DIR, "20261125100100_catalogo_pedidos.sql"), "utf8");
const FEAT = readFileSync(join(MIG_DIR, "20261125100000_features_catalogo_pedidos.sql"), "utf8");
const CODE = MAIN.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end);
}

const P = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "33333333-3333-4333-8333-333333333333";

const item = (over: Partial<CartItem> = {}): CartItem => ({
  productId: P,
  variantId: null,
  name: "Campera",
  variantLabel: null,
  unitPrice: 100,
  qty: 1,
  imageUrl: null,
  max: 5,
  unit: "un",
  ...over,
});

const ordering = (over: Partial<CatalogOrdering> = {}): CatalogOrdering => ({
  enabled: true,
  store: { id: "s1", name: "Centro", address: "Av. 1" },
  reservation_minutes: 30,
  retiro: { enabled: true, pickup_code: true, stores: [{ id: "s1", name: "Centro", address: "Av. 1" }] },
  envio: { enabled: true },
  pay_link: false,
  ...over,
});

const form = (over: Partial<CheckoutForm> = {}): CheckoutForm => ({
  deliveryType: "retiro",
  pickupStoreId: null,
  name: "Ana Pérez",
  phone: "11 4444-3333",
  email: "",
  address: "",
  notes: "",
  payment: "al_retirar",
  website: "",
  ...over,
});

describe("config del catálogo espejo de _catalog_order_config", () => {
  it("apagado por defecto, sucursal uuid y pago con link", () => {
    const body = fnBody(MAIN, "_catalog_order_config");
    expect(body).toMatch(/'enabled', _jbool\(c, 'enabled', false\)/);
    expect(body).toMatch(/'pay_link', _jbool\(c, 'pay_link', false\)/);
    expect(body).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    expect(DEFAULT_ORDER_CONFIG.catalog).toEqual({ enabled: false, store_id: null, pay_link: false });
    expect(orderConfig(null).catalog).toEqual(DEFAULT_ORDER_CONFIG.catalog);
    const c = orderConfig({ catalog: { enabled: true, store_id: V1, pay_link: true } }).catalog;
    expect(c).toEqual({ enabled: true, store_id: V1, pay_link: true });
    expect(orderConfig({ catalog: { enabled: "si", store_id: "x" } }).catalog).toEqual({ enabled: false, store_id: null, pay_link: false });
    // Guardar la config de pedidos no pierde la del catálogo.
    expect(orderConfig({ ...orderConfig({ catalog: { enabled: true } }), reservation_minutes: 45 }).catalog.enabled).toBe(true);
  });
});

describe("precio del catálogo espejo de _catalog_unit_price", () => {
  const list = { id: "l", adjustment_pct: 10 };
  const items = [
    { product_id: P, variant_id: V1, price: 199 },
    { product_id: "otro", variant_id: null, price: 5 },
  ];
  it("ítem de variante → ítem de producto → % sobre la base → base", () => {
    expect(catalogUnitPrice(null, items, P, V1, 200)).toBe(200);
    expect(catalogUnitPrice(list, items, P, V1, 200)).toBe(199);
    expect(catalogUnitPrice(list, items, P, V2, 200)).toBe(220);
    expect(catalogUnitPrice(list, items, "otro", null, 1)).toBe(5);
    expect(catalogUnitPrice({ id: "l", adjustment_pct: null }, [], P, null, 100)).toBe(100);
    expect(catalogUnitPrice({ id: "l", adjustment_pct: -15 }, [], P, null, 99.99)).toBe(84.99);
    const body = fnBody(MAIN, "_catalog_unit_price");
    const iVar = body.indexOf("pli.variant_id = p_variant");
    const iProd = body.indexOf("pli.variant_id is null");
    const iPct = body.indexOf("p_adj / 100");
    expect(iVar).toBeGreaterThan(0);
    expect(iProd).toBeGreaterThan(iVar);
    expect(iPct).toBeGreaterThan(iProd);
  });
});

describe("carrito", () => {
  it("suma, respeta el disponible y nunca más de 999", () => {
    let c = addToCart([], item({ qty: 2 }));
    c = addToCart(c, item({ qty: 9 }));
    expect(c).toHaveLength(1);
    expect(c[0]?.qty).toBe(5);
    expect(addToCart([], item({ max: null, qty: 5000 }))[0]?.qty).toBe(MAX_QTY);
    expect(addToCart([], item({ max: 0 }))).toHaveLength(0);
    const two = addToCart(c, item({ variantId: V1, variantLabel: "40", max: 1 }));
    expect(two).toHaveLength(2);
    expect(cartTotals(two)).toEqual({ units: 6, total: 600 });
    expect(setCartQty(two, cartKey(P, V1), 0)).toHaveLength(1);
    expect(setCartQty(two, cartKey(P, null), 3)[0]?.qty).toBe(3);
    expect(setCartQty(two, cartKey(P, null), 2.7)[0]?.qty).toBe(2);
  });

  it("tope y disponible", () => {
    expect(qtyCap(null)).toBe(MAX_QTY);
    expect(qtyCap(3.9)).toBe(3);
    expect(qtyCap(-2)).toBe(0);
    const simple: CatalogProduct = { id: P, name: "x", price: 10, image_url: null, category: null, available: 0 };
    expect(productOrderable(simple)).toBe(false);
    expect(productOrderable({ ...simple, available: null })).toBe(true);
    const withVariants: CatalogProduct = {
      ...simple,
      has_variants: true,
      variants: [
        { id: V1, label: "40", price: 200, available: 0 },
        { id: V2, label: "41", price: 220, available: 2 },
      ],
    };
    expect(productOrderable(withVariants)).toBe(true);
    expect(priceRange(withVariants)).toEqual({ min: 200, max: 220 });
    expect(productOrderable({ ...withVariants, variants: [] })).toBe(false);
  });

  it("lee el guardado tolerando basura y lo concilia con el catálogo de hoy", () => {
    const saved = readStoredCart([item({ qty: 4 }), { productId: 1 }, null, item({ productId: "gone" }), item({ variantId: V2, qty: 9 })]);
    expect(saved).toHaveLength(3);
    expect(readStoredCart("x")).toEqual([]);
    const products: CatalogProduct[] = [
      {
        id: P,
        name: "Campera",
        price: 120,
        image_url: null,
        category: null,
        available: 2,
        has_variants: false,
      },
    ];
    const { cart, changed } = reconcileCart(saved, products);
    expect(changed).toBe(true);
    // El que no existe y la variante de un producto sin variantes salen.
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ unitPrice: 120, qty: 2, max: 2 });
    const same = reconcileCart(cart, products);
    expect(same.changed).toBe(false);
    const noStock = reconcileCart(cart, [{ ...products[0]!, available: 0 }]);
    expect(noStock.cart).toHaveLength(0);
  });
});

describe("checkout", () => {
  it("validación igual que el servidor", () => {
    const o = ordering();
    expect(validateCheckout(form(), [item()], o)).toEqual({});
    expect(validateCheckout(form(), [], o).cart).toBeTruthy();
    expect(validateCheckout(form({ deliveryType: null }), [item()], o).deliveryType).toBeTruthy();
    expect(validateCheckout(form({ deliveryType: "envio" }), [item()], ordering({ envio: { enabled: false } })).deliveryType).toBeTruthy();
    expect(validateCheckout(form({ name: "A" }), [item()], o).name).toBeTruthy();
    expect(validateCheckout(form({ phone: "1234567" }), [item()], o).phone).toBeTruthy();
    expect(validateCheckout(form({ phone: "+54 9 11 4444-3333" }), [item()], o).phone).toBeUndefined();
    expect(validateCheckout(form({ phone: "<b>11444433</b>" }), [item()], o).phone).toBeTruthy();
    expect(validateCheckout(form({ email: "ana@" }), [item()], o).email).toBeTruthy();
    expect(validateCheckout(form({ deliveryType: "envio", address: "Av" }), [item()], o).address).toBeTruthy();
    expect(validateCheckout(form({ notes: "x".repeat(501) }), [item()], o).notes).toBeTruthy();
    const body = fnBody(MAIN, "public_catalog_order_create");
    expect(body).toMatch(/not between 8 and 15/);
    expect(body).toMatch(/char_length\(v_name\) < 2/);
    expect(body).toMatch(/v_type not in \('retiro', 'envio'\)/);
    expect(enabledCatalogDeliveryTypes(ordering({ retiro: { ...o.retiro, enabled: false } }))).toEqual(["envio"]);
    expect(enabledCatalogDeliveryTypes(null)).toEqual([]);
  });

  it("el payload lleva ids, cantidades y contacto; nunca precios", () => {
    const p = buildOrderPayload("id", "tok", form({ email: " Ana@Mail.com ", payment: "link" }), [item({ qty: 2 })], ordering());
    expect(p.items).toEqual([{ product_id: P, variant_id: null, qty: 2 }]);
    expect(JSON.stringify(p)).not.toMatch(/price|total/);
    expect(p.customer_email).toBe("ana@mail.com");
    expect(p.pickup_store_id).toBe("s1");
    expect(p.payment_preference).toBe("al_retirar"); // sin pay_link, siempre al retirar
    const e = buildOrderPayload("id", "tok", form({ deliveryType: "envio", address: " Calle 1 " }), [item()], ordering({ pay_link: true }));
    expect(e.pickup_store_id).toBeNull();
    expect(e.ship_address).toBe("Calle 1");
    expect(e.payment_preference).toBe("al_retirar");
  });

  it("token de seguimiento fuerte y con el formato que acepta el SQL", () => {
    const t = newTrackingToken();
    expect(t).toMatch(TOKEN_RE);
    expect(t.length).toBe(43);
    expect(newTrackingToken(new Uint8Array(32).fill(255))).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(MAIN).toContain("'^[A-Za-z0-9_-]{32,128}$'");
    expect(trackingPath("mi negocio", t)).toBe(`/c/mi%20negocio/pedido/${t}`);
  });

  it("errores del servidor en castellano y cuándo refrescar", () => {
    expect(catalogOrderErrorMessage(new Error("insufficient_available_stock: Campera (M)"))).toMatch(/Campera \(M\)/);
    expect(catalogOrderErrorMessage({ message: "rate_limited" })).toMatch(/Esperá/);
    expect(catalogOrderErrorMessage(new Error("catalog_orders_unavailable"))).toMatch(/no está tomando pedidos/);
    expect(catalogOrderErrorMessage(new Error("raro"))).toMatch(/No pudimos/);
    expect(errorNeedsRefresh(new Error("product_unavailable"))).toBe(true);
    expect(errorNeedsRefresh(new Error("rate_limited"))).toBe(false);
  });
});

describe("seguimiento", () => {
  const base = { delivery_type: "retiro" as const, payment_preference: "al_retirar" as const };
  it("etapa del cliente según pedido y expedición", () => {
    expect(trackingStage({ ...base, status: "abierto", dispatch: null })).toBe("recibido");
    expect(trackingStage({ ...base, status: "tomado", dispatch: null })).toBe("recibido");
    expect(trackingStage({ ...base, status: "cobrado", dispatch: null })).toBe("confirmado");
    const d = (status: "pendiente" | "armando" | "listo" | "en_transito" | "entregado" | "despachado" | "cancelado") => ({
      status, tracking: null, ready_at: null, sent_at: null, arrived_at: null, delivered_at: null,
    });
    expect(trackingStage({ ...base, status: "cobrado", dispatch: d("armando") })).toBe("preparando");
    expect(trackingStage({ ...base, status: "cobrado", dispatch: d("listo") })).toBe("listo");
    expect(trackingStage({ ...base, status: "cobrado", dispatch: d("en_transito") })).toBe("en_camino");
    expect(trackingStage({ ...base, status: "cobrado", dispatch: d("despachado") })).toBe("entregado");
    expect(trackingStage({ ...base, status: "anulado", dispatch: null })).toBe("cancelado");
    expect(stageIndex("en_camino")).toBe(3);
    expect(stageIndex("entregado")).toBe(4);
    expect(stageIndex("cancelado")).toBe(-1);
    expect(trackingHeadline({ ...base, status: "abierto", dispatch: null })).toMatch(/Pagás cuando lo retirás/);
    expect(trackingHeadline({ ...base, payment_preference: "link", status: "abierto", dispatch: null })).toMatch(/link de pago/);
  });
});

describe("migraciones (contratos)", () => {
  it("versión posterior a la última de main", () => {
    const names = readdirSync(MIG_DIR).filter((f) => f.includes("catalogo_pedidos")).sort();
    expect(names).toEqual(["20261125100000_features_catalogo_pedidos.sql", "20261125100100_catalogo_pedidos.sql"]);
    for (const n of names) expect(Number(n.slice(0, 14))).toBeGreaterThan(20261124100000);
  });

  it("feature OPTIONAL en Pro, Business y Enterprise con copy", () => {
    expect(FEAT).toMatch(/'catalogo_pedidos', 'Pedidos desde el catálogo'/);
    expect(FEAT).toMatch(/'catalogo', false, 101/);
    expect(FEAT).toMatch(/p\.key in \('pro', 'business', 'enterprise'\)/);
    expect(FEATURE_INFO.catalogo_pedidos?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.catalogo_pedidos?.requires).toEqual(["catalogo_publico", "pedidos_despacho"]);
  });

  it("gating real: plan, dueño y tipo de entrega en el servidor", () => {
    const g = fnBody(MAIN, "_catalog_ordering");
    for (const k of ["catalogo_publico", "catalogo_pedidos", "pedidos_despacho"]) {
      expect(g).toContain(`tenant_has_feature_for(p_tenant, '${k}')`);
    }
    expect(g).toMatch(/'enabled'\)::boolean/);
    expect(fnBody(MAIN, "public_catalog_order_create")).toMatch(/not _catalog_ordering\(v_tenant\)/);
    expect(MAIN).toMatch(/if _catalog_ordering\(v_t\.id\) then/);
  });

  it("precios, stock y sucursal del servidor; reusa H32 sin modelo nuevo", () => {
    const body = fnBody(MAIN, "public_catalog_order_create");
    expect(body).toMatch(/_catalog_unit_price\(v_list, v_adj/);
    expect(body).not.toMatch(/p_order ->> 'total'|unit_price'/);
    expect(body).toMatch(/insert into sale_orders/);
    expect(body).toMatch(/'catalogo_publico'/);
    expect(body).toMatch(/channel, customer_name/);
    expect(body).toMatch(/'pedido', left\(v_name/);
    expect(body).toMatch(/_order_delivery_check\(/);
    expect(body).toMatch(/insufficient_available_stock/);
    expect(body).toMatch(/hashtext\('stock_reservation:' \|\| v_store::text\)/);
    expect(MAIN).not.toMatch(/create table if not exists (catalog_orders|public_orders)/);
    expect(MAIN).not.toMatch(/function (public\.)?(create_sale|sale_order_take|sale_order_complete)\(/);
  });

  it("rate limit, honeypot, token con hash y avisos que nunca rompen el pedido", () => {
    const body = fnBody(MAIN, "public_catalog_order_create");
    expect(body).toMatch(/c_ip_max\s+constant int := 5/);
    expect(body).toMatch(/c_tenant_max\s+constant int := 60/);
    expect(body).toMatch(/raise exception 'rate_limited'/);
    expect(body).toMatch(/p_order ->> 'website'/);
    expect(body.indexOf("p_order ->> 'website'")).toBeLessThan(body.indexOf("from tenants"));
    expect(body).toMatch(/digest\(convert_to\(coalesce\(v_ip, 'sin-ip'\)/);
    expect(body).toMatch(/public_token_hash/);
    expect(body).toMatch(/raise warning 'catalog order notify/);
    expect(body).toMatch(/raise warning 'catalog order email/);
    expect(body).toMatch(/_catalog_html\(/);
    expect(body).toMatch(/'pedidos', 'info'/);
  });

  it("grants: sólo las dos RPC públicas para anon; tablas cerradas; sin is_internal", () => {
    expect(CODE).not.toMatch(/is_internal\(\)/);
    expect(CODE).not.toMatch(/create policy/i);
    const anonGrants = CODE.match(/grant execute on function [^;]* to anon[^;]*;/g) ?? [];
    expect(anonGrants.map((g) => g.match(/function (\w+)/)?.[1]).sort()).toEqual([
      "public_catalog",
      "public_catalog_order_create",
      "public_catalog_order_status",
    ]);
    expect(MAIN).toMatch(/alter table catalog_order_attempts enable row level security;/);
    expect(MAIN).toMatch(/revoke all on catalog_order_attempts from anon, authenticated;/);
    expect(MAIN).toMatch(/grant select \(source, customer_email, payment_preference\) on sale_orders to authenticated;/);
    expect(fnBody(MAIN, "_sale_order_json")).toMatch(/- 'public_token_hash'/);
    for (const h of ["_catalog_order_config", "_catalog_order_store", "_catalog_ordering", "_catalog_unit_price", "_catalog_link_ready", "_catalog_available"]) {
      expect(MAIN, h).toMatch(new RegExp(`revoke all on function ${h}\\([^)]*\\) from public, anon, authenticated;`));
    }
    expect(MAIN).toMatch(/'cobros','disputas','comercial','pedidos'/);
  });
});

describe("vidriera", () => {
  const catalog = (ord: CatalogOrdering | null): Catalog => ({
    tenant: { name: "Electro", slug: "electro" },
    branding: { logo_url: null, accent: "#ff0000", legal_name: null, trade_name: "Electro Fantasía", phone: null, address: null },
    ordering: ord,
    products: [
      { id: P, name: "Campera", price: 100, image_url: null, category: "Abrigo", available: 3, unit: "un", has_variants: false, variants: [] },
      { id: "p2", name: "Remera", price: 50, image_url: null, category: "Verano", available: 0, unit: "un", has_variants: false, variants: [] },
    ],
  });
  const palette = { accent: "#ff0000", accentInk: "#ffffff", accentText: "#cc0000" };

  it("sin pedidos es sólo vidriera", () => {
    render(<CatalogStorefront catalog={catalog(null)} title="Electro Fantasía" palette={palette} />);
    expect(screen.getByRole("heading", { name: "Electro Fantasía" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Agregar" })).toBeNull();
    expect(screen.getByText("Sin stock")).toBeTruthy();
  });

  it("con pedidos: agrega, muestra el carrito y no deja agregar lo que no tiene stock", () => {
    render(<CatalogStorefront catalog={catalog(ordering())} title="Electro Fantasía" palette={palette} />);
    const add = screen.getAllByRole("button", { name: "Agregar" });
    expect(add).toHaveLength(1);
    fireEvent.click(add[0]!);
    expect(screen.getByRole("group", { name: "Cantidad de Campera" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ver carrito \(1\)/ }));
    expect(screen.getByRole("dialog", { name: "Tu carrito" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    expect(screen.getByRole("dialog", { name: "Tus datos" })).toBeTruthy();
    expect(screen.getByLabelText("Teléfono o WhatsApp")).toBeTruthy();
    // Honeypot fuera de la vista.
    expect((screen.getByLabelText("Sitio web") as HTMLInputElement).tabIndex).toBe(-1);
  });

  it("copy sin raya larga", () => {
    for (const f of [
      "lib/catalog/publicOrder.ts",
      "components/catalog/public/CatalogStorefront.tsx",
      "components/catalog/public/CartSheet.tsx",
      "components/catalog/public/ProductSheet.tsx",
      "components/catalog/public/TrackingClient.tsx",
      "app/(public)/c/[slug]/pedido/[token]/page.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toContain("—");
    }
  });
});
