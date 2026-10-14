// ADR-122: presupuestos. Lógica pura (estados, número, totales, carrito ↔
// renglones, documento del motor, links) y modelos A4 y ticket.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { A4_MODELS } from "@/lib/invoices/models";
import { resolveInvoiceStyle } from "@/lib/invoices/style";
import { legalRequirements } from "@/lib/invoices/legal";
import {
  addDaysIso,
  cartToQuoteItems,
  daysBetween,
  effectiveQuoteStatus,
  lineSubtotal,
  publicQuoteUrl,
  quoteConvertible,
  quoteDetailLines,
  quoteEditable,
  quoteErrorMessage,
  quoteItemsToCart,
  quoteLegends,
  QUOTE_SIGNATURE,
  quoteNumberLabel,
  quoteShareText,
  quoteToInvoiceDoc,
  quoteTotals,
  whatsappPhone,
  whatsappUrl,
  type CartLineLike,
  type Quote,
  type QuoteItem,
} from "@/lib/quotes/logic";

const QUOTE: Quote = {
  id: "q1",
  pto_vta: 1,
  number: 12,
  version: 2,
  status: "sent",
  customer_id: "c1",
  customer_name: "Frigorífico Sur SA",
  customer_doc: "CUIT 30700000001",
  customer_email: "compras@sur.com",
  customer_phone: "341 15 555-1234",
  customer_address: "Ruta 9 km 285",
  customer_iva: "responsable_inscripto",
  issue_date: "2026-10-14",
  valid_until: "2026-10-29",
  terms: "50 % de anticipo y saldo contra entrega del informe.",
  notes: "Incluye traslado al laboratorio.",
  service_from: "2026-10-20",
  service_to: "2026-10-24",
  subtotal: 37000,
  discount_total: 1000,
  total: 36000,
  show_signature: true,
  public_token: null,
  sent_at: "2026-10-14T13:00:00Z",
  accepted_at: null,
  accepted_via: null,
  accepted_by_name: null,
  rejected_at: null,
  rejection_reason: null,
  converted_sale_id: null,
  converted_at: null,
  parent_quote_id: null,
  created_at: "2026-10-14T13:00:00Z",
  updated_at: "2026-10-14T13:00:00Z",
};

const ITEMS: QuoteItem[] = [
  {
    product_id: "p-srv",
    name: "Análisis microbiológico de agua",
    quantity: 2,
    unit_price: 15000,
    discount: 0,
    subtotal: 30000,
    is_service: true,
    unit_label: "analisis",
    service_type_name: "Análisis",
    line_detail: "Recuento de aerobios mesófilos\n- Coliformes totales",
    line_clarifications: ["Incluye toma de muestras"],
    line_note: "Muestras 45 y 46",
    clarification_ids: ["cl1"],
  },
  { product_id: "p-fr", name: "Frasco estéril", quantity: 3, unit_price: 700, discount: 100, subtotal: 2000, is_service: false },
  { product_id: null, name: "Viático", quantity: 1, unit_price: 5000, discount: 0, subtotal: 5000, is_service: false },
];

const STYLE = resolveInvoiceStyle({}, { accent: "#0F766E", logo_url: null }, { pro: true, unbranded: true });

describe("estados y número", () => {
  it("vencido = borrador o enviado con la validez pasada (mismo criterio que SQL)", () => {
    expect(effectiveQuoteStatus("sent", "2026-10-13", "2026-10-14")).toBe("expired");
    expect(effectiveQuoteStatus("draft", "2026-10-14", "2026-10-14")).toBe("draft");
    expect(effectiveQuoteStatus("accepted", "2020-01-01", "2026-10-14")).toBe("accepted");
    expect(effectiveQuoteStatus("converted", "2020-01-01", "2026-10-14")).toBe("converted");
  });
  it("editable mientras no esté aceptado ni convertido; convertible borrador, enviado o aceptado", () => {
    expect(quoteEditable("sent")).toBe(true);
    expect(quoteEditable("rejected")).toBe(true);
    expect(quoteEditable("accepted")).toBe(false);
    expect(quoteEditable("converted")).toBe(false);
    expect(quoteConvertible("accepted")).toBe(true);
    expect(quoteConvertible("expired")).toBe(false);
    expect(quoteConvertible("rejected")).toBe(false);
  });
  it("número con punto de venta", () => {
    expect(quoteNumberLabel(1, 12)).toBe("0001-00000012");
    expect(quoteNumberLabel(12345, 1)).toBe("12345-00000001");
  });
  it("fechas", () => {
    expect(addDaysIso("2026-10-14", 15)).toBe("2026-10-29");
    expect(daysBetween("2026-10-14", "2026-10-29")).toBe(15);
  });
});

describe("totales (mismo cálculo que quote_save)", () => {
  it("renglón y presupuesto", () => {
    expect(lineSubtotal({ quantity: 3, unit_price: 700, discount: 100 })).toBe(2000);
    const t = quoteTotals(ITEMS, 1000);
    expect(t).toEqual({ subtotal: 37000, discount: 1000, total: 36000 });
  });
  it("el descuento general nunca supera el subtotal ni es negativo", () => {
    expect(quoteTotals([{ quantity: 1, unit_price: 100 }], 500).total).toBe(0);
    expect(quoteTotals([{ quantity: 1, unit_price: 100 }], -5).discount).toBe(0);
  });
});

describe("carrito ↔ renglones", () => {
  const cart: CartLineLike[] = [
    { lineId: "a", productId: "p-srv", name: "Análisis", sku: null, unitPrice: 15000, quantity: 2, discount: 0, unit: "un", lineNote: " Muestras 45 ", clarificationIds: [] },
    { lineId: "b", productId: "p-x", name: "Regalo", sku: null, unitPrice: 0, quantity: 1, discount: 0, unit: "un", giftPromoId: "promo" },
    { lineId: "c", productId: "p-y", name: "Sesión", sku: null, unitPrice: 0, quantity: 1, discount: 0, unit: "un", packCreditId: "pc" },
    { lineId: "d", productId: null, name: "Monto libre", sku: null, unitPrice: 500, quantity: 1, discount: 50, unit: "un" },
  ];
  it("del carrito sale el payload de quote_save sin regalos ni sesiones de pack", () => {
    const items = cartToQuoteItems(cart);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ product_id: "p-srv", quantity: 2, unit_price: 15000, line_note: "Muestras 45", clarification_ids: [] });
    expect(items[0]).not.toHaveProperty("line_detail");
    expect(items[1]).toMatchObject({ name: "Monto libre", discount: 50 });
    expect(items[1]).not.toHaveProperty("product_id");
  });
  it("al convertir: precio acordado, cambio de precio con motivo si difiere de la lista", () => {
    const current = new Map([
      ["p-srv", { price: 16000, unit: "analisis", category_id: "cat", active: true }],
      ["p-fr", { price: 700, unit: "un", category_id: null, active: true }],
    ]);
    let n = 0;
    const lines = quoteItemsToCart(ITEMS, current, "Presupuesto N° 0001-00000012", () => `l${++n}`);
    expect(lines[0]).toMatchObject({
      productId: "p-srv",
      unitPrice: 15000,
      priceOverride: true,
      overrideReason: "Presupuesto N° 0001-00000012",
      listPrice: 16000,
      lineNote: "Muestras 45 y 46",
      clarificationIds: ["cl1"],
    });
    expect(lines[1]).toMatchObject({ productId: "p-fr", unitPrice: 700, discount: 100 });
    expect(lines[1]!.priceOverride).toBeUndefined();
    // Sin producto vigente: monto libre con su nombre.
    expect(lines[2]).toMatchObject({ productId: null, name: "Viático", unitPrice: 5000 });
  });
});

describe("documento del motor (ADR-112)", () => {
  const doc = quoteToInvoiceDoc(QUOTE, ITEMS, { legal_name: "Laboratorio A SRL", cuit: "30712345678", address: "Calle 1", phone: "341", iva_condition: "responsable_inscripto" });
  it("no fiscal: PRESUPUESTO, letra X y sin CAE", () => {
    expect(doc.fiscal).toBe(false);
    expect(doc.letter).toBe("X");
    expect(doc.label).toBe("Presupuesto");
    expect(doc.authorization).toBeNull();
    expect(doc.number).toBe("0001-00000012");
    expect(doc.concepto).toBeNull();
    expect(doc.date).toBe("2026-10-14");
  });
  it("tipo de servicio, detalle, aclaraciones y nota debajo del nombre", () => {
    expect(quoteDetailLines(ITEMS[0]!).map((l) => l.text)).toEqual([
      "Tipo: Análisis",
      "Recuento de aerobios mesófilos",
      "Coliformes totales",
      "Incluye toma de muestras",
      "Muestras 45 y 46",
    ]);
    expect(doc.lines[0]!.unit).toBe("análisis");
    expect(doc.lines[1]!.discountPct).toBeCloseTo(4.8, 1);
  });
  it("validez, revisión y condiciones como leyendas", () => {
    expect(quoteLegends(QUOTE)).toEqual([
      "Válido hasta el 29/10/2026.",
      "Revisión 2.",
      "Período del servicio: 20/10/2026 al 24/10/2026.",
      "Condiciones: 50 % de anticipo y saldo contra entrega del informe.",
      "Notas: Incluye traslado al laboratorio.",
      QUOTE_SIGNATURE,
    ]);
    expect(doc.totals.discounts).toEqual([{ label: "Descuento", amount: 1000 }]);
  });
});

describe("modelos de presupuesto", () => {
  it("hoja A4 con cada modelo del motor y sus opciones (esquinas, fotos)", () => {
    const images = new Map([["p-fr", "data:image/png;base64,iVBORw0KGgo="]]);
    for (const m of A4_MODELS) {
      for (const corners of ["rounded", "square"] as const) {
        const style = resolveInvoiceStyle({ a4_model: m.key, corners, show_photos: true }, { accent: "#0E7490", logo_url: null }, { pro: true, unbranded: true });
        const { container, unmount } = render(<QuoteDocument quote={QUOTE} items={ITEMS} brand={null} style={style} images={images} format="a4" />);
        const text = container.textContent ?? "";
        expect(container.querySelector("[data-invoice-a4]")?.getAttribute("data-model"), m.key).toBe(m.key);
        expect(text.toUpperCase(), m.key).toContain("PRESUPUESTO");
        expect(text, m.key).toContain("Válido hasta el 29/10/2026.");
        expect(text.toLowerCase(), m.key).toContain("documento no válido como factura");
        // Una sola copia aunque el negocio imprima Original y Duplicado.
        expect(container.querySelectorAll("[data-invoice-page]").length, m.key).toBeGreaterThanOrEqual(1);
        expect(text, m.key).not.toContain("DUPLICADO");
        unmount();
      }
    }
  });
  it("hoja A4: PRESUPUESTO, número, validez, no válido como factura, condiciones y firma", () => {
    const { container } = render(<QuoteDocument quote={QUOTE} items={ITEMS} brand={{ legal_name: "Laboratorio A SRL", cuit: "30712345678", address: "Calle 1", phone: "341" }} style={STYLE} format="a4" />);
    const text = container.textContent ?? "";
    expect(text.toUpperCase()).toContain("PRESUPUESTO");
    expect(text).toContain("0001-00000012");
    expect(text).toContain("Revisión 2");
    expect(text).toContain("Válido hasta");
    expect(text).toContain("29/10/2026");
    expect(text.toLowerCase()).toContain("documento no válido como factura");
    expect(text).toContain("50 % de anticipo");
    expect(text).toContain("Incluye traslado");
    expect(text).toContain("Tipo: Análisis");
    expect(text).toContain("Aclaración");
    expect(text).toContain("Firma");
    expect(container.querySelector('[data-seal="ninjasoft"]')).not.toBeNull();
  });
  it("aceptado: muestra quién lo aceptó en lugar de la firma", () => {
    const q = { ...QUOTE, status: "accepted" as const, accepted_at: "2026-10-15T15:00:00Z", accepted_by_name: "María Pérez", accepted_via: "link" as const };
    const { container } = render(<QuoteDocument quote={q} items={ITEMS} brand={null} style={STYLE} format="a4" />);
    expect(container.textContent).toContain("Aceptado por María Pérez");
    expect(container.textContent).not.toContain("Firma");
  });
  it("sin firma configurada no dibuja el bloque", () => {
    const { container } = render(<QuoteDocument quote={{ ...QUOTE, show_signature: false }} items={ITEMS} brand={null} style={STYLE} format="a4" />);
    expect(container.textContent).not.toContain("Firma");
  });
  it("ticket 80 y 58 con el motor: los campos de un no fiscal y la validez", () => {
    for (const format of ["80", "58"] as const) {
      const { container } = render(<QuoteDocument quote={QUOTE} items={ITEMS} brand={null} style={STYLE} format={format} />);
      const text = container.textContent ?? "";
      expect(text).toContain("Presupuesto");
      expect(text).toContain("0001-00000012");
      expect(text).not.toContain("Período facturado");
      expect(text).toContain("Válido hasta el 29/10/2026.");
      const got = new Set(Array.from(container.querySelectorAll("[data-legal]")).map((e) => e.getAttribute("data-legal")));
      const doc = quoteToInvoiceDoc(QUOTE, ITEMS, null);
      expect(legalRequirements(doc, "ticket").filter((k) => !got.has(k))).toEqual([]);
    }
  });
});

describe("compartir", () => {
  it("link público", () => {
    expect(publicQuoteUrl("https://pos.soft.ninja/", "abc")).toBe("https://pos.soft.ninja/presupuesto/abc");
  });
  it("teléfono para WhatsApp", () => {
    expect(whatsappPhone("341 15 555-1234")).toBe("5493415551234");
    expect(whatsappPhone("+54 9 341 555 1234")).toBe("5493415551234");
    expect(whatsappPhone("0341 155551234")).toBe("5493415551234");
    expect(whatsappPhone("123")).toBeNull();
  });
  it("mensaje con número, total, validez y link", () => {
    const text = quoteShareText(QUOTE, "Lab A", "https://x/presupuesto/t");
    expect(text).toContain("0001-00000012");
    expect(text).toContain("29/10/2026");
    expect(text).toContain("https://x/presupuesto/t");
    expect(whatsappUrl(null, "hola")).toBe("https://wa.me/?text=hola");
  });
  it("errores de las RPC en castellano", () => {
    expect(quoteErrorMessage(new Error("feature_not_in_plan"))).toMatch(/plan/);
    expect(quoteErrorMessage({ message: "quote_locked" })).toMatch(/aceptado/);
    expect(quoteErrorMessage("otra cosa")).toBe("No se pudo completar la operación.");
  });
});
