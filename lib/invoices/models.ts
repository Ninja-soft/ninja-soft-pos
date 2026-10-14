// Catálogo de modelos de comprobante (ADR-112, ADR-119). PURO.
//
// Cada modelo es un layout distinto sobre el MISMO InvoiceDoc: todos imprimen
// los campos legales de lib/invoices/legal.ts. "clasico" (A4 y ticket) es
// BASE; el resto pide `tickets_pro` (personalización de comprobantes).
// ADR-119: ya no existe el ticket de bloques "Simple (anterior)"; lo guardado
// como "simple" se lee como "clasico".

export type A4Model =
  | "clasico"
  | "moderno"
  | "minimal"
  | "corporativo"
  | "ejecutivo"
  | "elegante"
  | "bloques"
  | "compacto"
  | "catalogo";
export type TicketModel =
  | "clasico"
  | "compacto"
  | "destacado"
  | "moderno"
  | "minimal";

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
    description:
      "Encabezado con logo, letra al centro y bloques con título. El formato de factura de siempre, prolijo.",
    pro: false,
  },
  {
    key: "moderno",
    name: "Moderno",
    description:
      "Tabla con cabecera de color, totales destacados en una caja de color y mucho aire.",
    pro: true,
  },
  {
    key: "minimal",
    name: "Minimal",
    description:
      "Tipografía protagonista, filetes finos y el color sólo en el total. Ideal para servicios.",
    pro: true,
  },
  {
    key: "corporativo",
    name: "Corporativo",
    description:
      "Banda de color de punta a punta con el logo en blanco y datos en columnas.",
    pro: true,
  },
  {
    key: "ejecutivo",
    name: "Ejecutivo",
    description:
      "Columna lateral de color con emisor y receptor, detalle a la derecha. Muy formal.",
    pro: true,
  },
  {
    key: "elegante",
    name: "Elegante",
    description:
      "Encabezado centrado, filetes dobles y títulos en versalitas. Sobrio, para estudios y comercios premium.",
    pro: true,
  },
  {
    key: "bloques",
    name: "Bloques de color",
    description:
      "Cada sección en una tarjeta con su barra de título en color. Se recorre de un vistazo.",
    pro: true,
  },
  {
    key: "compacto",
    name: "Compacto de una hoja",
    description:
      "Encabezado bajo, datos en una franja y tabla densa: entran muchos renglones en una sola hoja.",
    pro: true,
  },
  {
    key: "catalogo",
    name: "Catálogo con fotos",
    description:
      "Cada renglón con la foto grande del producto y más aire. Ideal para mayoristas y pedidos de catálogo.",
    pro: true,
  },
];

export const TICKET_MODELS: ModelInfo<TicketModel>[] = [
  {
    key: "clasico",
    name: "Clásico",
    description:
      "Factura térmica completa: letra en recuadro, detalle, IVA y CAE con QR.",
    pro: false,
  },
  {
    key: "compacto",
    name: "Compacto",
    description:
      "Lo mismo en menos papel: líneas en una fila y datos fiscales condensados.",
    pro: true,
  },
  {
    key: "destacado",
    name: "Destacado",
    description:
      "Encabezado invertido, total grande y separadores marcados. Se lee de lejos.",
    pro: true,
  },
  {
    key: "moderno",
    name: "Moderno",
    description:
      "Secciones en recuadros, el tipo de comprobante en una pastilla y el total en una caja.",
    pro: true,
  },
  {
    key: "minimal",
    name: "Minimal",
    description:
      "Sin recuadros ni rellenos: alineado a la izquierda, mucho aire y el total grande.",
    pro: true,
  },
];

export const isA4Model = (v: unknown): v is A4Model =>
  A4_MODELS.some((m) => m.key === v);
export const isTicketModel = (v: unknown): v is TicketModel =>
  TICKET_MODELS.some((m) => m.key === v);

export const a4ModelIsPro = (k: A4Model) =>
  A4_MODELS.find((m) => m.key === k)?.pro ?? false;
export const ticketModelIsPro = (k: TicketModel) =>
  TICKET_MODELS.find((m) => m.key === k)?.pro ?? false;
