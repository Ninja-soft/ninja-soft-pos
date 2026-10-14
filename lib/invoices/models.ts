// Catálogo de modelos de comprobante (ADR-112). PURO.
//
// Cada modelo es un layout distinto sobre el MISMO InvoiceDoc: todos imprimen
// los campos legales de lib/invoices/legal.ts. "clasico" (A4 y ticket) y
// "simple" (el ticket de bloques de siempre) son BASE; el resto pide
// `tickets_pro` (personalización de comprobantes).

export type A4Model = "clasico" | "moderno" | "minimal" | "corporativo" | "ejecutivo";
export type TicketModel = "clasico" | "compacto" | "destacado" | "simple";

export interface ModelInfo<K extends string> {
  key: K;
  name: string;
  description: string;
  /** Pide `tickets_pro`. */
  pro: boolean;
}

export const A4_MODELS: ModelInfo<A4Model>[] = [
  {
    key: "clasico",
    name: "Clásico",
    description: "Encabezado con logo, letra al centro y bloques con título. El formato de factura de siempre, prolijo.",
    pro: false,
  },
  {
    key: "moderno",
    name: "Moderno",
    description: "Tabla con cabecera de color, totales destacados en una caja de color y mucho aire.",
    pro: true,
  },
  {
    key: "minimal",
    name: "Minimal",
    description: "Tipografía protagonista, filetes finos y el color sólo en el total. Ideal para servicios.",
    pro: true,
  },
  {
    key: "corporativo",
    name: "Corporativo",
    description: "Banda de color de punta a punta con el logo en blanco y datos en columnas.",
    pro: true,
  },
  {
    key: "ejecutivo",
    name: "Ejecutivo",
    description: "Columna lateral de color con emisor y receptor, detalle a la derecha. Muy formal.",
    pro: true,
  },
];

export const TICKET_MODELS: ModelInfo<TicketModel>[] = [
  {
    key: "clasico",
    name: "Clásico",
    description: "Factura térmica completa: letra en recuadro, detalle, IVA y CAE con QR.",
    pro: false,
  },
  {
    key: "compacto",
    name: "Compacto",
    description: "Lo mismo en menos papel: líneas en una fila y datos fiscales condensados.",
    pro: true,
  },
  {
    key: "destacado",
    name: "Destacado",
    description: "Encabezado invertido, total grande y separadores marcados. Se lee de lejos.",
    pro: true,
  },
  {
    key: "simple",
    name: "Simple (anterior)",
    description: "El ticket de bloques de antes, sin cambios.",
    pro: false,
  },
];

export const isA4Model = (v: unknown): v is A4Model => A4_MODELS.some((m) => m.key === v);
export const isTicketModel = (v: unknown): v is TicketModel => TICKET_MODELS.some((m) => m.key === v);

export const a4ModelIsPro = (k: A4Model) => A4_MODELS.find((m) => m.key === k)?.pro ?? false;
export const ticketModelIsPro = (k: TicketModel) => TICKET_MODELS.find((m) => m.key === k)?.pro ?? false;
