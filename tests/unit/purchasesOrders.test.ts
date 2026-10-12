import { describe, expect, it } from "vitest";
import {
  canOrderAction,
  discountFactor,
  formatDiscounts,
  formatOrderNumber,
  lineNet,
  nextOrderStatus,
  orderActions,
  orderShareText,
  orderTotals,
  parseDiscounts,
  pendingAfterReceipt,
  pendingQty,
  purchaseErrorMessage,
  receiptDifference,
  receivedPct,
  unitNet,
  validDiscounts,
} from "@/lib/purchases/orders";
import { suggestPurchaseQty } from "@/lib/purchases/suggest";

describe("máquina de estados de la OC", () => {
  const draft = { status: "draft" as const, units_received: 0 };
  const sent = { status: "sent" as const, units_received: 0 };
  const partial = { status: "partially_received" as const, units_received: 5 };
  const done = { status: "received" as const, units_received: 10 };
  const cancelled = { status: "cancelled" as const, units_received: 0 };

  it("borrador: editar, enviar y cancelar", () => {
    expect(orderActions(draft, "owner")).toEqual(["edit", "send", "cancel"]);
    expect(nextOrderStatus(draft, "send")).toBe("sent");
    expect(nextOrderStatus(draft, "cancel")).toBe("cancelled");
  });

  it("enviada: reabrir, recibir y cancelar si no llegó nada", () => {
    expect(orderActions(sent, "manager")).toEqual(["reopen", "receive", "cancel"]);
    expect(nextOrderStatus(sent, "receive", { pendingAfter: 3 })).toBe("partially_received");
    expect(nextOrderStatus(sent, "receive", { pendingAfter: 0 })).toBe("received");
    expect(nextOrderStatus(sent, "reopen")).toBe("draft");
  });

  it("recibida en parte: recibir el resto o cerrar con faltante; no se cancela", () => {
    expect(orderActions(partial, "owner")).toEqual(["receive", "close"]);
    expect(canOrderAction(partial, "cancel")).toBe(false);
    expect(nextOrderStatus(partial, "receive", { pendingAfter: 2, close: true })).toBe("received");
    expect(nextOrderStatus(partial, "close")).toBe("received");
  });

  it("estados finales sin acciones", () => {
    expect(orderActions(done, "owner")).toEqual([]);
    expect(orderActions(cancelled, "owner")).toEqual([]);
    expect(nextOrderStatus(done, "receive")).toBeNull();
  });

  it("el cajero sólo recibe y si el negocio lo permite", () => {
    expect(orderActions(sent, "cashier")).toEqual(["receive"]);
    expect(orderActions(sent, "cashier", false)).toEqual([]);
    expect(orderActions(draft, "cashier")).toEqual([]);
    expect(orderActions(sent, "viewer")).toEqual([]);
  });
});

describe("descuentos en cascada y totales", () => {
  it("parsea y formatea descuentos", () => {
    expect(parseDiscounts("10 + 5,5")).toEqual([10, 5.5]);
    expect(parseDiscounts("0+abc")).toEqual([]);
    expect(formatDiscounts([10, 5.5])).toBe("10 + 5,5");
    expect(validDiscounts([10, 99.9])).toBe(true);
    expect(validDiscounts([100])).toBe(false);
  });

  it("10 + 5 no es 15", () => {
    expect(discountFactor([10, 5])).toBeCloseTo(0.855, 10);
    expect(lineNet(10, 100, [10, 5])).toBe(855);
    expect(unitNet(100, [10, 5], 10)).toBe(76.95);
  });

  it("totales con descuento global e IVA por alícuota", () => {
    const t = orderTotals(
      [
        { qty: 10, unit_cost: 100, discounts: [10], tax_rate: 21 },
        { qty: 2, unit_cost: 50, tax_rate: 10.5 },
      ],
      10,
    );
    expect(t.subtotal).toBe(1000);
    expect(t.discount_total).toBe(100);
    expect(t.net_total).toBe(900);
    // 900 × 0,9 × 21 % = 170,10 ; 100 × 0,9 × 10,5 % = 9,45
    expect(t.tax_total).toBe(179.55);
    expect(t.total).toBe(1079.55);
    expect(t.units).toBe(12);
  });
});

describe("recepción", () => {
  it("pendiente por línea y total después de recibir", () => {
    expect(pendingQty({ qty_ordered: 10, qty_received: 4 })).toBe(6);
    expect(pendingQty({ qty_ordered: 10, qty_received: 12 })).toBe(0);
    const items = [
      { qty_ordered: 10, qty_received: 0 },
      { qty_ordered: 5, qty_received: 5 },
    ];
    expect(pendingAfterReceipt(items, [6, 0])).toBe(4);
    expect(pendingAfterReceipt(items, [12, 0])).toBe(0);
  });

  it("diferencia y % recibido", () => {
    expect(receiptDifference(10, 8)).toBe(-2);
    expect(receiptDifference(10, 11)).toBe(1);
    expect(receiptDifference(null, 3)).toBe(0);
    expect(receivedPct({ units_ordered: 8, units_received: 2 })).toBe(25);
    expect(receivedPct({ units_ordered: 0, units_received: 0 })).toBe(0);
  });
});

describe("sugerencia de compra por sucursal", () => {
  it("lleva al máximo contando lo que viene en camino y lo pedido", () => {
    expect(suggestPurchaseQty({ qty: 1, min_qty: 10, max_qty: 30, in_transit_in: 3, on_order: 5 })).toBe(21);
  });

  it("sin máximo lleva al mínimo; arriba del mínimo no sugiere", () => {
    expect(suggestPurchaseQty({ qty: 4, min_qty: 10, max_qty: null })).toBe(6);
    expect(suggestPurchaseQty({ qty: 10, min_qty: 10, max_qty: 30 })).toBe(0);
    expect(suggestPurchaseQty({ qty: 0, min_qty: 0, max_qty: 30 })).toBe(0);
  });

  it("redondea a la unidad de compra y respeta el mínimo del proveedor", () => {
    expect(suggestPurchaseQty({ qty: 0, min_qty: 5, max_qty: 13, units_per_purchase: 6 })).toBe(18);
    expect(suggestPurchaseQty({ qty: 9, min_qty: 10, max_qty: null, min_order_qty: 24, units_per_purchase: 12 })).toBe(24);
  });
});

describe("numeración, texto para compartir y errores", () => {
  it("formatea el número de OC", () => {
    expect(formatOrderNumber(42)).toBe("OC-000042");
  });

  it("arma el texto del pedido", () => {
    const txt = orderShareText({
      number: 7,
      businessName: "Kiosco Ninja",
      supplierName: "Distribuidora Sur",
      storeName: "Centro",
      expected_date: "2026-10-20",
      currency: "ARS",
      notes: "Entregar por la tarde",
      items: [
        { product_name: "Gaseosa", variant_label: "Lima", supplier_sku: "GL-1", sku: "123", qty_ordered: 24, unit: "un" },
        { product_name: "Harina", variant_label: null, supplier_sku: null, sku: null, qty_ordered: 2.5, unit: "kg" },
      ],
    });
    expect(txt).toContain("OC-000007");
    expect(txt).toContain("Fecha esperada: 20/10/2026");
    expect(txt).toContain("• 24 un Gaseosa (Lima) [GL-1]");
    expect(txt).toContain("• 2,5 kg Harina");
    expect(txt).not.toContain("—");
  });

  it("traduce errores del servidor", () => {
    expect(purchaseErrorMessage(new Error("feature_not_in_plan: compras"))).toMatch(/Compras no está incluido/);
    expect(purchaseErrorMessage({ message: "feature_not_in_plan: compras_importacion" })).toMatch(/importación/);
    expect(purchaseErrorMessage(new Error("algo raro"))).toBe("algo raro");
  });
});
