import { describe, expect, it } from "vitest";
import {
  brandDisplayName,
  businessDisplayName,
  businessDisplayNameOrNull,
  cleanTradeName,
  invoiceTradeName,
  TRADE_NAME_MAX,
} from "@/lib/branding/businessName";
import { resolveInvoiceStyle } from "@/lib/invoices/style";
import { effectiveTicketBrand } from "@/lib/tickets/branchBrand";
import { invoiceFromTicket, docOptions } from "@/lib/invoices/fromTicket";
import { sampleSale } from "@/lib/invoices/samples";
import type { SampleBrand } from "@/lib/tickets/sample";

const ENT = { pro: true, unbranded: true };

describe("businessDisplayName (ADR-124)", () => {
  it("fantasía, si no la cuenta, si no la razón social, si no el fallback", () => {
    expect(businessDisplayName({ tradeName: "Kiosco Pepe", tenantName: "Pepe SRL cuenta", legalName: "Pepe SRL" })).toBe("Kiosco Pepe");
    expect(businessDisplayName({ tradeName: "  ", tenantName: "Mi cuenta", legalName: "Pepe SRL" })).toBe("Mi cuenta");
    expect(businessDisplayName({ legalName: "Pepe SRL" })).toBe("Pepe SRL");
    expect(businessDisplayName(null)).toBe("Mi negocio");
    expect(businessDisplayName({}, "Negocio")).toBe("Negocio");
    expect(businessDisplayNameOrNull({})).toBeNull();
  });

  it("colapsa espacios", () => {
    expect(businessDisplayName({ tradeName: "  La   Esquina " })).toBe("La Esquina");
  });

  it("brandDisplayName lee las columnas de la marca", () => {
    expect(brandDisplayName({ trade_name: "Fantasía", tenant_name: "Cuenta", legal_name: "Razón" })).toBe("Fantasía");
    expect(brandDisplayName({ trade_name: null, tenant_name: "Cuenta", legal_name: "Razón" })).toBe("Cuenta");
    expect(brandDisplayName(null, "")).toBe("");
  });

  it("cleanTradeName: vacío = null y tope de largo", () => {
    expect(cleanTradeName("   ")).toBeNull();
    expect(cleanTradeName(42)).toBeNull();
    expect(cleanTradeName("x".repeat(200))!.length).toBe(TRADE_NAME_MAX);
  });
});

describe("invoiceTradeName: encabezado comercial del comprobante", () => {
  it("override del comprobante > fantasía de la marca > cuenta", () => {
    expect(invoiceTradeName({ override: "Solo factura", tradeName: "Fantasía", tenantName: "Cuenta" })).toBe("Solo factura");
    expect(invoiceTradeName({ override: "", tradeName: "Fantasía", tenantName: "Cuenta" })).toBe("Fantasía");
    expect(invoiceTradeName({ tenantName: "Cuenta" })).toBe("Cuenta");
    expect(invoiceTradeName({})).toBeNull();
  });

  it("no repite la razón social", () => {
    expect(invoiceTradeName({ tradeName: "pepe srl", legalName: "Pepe SRL" })).toBeNull();
  });

  it("resolveInvoiceStyle aplica la prioridad", () => {
    const brand = { trade_name: "La Esquina", tenant_name: "Cuenta", legal_name: "Esquina SA" };
    expect(resolveInvoiceStyle({}, brand, ENT).tradeName).toBe("La Esquina");
    expect(resolveInvoiceStyle({ trade_name: "Override" }, brand, ENT).tradeName).toBe("Override");
    expect(resolveInvoiceStyle({}, { tenant_name: "Cuenta", legal_name: "Esquina SA" }, ENT).tradeName).toBe("Cuenta");
  });
});

const BRAND: SampleBrand = {
  logo_url: null,
  legal_name: "Esquina SA",
  trade_name: "La Esquina",
  tenant_name: "Cuenta",
  cuit: null,
  phone: null,
  address: null,
  ticket_footer: null,
  ticket_width: "80",
  ticket_title: null,
  ticket_legend: null,
  ticket_show_qr: null,
  ticket_show_logo: null,
};

describe("nombre de fantasía por sucursal", () => {
  it("la sucursal lo pisa (dominio ticket)", () => {
    const eff = effectiveTicketBrand(
      BRAND,
      [{ scope: "store", scope_id: "s1", domain: "ticket", domain_key: "", patch: { trade_name: "La Esquina Norte" } }],
      { storeId: "s1", groupId: null, registerId: null, multiStore: true, multiRegister: false },
      null,
    );
    expect(eff?.trade_name).toBe("La Esquina Norte");
    expect(eff?.tenant_name).toBe("Cuenta");
  });

  it("sin override hereda el del negocio", () => {
    const eff = effectiveTicketBrand(BRAND, [], { storeId: "s1", groupId: null, registerId: null, multiStore: true, multiRegister: false }, null);
    expect(eff?.trade_name).toBe("La Esquina");
  });
});

describe("comprobante desde la venta", () => {
  it("fantasía arriba y razón social como emisor", () => {
    const style = resolveInvoiceStyle({}, BRAND, ENT);
    const data = sampleSale("B", BRAND);
    const doc = invoiceFromTicket(data, docOptions(style));
    expect(doc.issuer.tradeName).toBe("La Esquina");
    expect(doc.issuer.name).toBe("Esquina SA");
  });

  it("sin razón social: el emisor se nombra con la fantasía y no se repite", () => {
    const b = { ...BRAND, legal_name: null };
    const style = resolveInvoiceStyle({}, b, ENT);
    const base = sampleSale("B", b);
    const data = { ...base, brand: { ...base.brand!, legal_name: null } };
    const doc = invoiceFromTicket(data, docOptions(style));
    expect(doc.issuer.name).toBe("La Esquina");
    expect(doc.issuer.tradeName).toBeNull();
  });
});
