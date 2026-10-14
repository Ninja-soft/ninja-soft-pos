// Motor de comprobantes (ADR-112). Modelo de documento NEUTRO: no sabe de
// ventas del POS ni de la cobranza de la plataforma. Cada origen tiene su
// adaptador (lib/invoices/fromTicket.ts para los negocios; la factura de
// NinjaSoft a sus clientes armará el mismo InvoiceDoc desde su ledger, ADR-110)
// y los modelos (components/invoices) sólo leen este tipo. PURO.

/** Letra del comprobante. "X" = comprobante no fiscal (no es factura). */
export type InvoiceLetter = "A" | "B" | "C" | "M" | "E" | "X";

/** Clase del comprobante. */
export type InvoiceClass = "factura" | "nota_credito" | "nota_debito" | "no_fiscal";

/** Condición frente al IVA (mismas claves que tenant_branding.iva_condition y customers). */
export type IvaCondition =
  | "responsable_inscripto"
  | "monotributo"
  | "monotributo_social"
  | "exento"
  | "consumidor_final"
  | "no_categorizado"
  | "exterior";

export interface InvoiceParty {
  /** Razón social (emisor) o nombre y apellido / razón social (receptor). */
  name: string;
  /** Nombre de fantasía del emisor (opcional, va sobre la razón social). */
  tradeName?: string | null;
  cuit?: string | null;
  /** N° de Ingresos Brutos (o "Convenio Multilateral 901-..."). */
  iibb?: string | null;
  /** Inicio de actividades (ISO AAAA-MM-DD). */
  activityStart?: string | null;
  ivaCondition?: IvaCondition | string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Receptor: tipo de documento (CUIT, CUIL, DNI, Pasaporte). */
  docType?: string | null;
  docNumber?: string | null;
}

export interface InvoiceLine {
  code?: string | null;
  description: string;
  quantity: number;
  /** Unidad de medida ("unidad", "kg", "hora"). */
  unit?: string | null;
  /** Precio unitario tal como se muestra (neto en A, final en B/C). */
  unitPrice: number;
  /** Bonificación en % sobre la línea (opcional). */
  discountPct?: number | null;
  /** Alícuota de IVA de la línea (21, 10.5, 27, 0); se muestra en A. */
  ivaRate?: number | null;
  /** Importe de la línea tal como se muestra (neto en A, final en B/C). */
  subtotal: number;
}

export interface InvoiceIvaRow {
  rate: number;
  base: number;
  amount: number;
}

export interface InvoiceAmountRow {
  label: string;
  amount: number;
}

export interface InvoiceTotals {
  /** Suma de las líneas tal como se muestran. */
  subtotal: number;
  /** Descuentos y promociones (una fila por concepto, montos positivos). */
  discounts: InvoiceAmountRow[];
  /** Comprobante A (IVA discriminado): neto gravado, no gravado y exento. */
  netTaxed?: number | null;
  netUntaxed?: number | null;
  exempt?: number | null;
  /** IVA discriminado por alícuota (sólo A / M). */
  iva: InvoiceIvaRow[];
  /** Percepciones y otros tributos (IIBB, internos, etc.). */
  otherTaxes: InvoiceAmountRow[];
  total: number;
}

export interface InvoiceAuthorization {
  type: "CAE" | "CAEA";
  code: string;
  /** Vencimiento (dd/mm/aaaa o ISO). */
  due: string;
}

export interface InvoiceAssociated {
  /** "Factura B". */
  label: string;
  /** "00003-00000012". */
  number: string;
  date?: string | null;
}

export interface InvoiceCurrency {
  /** Código ISO (ARS, USD, EUR). */
  code: string;
  /** Cotización usada si no es ARS. */
  rate?: number | null;
}

export type InvoiceCopy = "ORIGINAL" | "DUPLICADO" | "TRIPLICADO";

export interface InvoiceDoc {
  /** true = comprobante fiscal autorizado o a autorizar por ARCA. */
  fiscal: boolean;
  letter: InvoiceLetter;
  cbteClass: InvoiceClass;
  /** Código ARCA del tipo (006). null en no fiscal. */
  cbteCode: string | null;
  /** "Factura B", "Nota de crédito A", "Comprobante no fiscal". */
  label: string;
  /** Punto de venta (00003). */
  ptoVta: string;
  /** Número (00000012). */
  number: string;
  /** Fecha de emisión (ISO). */
  date: string;
  /** Concepto ARCA: 1 productos, 2 servicios, 3 ambos. */
  concepto?: 1 | 2 | 3 | null;
  /** Período facturado (servicios). ISO. */
  servicePeriod?: { from: string; to: string } | null;
  /** Vencimiento del pago (servicios). ISO. */
  paymentDue?: string | null;
  /** "Contado", "Cuenta corriente", "Tarjeta de crédito". */
  saleCondition: string;
  currency: InvoiceCurrency;
  issuer: InvoiceParty;
  receiver: InvoiceParty;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  /** Régimen de Transparencia Fiscal al Consumidor (Ley 27.743), B y C. */
  transparency?: { iva: number; others: number } | null;
  authorization?: InvoiceAuthorization | null;
  /** URL del QR fiscal de ARCA (RG 4892). */
  qrUrl?: string | null;
  /** Texto del QR del comprobante no fiscal (el QR va siempre). */
  qrFallbackText: string;
  /** Comprobantes asociados (NC / ND). */
  associated?: InvoiceAssociated[];
  payments?: InvoiceAmountRow[];
  notes?: string | null;
  /** Pie (agradecimiento) y leyendas del negocio. */
  footer?: string | null;
  legends?: string[];
  /** Número interno de la venta (#0001042). */
  internalRef?: string | null;
  /** Sucursal y caja (multi-sucursal). */
  branchText?: string | null;
  voided?: boolean;
  /** Factura en modo prueba (homologación): sin validez fiscal. */
  homologacion?: boolean;
  /** Factura pedida a ARCA y todavía sin CAE. */
  pendingAuthorization?: boolean;
  /** ORIGINAL / DUPLICADO (A4). */
  copy?: InvoiceCopy | null;
}
