import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { InvoiceDocument, a4Copies } from "@/components/invoices/InvoiceDocument";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";
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
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
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
  for (const m of TICKET_MODELS.filter((x) => x.key !== "simple")) {
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
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ a4_model: "moderno" }))).toBe(true);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ ticket_model: "destacado" }))).toBe(true);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ accent_mode: "custom", accent_custom: "#123456" }))).toBe(true);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ accent_mode: "custom", accent_custom: "rojo" }))).toBe(false);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ legends: "  " }))).toBe(false);
    expect(invoiceStyleNeedsPro(normalizeInvoiceStyle({ legends: "Cambios en 30 días" }))).toBe(true);
    expect(invoiceStyleNeedsPro(clampInvoiceStyle(normalizeInvoiceStyle({ a4_model: "corporativo" }), { pro: false, unbranded: false }))).toBe(false);
  });
});

describe("TemplateRenderer con el motor de comprobantes", () => {
  const data = sampleSale("B", null);
  it("sin plantilla propia usa el modelo de ticket elegido", () => {
    const style = resolveInvoiceStyle({ ticket_model: "destacado" }, null, FULL);
    const { container } = render(<TemplateRenderer template={null} fallbackBlocks={defaultSaleBlocks()} data={data} invoice={{ style }} />);
    expect(container.querySelector('[data-model="destacado"]')).not.toBeNull();
  });
  it("modelo Simple: el ticket de bloques de siempre", () => {
    const style = resolveInvoiceStyle({ ticket_model: "simple" }, null, FULL);
    const { container } = render(<TemplateRenderer template={null} fallbackBlocks={defaultSaleBlocks()} data={data} invoice={{ style }} />);
    expect(container.querySelector("[data-invoice-ticket]")).toBeNull();
    expect(container.querySelector('img[alt="QR fiscal de ARCA"]')).not.toBeNull();
  });
  it("sin estilo (otros usos) no cambia nada", () => {
    const { container } = render(<TemplateRenderer template={null} fallbackBlocks={defaultSaleBlocks()} data={data} />);
    expect(container.querySelector("[data-invoice-ticket]")).toBeNull();
  });
});
