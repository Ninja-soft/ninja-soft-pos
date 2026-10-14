// Comprobantes de ejemplo para la vista previa y los tests (ADR-112). PURO.
// Datos ficticios: nunca se emiten. Cada tipo pasa por el MISMO adaptador que
// las ventas reales (invoiceFromTicket), así la vista previa muestra lo que se
// va a imprimir.

import type { TicketFiscal } from "@/lib/arca/ticket";
import type { SampleBrand, SampleTicketData } from "@/lib/tickets/sample";
import { qrUrl } from "@/supabase/functions/_shared/arca/qr";
import { invoiceFromTicket, type FromTicketOptions } from "./fromTicket";
import type { InvoiceDoc } from "./types";

export type SampleKind = "A" | "B" | "C" | "NC" | "X";

export const SAMPLE_KINDS: { value: SampleKind; label: string }[] = [
  { value: "A", label: "Factura A" },
  { value: "B", label: "Factura B" },
  { value: "C", label: "Factura C" },
  { value: "NC", label: "Nota de crédito" },
  { value: "X", label: "No fiscal" },
];

/** Datos del negocio de ejemplo para lo que la tienda todavía no cargó. */
export const DEMO_ISSUER = {
  legal_name: "Tu Negocio S.R.L.",
  cuit: "30-71122334-5",
  address: "Av. Corrientes 1234, CABA",
  phone: "11 4555-1234",
  iibb: "901-123456-7",
  activity_start: "2019-03-01",
};

/** Completa la marca real con datos de ejemplo donde falten. */
export function previewBrand(brand: SampleBrand | null | undefined, kind: SampleKind): SampleBrand {
  const b = brand ?? null;
  const pick = <T,>(v: T | null | undefined, d: T) => (v == null || v === "" ? d : v);
  return {
    logo_url: b?.logo_url ?? null,
    accent: b?.accent ?? null,
    legal_name: pick(b?.legal_name, DEMO_ISSUER.legal_name),
    cuit: pick(b?.cuit, DEMO_ISSUER.cuit),
    phone: pick(b?.phone, DEMO_ISSUER.phone),
    address: pick(b?.address, DEMO_ISSUER.address),
    ticket_footer: b?.ticket_footer ?? null,
    ticket_width: b?.ticket_width ?? "80",
    ticket_title: b?.ticket_title ?? null,
    ticket_legend: b?.ticket_legend ?? null,
    ticket_show_qr: true,
    ticket_show_logo: b?.ticket_show_logo ?? true,
    iva_condition: kind === "C" ? "monotributo" : pick(b?.iva_condition, "responsable_inscripto"),
    iibb: pick(b?.iibb, DEMO_ISSUER.iibb),
    activity_start: pick(b?.activity_start, DEMO_ISSUER.activity_start),
  };
}

const DATE = "2026-10-13T15:42:00-03:00";

function fiscal(tipo: number, label: string, letter: string, nro: number, total: number, cuit: string, doc?: { tipo: number; nro: string }): TicketFiscal {
  const cae = "86410992504868";
  return {
    status: "aprobado",
    cbteLabel: label,
    letter,
    codigo: String(tipo).padStart(3, "0"),
    ptoVta: "00003",
    numero: `00003-${String(nro).padStart(8, "0")}`,
    cae,
    caeVto: "23/10/2026",
    qrUrl: qrUrl({
      fecha: "2026-10-13",
      cuit: cuit.replace(/\D/g, "") || "30711223345",
      ptoVta: 3,
      tipoCmp: tipo,
      nroCmp: nro,
      importe: total,
      tipoDocRec: doc?.tipo ?? 99,
      nroDocRec: doc?.nro ?? 0,
      tipoCodAut: "E",
      codAut: cae,
    }),
    emissionType: "CAE",
    homologacion: false,
    cbteFch: "2026-10-13",
    docTipo: doc?.tipo ?? 99,
    docNro: doc?.nro ?? "0",
    concepto: 1,
  };
}

const ITEMS = [
  { id: "s1", product_name: "Remera básica algodón negra talle M", quantity: 2, unit_price: 18150, subtotal: 36300 },
  { id: "s2", product_name: "Gorra trucker bordada", quantity: 1, unit_price: 12100, subtotal: 12100 },
  { id: "s3", product_name: "Medias deportivas pack x3", quantity: 1, unit_price: 6050, subtotal: 6050 },
];

/** Venta de ejemplo (formato TicketData) de cada tipo. */
export function sampleSale(kind: SampleKind, brand: SampleBrand | null | undefined): SampleTicketData {
  const b = previewBrand(brand, kind);
  const cuit = b.cuit ?? DEMO_ISSUER.cuit;
  const base: SampleTicketData = {
    sale: {
      number: 1042,
      numberLabel: "#0001042",
      created_at: DATE,
      subtotal: 54450,
      discount_total: 2450,
      total: 52000,
      status: "completed",
      promotions: [{ label: "Promo 10 % remeras", kind: "discount", amount: 2450 }],
    },
    items: ITEMS,
    payments: [
      { id: "p1", method: "debit", amount: 40000 },
      { id: "p2", method: "cash", amount: 12000 },
    ],
    customer: { name: "Consumidor Final" },
    brand: b,
  };
  switch (kind) {
    case "A": {
      const total = 52644.63;
      return {
        ...base,
        sale: {
          ...base.sale,
          total,
          ivaLines: [{ rate: 21, base: 42975.21, amount: 9024.79 }],
          perceptions: [{ name: "Perc. IIBB Buenos Aires 1,5 %", amount: 644.63 }],
          fiscal: fiscal(1, "Factura A", "A", 1838, total, cuit, { tipo: 80, nro: "30707070707" }),
        },
        payments: [{ id: "p1", method: "transfer", amount: total }],
        customer: {
          name: "Distribuidora Andina S.A.",
          email: "compras@andina.com.ar",
          document_type: "CUIT",
          document_number: "30-70707070-7",
          iva_condition: "responsable_inscripto",
          address: "Ruta 8 km 52, Pilar, Buenos Aires",
        },
      };
    }
    case "B":
      return {
        ...base,
        sale: {
          ...base.sale,
          transparency: { iva: 9024.79, others: 0 },
          fiscal: fiscal(6, "Factura B", "B", 1837, 52000, cuit),
        },
      };
    case "C":
      return {
        ...base,
        sale: { ...base.sale, fiscal: fiscal(11, "Factura C", "C", 214, 52000, cuit) },
      };
    case "NC":
      return {
        ...base,
        sale: {
          ...base.sale,
          subtotal: 12100,
          discount_total: 0,
          total: 12100,
          promotions: [],
          transparency: { iva: 2100, others: 0 },
          fiscal: fiscal(8, "Nota de crédito B", "B", 96, 12100, cuit),
        },
        items: [ITEMS[1]!],
        payments: [{ id: "p1", method: "cash", amount: 12100 }],
        customer: { name: "Juan Pérez", document_type: "DNI", document_number: "30123456" },
      };
    case "X":
    default:
      return { ...base, customer: { name: "Juan Pérez", email: "juan@example.com" } };
  }
}

export function sampleInvoice(
  kind: SampleKind,
  brand: SampleBrand | null | undefined,
  opts: FromTicketOptions = {},
): InvoiceDoc {
  return invoiceFromTicket(sampleSale(kind, brand), {
    ...opts,
    associated:
      kind === "NC" ? [{ label: "Factura B", number: "00003-00001837", date: "2026-10-13" }] : opts.associated,
  });
}

/**
 * Factura A de servicios profesionales (ADR-116): un laboratorio de
 * bromatología factura análisis a una planta, con descripción ampliada,
 * aclaraciones predefinidas y la aclaración de cada renglón, período del
 * servicio y vencimiento del pago (concepto 2).
 */
export function sampleServiceSale(brand: SampleBrand | null | undefined): SampleTicketData {
  const b = previewBrand(brand, "A");
  const cuit = b.cuit ?? DEMO_ISSUER.cuit;
  const total = 653400;
  const f = fiscal(1, "Factura A", "A", 412, total, cuit, { tipo: 80, nro: "30712345678" });
  return {
    sale: {
      number: 2207,
      numberLabel: "#0002207",
      created_at: DATE,
      subtotal: total,
      discount_total: 0,
      total,
      status: "completed",
      ivaLines: [{ rate: 21, base: 540000, amount: 113400 }],
      fiscal: { ...f, concepto: 2 },
      service_from: "2026-10-01",
      service_to: "2026-10-10",
      payment_due: "2026-10-30",
    },
    items: [
      {
        id: "v1",
        product_name: "Análisis microbiológico de agua potable",
        quantity: 3,
        unit_price: 72600,
        subtotal: 217800,
        unit_label: "analisis",
        line_detail: "Según CAA art. 982\n- Recuento de aerobios mesófilos\n- Coliformes totales y Escherichia coli\n- Pseudomonas aeruginosa",
        line_clarifications: ["Incluye toma de muestras en planta"],
        line_note: "Muestras N° 45, 46 y 47 · Tanque de reserva y línea de envasado",
      },
      {
        id: "v2",
        product_name: "Relevamiento higiénico-sanitario de planta",
        quantity: 1,
        unit_price: 290400,
        subtotal: 290400,
        unit_label: "visita",
        line_detail: "Inspección de BPM, POES y registros de limpieza con informe y plan de acción.",
        line_clarifications: ["Normativa CAA capítulo II, Res. GMC 80/96"],
        line_note: "Planta Ruta 9 km 285, Pueblo Esther",
      },
      {
        id: "v3",
        product_name: "Informe técnico firmado",
        quantity: 1,
        unit_price: 145200,
        subtotal: 145200,
        unit_label: "informe",
        line_note: "Lote 2381 · Para presentar en ASSAL",
      },
    ],
    payments: [{ id: "p1", method: "transfer", amount: total }],
    customer: {
      name: "Lácteos del Litoral S.A.",
      email: "calidad@lacteoslitoral.com.ar",
      document_type: "CUIT",
      document_number: "30-71234567-8",
      iva_condition: "responsable_inscripto",
      address: "Ruta 9 km 285, Pueblo Esther, Santa Fe",
    },
    brand: { ...b, legal_name: brand?.legal_name || "Laboratorio Bromatológico Rosario S.R.L." },
  };
}

/**
 * Factura de servicios de la plataforma (NinjaSoft a un negocio), para
 * mostrar que el mismo motor sirve a la cobranza SaaS (ADR-110): período
 * facturado, vencimiento del pago y emisor Ninja Soft.
 */
export function samplePlatformInvoice(): InvoiceDoc {
  const total = 60500;
  return {
    fiscal: true,
    letter: "A",
    cbteClass: "factura",
    cbteCode: "001",
    label: "Factura A",
    ptoVta: "00001",
    number: "00000421",
    date: "2026-11-01",
    concepto: 2,
    servicePeriod: { from: "2026-10-01", to: "2026-10-31" },
    paymentDue: "2026-11-10",
    saleCondition: "Débito automático",
    currency: { code: "ARS" },
    issuer: {
      name: "Ninja Soft S.A.S.",
      tradeName: "Ninja Soft",
      cuit: "30-71888999-1",
      iibb: "901-998877-6",
      activityStart: "2024-01-15",
      ivaCondition: "responsable_inscripto",
      address: "Av. del Libertador 5000, CABA",
      email: "facturacion@ninjasoft.com.ar",
    },
    receiver: {
      name: "Tu Negocio S.R.L.",
      cuit: "30-71122334-5",
      docType: "CUIT",
      docNumber: "30-71122334-5",
      ivaCondition: "responsable_inscripto",
      address: "Av. Corrientes 1234, CABA",
    },
    lines: [
      { code: "PRO-M", description: "Plan Pro mensual (octubre 2026)", quantity: 1, unit: "servicio", unitPrice: 45000, ivaRate: 21, subtotal: 45000 },
      { code: "SUC-2", description: "Sucursal adicional", quantity: 1, unit: "servicio", unitPrice: 5000, ivaRate: 21, subtotal: 5000 },
    ],
    totals: { subtotal: 50000, discounts: [], netTaxed: 50000, iva: [{ rate: 21, base: 50000, amount: 10500 }], otherTaxes: [], total },
    authorization: { type: "CAE", code: "86410992509999", due: "11/11/2026" },
    qrUrl: qrUrl({ fecha: "2026-11-01", cuit: "30718889991", ptoVta: 1, tipoCmp: 1, nroCmp: 421, importe: total, tipoDocRec: 80, nroDocRec: "30711223345", tipoCodAut: "E", codAut: "86410992509999" }),
    qrFallbackText: "Ninja Soft | 00001-00000421",
    associated: [],
    payments: [],
    footer: "Gracias por confiar en Ninja Soft.",
    legends: [],
    internalRef: null,
  };
}
