import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  orderItemError,
  parsePriceMismatch,
  priceChangedMessage,
  priceDeviationPct,
  repriceChanges,
} from "@/lib/pos/priceMismatch";
import { DEFAULT_POLICY, normalizeSettings, pinRequired, supervisorRequiredAction } from "@/lib/security/pinPolicy";
import { currentSupervisorToken, withSupervisorToken } from "@/lib/security/supervisorToken";
import { currentPriceSource, withPriceSource } from "@/lib/prices/priceSource";
import { buildSaleItemsAndExtras } from "@/modules/pending-charges/logic";
import { cartToSaleLines } from "@/modules/pos/screen/usePosSale";
import { useCartStore, type CartLine } from "@/modules/pos/store";
import { useSupervisorPrompt, withSupervisor } from "@/modules/security/supervisor";
import { basePriceAt, basePriceSeries, type PriceHistoryRow } from "@/modules/products/priceHistory";

// Precio autoritativo del servidor e historial de precios (F18 · H100, ADR-056).

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const money = (n: number) => `$${n}`;

const mismatchError = (items: unknown[]) =>
  new Error(`price_mismatch:${JSON.stringify({ items })}`);

describe("price_mismatch del servidor", () => {
  it("lee el precio esperado de cada línea", () => {
    const e = mismatchError([
      { product_id: "p1", variant_id: null, expected: 1250, received: 1000 },
      { product_id: "p2", variant_id: "v2", expected: 99.5, received: 90 },
    ]);
    expect(parsePriceMismatch(e)).toEqual([
      { productId: "p1", variantId: null, expected: 1250, received: 1000 },
      { productId: "p2", variantId: "v2", expected: 99.5, received: 90 },
    ]);
    // Formato de PostgREST ({ message }) y errores ajenos.
    expect(parsePriceMismatch({ message: e.message })).toHaveLength(2);
    expect(parsePriceMismatch(new Error("insufficient_payment"))).toBeNull();
    expect(parsePriceMismatch(new Error("price_mismatch:no-json"))).toEqual([]);
  });

  it("reprecia sólo las líneas del producto y variante, sin tocar regalos, packs ni precios manuales", () => {
    const lines = [
      { lineId: "a", productId: "p1", name: "Yerba", unitPrice: 1000 },
      { lineId: "b", productId: "p1", name: "Yerba manual", unitPrice: 800, priceOverride: true },
      { lineId: "c", productId: "p1", name: "Yerba regalo", unitPrice: 0, giftPromoId: "promo" },
      { lineId: "d", productId: "p2", variantId: "v1", name: "Remera M", unitPrice: 90 },
      { lineId: "e", productId: "p2", variantId: "v2", name: "Remera L", unitPrice: 90 },
      { lineId: "f", productId: null, name: "Venta libre", unitPrice: 50 },
    ];
    const changes = repriceChanges(lines, [
      { productId: "p1", variantId: null, expected: 1250, received: 1000 },
      { productId: "p2", variantId: "v1", expected: 99.5, received: 90 },
    ]);
    expect(changes).toEqual([
      { lineId: "a", name: "Yerba", from: 1000, to: 1250 },
      { lineId: "d", name: "Remera M", from: 90, to: 99.5 },
    ]);
  });

  it("arma el aviso para la cajera", () => {
    expect(priceChangedMessage([{ lineId: "a", name: "Yerba", from: 1, to: 1250 }], money)).toBe(
      "El precio de Yerba cambió a $1250",
    );
    expect(priceChangedMessage([], money)).toMatch(/revisá el carrito/);
    expect(
      priceChangedMessage(
        [
          { lineId: "a", name: "A", from: 1, to: 2 },
          { lineId: "b", name: "B", from: 1, to: 2 },
        ],
        money,
      ),
    ).toBe("Cambiaron 2 precios: revisá el carrito antes de cobrar");
  });

  it("el desvío para el PIN redondea hacia arriba (cubre al del servidor)", () => {
    expect(priceDeviationPct(95, 80)).toBe(15.79);
    expect(priceDeviationPct(100, 110)).toBe(10);
    expect(priceDeviationPct(0, 10)).toBe(100);
  });

  it("errores de mesa y delivery con texto claro", () => {
    const r = orderItemError(mismatchError([{ product_id: "p1", expected: 300, received: 250 }]), "Café", money);
    expect(r).toMatchObject({ title: "El precio de Café cambió a $300", refresh: true });
    expect(orderItemError(new Error("free_sale_not_allowed"), "x", money).title).toMatch(/venta libre/i);
    expect(orderItemError(new Error("otro"), "x", money)).toMatchObject({ title: "No se pudo agregar", refresh: false });
  });
});

describe("carrito: cambio manual de precio", () => {
  beforeEach(() => useCartStore.getState().clear());

  it("marca la línea con el precio de lista y el motivo; volver al de lista la limpia", () => {
    const s = useCartStore.getState();
    s.addProduct({ id: "p1", name: "Yerba", sku: null, price: 1000 });
    const id = useCartStore.getState().lines[0]!.lineId;
    s.setLinePrice(id, 800, "  Producto con falla ");
    let l = useCartStore.getState().lines[0]!;
    expect(l).toMatchObject({ unitPrice: 800, priceOverride: true, overrideReason: "Producto con falla", listPrice: 1000 });
    s.setLinePrice(id, 1000, "");
    l = useCartStore.getState().lines[0]!;
    expect(l).toMatchObject({ unitPrice: 1000, priceOverride: false, overrideReason: null, listPrice: 1000 });
  });

  it("aplica los precios del servidor", () => {
    const s = useCartStore.getState();
    s.addProduct({ id: "p1", name: "Yerba", sku: null, price: 1000 });
    const id = useCartStore.getState().lines[0]!.lineId;
    s.applyServerPrices([{ lineId: id, to: 1250 }]);
    expect(useCartStore.getState().lines[0]).toMatchObject({ unitPrice: 1250, listPrice: 1250 });
  });

  it("create_sale recibe la marca, el motivo y el precio de lista; regalos y packs explican el $0", () => {
    const cart: CartLine[] = [
      {
        lineId: "1", productId: "p1", name: "Yerba", sku: null, unitPrice: 800, quantity: 1, discount: 0, unit: "un",
        priceOverride: true, overrideReason: "Falla", listPrice: 1000,
      },
      { lineId: "2", productId: "p2", name: "Regalo", sku: null, unitPrice: 0, quantity: 1, discount: 0, unit: "un", giftPromoId: "promo1" },
      { lineId: "3", productId: "p3", name: "Corte", sku: null, unitPrice: 500, quantity: 1, discount: 0, unit: "un", packCreditId: "cr1" },
      { lineId: "4", productId: "p4", name: "Normal", sku: null, unitPrice: 10, quantity: 2, discount: 0, unit: "un" },
    ];
    const { items } = buildSaleItemsAndExtras(cartToSaleLines(cart), []);
    expect(items[0]).toEqual({
      product_id: "p1", quantity: 1, unit_price: 800, discount: 0,
      price_override: true, override_reason: "Falla", list_price: 1000,
    });
    expect(items[1]).toEqual({ product_id: "p2", quantity: 1, unit_price: 0, discount: 0, gift_promo_id: "promo1" });
    expect(items[2]).toEqual({ product_id: "p3", quantity: 1, unit_price: 0, discount: 0, pack_credit_id: "cr1" });
    expect(items[3]).toEqual({ product_id: "p4", quantity: 2, unit_price: 10, discount: 0 });
  });
});

describe("PIN de supervisor: cambio de precio", () => {
  it("encendido por defecto, en porcentaje sobre el umbral", () => {
    expect(pinRequired(DEFAULT_POLICY, "cambio_precio", 0.5)).toBe(true);
    expect(pinRequired(DEFAULT_POLICY, "cambio_precio", 0)).toBe(false);
    const p = normalizeSettings({ pin_policy: { ...DEFAULT_POLICY, cambio_precio: { enabled: true, threshold: 10 } } }).pin_policy;
    expect(pinRequired(p, "cambio_precio", 10)).toBe(false);
    expect(pinRequired(p, "cambio_precio", 10.5)).toBe(true);
    expect(supervisorRequiredAction(new Error("supervisor_required:cambio_precio"))).toBe("cambio_precio");
  });

  it("los tokens anidados se acumulan en el header", async () => {
    await withSupervisorToken("t1", async () => {
      expect(currentSupervisorToken()).toBe("t1");
      await withSupervisorToken("t2", async () => {
        expect(currentSupervisorToken()).toBe("t1,t2");
      });
      expect(currentSupervisorToken()).toBe("t1");
    });
    expect(currentSupervisorToken()).toBeNull();
  });

  it("withSupervisor pide una autorización por acción y reintenta con todas", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    const fn = async () => {
      calls++;
      seen.push(currentSupervisorToken());
      const tok = currentSupervisorToken() ?? "";
      if (!tok.includes("tok-precio")) throw new Error("supervisor_required:cambio_precio");
      if (!tok.includes("tok-desc")) throw new Error("supervisor_required:discount_over");
      return "ok";
    };
    // Simula el diálogo de PIN: resuelve con un token por acción.
    const unsub = useSupervisorPrompt.subscribe((st) => {
      const r = st.request;
      if (!r) return;
      queueMicrotask(() => r.resolve(r.action === "cambio_precio" ? "tok-precio" : "tok-desc"));
    });
    const res = await withSupervisor(fn, { cambio_precio: 12.5, discount_over: 8 });
    unsub();
    expect(res).toBe("ok");
    expect(calls).toBe(3);
    expect(seen).toEqual([null, "tok-precio", "tok-precio,tok-desc"]);
  });
});

describe("historial de precios", () => {
  const row = (at: string, price: number | null, extra: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
    id: at, product_id: "p1", variant_id: null, list_id: null, old_price: null, new_price: price,
    changed_by: null, source: "manual", at, changed_by_name: null, ...extra,
  });
  const rows = [
    row("2026-03-10T12:00:00Z", 130),
    row("2026-01-01T12:00:00Z", 100),
    row("2026-02-01T12:00:00Z", 999, { list_id: "l1", source: "list" }),
    row("2026-02-15T12:00:00Z", 120),
  ];

  it("serie del precio base en orden cronológico", () => {
    expect(basePriceSeries(rows).map((p) => p.price)).toEqual([100, 120, 130]);
  });

  it("¿cuánto valía el 3 de marzo?", () => {
    expect(basePriceAt(rows, new Date("2026-03-03T12:00:00Z"))).toBe(120);
    expect(basePriceAt(rows, new Date("2025-12-31T12:00:00Z"))).toBeNull();
  });

  it("el origen del import viaja como header", async () => {
    expect(currentPriceSource()).toBeNull();
    await withPriceSource("import", async () => expect(currentPriceSource()).toBe("import"));
    expect(currentPriceSource()).toBeNull();
  });
});

describe("migraciones de ADR-056", () => {
  const sql = read("supabase/migrations/20261019100000_precio_servidor.sql");
  const hist = read("supabase/migrations/20261019110000_historial_precios.sql");

  it("create_sale valida el precio salvo al acreditar un cobro en espera", () => {
    expect(sql).toMatch(/v_pc\s+boolean := coalesce\(current_setting\('ninja\.pc_complete', true\), ''\) <> ''/);
    expect(sql).toMatch(/if not v_pc then/);
    expect(sql).toMatch(/'price_mismatch:' \|\| jsonb_build_object\('items', v_mismatch\)/);
    expect(sql).toMatch(/abs\(v_up - v_exp\) <= 0\.01/);
    expect(sql).toMatch(/require_supervisor\('cambio_precio', v_max_dev, null\)/);
  });

  it("conserva sucursal del turno, configuración efectiva y stock por sucursal", () => {
    expect(sql).toMatch(/resolve_sale_shift\(p_cash_shift_id, true\)/);
    expect(sql).toMatch(/_effective_config\(v_tenant, 'pos_settings', '', v_store, v_reg\)/);
    expect(sql).toMatch(/insufficient_stock_branch/);
  });

  it("historial con RLS de negocio, feature y staff interno (ADR-052)", () => {
    expect(hist).toMatch(/enable row level security/);
    expect(hist).toMatch(/internal_scope\(\)/);
    expect(hist).not.toMatch(/is_internal\(\)/);
    expect(hist).toMatch(/'historial_precios'/);
  });

  it("sin rayas largas en los textos nuevos", () => {
    const EM_DASH = String.fromCharCode(0x2014);
    for (const f of [
      "supabase/migrations/20261019100000_precio_servidor.sql",
      "supabase/migrations/20261019110000_historial_precios.sql",
      "lib/pos/priceMismatch.ts",
      "components/products/PriceHistoryPanel.tsx",
      "modules/products/priceHistory.ts",
    ]) {
      expect(read(f).includes(EM_DASH), f).toBe(false);
    }
  });
});
