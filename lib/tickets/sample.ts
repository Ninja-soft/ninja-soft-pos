// Venta ficticia para el preview del editor de tickets (H9b).
import type { TicketFiscal } from "@/lib/arca/ticket";
export interface SampleBrand {
  logo_url: string | null;
  legal_name: string | null;
  accent?: string | null;
  cuit: string | null;
  phone: string | null;
  address: string | null;
  ticket_footer: string | null;
  ticket_width: string | null;
  ticket_title: string | null;
  ticket_legend: string | null;
  ticket_show_qr: boolean | null;
  ticket_show_logo: boolean | null;
  // Condición frente al IVA del emisor (monotributo / responsable_inscripto /
  // exento / consumidor_final). Opcional: aparece en la plantilla A4 legal.
  iva_condition?: string | null;
}

export interface SampleTicketData {
  sale: {
    number: number;
    numberLabel: string;
    created_at: string;
    subtotal: number;
    discount_total: number;
    total: number;
    status: string;
    /** ADR-068: percepciones cobradas (líneas aparte, antes del total). */
    perceptions?: { name: string; amount: number }[];
    /**
     * ADR-068: Transparencia Fiscal al Consumidor (Ley 27.743): IVA contenido
     * y otros impuestos nacionales indirectos (internos) en el comprobante B.
     */
    transparency?: { iva: number; others: number } | null;
    /**
     * F3 · ADR-072: factura electrónica de la venta (tipo, número, CAE o CAEA,
     * vencimiento y QR fiscal) o el aviso de pendiente de autorización.
     */
    fiscal?: TicketFiscal | null;
    /** ADR-074: cada promoción aplicada (descuentos y regalos). */
    promotions?: { label: string; kind: "discount" | "gift"; amount: number }[];
  };
  items: { id: string; product_name: string; quantity: number; unit_price: number; subtotal: number }[];
  payments: { id: string; method: string; amount: number }[];
  customer?: { name: string; email?: string | null } | null;
  brand: SampleBrand | null;
  // Sucursal y caja de la venta (F17 · H90). Sólo viene con 2+ sucursales: con
  // una, el ticket queda igual que siempre.
  location?: { branch: string | null; register: string | null } | null;
}

export function sampleTicketData(brand: SampleBrand | null): SampleTicketData {
  return {
    sale: {
      number: 1042,
      numberLabel: "#0001042",
      created_at: new Date("2026-06-06T16:30:00").toISOString(),
      subtotal: 14500,
      discount_total: 500,
      total: 14000,
      status: "completed",
    },
    items: [
      { id: "s1", product_name: "Remera básica negra M", quantity: 2, unit_price: 4500, subtotal: 9000 },
      { id: "s2", product_name: "Gorra trucker", quantity: 1, unit_price: 3500, subtotal: 3500 },
      { id: "s3", product_name: "Medias pack x3", quantity: 1, unit_price: 2000, subtotal: 2000 },
    ],
    payments: [
      { id: "p1", method: "cash", amount: 10000 },
      { id: "p2", method: "transfer", amount: 4000 },
    ],
    customer: { name: "Juan Pérez", email: "juan@example.com" },
    brand,
  };
}
