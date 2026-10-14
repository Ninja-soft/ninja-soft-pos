import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { InvoiceDocument, a4Copies } from "@/components/invoices/InvoiceDocument";
import { A4_MODELS, TICKET_MODELS } from "@/lib/invoices/models";
import { legalRequirements, receiverIdRequired, RECEIVER_ID_THRESHOLD } from "@/lib/invoices/legal";
import {
  BUSINESS_DEFAULTS,
  DEFAULT_INVOICE_STYLE,
  NINJA_POS_ACCENT,
  NINJA_POS_LOGO,
  PLATFORM_DEFAULTS,
  NINJA_SOFT_LOGO,
  clampInvoiceStyle,
  invoiceStyleNeedsPro,
  normalizeInvoiceStyle,
  resolveInvoiceStyle,
} from "@/lib/invoices/style";
import { sampleInvoice, samplePlatformInvoice, sampleSale, type SampleKind } from "@/lib/invoices/samples";
import { invoiceFromTicket } from "@/lib/invoices/fromTicket";
import type { InvoiceDoc } from "@/lib/invoices/types";
import { paginateLines } from "@/lib/invoices/paginate";
import { docOptions } from "@/lib/invoices/fromTicket";
import { decodeQrUrl } from "@/supabase/functions/_shared/arca/qr";

const FULL = { pro: true, unbranded: true };
const KINDS: SampleKind[] = ["A", "B", "C", "NC", "X"];
const STORE = { accent: "#0F766E", logo_url: "https://cdn.example.com/logo.png" };

function legalKeys(container: HTMLElement): Set<string> {
  return new Set(Array.from(container.querySelectorAll("[data-legal]")).map((e) => e.getAttribute("data-legal")!));
}

function missing(doc: InvoiceDoc, format: "a4" | "ticket", container: HTMLElement): string[] {
  const got = legalKeys(container);
  return legalRequirements(doc, format).filter((k) => !got.has(k));
}

describe("modelos A4: campos obligatorios por tipo", () => {
  for (const m of A4_MODELS) {
    for (const kind of KINDS) {
      it(`${m.name} · ${kind}`, () => {
        const style = resolveInvoiceStyle({ a4_model: m.key }, null, FULL);
        const doc = sampleInvoice(kind, null);
        const { container } = render(<InvoiceDocument doc={doc} style={style} format="a4" />);
        expect(missing(doc, "a4", container)).toEqual([]);
        // El QR va siempre.
        expect(container.querySelector('img[data-legal="qr"]')).not.toBeNull();
        expect(container.querySelector(`[data-model="${m.key}"]`)).not.toBeNull();
      });
    }
    it(`${m.name} · factura de la plataforma (servicios con período)`, () => {
      const style = resolveInvoiceStyle({ a4_model: m.key }, null, FULL, PLATFORM_DEFAULTS);
      const doc = samplePlatformInvoice();
      const { container } = render(<InvoiceDocument doc={doc} style={style} format="a4" />);
      expect(missing(doc, "a4", container)).toEqual([]);
      expect(container.textContent).toContain("01/10/2026 al 31/10/2026");
    });
  }
});

describe("modelos de ticket 80 y 58 mm: campos obligatorios por tipo", () => {
  for (const m of TICKET_MODELS) {
    for (const paper of ["80", "58"] as const) {
      for (const kind of KINDS) {
        it(`${m.name} ${paper} mm · ${kind}`, () => {
          const style = resolveInvoiceStyle({ ticket_model: m.key }, null, FULL);
          const doc = sampleInvoice(kind, null);
          const { container } = render(<InvoiceDocument doc={doc} style={style} format={paper} />);
          expect(missing(doc, "ticket", container)).toEqual([]);
          expect(container.querySelector('img[data-legal="qr"]')).not.toBeNull();
        });
      }
    }
  }
});

describe("requisitos legales según el tipo", () => {
  it("A: IVA discriminado, alícuota, documento y domicilio del receptor", () => {
    const r = legalRequirements(sampleInvoice("A", null), "a4");
    expect(r).toEqual(expect.arrayContaining(["iva_discriminado", "alicuota", "receptor_doc", "receptor_domicilio", "cae", "cae_vto", "copia", "emisor_iibb", "emisor_inicio"]));
    expect(r).not.toContain("transparencia");
  });
  it("B y C: transparencia fiscal (Ley 27.743), sin IVA discriminado", () => {
    for (const k of ["B", "C"] as const) {
      const r = legalRequirements(sampleInvoice(k, null), "ticket");
      expect(r).toContain("transparencia");
      expect(r).not.toContain("iva_discriminado");
      expect(r).not.toContain("copia");
    }
  });
  it("NC: comprobante asociado", () => {
    const doc = sampleInvoice("NC", null);
    expect(doc.cbteClass).toBe("nota_credito");
    expect(legalRequirements(doc, "a4")).toContain("asociado");
  });
  it("no fiscal: marcado como tal, sin CAE ni letra fiscal", () => {
    const doc = sampleInvoice("X", null);
    const r = legalRequirements(doc, "a4");
    expect(doc.fiscal).toBe(false);
    expect(doc.letter).toBe("X");
    expect(r).toContain("no_fiscal");
    expect(r).not.toContain("cae");
    const { container } = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({}, null, FULL)} format="80" />);
    expect(container.textContent).toContain("Documento no válido como factura");
  });
  it("moneda extranjera: moneda y cotización", () => {
    const doc: InvoiceDoc = { ...samplePlatformInvoice(), currency: { code: "USD", rate: 1450 } };
    expect(legalRequirements(doc, "a4")).toContain("moneda");
    const { container } = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({}, null, FULL)} format="a4" />);
    expect(missing(doc, "a4", container)).toEqual([]);
    expect(container.textContent).toContain("Cotización");
  });
  it("B por encima del umbral exige identificar al consumidor final", () => {
    const doc = sampleInvoice("B", null);
    expect(receiverIdRequired(doc)).toBe(false);
    expect(receiverIdRequired({ ...doc, totals: { ...doc.totals, total: RECEIVER_ID_THRESHOLD } })).toBe(true);
  });
  it("A4 fiscal: Original y Duplicado cuando se piden dos copias", () => {
    const doc = sampleInvoice("B", null);
    expect(a4Copies(doc, 2)).toEqual(["ORIGINAL", "DUPLICADO"]);
    const style = resolveInvoiceStyle({ a4_copies: 2 }, null, FULL);
    const { container } = render(<InvoiceDocument doc={doc} style={style} format="a4" />);
    expect(container.querySelectorAll("[data-invoice-page]")).toHaveLength(2);
    expect(container.textContent).toContain("DUPLICADO");
  });
});

describe("adaptador venta -> comprobante", () => {
  it("A: neto + IVA + percepciones = total y el QR fiscal se conserva", () => {
    const doc = sampleInvoice("A", null);
    const iva = doc.totals.iva.reduce((a, r) => a + r.amount, 0);
    const other = doc.totals.otherTaxes.reduce((a, r) => a + r.amount, 0);
    expect(Math.round(((doc.totals.netTaxed ?? 0) + iva + other) * 100) / 100).toBe(doc.totals.total);
    expect(doc.lines.every((l) => l.ivaRate === 21)).toBe(true);
    expect(decodeQrUrl(doc.qrUrl!)).toMatchObject({ tipoCmp: 1, ptoVta: 3, nroCmp: 1838 });
  });
  it("venta sin factura autorizada: no fiscal con el aviso de pendiente", () => {
    const sale = sampleSale("B", null);
    const doc = invoiceFromTicket({ ...sale, sale: { ...sale.sale, fiscal: { ...sale.sale.fiscal!, status: "pendiente", cae: null, numero: null } } });
    expect(doc.fiscal).toBe(false);
    expect(doc.pendingAuthorization).toBe(true);
  });
});

describe("personalización: colores, logo y sello", () => {
  it("sin marca de tienda: color y logo de Ninja POS", () => {
    const s = resolveInvoiceStyle({}, null, FULL);
    expect(s.accent).toBe(NINJA_POS_ACCENT);
    expect(s.logoUrl).toBe(NINJA_POS_LOGO.onLight);
    expect(s.logoIsDefault).toBe(true);
    expect(s.a4Model).toBe("clasico");
    expect(s.ticketModel).toBe("clasico");
  });
  it("con marca de tienda: su color y su logo", () => {
    const s = resolveInvoiceStyle({}, STORE, FULL);
    expect(s.accent).toBe("#0F766E");
    expect(s.logoUrl).toBe(STORE.logo_url);
    expect(s.logoIsDefault).toBe(false);
  });
  it("color y logo propios del comprobante pisan la marca (con el plan)", () => {
    const raw = { accent_mode: "custom", accent_custom: "#1D4ED8", logo_mode: "custom", logo_custom_url: "https://x/l.webp" };
    const s = resolveInvoiceStyle(raw, STORE, FULL);
    expect(s.accent).toBe("#1D4ED8");
    expect(s.logoUrl).toBe("https://x/l.webp");
    // Sin tickets_pro vuelve a la marca.
    const d = resolveInvoiceStyle(raw, STORE, { pro: false, unbranded: false });
    expect(d.accent).toBe("#0F766E");
    expect(d.logoUrl).toBe(STORE.logo_url);
  });
  it("sin logo", () => {
    expect(resolveInvoiceStyle({ logo_mode: "none" }, STORE, FULL).logoUrl).toBeNull();
  });
  it("la plataforma usa el logo de Ninja Soft por defecto", () => {
    expect(resolveInvoiceStyle({}, null, FULL, PLATFORM_DEFAULTS).logoUrl).toBe(NINJA_SOFT_LOGO.onLight);
    expect(BUSINESS_DEFAULTS.logo).toBe(NINJA_POS_LOGO);
  });
  it("color de texto legible aunque el resalte sea claro", () => {
    const s = resolveInvoiceStyle({ accent_mode: "custom", accent_custom: "#FFD21F" }, null, FULL);
    expect(s.accentInk).toBe("#141414");
    expect(s.accentText).not.toBe("#FFD21F");
  });
  it("sello visible por defecto y ocultable con el plan", () => {
    const doc = sampleInvoice("B", null);
    const on = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({}, null, FULL)} format="a4" />);
    expect(on.container.querySelector('[data-seal="ninjasoft"]')).not.toBeNull();
    expect(on.container.textContent).toContain("Un software de Ninja Soft");
    on.unmount();
    const off = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({ show_ninja_seal: false }, null, FULL)} format="80" />);
    expect(off.container.querySelector('[data-seal="ninjasoft"]')).toBeNull();
    off.unmount();
    // Sin comprobantes_sin_sello el sello vuelve.
    const forced = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({ show_ninja_seal: false }, null, { pro: true, unbranded: false })} format="80" />);
    expect(forced.container.querySelector('[data-seal="ninjasoft"]')).not.toBeNull();
  });
  it("qué pide tickets_pro (espejo de invoice_style_needs_pro)", () => {
    expect(invoiceStyleNeedsPro(DEFAULT_INVOICE_STYLE)).toBe(false);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ ticket_model: "simple", show_ninja_seal: false }))).toBe(false);
    // ADR-119: el aspecto pide Pro; el tamaño de letra y los bloques no.
    for (const o of [{ font_family: "serif" }, { density: "amplia" }, { corners: "square" }, { logo_position: "center" }, { header_style: "filled" }, { separators: "none" }, { show_photos: true }, { ticket_photos: true }, { a4_model: "catalogo" }, { ticket_model: "minimal" }]) {
      expect(invoiceStyleNeedsPro(normalizeInvoiceStyle(o)), JSON.stringify(o)).toBe(true);
    }
    for (const o of [{ font_size: "lg" }, { show_contact: false }, { show_iva_breakdown: true }, { show_legends: false }, { show_sale_barcode: true }, { show_payments: false }]) {
      expect(invoiceStyleNeedsPro(normalizeInvoiceStyle(o)), JSON.stringify(o)).toBe(false);
    }
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ a4_model: "moderno" }))).toBe(true);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ ticket_model: "destacado" }))).toBe(true);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ accent_mode: "custom", accent_custom: "#123456" }))).toBe(true);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ accent_mode: "custom", accent_custom: "rojo" }))).toBe(false);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ legends: "  " }))).toBe(false);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ legends: "Cambios en 30 días" }))).toBe(true);
    expect(invoiceStyleNeedsPro(clampInvoiceStyle(normalizeInvoiceStyle({ a4_model: "corporativo" }), { pro: false, unbranded: false }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADR-119
// ---------------------------------------------------------------------------

/** Combinaciones extremas de opciones: ninguna puede dejar afuera un campo legal. */
const OPTION_SETS: Record<string, Record<string, unknown>> = {
  "rectos, fotos y todo oculto": {
    corners: "square",
    show_photos: true,
    ticket_photos: true,
    show_contact: false,
    show_payments: false,
    show_internal_ref: false,
    show_legends: false,
    separators: "none",
    logo_mode: "none",
  },
  "letra grande, amplia, serif, logo centrado y pastilla": {
    font_size: "lg",
    density: "amplia",
    font_family: "serif",
    logo_position: "center",
    header_style: "filled",
    separators: "dotted",
    show_iva_breakdown: true,
    show_sale_barcode: true,
  },
};

describe("ADR-119: modelos × tipos × opciones mantienen lo obligatorio", () => {
  for (const [name, opts] of Object.entries(OPTION_SETS)) {
    for (const m of A4_MODELS) {
      it(`A4 ${m.name} · ${name}`, () => {
        const style = resolveInvoiceStyle({ ...opts, a4_model: m.key }, STORE, FULL);
        for (const kind of KINDS) {
          const doc = sampleInvoice(kind, null, docOptions(style));
          const { container, unmount } = render(<InvoiceDocument doc={doc} style={style} format="a4" />);
          expect(missing(doc, "a4", container), kind).toEqual([]);
          unmount();
        }
      });
    }
    for (const m of TICKET_MODELS) {
      it(`ticket ${m.name} · ${name}`, () => {
        const style = resolveInvoiceStyle({ ...opts, ticket_model: m.key }, STORE, FULL);
        for (const paper of ["80", "58"] as const) {
          for (const kind of KINDS) {
            const doc = sampleInvoice(kind, null, docOptions(style));
            const { container, unmount } = render(<InvoiceDocument doc={doc} style={style} format={paper} />);
            expect(missing(doc, "ticket", container), `${paper} ${kind}`).toEqual([]);
            unmount();
          }
        }
      });
    }
  }
});

describe("ADR-119: sin el ticket de bloques", () => {
  it("lo guardado como Simple se lee como Clásico", () => {
    expect(normalizeInvoiceStyle({ ticket_model: "simple" }).ticket_model).toBe("clasico");
    expect(TICKET_MODELS.some((m) => (m.key as string) === "simple")).toBe(false);
  });
  it("hay 9 modelos A4 y 5 de ticket; sólo Clásico es base", () => {
    expect(A4_MODELS.map((m) => m.key)).toEqual(expect.arrayContaining(["elegante", "bloques", "compacto", "catalogo"]));
    expect(TICKET_MODELS.map((m) => m.key)).toEqual(expect.arrayContaining(["moderno", "minimal"]));
    expect([...A4_MODELS, ...TICKET_MODELS].filter((m) => !m.pro).map((m) => m.key)).toEqual(["clasico", "clasico"]);
  });
  it("sin tickets_pro el aspecto vuelve al default", () => {
    const s = resolveInvoiceStyle({ corners: "square", font_family: "mono", density: "compacta", show_photos: true, font_size: "lg" }, null, { pro: false, unbranded: false });
    expect(s.rounded).toBe(true);
    expect(s.fontFamily).toBeNull();
    expect(s.density).toBe(1);
    expect(s.showPhotos).toBe(false);
    // El tamaño de letra es base.
    expect(s.fontScale).toBeGreaterThan(1);
  });
});

describe("ADR-119: bordes, fotos y bloques", () => {
  const doc = sampleInvoice("B", null);
  it("bordes redondeados o rectos en la raíz de la hoja y del rollo", () => {
    const round = resolveInvoiceStyle({}, null, FULL);
    const square = resolveInvoiceStyle({ corners: "square" }, null, FULL);
    for (const format of ["a4", "80"] as const) {
      const a = render(<InvoiceDocument doc={doc} style={round} format={format} />);
      const root = a.container.querySelector<HTMLElement>("[data-invoice-page],[data-invoice-ticket]")!;
      expect(root.style.getPropertyValue("--inv-r")).toBe("1");
      a.unmount();
      const b = render(<InvoiceDocument doc={doc} style={square} format={format} />);
      const root2 = b.container.querySelector<HTMLElement>("[data-invoice-page],[data-invoice-ticket]")!;
      expect(root2.style.getPropertyValue("--inv-r")).toBe("0");
      b.unmount();
    }
  });
  it("Catálogo: foto grande en cada renglón y placeholder si no tiene", () => {
    const style = resolveInvoiceStyle({ a4_model: "catalogo" }, null, FULL);
    const { container } = render(<InvoiceDocument doc={doc} style={style} format="a4" />);
    expect(container.querySelectorAll('[data-product-photo="color"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-product-photo="none"]')).toHaveLength(1);
  });
  it("foto en A4 sólo con la opción; en el ticket, monocromo y apagada por defecto", () => {
    const off = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({}, null, FULL)} format="a4" />);
    expect(off.container.querySelector("[data-product-photo]")).toBeNull();
    off.unmount();
    const on = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({ show_photos: true }, null, FULL)} format="a4" />);
    expect(on.container.querySelectorAll('[data-product-photo="color"]')).toHaveLength(2);
    on.unmount();
    const tOff = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({ show_photos: true }, null, FULL)} format="80" />);
    expect(tOff.container.querySelector("[data-product-photo]")).toBeNull();
    tOff.unmount();
    const tOn = render(<InvoiceDocument doc={doc} style={resolveInvoiceStyle({ ticket_photos: true }, null, FULL)} format="80" />);
    expect(tOn.container.querySelectorAll('[data-product-photo="mono"]')).toHaveLength(2);
  });
  it("detalle de IVA en la B (no en la C) y contacto ocultable", () => {
    const style = resolveInvoiceStyle({ show_iva_breakdown: true, show_contact: false }, null, FULL);
    const b = sampleInvoice("B", null, docOptions(style));
    expect(b.issuer.phone).toBeNull();
    const { container } = render(<InvoiceDocument doc={b} style={style} format="a4" />);
    expect(container.textContent).toContain("IVA 21 % contenido");
    const c = sampleInvoice("C", null, docOptions(style));
    expect(c.transparencyBreakdown).toBeNull();
  });
  it("código de barras de la venta sólo con la opción", () => {
    const style = resolveInvoiceStyle({ show_sale_barcode: true }, null, FULL);
    const d = sampleInvoice("X", null, docOptions(style));
    const { container } = render(<InvoiceDocument doc={d} style={style} format="80" />);
    expect(container.querySelector("[data-sale-barcode]")).not.toBeNull();
    expect(sampleInvoice("X", null).saleCode).toBeNull();
  });
});

describe("ADR-119: paginación A4", () => {
  const many = (n: number): InvoiceDoc => {
    const base = sampleInvoice("A", null);
    const line = base.lines[0]!;
    return { ...base, lines: Array.from({ length: n }, (_, i) => ({ ...line, code: String(i + 1), description: `Artículo ${i + 1}` })) };
  };
  it("pocos renglones: una hoja", () => {
    expect(paginateLines(sampleInvoice("B", null).lines)).toEqual([[0, 3]]);
  });
  it("muchos renglones: varias hojas sin perder ninguno", () => {
    const d = many(70);
    const pages = paginateLines(d.lines);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]![0]).toBe(0);
    expect(pages[pages.length - 1]![1]).toBe(70);
    for (let i = 1; i < pages.length; i++) expect(pages[i]![0]).toBe(pages[i - 1]![1]);
  });
  for (const m of A4_MODELS) {
    it(`${m.name}: encabezado en cada hoja, totales y CAE sólo en la última`, () => {
      const d = many(70);
      const style = resolveInvoiceStyle({ a4_model: m.key }, null, FULL);
      const { container } = render(<InvoiceDocument doc={d} style={style} format="a4" />);
      const sheets = Array.from(container.querySelectorAll<HTMLElement>("[data-invoice-page]"));
      expect(sheets.length).toBeGreaterThan(1);
      sheets.forEach((sh, i) => {
        const keys = legalKeys(sh);
        expect(keys.has("tipo") && keys.has("numero") && keys.has("emisor_cuit") && keys.has("receptor")).toBe(true);
        expect(sh.textContent).toContain(`Hoja ${i + 1} de ${sheets.length}`);
        if (i < sheets.length - 1) {
          expect(keys.has("total")).toBe(false);
          expect(sh.textContent).toContain("Continúa en la hoja siguiente");
        }
      });
      const last = sheets[sheets.length - 1]!;
      expect(legalRequirements(d, "a4").filter((k) => !legalKeys(last).has(k))).toEqual([]);
      const rows = sheets.reduce((a, sh) => a + sh.querySelectorAll("tbody tr").length, 0);
      expect(rows).toBe(70);
    });
  }
});
