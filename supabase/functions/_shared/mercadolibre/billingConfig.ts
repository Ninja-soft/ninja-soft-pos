// =============================================================================
// _shared/mercadolibre/billingConfig.ts (ADR-145 sobre ADR-141). PURO, sin
// dependencias de runtime.
//
// Piezas de la configuración de facturación de Mercado Libre que comparten la
// pantalla (vista previa), el worker (PDF y mensaje al subir la factura) y la
// Edge ml_facturacion (mensaje de la percepción):
//
//   • Plantillas con variables entre llaves: {comprador}, {venta}, {monto},
//     {link}, {jurisdiccion}, {factura}, {total}, {fecha}, {envio}… Lo que no
//     es una variable conocida queda tal cual (así el dueño ve el error en la
//     vista previa en lugar de un texto vacío).
//   • Textos de ejemplo precargados: mensaje de la percepción (pensado para
//     entrar en los 350 caracteres de la guía de acciones de ML con el link
//     completo de Mercado Pago), mensaje al subir la factura y leyenda de la
//     factura. null en la base = el ejemplo vigente.
//   • Sucursal y depósito por tipo de envío: la regla del tipo, si no la
//     "por defecto", si no la de la cuenta (ml_location_map). El SQL
//     (_ml_logistic_store) aplica exactamente este orden.
// =============================================================================

export type TemplateKind = "perception" | "invoice_message" | "invoice_notes";

export interface TemplateVar {
  key: string;
  label: string;
  example: string;
}

/** Variables de cada plantilla (con el valor de la venta de ejemplo). */
export const TEMPLATE_VARS: Record<TemplateKind, TemplateVar[]> = {
  perception: [
    { key: "comprador", label: "Nombre del comprador", example: "Martina" },
    { key: "monto", label: "Monto de la percepción", example: "$ 1.875,00" },
    { key: "link", label: "Link de pago de Mercado Pago", example: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123456789-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d" },
    { key: "venta", label: "Número de venta de Mercado Libre", example: "2000012345678901" },
    { key: "jurisdiccion", label: "Provincias que perciben", example: "Buenos Aires" },
    { key: "detalle", label: "Provincias con su alícuota", example: "Buenos Aires 1,5 %" },
    { key: "dias", label: "Días para pagar", example: "3" },
  ],
  invoice_message: [
    { key: "comprador", label: "Nombre del comprador", example: "Martina" },
    { key: "factura", label: "Tipo y número de factura", example: "A 00004-00000123" },
    { key: "total", label: "Total facturado", example: "$ 126.875,00" },
    { key: "venta", label: "Número de venta de Mercado Libre", example: "2000012345678901" },
    { key: "fecha", label: "Fecha de la factura", example: "15/10/2026" },
  ],
  invoice_notes: [
    { key: "venta", label: "Número de venta de Mercado Libre", example: "2000012345678901" },
    { key: "comprador", label: "Nombre del comprador", example: "Martina" },
    { key: "envio", label: "Tipo de envío", example: "Mercado Envíos" },
    { key: "fecha", label: "Fecha de la venta", example: "15/10/2026" },
  ],
};

/** Ejemplo precargado del mensaje de la percepción (editable). */
export const DEFAULT_PERCEPTION_MESSAGE =
  "Hola {comprador}, pediste factura A y figurás en el padrón de percepciones de Ingresos Brutos de {jurisdiccion}. " +
  "Eso suma {monto} a tu compra. Si no querés abonarlo, te facturamos B; si querés la A, pagá este link: {link}";

/** Mensaje al comprador cuando la factura queda subida a la venta. */
export const DEFAULT_INVOICE_MESSAGE =
  "Hola {comprador}, ya está tu factura {factura} por {total} de la compra #{venta}. " +
  "La descargás desde el detalle de la compra en Mercado Libre. ¡Gracias por elegirnos!";

/** Leyenda que va impresa en la factura (observaciones del comprobante). */
export const DEFAULT_INVOICE_NOTES = "Venta en Mercado Libre #{venta}. Gracias por tu compra.";

export const DEFAULT_TEMPLATES: Record<TemplateKind, string> = {
  perception: DEFAULT_PERCEPTION_MESSAGE,
  invoice_message: DEFAULT_INVOICE_MESSAGE,
  invoice_notes: DEFAULT_INVOICE_NOTES,
};

/** Topes: guía de acciones de ML, mensaje postventa y leyenda del PDF. */
export const TEMPLATE_LIMITS: Record<TemplateKind, { max: number; stored: number }> = {
  perception: { max: 350, stored: 1000 },
  invoice_message: { max: 350, stored: 1000 },
  invoice_notes: { max: 240, stored: 300 },
};

const VAR_RE = /\{([a-z_]+)\}/g;

/** Plantilla efectiva: la guardada o, si está vacía, el ejemplo. */
export const effectiveTemplate = (kind: TemplateKind, saved: string | null | undefined): string =>
  saved && saved.trim() ? saved : DEFAULT_TEMPLATES[kind];

/** Reemplaza las variables conocidas; deja igual lo que no es variable. */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template
    .replace(VAR_RE, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m))
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/Hola\s*,/, "Hola,")
    .trim();
}

/** Variables de la plantilla que no existen (para avisar en la pantalla). */
export function unknownVars(kind: TemplateKind, template: string): string[] {
  const known = new Set(TEMPLATE_VARS[kind].map((v) => v.key));
  // Compatibilidad: {nombre} sigue funcionando en el mensaje de la percepción.
  if (kind === "perception") known.add("nombre");
  const out = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) if (!known.has(m[1]!)) out.add(m[1]!);
  return [...out];
}

/** Vista previa con los datos de la venta de ejemplo. */
export function exampleVars(kind: TemplateKind): Record<string, string> {
  const v: Record<string, string> = {};
  for (const x of TEMPLATE_VARS[kind]) v[x.key] = x.example;
  if (kind === "perception") v.nombre = v.comprador!;
  return v;
}

/** Recorta sin cortar la URL (los mensajes de ML tienen tope). */
export function trimKeepingLink(text: string, max: number): string {
  if (text.length <= max) return text;
  const m = /(https?:\/\/\S+)/.exec(text);
  if (!m) return text.slice(0, max);
  const url = m[1]!;
  if (url.length >= max) return url;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + url.length);
  const afterKept = after.slice(0, Math.max(0, max - url.length - before.length));
  const beforeKept = before.slice(0, max - url.length - afterKept.length);
  return beforeKept + url + afterKept;
}

/** Mensaje al comprador al subir la factura (versión completa y la de 350). */
export function invoiceMessageTexts(
  template: string | null | undefined,
  vars: Record<string, string | number | null | undefined>,
): { full: string; short: string } {
  const full = renderTemplate(effectiveTemplate("invoice_message", template), vars);
  return { full: trimKeepingLink(full, 3500), short: trimKeepingLink(full, TEMPLATE_LIMITS.invoice_message.max) };
}

/** Leyenda de la factura (una línea lógica, hasta 240 caracteres). */
export function invoiceNotesText(
  template: string | null | undefined,
  vars: Record<string, string | number | null | undefined>,
): string {
  return renderTemplate(effectiveTemplate("invoice_notes", template), vars)
    .replace(/\s+/g, " ")
    .slice(0, TEMPLATE_LIMITS.invoice_notes.max)
    .trim();
}

/** "15/10/2026" desde AAAA-MM-DD (o un timestamp). */
export function dateAr(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "$ 126.875,00". */
export function moneyAr(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$ ${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// -----------------------------------------------------------------------------
// Sucursal y depósito según el tipo de envío
// -----------------------------------------------------------------------------
export type LogisticRuleKey = "default" | "me2" | "full" | "flex" | "me1" | "custom" | "a_convenir" | "none";

export interface LogisticStoreRule {
  store_id: string;
  warehouse_id?: string | null;
}

export type LogisticStores = Partial<Record<LogisticRuleKey, LogisticStoreRule>>;

export const LOGISTIC_RULE_KEYS: LogisticRuleKey[] = ["default", "me2", "full", "flex", "me1", "custom", "a_convenir", "none"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normaliza lo guardado (jsonb): sólo claves y ids válidos. */
export function logisticStoresFrom(raw: unknown): LogisticStores {
  const out: LogisticStores = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of LOGISTIC_RULE_KEYS) {
    const r = (raw as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") continue;
    const store = String(r.store_id ?? "");
    if (!UUID_RE.test(store)) continue;
    const wh = String(r.warehouse_id ?? "");
    out[k] = { store_id: store, warehouse_id: UUID_RE.test(wh) && k !== "full" ? wh : null };
  }
  return out;
}

export interface ResolvedStore {
  store_id: string | null;
  warehouse_id: string | null;
  /** De dónde salió: la regla del tipo de envío, la "por defecto" o la cuenta. */
  source: "logistic" | "default" | "account";
  /** Full: el stock sale del depósito virtual Full (ADR-142), no del depósito elegido. */
  full_stock: boolean;
}

/**
 * Sucursal (factura y punto de venta) y depósito (stock) de una venta según
 * su tipo de envío. Mismo orden que _ml_logistic_store en SQL.
 */
export function resolveLogisticStore(
  rules: LogisticStores,
  kind: string,
  account: { store_id: string | null; warehouse_id: string | null },
): ResolvedStore {
  const full = kind === "full";
  const own = rules[kind as LogisticRuleKey];
  if (own?.store_id) {
    return { store_id: own.store_id, warehouse_id: full ? null : (own.warehouse_id ?? null), source: "logistic", full_stock: full };
  }
  const def = rules.default;
  if (def?.store_id) {
    return { store_id: def.store_id, warehouse_id: full ? null : (def.warehouse_id ?? null), source: "default", full_stock: full };
  }
  return { store_id: account.store_id, warehouse_id: full ? null : account.warehouse_id, source: "account", full_stock: full };
}
