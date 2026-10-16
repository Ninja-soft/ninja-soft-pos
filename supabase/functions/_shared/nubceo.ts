// =============================================================================
// NubCeo (conciliación de cobros): lógica PURA compartida por la Edge Function
// `nubceo_sync`, la pantalla de Configuración > Integraciones > NubCeo y los
// tests. Sin APIs de Deno ni imports: la Edge la importa con
// "../_shared/nubceo.ts" y Next/Vitest con "@/supabase/functions/_shared/nubceo".
// ADR-062.
//
// Contrato (documento "Especificación API Ventas y Contabilidad, nubceo
// Conciliaciones 5.0", versión 5, y el sincronizador de ANDESMAR que ya manda
// ventas reales a producción):
//   * Login: POST {base}/authenticate { API_KEY, API_SECRET } → { token } (JWT
//     de ~1 h, Bearer en cada pedido). Se renueva a los 50 min o ante un 401.
//   * TODAS las consultas son secuenciales (lo pide NubCeo): una cola interna.
//   * Ventas: POST {base}/v1/tenants/:tenant/reconciler/sales [venta...] (hasta
//     500). 200 → data.insertedSales[].insertedSaleId y
//     data.summary.existingSalesIds ("ID for company id N"). 400 con
//     errors[].SaleIndexNumber rechaza TODA la tanda (se reenvían las buenas).
//   * Borrar: POST {base}/v1/tenants/:tenant/:company/reconciler/sales/delete
//     { ids } → data.deletedSales.ids / noExistentSales.ids / reconciledSales.ids
//     (una venta con pagos conciliados no se puede borrar).
//   * Compañías: GET {base}/v1/tenants/tenants/:tenant/companies (el companyId
//     que piden borrar y modificar; se elige por taxCode).
//   * Asientos contables: GET {base}/v1/tenants/:tenant/accounting/ledger-header
//     (paginado, filtros filter[prop][op]=valor, orden sort[prop][dir]) →
//     data[] con LedgerEntries[] y su AccountingAccount. Confirmar o
//     desconfirmar: PATCH .../accounting/ledger-header/status { status, ids }.
//   * Una venta: id (externalCode, llave de idempotencia), type invoice |
//     creditNote, grossAmount = netAmount + taxAmount (si no cierra, NubCeo la
//     rechaza), relatedPayments[] con id único por pago. Lo vacío no se manda.
// =============================================================================

// -----------------------------------------------------------------------------
// Catálogos
// -----------------------------------------------------------------------------

export const NUBCEO_DEFAULT_API_URL = "https://connectapi.nubceo.com";

export type NubceoEnv = "test" | "prod";

/** Medios de pago de NinjaPOS (payments.method). */
export type PosMethod =
  | "cash"
  | "debit"
  | "credit"
  | "transfer"
  | "qr"
  | "directo"
  | "other"
  | "store_credit"
  | "account";

export const POS_METHODS: { key: PosMethod; label: string; hint: string }[] = [
  { key: "cash", label: "Efectivo", hint: "Billetes en la caja" },
  {
    key: "debit",
    label: "Tarjeta de débito",
    hint: "Posnet, Point o terminal integrada",
  },
  {
    key: "credit",
    label: "Tarjeta de crédito",
    hint: "Posnet, Point o terminal integrada, con cuotas",
  },
  {
    key: "transfer",
    label: "Transferencia",
    hint: "A tu cuenta bancaria o billetera",
  },
  {
    key: "qr",
    label: "QR y link de pago",
    hint: "Mercado Pago, MODO, GO Cuotas y otros",
  },
  { key: "directo", label: "Directo", hint: "Cobro por Directo" },
  {
    key: "other",
    label: "Otro medio",
    hint: "Lo que el cajero cargó como otro",
  },
  {
    key: "store_credit",
    label: "Vale o saldo a favor",
    hint: "No es plata que entra",
  },
  {
    key: "account",
    label: "Cuenta corriente",
    hint: "Se cobra después; no es plata que entra hoy",
  },
];

/** paymentType de NubCeo (enum de la especificación). */
export type NubceoPaymentType =
  | "cash"
  | "debit"
  | "credit"
  | "qr"
  | "wallet"
  | "offline"
  | "auto_debit"
  | "prepaid";

export const NUBCEO_PAYMENT_TYPES: {
  value: NubceoPaymentType;
  label: string;
}[] = [
  { value: "cash", label: "Efectivo (cash)" },
  { value: "debit", label: "Débito (debit)" },
  { value: "credit", label: "Crédito (credit)" },
  { value: "qr", label: "QR (qr)" },
  { value: "wallet", label: "Billetera (wallet)" },
  { value: "offline", label: "Fuera de línea (offline)" },
  { value: "auto_debit", label: "Débito automático (auto_debit)" },
  { value: "prepaid", label: "Prepaga (prepaid)" },
];

/** platformExternalCode de NubCeo para Argentina (lista de la especificación). */
export const NUBCEO_PLATFORMS: { code: string; label: string }[] = [
  { code: "mercadopago_ar", label: "Mercado Pago" },
  { code: "prisma_ar", label: "Prisma (Payway)" },
  { code: "getnet_ar", label: "Getnet" },
  { code: "fiserv_ar", label: "Fiserv (Clover)" },
  { code: "firstdata_ar", label: "Fiserv (First Data, código anterior)" },
  { code: "naranja_ar", label: "Naranja" },
  { code: "cabal_ar", label: "Cabal" },
  { code: "amex_ar", label: "American Express" },
  { code: "gocuotas_ar", label: "GO Cuotas" },
  { code: "moddo_ar", label: "MODO" },
  { code: "tiendanube_ar", label: "Tiendanube" },
  { code: "pedidosya_ar", label: "PedidosYa" },
  { code: "rappi_ar", label: "Rappi" },
  { code: "italcred_ar", label: "Italcred" },
  { code: "bilsantafe_ar", label: "Billetera Santa Fe" },
  { code: "worldpay_ar", label: "Worldpay" },
  { code: "glovo_ar", label: "Glovo" },
];

export function isNubceoPlatform(code: string): boolean {
  return NUBCEO_PLATFORMS.some((p) => p.code === code);
}

/** cardBrand de NubCeo (lista de la especificación). */
export const NUBCEO_CARD_BRANDS = [
  "VISA",
  "VISA DEBIT",
  "MASTERCARD",
  "MASTERCARD DEBIT",
  "CABAL",
  "CABAL DEBIT",
  "MAESTRO",
  "MAESTRO DEBIT",
  "NARANJA",
  "NARANJA DEBIT",
  "AMEX",
  "DINERS CLUB",
  "ARGENCARD",
  "RED LIDER",
  "TARJETA MAS",
  "FALABELLA CMR",
  "TICKET NACIÓN",
  "CDNI",
  "BNA+",
  "MODO",
  "MERCADO PAGO",
  "UALA",
  "BILLETERA SANTA FE",
  "BM CIUDAD",
  "OTHER",
] as const;

/**
 * Marca (etiqueta del cupón de NinjaPOS, sin tildes y en minúsculas) → marca de
 * NubCeo para crédito. Con débito se usa la variante DEBIT si NubCeo la tiene.
 */
const BRAND_BASE: Record<string, string> = {
  visa: "VISA",
  "visa debito": "VISA DEBIT",
  "visa electron": "VISA DEBIT",
  mastercard: "MASTERCARD",
  master: "MASTERCARD",
  "mastercard debito": "MASTERCARD DEBIT",
  maestro: "MAESTRO",
  cabal: "CABAL",
  "cabal debito": "CABAL DEBIT",
  naranja: "NARANJA",
  "naranja x": "NARANJA",
  amex: "AMEX",
  "american express": "AMEX",
  diners: "DINERS CLUB",
  "diners club": "DINERS CLUB",
  argencard: "ARGENCARD",
  "tarjeta mas": "TARJETA MAS",
  "cmr falabella": "FALABELLA CMR",
  "falabella cmr": "FALABELLA CMR",
  "cuenta dni": "CDNI",
  "bna+": "BNA+",
  modo: "MODO",
  "mercado pago": "MERCADO PAGO",
  mercadopago: "MERCADO PAGO",
  uala: "UALA",
};
const HAS_DEBIT_VARIANT = new Set([
  "VISA",
  "MASTERCARD",
  "CABAL",
  "MAESTRO",
  "NARANJA",
]);

/** Proveedor o adquirente de NinjaPOS → platformExternalCode por defecto. */
export const DEFAULT_PLATFORMS: Record<string, string> = {
  mercadopago: "mercadopago_ar",
  payway: "prisma_ar",
  getnet: "getnet_ar",
  fiserv: "fiserv_ar",
  gocuotas: "gocuotas_ar",
  modo: "moddo_ar",
  nave: "",
  mobbex: "",
  pagos360: "",
  directo: "",
  other: "",
};

export const PLATFORM_SOURCES: { key: string; label: string }[] = [
  { key: "mercadopago", label: "Mercado Pago (QR, link y Point)" },
  { key: "payway", label: "Payway" },
  { key: "getnet", label: "Getnet" },
  { key: "fiserv", label: "Fiserv / Clover" },
  { key: "nave", label: "Nave" },
  { key: "modo", label: "MODO" },
  { key: "gocuotas", label: "GO Cuotas" },
  { key: "mobbex", label: "Mobbex" },
  { key: "pagos360", label: "Pagos360" },
  { key: "directo", label: "Directo" },
  { key: "other", label: "Otra terminal" },
];

// -----------------------------------------------------------------------------
// Mapeo de campos (nubceo_settings.mapping)
// -----------------------------------------------------------------------------

export type CategorySource =
  | "none"
  | "store"
  | "register"
  | "cashier"
  | "customer"
  | "channel"
  | "fixed";

export const CATEGORY_SOURCES: { value: CategorySource; label: string }[] = [
  { value: "none", label: "No mandar" },
  { value: "store", label: "Nombre de la sucursal" },
  { value: "register", label: "Nombre de la caja" },
  { value: "cashier", label: "Cajero" },
  { value: "customer", label: "Cliente" },
  { value: "channel", label: "Canal (POS)" },
  { value: "fixed", label: "Texto fijo" },
];

export interface CategoryRule {
  source: CategorySource;
  /** Sólo con source = fixed. */
  value: string;
}

export interface MethodRule {
  /** Si el medio viaja como pago a NubCeo. */
  include: boolean;
  /** paymentType ("" = no mandar). */
  paymentType: NubceoPaymentType | "";
  /** Plataforma fija ("" = la resuelve el proveedor o el adquirente del cupón). */
  platform: string;
}

/** Datos opcionales de cada pago que se pueden apagar. */
export type PaymentFieldKey =
  | "platformBranchReference"
  | "cardNumber"
  | "voucher"
  | "batch"
  | "terminal"
  | "authorizationCode"
  | "installments"
  | "externalReference"
  | "buyerIdentification";

export const PAYMENT_FIELDS: {
  key: PaymentFieldKey;
  label: string;
  source: string;
}[] = [
  {
    key: "platformBranchReference",
    label: "platformBranchReference",
    source: "N° de comercio del cupón o del plan",
  },
  { key: "voucher", label: "voucher", source: "N° de cupón" },
  { key: "batch", label: "batch", source: "N° de lote" },
  {
    key: "terminal",
    label: "terminal",
    source: "Terminal integrada (número de serie o id)",
  },
  {
    key: "authorizationCode",
    label: "authorizationCode",
    source: "Código de autorización",
  },
  { key: "installments", label: "installments", source: "Cuotas" },
  {
    key: "cardNumber",
    label: "cardNumber",
    source: "Últimos 4 de la tarjeta (enmascarada)",
  },
  {
    key: "externalReference",
    label: "externalReference",
    source: "N° de operación del proveedor (QR, link o Point)",
  },
  {
    key: "buyerIdentification",
    label: "buyerIdentification",
    source: "Documento del cliente",
  },
];

export interface NubceoMapping {
  /** Cómo se arma el id de la venta en NubCeo (llave de idempotencia). */
  saleIdSource: "number" | "uuid";
  saleIdPrefix: string;
  /** store_id → customerBranchReference (código de la sucursal cabecera en NubCeo). */
  branchCodes: Record<string, string>;
  categories: [CategoryRule, CategoryRule, CategoryRule];
  internalReference: "sale_number" | "none";
  /** Fecha de cada pago: la de la venta o la del cobro. */
  paymentDate: "sale" | "payment";
  methods: Record<PosMethod, MethodRule>;
  /** Proveedor o adquirente → platformExternalCode. */
  platforms: Record<string, string>;
  /** Marca del cupón (minúsculas, sin tildes) → cardBrand de NubCeo (pisa la tabla). */
  cardBrands: Record<string, string>;
  paymentFields: Record<PaymentFieldKey, boolean>;
  /**
   * IVA para separar neto e impuestos cuando la venta no los trae (NinjaPOS
   * guarda precios finales): 0 = sin discriminar (neto = total).
   */
  taxRate: number;
  /** Devoluciones en efectivo como nota de crédito. */
  sendReturns: boolean;
  /** Anular una venta ya enviada la borra de NubCeo. */
  sendVoids: boolean;
}

export const DEFAULT_METHODS: Record<PosMethod, MethodRule> = {
  cash: { include: true, paymentType: "cash", platform: "" },
  debit: { include: true, paymentType: "debit", platform: "" },
  credit: { include: true, paymentType: "credit", platform: "" },
  transfer: { include: true, paymentType: "offline", platform: "" },
  qr: { include: true, paymentType: "qr", platform: "" },
  directo: { include: true, paymentType: "", platform: "" },
  other: { include: false, paymentType: "", platform: "" },
  store_credit: { include: false, paymentType: "prepaid", platform: "" },
  account: { include: false, paymentType: "", platform: "" },
};

export function defaultMapping(): NubceoMapping {
  return {
    saleIdSource: "number",
    saleIdPrefix: "NP-",
    branchCodes: {},
    categories: [
      { source: "store", value: "" },
      { source: "register", value: "" },
      { source: "channel", value: "" },
    ],
    internalReference: "sale_number",
    paymentDate: "payment",
    methods: Object.fromEntries(
      Object.entries(DEFAULT_METHODS).map(([k, v]) => [k, { ...v }]),
    ) as Record<PosMethod, MethodRule>,
    platforms: { ...DEFAULT_PLATFORMS },
    cardBrands: {},
    paymentFields: {
      platformBranchReference: true,
      cardNumber: true,
      voucher: true,
      batch: true,
      terminal: true,
      authorizationCode: true,
      installments: true,
      externalReference: true,
      buyerIdentification: true,
    },
    taxRate: 0,
    sendReturns: true,
    sendVoids: true,
  };
}

/** Alícuotas que ofrece la pantalla. */
export const TAX_RATES: { value: number; label: string }[] = [
  { value: 0, label: "Sin discriminar (neto = total)" },
  { value: 21, label: "IVA 21 % incluido" },
  { value: 10.5, label: "IVA 10,5 % incluido" },
  { value: 27, label: "IVA 27 % incluido" },
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const txt = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

const CATEGORY_SET = new Set<CategorySource>(
  CATEGORY_SOURCES.map((c) => c.value),
);
const PAYMENT_TYPE_SET = new Set<string>(
  NUBCEO_PAYMENT_TYPES.map((p) => p.value),
);

function normCategory(raw: unknown, fallback: CategoryRule): CategoryRule {
  if (!isObj(raw)) return { ...fallback };
  const source = CATEGORY_SET.has(raw.source as CategorySource)
    ? (raw.source as CategorySource)
    : fallback.source;
  return {
    source,
    value: source === "fixed" ? txt(raw.value).slice(0, 60) : "",
  };
}

/** Normaliza lo guardado (o lo que manda la pantalla) sobre los valores por defecto. */
export function normalizeMapping(raw: unknown): NubceoMapping {
  const d = defaultMapping();
  if (!isObj(raw)) return d;
  const out = d;
  if (raw.saleIdSource === "uuid" || raw.saleIdSource === "number")
    out.saleIdSource = raw.saleIdSource;
  if (typeof raw.saleIdPrefix === "string")
    out.saleIdPrefix = sanitizePrefix(raw.saleIdPrefix);
  if (isObj(raw.branchCodes)) {
    for (const [k, v] of Object.entries(raw.branchCodes)) {
      const code = txt(v).slice(0, 60);
      if (code) out.branchCodes[k] = code;
    }
  }
  if (Array.isArray(raw.categories)) {
    out.categories = [
      normCategory(raw.categories[0], d.categories[0]),
      normCategory(raw.categories[1], d.categories[1]),
      normCategory(raw.categories[2], d.categories[2]),
    ];
  }
  if (
    raw.internalReference === "none" ||
    raw.internalReference === "sale_number"
  ) {
    out.internalReference = raw.internalReference;
  }
  if (raw.paymentDate === "sale" || raw.paymentDate === "payment")
    out.paymentDate = raw.paymentDate;
  if (isObj(raw.methods)) {
    for (const m of POS_METHODS) {
      const r = raw.methods[m.key];
      if (!isObj(r)) continue;
      const base = out.methods[m.key];
      out.methods[m.key] = {
        include: typeof r.include === "boolean" ? r.include : base.include,
        paymentType:
          r.paymentType === ""
            ? ""
            : PAYMENT_TYPE_SET.has(String(r.paymentType))
              ? (r.paymentType as NubceoPaymentType)
              : base.paymentType,
        platform:
          typeof r.platform === "string" &&
          (r.platform === "" || isNubceoPlatform(r.platform))
            ? r.platform
            : base.platform,
      };
    }
  }
  if (isObj(raw.platforms)) {
    for (const s of PLATFORM_SOURCES) {
      const v = raw.platforms[s.key];
      if (typeof v === "string" && (v === "" || isNubceoPlatform(v)))
        out.platforms[s.key] = v;
    }
  }
  if (isObj(raw.cardBrands)) {
    for (const [k, v] of Object.entries(raw.cardBrands)) {
      const code = txt(v).toUpperCase();
      if (code && (NUBCEO_CARD_BRANDS as readonly string[]).includes(code))
        out.cardBrands[brandKey(k)] = code;
    }
  }
  if (isObj(raw.paymentFields)) {
    for (const f of PAYMENT_FIELDS) {
      const v = raw.paymentFields[f.key];
      if (typeof v === "boolean") out.paymentFields[f.key] = v;
    }
  }
  if (
    typeof raw.taxRate === "number" &&
    TAX_RATES.some((t) => t.value === raw.taxRate)
  )
    out.taxRate = raw.taxRate;
  if (typeof raw.sendReturns === "boolean") out.sendReturns = raw.sendReturns;
  if (typeof raw.sendVoids === "boolean") out.sendVoids = raw.sendVoids;
  return out;
}

/** Prefijo del id: letras, números, guion y guion bajo; hasta 12. Espejo de nubceo_settings_save. */
export function sanitizePrefix(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
}

/** Problemas que impiden mandar ventas con esta configuración (para la pantalla). */
export function mappingWarnings(
  m: NubceoMapping,
  storeIds: string[],
): string[] {
  const out: string[] = [];
  const missing = storeIds.filter((id) => !txt(m.branchCodes[id]));
  if (missing.length > 0) {
    out.push(
      missing.length === 1
        ? "Falta el código de sucursal cabecera de 1 sucursal incluida."
        : `Falta el código de sucursal cabecera de ${missing.length} sucursales incluidas.`,
    );
  }
  if (!POS_METHODS.some((p) => m.methods[p.key].include))
    out.push("No hay ningún medio de pago incluido.");
  m.categories.forEach((c, i) => {
    if (c.source === "fixed" && !c.value)
      out.push(`La categoría ${i + 1} es texto fijo pero está vacía.`);
  });
  return out;
}

// -----------------------------------------------------------------------------
// Id de la venta (llave de idempotencia). Espejo de nubceo_venta_id() en SQL.
// -----------------------------------------------------------------------------

export function ventaIdFor(
  m: Pick<NubceoMapping, "saleIdSource" | "saleIdPrefix">,
  sale: { id: string; number: number | string },
): string {
  const body = m.saleIdSource === "uuid" ? sale.id : String(sale.number);
  return `${sanitizePrefix(m.saleIdPrefix)}${body}`;
}

/** Nota de crédito de una devolución: id de la venta + "-NC" + n° de devolución. */
export function returnVentaIdFor(
  parentVentaId: string,
  returnNumber: number | string,
): string {
  return `${parentVentaId}-NC${returnNumber}`;
}

// -----------------------------------------------------------------------------
// Fechas y montos
// -----------------------------------------------------------------------------

/**
 * Fecha ISO con zona → hora de Argentina "YYYY-MM-DDTHH:mm:ss.000-03:00"
 * (Argentina no tiene horario de verano). Sin zona, se toma como ya local.
 */
export function fechaAr(valor: unknown): string {
  const s = txt(valor);
  if (!s) return "";
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const ms = new Date(s).getTime();
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms - 3 * 3600 * 1000);
    return d.toISOString().slice(0, 19) + ".000-03:00";
  }
  return s.replace(" ", "T").slice(0, 19) + ".000-03:00";
}

export const toCents = (n: unknown): number =>
  Math.round((Number(n) || 0) * 100);
export const fromCents = (c: number): number => Math.round(c) / 100;

// -----------------------------------------------------------------------------
// Armado de la venta (equivalente a armar.js de ANDESMAR)
// -----------------------------------------------------------------------------

/** Un pago ya resuelto, listo para armar. */
export interface EnvPayment {
  n: number;
  amount: number;
  include: boolean;
  platform: string;
  merchant: string;
  paymentType: string;
  brand: string;
  cardNumber: string;
  voucher: string;
  terminal: string;
  authorization: string;
  installments: number | null;
  externalRef: string;
  buyerId: string;
  batch: string;
  date: string;
}

/** Una venta ya clasificada, lista para armar. */
export interface SaleEnvelope {
  ventaId: string;
  type: "invoice" | "creditNote";
  branchRef: string;
  date: string;
  currency: string;
  /** Total del comprobante y neto (sin impuestos): se usa la proporción. */
  total: number;
  net: number;
  categories: [string, string, string];
  internalReference: string;
  buyerId: string;
  payments: EnvPayment[];
}

export interface NubceoPayment {
  id: string;
  presentedDate: string;
  date: string;
  grossAmount: number;
  currencyCode: string;
  platformExternalCode?: string;
  platformBranchReference?: string;
  paymentType?: string;
  cardBrand?: string;
  cardNumber?: string;
  voucher?: string;
  terminal?: string;
  authorizationCode?: string;
  installments?: number;
  externalReference?: string;
  buyerIdentification?: string;
  batch?: string;
}

export interface NubceoSale {
  saleIndexNumber: number;
  taxCode?: string;
  customerBranchReference: string;
  date: string;
  currencyCode: string;
  type: "invoice" | "creditNote";
  id: string;
  grossAmount: number;
  netAmount: number;
  taxAmount: number;
  categoryOne?: string;
  categoryTwo?: string;
  categoryThree?: string;
  internalReference?: string;
  relatedPayments: NubceoPayment[];
}

/**
 * La venta que recibe NubCeo. Total = suma de los pagos incluidos; neto en la
 * proporción del comprobante y impuestos = total − neto, en centavos enteros
 * (gross = net + tax siempre cierra). Nota de crédito: todo negativo. Lo vacío
 * no se manda.
 */
export function buildNubceoSale(
  env: SaleEnvelope,
  opts: {
    taxCode?: string;
    index: number;
    paymentDate?: "sale" | "payment";
    fields?: Partial<Record<PaymentFieldKey, boolean>>;
  },
): NubceoSale {
  const signo = env.type === "creditNote" ? -1 : 1;
  const incluidos = env.payments.filter((p) => p.include);
  const brutoC = incluidos.reduce((a, p) => a + Math.abs(toCents(p.amount)), 0);
  const totalC = Math.abs(toCents(env.total));
  const netoCompC = Math.abs(toCents(env.net));
  const netoC =
    totalC > 0
      ? Math.min(Math.round((brutoC * netoCompC) / totalC), brutoC)
      : brutoC;
  const venta: NubceoSale = {
    saleIndexNumber: opts.index,
    customerBranchReference: env.branchRef,
    date: fechaAr(env.date),
    currencyCode: env.currency || "ARS",
    type: env.type,
    id: env.ventaId,
    grossAmount: signo * fromCents(brutoC),
    netAmount: signo * fromCents(netoC),
    taxAmount: signo * fromCents(brutoC - netoC),
    relatedPayments: [],
  };
  const tax = txt(opts.taxCode).replace(/\D/g, "");
  if (tax) venta.taxCode = tax;
  const cats = ["categoryOne", "categoryTwo", "categoryThree"] as const;
  cats.forEach((k, i) => {
    const v = txt(env.categories[i]);
    if (v) venta[k] = v.slice(0, 100);
  });
  if (txt(env.internalReference))
    venta.internalReference = txt(env.internalReference);
  const on = (k: PaymentFieldKey) => opts.fields?.[k] !== false;
  venta.relatedPayments = incluidos.map((p) => {
    const fecha =
      opts.paymentDate === "sale"
        ? fechaAr(env.date)
        : fechaAr(p.date) || fechaAr(env.date);
    const x: NubceoPayment = {
      id: `${env.ventaId}-${p.n}`,
      presentedDate: fecha,
      date: fecha,
      grossAmount: signo * fromCents(Math.abs(toCents(p.amount))),
      currencyCode: env.currency || "ARS",
    };
    const poner = <K extends keyof NubceoPayment>(
      k: K,
      v: NubceoPayment[K] | "" | null | undefined,
    ) => {
      if (v !== "" && v !== null && v !== undefined)
        x[k] = v as NubceoPayment[K];
    };
    poner("platformExternalCode", txt(p.platform));
    if (on("platformBranchReference"))
      poner("platformBranchReference", txt(p.merchant));
    poner("paymentType", txt(p.paymentType));
    poner("cardBrand", txt(p.brand));
    if (on("cardNumber")) poner("cardNumber", txt(p.cardNumber));
    if (on("voucher")) poner("voucher", txt(p.voucher));
    if (on("terminal")) poner("terminal", txt(p.terminal));
    if (on("authorizationCode"))
      poner("authorizationCode", txt(p.authorization));
    if (on("installments"))
      poner(
        "installments",
        Number(p.installments) > 0 ? Math.trunc(Number(p.installments)) : null,
      );
    if (on("externalReference")) poner("externalReference", txt(p.externalRef));
    if (on("buyerIdentification"))
      poner("buyerIdentification", txt(p.buyerId) || txt(env.buyerId));
    if (on("batch")) poner("batch", txt(p.batch));
    return x;
  });
  return venta;
}

// -----------------------------------------------------------------------------
// De la venta de NinjaPOS al sobre (clasificación)
// -----------------------------------------------------------------------------

/** Pago de NinjaPOS tal como lo devuelve nubceo_snapshots(). */
export interface SnapPayment {
  id: string;
  method: string;
  amount: number | string;
  reference: string | null;
  card_voucher: Record<string, unknown> | null;
  created_at: string;
  /** provider_key del intent (QR, link, Point) si el pago tiene uno. */
  provider_key: string | null;
  /** Id de la operación en el proveedor (mp_payment_intents.mp_payment_id). */
  provider_payment_id: string | null;
}

/** Venta (o devolución) tal como la devuelve nubceo_snapshots(). */
export interface SaleSnapshot {
  sync_id: string;
  kind: "sale" | "return";
  venta_id: string;
  status: string;
  sale: {
    id: string;
    number: number;
    created_at: string;
    status: string;
    total: number | string;
    tax_total: number | string;
    store_id: string;
    store_name: string | null;
    register_name: string | null;
    cashier_name: string | null;
    customer_name: string | null;
    customer_doc: string | null;
  };
  payments: SnapPayment[];
  ret: {
    id: string;
    number: number;
    created_at: string;
    total: number | string;
    refund_method: string;
  } | null;
}

export interface ClassifyContext {
  mapping: NubceoMapping;
  /** null = todas las sucursales. */
  storeIds: string[] | null;
}

export type Classified =
  | { action: "exclude"; reason: string }
  | { action: "config_error"; reason: string }
  | { action: "send"; envelope: SaleEnvelope };

const normKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function brandKey(s: string): string {
  return normKey(s);
}

/** Marca del cupón → cardBrand de NubCeo ("" si no se reconoce). */
export function nubceoCardBrand(
  marca: string,
  method: string,
  overrides: Record<string, string> = {},
): string {
  const k = brandKey(marca);
  if (!k) return "";
  if (overrides[k]) return overrides[k] as string;
  let base = BRAND_BASE[k] ?? "";
  if (!base) {
    // "Visa Débito Galicia" o "Mastercard Black": la primera palabra conocida.
    const first = Object.keys(BRAND_BASE).find(
      (b) => !b.includes(" ") && k.split(" ").includes(b),
    );
    base = first ? (BRAND_BASE[first] as string) : "";
  }
  if (!base) return "";
  if (method === "debit" && HAS_DEBIT_VARIANT.has(base)) return `${base} DEBIT`;
  return base;
}

/** Proveedor del intent ("mercadopago_point", "fiserv_point"...) → marca base. */
export function providerBrand(providerKey: string | null | undefined): string {
  const k = txt(providerKey).toLowerCase();
  if (!k) return "";
  if (k === "fiserv_point" || k === "clover") return "fiserv";
  return k.replace(/_point$/, "").replace(/_qr$/, "");
}

/** Plataforma de un pago: fija del medio, la del proveedor o la del adquirente del cupón. */
export function resolvePlatform(p: SnapPayment, m: NubceoMapping): string {
  const rule = m.methods[p.method as PosMethod];
  if (rule?.platform) return rule.platform;
  const brand = providerBrand(p.provider_key);
  if (brand && m.platforms[brand] !== undefined)
    return m.platforms[brand] ?? "";
  const acq = txt(p.card_voucher?.adquirente).toLowerCase();
  if (acq && m.platforms[acq] !== undefined) return m.platforms[acq] ?? "";
  if (p.method === "directo") return m.platforms.directo ?? "";
  return "";
}

function categoryValue(rule: CategoryRule, s: SaleSnapshot): string {
  switch (rule.source) {
    case "store":
      return txt(s.sale.store_name);
    case "register":
      return txt(s.sale.register_name);
    case "cashier":
      return txt(s.sale.cashier_name);
    case "customer":
      return txt(s.sale.customer_name);
    case "channel":
      return "POS";
    case "fixed":
      return txt(rule.value);
    default:
      return "";
  }
}

/** Neto del comprobante: el impuesto de la venta si lo tiene; si no, la alícuota del mapeo. */
export function netOf(
  total: number,
  taxTotal: number,
  taxRate: number,
): number {
  const t = Math.abs(total);
  const tax = Math.abs(taxTotal);
  if (tax > 0) return Math.max(t - tax, 0);
  if (taxRate > 0)
    return fromCents(Math.round(toCents(t) / (1 + taxRate / 100)));
  return t;
}

const NA = new Set(["", "na", "n/a", "0", "-"]);
const clean = (v: unknown) => (NA.has(txt(v).toLowerCase()) ? "" : txt(v));

/**
 * Decide qué se hace con una venta: excluir (regla), error de configuración
 * (no se reintenta solo) o mandar con su sobre armado.
 */
export function classifySnapshot(
  s: SaleSnapshot,
  ctx: ClassifyContext,
): Classified {
  const m = ctx.mapping;
  if (ctx.storeIds && !ctx.storeIds.includes(s.sale.store_id)) {
    return { action: "exclude", reason: "Sucursal no incluida" };
  }
  const branchRef = txt(m.branchCodes[s.sale.store_id]);
  if (!branchRef) {
    return {
      action: "config_error",
      reason: `Falta el código de sucursal cabecera de ${txt(s.sale.store_name) || "la sucursal"}`,
    };
  }
  const categories = m.categories.map((c) => categoryValue(c, s)) as [
    string,
    string,
    string,
  ];
  const buyerId = txt(s.sale.customer_doc).replace(/[^\dA-Za-z]/g, "");

  if (s.kind === "return") {
    if (!m.sendReturns)
      return { action: "exclude", reason: "Devoluciones apagadas" };
    const r = s.ret;
    if (!r) return { action: "exclude", reason: "Devolución inexistente" };
    if (r.refund_method !== "cash")
      return {
        action: "exclude",
        reason: "Devolución sin reintegro de dinero",
      };
    if (!m.methods.cash.include)
      return { action: "exclude", reason: "Efectivo no incluido" };
    const total = Math.abs(Number(r.total) || 0);
    if (total <= 0) return { action: "exclude", reason: "Devolución en cero" };
    const saleTotal = Math.abs(Number(s.sale.total) || 0);
    const saleNet = netOf(saleTotal, Number(s.sale.tax_total) || 0, m.taxRate);
    return {
      action: "send",
      envelope: {
        ventaId: s.venta_id,
        type: "creditNote",
        branchRef,
        date: r.created_at,
        currency: "ARS",
        total: saleTotal,
        net: saleNet,
        categories,
        internalReference:
          m.internalReference === "sale_number"
            ? `Devolución ${r.number} de la venta ${s.sale.number}`
            : "",
        buyerId,
        payments: [
          {
            n: 1,
            amount: total,
            include: true,
            platform: "",
            merchant: "",
            paymentType: m.methods.cash.paymentType,
            brand: "",
            cardNumber: "",
            voucher: "",
            terminal: "",
            authorization: "",
            installments: null,
            externalRef: "",
            buyerId,
            batch: "",
            date: r.created_at,
          },
        ],
      },
    };
  }

  if (s.sale.status === "voided")
    return { action: "exclude", reason: "Venta anulada" };
  const total = Number(s.sale.total) || 0;
  if (total <= 0) return { action: "exclude", reason: "Venta en cero" };

  // Orden estable (fecha y id): el n° de cada pago es parte de su id en NubCeo.
  const sorted = s.payments
    .slice()
    .sort((a, b) =>
      a.created_at < b.created_at
        ? -1
        : a.created_at > b.created_at
          ? 1
          : a.id < b.id
            ? -1
            : 1,
    );
  const payments: EnvPayment[] = sorted.map((p, i) => {
    const rule = m.methods[p.method as PosMethod] ?? {
      include: false,
      paymentType: "",
      platform: "",
    };
    const v = p.card_voucher ?? {};
    const last4 = clean(v.ultimos4).replace(/\D/g, "").slice(-4);
    const isCard = p.method === "debit" || p.method === "credit";
    const brand = isCard
      ? nubceoCardBrand(txt(v.marca), p.method, m.cardBrands)
      : "";
    const providerRef = clean(p.provider_payment_id);
    return {
      n: i + 1,
      amount: Number(p.amount) || 0,
      include: rule.include && (Number(p.amount) || 0) > 0,
      platform: resolvePlatform(p, m),
      merchant: clean(v.comercio),
      paymentType: rule.paymentType,
      brand,
      cardNumber: last4.length === 4 ? `************${last4}` : "",
      voucher: clean(v.cupon),
      terminal: clean(v.terminal ?? v.terminal_id),
      authorization: clean(v.autorizacion).toUpperCase(),
      installments:
        Number(v.cuotas ?? v.installments) > 0
          ? Math.trunc(Number(v.cuotas ?? v.installments))
          : null,
      externalRef:
        providerRef || (p.method === "directo" ? clean(p.reference) : ""),
      buyerId,
      batch: clean(v.lote),
      date: p.created_at,
    };
  });
  // Vuelto: si los cobros suman más que la venta, el excedente sale del
  // efectivo (lo entregado no es lo que entró).
  let excessC =
    payments.reduce((a, p) => a + toCents(p.amount), 0) - toCents(total);
  if (excessC > 0) {
    for (const p of payments
      .filter((x) => sorted[x.n - 1]?.method === "cash")
      .sort((a, b) => b.amount - a.amount)) {
      const take = Math.min(excessC, toCents(p.amount));
      p.amount = fromCents(toCents(p.amount) - take);
      if (p.amount <= 0) p.include = false;
      excessC -= take;
      if (excessC <= 0) break;
    }
  }
  if (!payments.some((p) => p.include)) {
    return { action: "exclude", reason: "Sin medios de pago incluidos" };
  }
  return {
    action: "send",
    envelope: {
      ventaId: s.venta_id,
      type: "invoice",
      branchRef,
      date: s.sale.created_at,
      currency: "ARS",
      total,
      net: netOf(total, Number(s.sale.tax_total) || 0, m.taxRate),
      categories,
      internalReference:
        m.internalReference === "sale_number" ? `Venta ${s.sale.number}` : "",
      buyerId,
      payments,
    },
  };
}

// -----------------------------------------------------------------------------
// Huella del payload (detecta cambios entre envíos y simulaciones)
// -----------------------------------------------------------------------------

/** FNV-1a de 32 bits del JSON con claves ordenadas, en hex. */
export function payloadHash(v: unknown): string {
  const s = stableJson(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

// -----------------------------------------------------------------------------
// Respuestas de NubCeo (equivalente a respuesta.js de ANDESMAR)
// -----------------------------------------------------------------------------

export interface ApiResult {
  /** 0 = sin respuesta (red, timeout). */
  status: number;
  body: unknown;
  error?: string;
}

export type SaleOutcome =
  | { result: "ok" }
  | { result: "already" }
  | { result: "unconfirmed"; message: string }
  | { result: "rejected"; message: string };

export interface InsertReading {
  kind: "ok" | "rejected" | "split" | "credentials" | "retry";
  results: Record<string, SaleOutcome>;
  message: string;
}

/** Los ids "existentes" vienen como texto: "ASD-007-ps for company id 1194". */
export const idOf = (s: unknown): string =>
  txt(s)
    .replace(/\s+for company id.*$/i, "")
    .trim();

export function readInsertResponse(
  res: ApiResult | null | undefined,
  ids: string[],
): InsertReading {
  const results: Record<string, SaleOutcome> = {};
  if (!res || !res.status) {
    return {
      kind: "retry",
      results,
      message: `Sin respuesta de NubCeo: ${res?.error || "error de red"}`,
    };
  }
  const b = isObj(res.body) ? res.body : {};
  if (res.status === 200 || res.status === 201) {
    const d = isObj(b.data) ? b.data : {};
    const ins = Array.isArray(d.insertedSales)
      ? d.insertedSales
      : Array.isArray(d.insertedPosSales)
        ? d.insertedPosSales
        : [];
    const inserted = new Set(
      ins.map((x: unknown) =>
        idOf(isObj(x) ? (x.insertedSaleId ?? x.insertedPosSaleId) : ""),
      ),
    );
    const summary = isObj(d.summary) ? d.summary : {};
    const existingRaw = Array.isArray(summary.existingSalesIds)
      ? summary.existingSalesIds
      : Array.isArray(summary.existingPosSalesIds)
        ? summary.existingPosSalesIds
        : [];
    const existing = new Set(existingRaw.map(idOf));
    for (const id of ids) {
      results[id] = inserted.has(id)
        ? { result: "ok" }
        : existing.has(id)
          ? { result: "already" }
          : {
              result: "unconfirmed",
              message: "NubCeo respondió 200 pero no nombró la venta",
            };
    }
    return { kind: "ok", results, message: "" };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "credentials",
      results,
      message: `NubCeo rechazó las credenciales (${res.status})`,
    };
  }
  if (res.status === 400) {
    const errors = Array.isArray(b.errors) ? b.errors : [];
    const indexOf = (e: unknown): number | null => {
      if (!isObj(e)) return null;
      const i = Number.isInteger(e.SaleIndexNumber)
        ? e.SaleIndexNumber
        : Number.isInteger(e.saleIndexNumber)
          ? e.saleIndexNumber
          : null;
      return typeof i === "number" ? i : null;
    };
    // Un índice fuera de rango no cuenta (si contara, se reenviaría la tanda
    // entera para siempre contra la misma respuesta).
    const withIndex = errors.filter((e: unknown) => {
      const i = indexOf(e);
      return i !== null && i >= 0 && i < ids.length;
    });
    if (withIndex.length > 0) {
      for (const e of withIndex) {
        const id = ids[indexOf(e) as number] as string;
        const prev = results[id];
        const msg = txt(isObj(e) ? e.message : "") || "Rechazada por NubCeo";
        results[id] = {
          result: "rejected",
          message:
            prev && prev.result === "rejected"
              ? `${prev.message} · ${msg}`
              : msg,
        };
      }
      return { kind: "rejected", results, message: "" };
    }
    const first = errors[0];
    const message =
      txt(b.message) ||
      txt(isObj(first) ? first.message : "") ||
      txt(b.code) ||
      "NubCeo rechazó la tanda";
    if (ids.length > 1) return { kind: "split", results, message };
    if (ids[0]) results[ids[0]] = { result: "rejected", message };
    return { kind: "rejected", results, message };
  }
  return {
    kind: "retry",
    results,
    message: `NubCeo respondió ${res.status}${txt(b.message) ? `: ${txt(b.message)}` : ""}`,
  };
}

export type DeleteOutcome =
  | { result: "deleted"; message?: string }
  | { result: "reconciled"; message: string }
  | { result: "retry"; message: string };

export function readDeleteResponse(
  res: ApiResult | null | undefined,
  ids: string[],
): Record<string, DeleteOutcome> {
  const out: Record<string, DeleteOutcome> = {};
  if (!res || res.status !== 200) {
    const message = res?.status
      ? `NubCeo respondió ${res.status}`
      : "Sin respuesta de NubCeo";
    for (const id of ids) out[id] = { result: "retry", message };
    return out;
  }
  const b = isObj(res.body) ? res.body : {};
  const d = isObj(b.data) ? b.data : {};
  const set = (k: string) => {
    const g = d[k];
    const list = isObj(g) && Array.isArray(g.ids) ? g.ids : [];
    return new Set(list.map(idOf));
  };
  const deleted = set("deletedSales");
  const missing = set("noExistentSales");
  const reconciled = set("reconciledSales");
  for (const id of ids) {
    out[id] = deleted.has(id)
      ? { result: "deleted" }
      : missing.has(id)
        ? { result: "deleted", message: "NubCeo no la tenía" }
        : reconciled.has(id)
          ? {
              result: "reconciled",
              message: "NubCeo ya la concilió: no se puede borrar",
            }
          : { result: "retry", message: "NubCeo no nombró la venta" };
  }
  return out;
}

// -----------------------------------------------------------------------------
// Reintentos, ritmo y ventana horaria
// -----------------------------------------------------------------------------

/** Minutos de espera según el intento (el último se repite). */
export const RETRY_MINUTES = [1, 5, 15, 30, 60, 180];

export function nextAttemptAt(
  attempts: number,
  nowMs: number,
  minutes: number[] = RETRY_MINUTES,
): string {
  const list = minutes.length > 0 ? minutes : [1];
  const idx = Math.min(Math.max(Math.trunc(attempts) - 1, 0), list.length - 1);
  return new Date(nowMs + (list[idx] as number) * 60_000).toISOString();
}

export const exhausted = (attempts: number, max: number): boolean =>
  attempts >= max;

/** Ritmos que ofrece la pantalla (minutos). Espejo del check de nubceo_settings. */
export const EVERY_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "Cada 5 minutos" },
  { minutes: 15, label: "Cada 15 minutos" },
  { minutes: 30, label: "Cada 30 minutos" },
  { minutes: 60, label: "Cada 1 hora" },
  { minutes: 120, label: "Cada 2 horas" },
  { minutes: 360, label: "Cada 6 horas" },
  { minutes: 720, label: "Cada 12 horas" },
  { minutes: 1440, label: "Una vez por día" },
];

export interface WindowCfg {
  /** "HH:MM" hora de Argentina. Igual inicio y fin = todo el día. */
  start: string;
  end: string;
  /** 0 = domingo ... 6 = sábado. */
  days: number[];
}

export function argentinaParts(ms: number): {
  day: number;
  hhmm: string;
  date: string;
} {
  const d = new Date(ms - 3 * 3600 * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return {
    day: d.getUTCDay(),
    hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
  };
}

const hhmm = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(txt(s));
  if (!m) return "";
  return `${String(Math.min(Number(m[1]), 23)).padStart(2, "0")}:${m[2]}`;
};

/**
 * ¿Se puede enviar en este momento? Espejo de nubceo_in_window() en SQL.
 * Franja [inicio, fin) en hora de Argentina; si fin < inicio cruza la
 * medianoche (y el día que cuenta es el del inicio de la franja).
 */
export function inWindow(w: WindowCfg, ms: number): boolean {
  const days = Array.isArray(w.days) ? w.days : [];
  const { day, hhmm: now } = argentinaParts(ms);
  const s = hhmm(w.start) || "00:00";
  const e = hhmm(w.end) || "00:00";
  if (s === e) return days.includes(day);
  if (s < e) return days.includes(day) && now >= s && now < e;
  // Cruza la medianoche: antes de la medianoche cuenta hoy; después, ayer.
  if (now >= s) return days.includes(day);
  if (now < e) return days.includes((day + 6) % 7);
  return false;
}

/** Próxima vuelta: ahora + el ritmo, al minuto. */
export function nextRunAt(nowMs: number, everyMinutes: number): string {
  const every = Math.max(5, Math.trunc(everyMinutes) || 60);
  const base = Math.floor(nowMs / 60_000) * 60_000;
  return new Date(base + every * 60_000).toISOString();
}

// -----------------------------------------------------------------------------
// Credenciales y URL
// -----------------------------------------------------------------------------

/**
 * Sólo https contra connectapi.nubceo.com o un subdominio de nubceo.com, sin
 * usuario:clave@ ni puertos raros: si la URL fuese libre, el sincronizador le
 * mandaría la API key y el secreto a cualquier servidor. Espejo del check SQL.
 */
export function allowedApiUrl(
  v: unknown,
): { ok: true; url: string } | { ok: false; reason: string } {
  const s = txt(v);
  if (!s) return { ok: true, url: NUBCEO_DEFAULT_API_URL };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "La URL de la API no es válida" };
  }
  const host = u.hostname.toLowerCase();
  const hostOk = host === "nubceo.com" || host.endsWith(".nubceo.com");
  if (u.protocol !== "https:")
    return { ok: false, reason: "La URL de la API tiene que ser https" };
  if (!hostOk)
    return {
      ok: false,
      reason: "La URL de la API tiene que ser de nubceo.com",
    };
  if (u.username || u.password)
    return { ok: false, reason: "La URL no puede llevar usuario ni clave" };
  if (u.port !== "" && u.port !== "443")
    return { ok: false, reason: "Puerto no permitido" };
  return { ok: true, url: (u.origin + u.pathname).replace(/\/+$/, "") };
}

/** Compañía del CUIT (taxCode) o la única que haya. */
export function pickCompany(
  body: unknown,
  taxCode: string,
): { id: string; name: string } | null {
  const b = isObj(body) ? body : {};
  const list = (Array.isArray(b.data) ? b.data : []).filter(isObj);
  const tax = txt(taxCode).replace(/\D/g, "");
  const match = tax
    ? list.find((c) => txt(c.taxCode).replace(/\D/g, "") === tax)
    : undefined;
  const pick = match ?? (list.length === 1 ? list[0] : undefined);
  return pick ? { id: txt(pick.id), name: txt(pick.name) } : null;
}

export function listCompanies(
  body: unknown,
): { id: string; name: string; taxCode: string }[] {
  const b = isObj(body) ? body : {};
  return (Array.isArray(b.data) ? b.data : [])
    .filter(isObj)
    .map((c) => ({
      id: txt(c.id),
      name: txt(c.name),
      taxCode: txt(c.taxCode),
    }));
}

// -----------------------------------------------------------------------------
// Asientos contables (ledger headers)
// -----------------------------------------------------------------------------

export interface LedgerEntry {
  nubceo_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  subaccount_code: string;
  subaccount_name: string;
  cost_center: string;
  /** Con signo: positivo = Debe, negativo = Haber (a confirmar con NubCeo). */
  amount: number;
}

export interface LedgerHeader {
  nubceo_id: string;
  number: string;
  company_id: string;
  batch_id: string;
  category: string;
  status: "confirmed" | "not_confirmed";
  date: string;
  currency: string;
  deleted: boolean;
  entries: LedgerEntry[];
}

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** data[] de GET /accounting/ledger-header → asientos normalizados. */
export function parseLedgerPage(body: unknown): {
  headers: LedgerHeader[];
  total: number;
  count: number;
  /** Filas que vinieron en la página, válidas o no (para saber si hay más). */
  rows: number;
  /** El `updatedAt` más nuevo de la página (el listado viene ordenado por él). */
  lastUpdatedAt: string | null;
} {
  const b = isObj(body) ? body : {};
  const meta = isObj(b.meta) ? b.meta : {};
  const rows = (Array.isArray(b.data) ? b.data : []).filter(isObj);
  const headers = rows
    .map((h): LedgerHeader => {
      const entriesRaw = pick(h, "LedgerEntries", "ledgerEntries", "entries");
      const entries = (Array.isArray(entriesRaw) ? entriesRaw : [])
        .filter(isObj)
        .map((e): LedgerEntry => {
          const accRaw = pick(e, "AccountingAccount", "accountingAccount");
          const acc = isObj(accRaw) ? accRaw : {};
          return {
            nubceo_id: txt(e.id),
            account_id: txt(pick(e, "accountingAccountId") ?? acc.id),
            account_code: txt(acc.code),
            account_name: txt(acc.name),
            subaccount_code: txt(acc.subaccountCode),
            subaccount_name: txt(acc.subaccountName),
            cost_center: txt(e.costCenterCode),
            amount: fromCents(toCents(e.amount)),
          };
        });
      const dateRaw = txt(h.date);
      return {
        nubceo_id: txt(h.id),
        number: txt(h.number),
        company_id: txt(h.companyId),
        batch_id: txt(h.accountingBatchId),
        category: txt(h.ledgerCategory),
        status: txt(h.status) === "confirmed" ? "confirmed" : "not_confirmed",
        date: /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : "",
        currency: txt(h.currencyCode) || "ARS",
        deleted: Boolean(txt(h.deletedAt)),
        entries,
      };
    })
    .filter((h) => h.nubceo_id && h.date);
  let lastUpdatedAt: string | null = null;
  for (const h of rows) {
    const u = txt(pick(h, "updatedAt", "updated_at"));
    if (u && !Number.isNaN(Date.parse(u)) && (!lastUpdatedAt || Date.parse(u) > Date.parse(lastUpdatedAt))) {
      lastUpdatedAt = u;
    }
  }
  return {
    headers,
    total: Number(meta.total) || 0,
    count: Number(meta.count) || headers.length,
    rows: rows.length,
    lastUpdatedAt,
  };
}

/**
 * Desde dónde sigue la próxima importación de asientos.
 *
 * Si la vuelta trajo todo, desde que empezó. Si cortó por el tope de páginas,
 * desde el `updatedAt` del último asiento traído (el filtro es `gte`, así que
 * ese asiento se vuelve a traer y se pisa igual): nunca desde que empezó,
 * porque los asientos que quedaron sin traer tienen un `updatedAt` anterior y
 * se perderían para siempre. Si falló, queda el cursor anterior.
 */
export function ledgerNextCursor(o: {
  ok: boolean;
  complete: boolean;
  startedAt: string;
  previous: string | null;
  lastUpdatedAt: string | null;
}): string | null {
  if (!o.ok) return o.previous;
  if (o.complete) return o.startedAt;
  return o.lastUpdatedAt ?? o.previous;
}

export const LEDGER_CATEGORY_LABEL: Record<string, string> = {
  settlement: "Liquidación",
};

/** Query string del listado de asientos (desde una fecha de actualización). */
export function ledgerQuery(opts: {
  page: number;
  pageSize: number;
  updatedSince?: string | null;
}): string {
  const q = [
    `page=${Math.max(1, Math.trunc(opts.page))}`,
    `pageSize=${Math.min(Math.max(1, Math.trunc(opts.pageSize)), 500)}`,
  ];
  q.push(`sort[updatedAt][dir]=asc`);
  if (opts.updatedSince)
    q.push(`filter[updatedAt][gte]=${encodeURIComponent(opts.updatedSince)}`);
  return q.join("&");
}

// -----------------------------------------------------------------------------
// Cliente HTTP (fetch inyectable; nunca tira)
// -----------------------------------------------------------------------------

export interface NubceoApiOpts {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  tenant: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export function createNubceoApi(o: NubceoApiOpts) {
  const base = String(o.baseUrl || NUBCEO_DEFAULT_API_URL).replace(/\/+$/, "");
  const t = encodeURIComponent(String(o.tenant || ""));
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 60_000;
  const now = o.now ?? (() => Date.now());
  let token: string | null = null;
  let tokenAt = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const inQueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await doFetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { message: String(text).slice(0, 500) };
      }
      return { status: r.status, body: json };
    } catch (e) {
      const byTime = e instanceof Error && e.name === "AbortError";
      return {
        status: 0,
        body: null,
        error: byTime
          ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)} s)`
          : String(e instanceof Error ? e.message : e),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Sólo 400/401/403 en el login son credenciales (→ 401). Un 2xx sin token
  // tampoco vuelve como 2xx (se leería como éxito): va como 502.
  async function login(): Promise<ApiResult | null> {
    token = null;
    const r = await call("POST", "/authenticate", {
      API_KEY: o.apiKey,
      API_SECRET: o.apiSecret,
    });
    const tk = isObj(r.body) ? txt(r.body.token) : "";
    if (r.status === 200 && tk) {
      token = tk;
      tokenAt = now();
      return null;
    }
    if (r.status === 400 || r.status === 401 || r.status === 403)
      return { ...r, status: 401 };
    if (r.status >= 200 && r.status < 300) {
      return {
        status: 502,
        body: { message: `El login de NubCeo respondió ${r.status} sin token` },
      };
    }
    return r;
  }

  async function authed(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult> {
    if (!token || now() - tokenAt > 50 * 60_000) {
      const fail = await login();
      if (fail) return fail;
    }
    let r = await call(method, path, body);
    if (r.status === 401) {
      const fail = await login();
      if (fail) return fail;
      r = await call(method, path, body);
    }
    return r;
  }

  return {
    login: () => inQueue(login),
    insertSales: (sales: NubceoSale[]) =>
      inQueue(() => authed("POST", `/v1/tenants/${t}/reconciler/sales`, sales)),
    deleteSales: (companyId: string, ids: string[]) =>
      inQueue(() =>
        authed(
          "POST",
          `/v1/tenants/${t}/${encodeURIComponent(companyId)}/reconciler/sales/delete`,
          { ids },
        ),
      ),
    companies: () =>
      inQueue(() => authed("GET", `/v1/tenants/tenants/${t}/companies`)),
    ledgerHeaders: (query: string) =>
      inQueue(() =>
        authed("GET", `/v1/tenants/${t}/accounting/ledger-header?${query}`),
      ),
    ledgerStatus: (status: "confirmed" | "not_confirmed", ids: string[]) =>
      inQueue(() =>
        authed("PATCH", `/v1/tenants/${t}/accounting/ledger-header/status`, {
          status,
          ids,
        }),
      ),
    /** Ventas enviadas con su estado de conciliación (ADR-162, H153). */
    reconciledSales: (query: string) =>
      inQueue(() => authed("GET", `/v1/tenants/${t}/reconciler/sales?${query}`)),
  };
}

// -----------------------------------------------------------------------------
// Estado de conciliación por venta (ADR-162, H153)
// -----------------------------------------------------------------------------

export type ReconciledStatus = "reconciled" | "pending" | "difference";

export interface ReconciledRow {
  venta_id: string;
  status: ReconciledStatus;
  reconciled_at: string | null;
  detail: Record<string, unknown> | null;
}

/** Query del listado de ventas con su conciliación, por fecha de la venta. */
export function reconciledQuery(opts: { page: number; pageSize: number; from: string; to: string }): string {
  const q = [
    "getReconciledSales=true",
    `page=${Math.max(1, Math.trunc(opts.page))}`,
    `pageSize=${Math.min(Math.max(1, Math.trunc(opts.pageSize)), 500)}`,
    `filter[fecha][gte]=${encodeURIComponent(opts.from)}`,
    `filter[fecha][lte]=${encodeURIComponent(opts.to)}`,
  ];
  return q.join("&");
}

/** Estado de NubCeo en palabras nuestras. Sin estado reconocible: null. */
export function reconciledStatusOf(raw: unknown): ReconciledStatus | null {
  const s = txt(raw)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s-]+/g, "_");
  if (!s) return null;
  if (/(diff|difer|partial|parcial|mismatch|inconsist)/.test(s)) return "difference";
  if (/^(not_|no_|un|sin_|pending|pendiente|unreconciled)/.test(s)) return "pending";
  if (/(reconciled|conciliad|matched|ok$|complete)/.test(s)) return "reconciled";
  return "pending";
}

/** data[] de GET /reconciler/sales?getReconciledSales=true → estado por venta_id. */
export function parseReconciledSales(body: unknown): { rows: ReconciledRow[]; total: number; count: number } {
  const b = isObj(body) ? body : {};
  const meta = isObj(b.meta) ? b.meta : {};
  const list = (Array.isArray(b.data) ? b.data : Array.isArray(body) ? (body as unknown[]) : []).filter(isObj);
  const rows: ReconciledRow[] = [];
  for (const r of list) {
    const venta = txt(pick(r, "venta_id", "ventaId", "saleId", "externalId", "external_id", "id"));
    const status = reconciledStatusOf(pick(r, "reconciliationStatus", "reconciliation_status", "status"));
    if (!venta || !status) continue;
    const at = txt(pick(r, "reconciledAt", "reconciliationDate", "updatedAt"));
    const diff = pick(r, "difference", "diferencia", "reconciliationDifference");
    rows.push({
      venta_id: venta.slice(0, 200),
      status,
      reconciled_at: status === "reconciled" && at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null,
      detail: diff !== undefined ? { difference: diff } : null,
    });
  }
  return { rows, total: Number(meta.total) || 0, count: Number(meta.count) || list.length };
}

export type NubceoApi = ReturnType<typeof createNubceoApi>;
