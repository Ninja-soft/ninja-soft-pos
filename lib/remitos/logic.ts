// Remitos de entrega y de envío con COT (ADR-136). PURO: sin React ni
// Supabase. Espejos de remito_config y remito_cot_required (SQL) con test.
import { roleErrorMessage } from "@/lib/permissions/errors";

export type RemitoKind = "entrega" | "envio";
export type RemitoStatus = "emitido" | "anulado";
export type CotJurisdiction = "pba" | "caba" | "otra";

export const REMITO_KIND_LABEL: Record<RemitoKind, string> = {
  entrega: "Remito de entrega",
  envio: "Remito de envío",
};

export const COT_JURISDICTION_LABEL: Record<CotJurisdiction, string> = {
  pba: "Provincia de Buenos Aires (ARBA)",
  caba: "Ciudad de Buenos Aires (AGIP)",
  otra: "Otra jurisdicción",
};

export const COT_JURISDICTION_SHORT: Record<CotJurisdiction, string> = {
  pba: "ARBA",
  caba: "AGIP",
  otra: "Otra",
};

/** Foto del emisor guardada en el remito. */
export interface RemitoIssuer {
  legal_name?: string | null;
  trade_name?: string | null;
  cuit?: string | null;
  iva_condition?: string | null;
  iibb?: string | null;
  activity_start?: string | null;
  address?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  store_name?: string | null;
  store_address?: string | null;
}

export interface RemitoItem {
  id: string;
  product_id: string | null;
  variant_id: string | null;
  description: string;
  sku: string | null;
  unit: string;
  qty: number;
  unit_price: number | null;
  sort: number;
}

export interface Remito {
  id: string;
  store_id: string;
  pto_vta: number;
  number: number;
  kind: RemitoKind;
  status: RemitoStatus;
  dispatch_id: string | null;
  sale_id: string | null;
  issued_at: string;
  issuer: RemitoIssuer;
  receiver_name: string;
  receiver_doc: string | null;
  receiver_iva: string | null;
  receiver_address: string | null;
  delivery_address: string | null;
  packages: number;
  weight_kg: number | null;
  declared_value: number;
  show_prices: boolean;
  carrier_name: string | null;
  carrier_cuit: string | null;
  vehicle_plate: string | null;
  driver_name: string | null;
  cot_number: string | null;
  cot_jurisdiction: CotJurisdiction | null;
  cot_valid_until: string | null;
  cot_source: "manual" | "arba_ws" | null;
  notes: string | null;
  legend: string | null;
  received_name: string | null;
  received_doc: string | null;
  received_at: string | null;
  emailed_to: string | null;
  emailed_at: string | null;
  void_reason: string | null;
  voided_at: string | null;
  items: RemitoItem[];
  sale?: { number: number } | null;
}

export interface RemitoConfig {
  cot_threshold: number | null;
  cot_jurisdiction: CotJurisdiction;
  show_prices: boolean;
  legend: string | null;
}

export const DEFAULT_REMITO_CONFIG: RemitoConfig = {
  cot_threshold: null,
  cot_jurisdiction: "pba",
  show_prices: false,
  legend: null,
};

/** Espejo de remito_config(): defaults y validación de lo guardado. */
export function remitoConfig(raw: unknown): RemitoConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const t = r.cot_threshold;
  const tStr = typeof t === "number" ? String(t) : typeof t === "string" ? t : "";
  const threshold = /^[0-9]{1,12}(\.[0-9]{1,2})?$/.test(tStr) ? Number(tStr) : null;
  const j = r.cot_jurisdiction;
  const legend = typeof r.legend === "string" ? r.legend.trim().slice(0, 300) : "";
  return {
    cot_threshold: threshold,
    cot_jurisdiction: j === "pba" || j === "caba" || j === "otra" ? j : "pba",
    show_prices: r.show_prices === true || r.show_prices === "true",
    legend: legend || null,
  };
}

/**
 * Espejo de remito_cot_required: el remito supera el umbral del negocio en
 * PBA o CABA. Sin umbral no avisa (la obligación y el monto los fija cada
 * jurisdicción y cambian).
 */
export function cotRequired(threshold: number | null, jurisdiction: CotJurisdiction | null, value: number): boolean {
  return threshold != null && (jurisdiction ?? "pba") !== "otra" && Number(value || 0) >= threshold;
}

/** Formato laxo del COT (el mismo check del servidor). */
export function cotValid(raw: string | null | undefined): boolean {
  const v = (raw ?? "").trim();
  return v === "" || /^[0-9A-Za-z-]{6,40}$/.test(v);
}

/** CUIT del transporte: 11 dígitos (acepta guiones). Vacío = sin dato. */
export function normalizeCuit(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d ? d : null;
}

export function cuitValid(raw: string | null | undefined): boolean {
  const d = normalizeCuit(raw);
  return d === null || /^[0-9]{11}$/.test(d);
}

/** "0001-00000012" (punto de venta interno y número). */
export function remitoNumberLabel(pto: number, number: number): string {
  return `${String(pto).padStart(4, "0")}-${String(number).padStart(8, "0")}`;
}

export function remitoFileName(r: Pick<Remito, "pto_vta" | "number">): string {
  return `remito-${remitoNumberLabel(r.pto_vta, r.number)}.pdf`;
}

/** Unidades y valor de los ítems (para el pie del remito). */
export function remitoTotals(items: Pick<RemitoItem, "qty" | "unit_price">[]): { units: number; value: number } {
  let units = 0;
  let value = 0;
  for (const i of items) {
    units += Number(i.qty) || 0;
    value += (Number(i.qty) || 0) * (Number(i.unit_price) || 0);
  }
  return { units: Math.round(units * 1000) / 1000, value: Math.round(value * 100) / 100 };
}

/** "123.456,78" sin símbolo, para el valor declarado. */
export function moneyAr(n: number): string {
  return Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fecha corta en hora de Argentina (dd/mm/aaaa). */
export function dateAr(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00-03:00`) : new Date(iso);
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

const IVA_LABEL: Record<string, string> = {
  responsable_inscripto: "Responsable inscripto",
  monotributo: "Monotributo",
  monotributo_social: "Monotributo social",
  exento: "Exento",
  consumidor_final: "Consumidor final",
  no_categorizado: "No categorizado",
  exterior: "Exterior",
};

export function ivaLabel(v: string | null | undefined): string {
  return v ? (IVA_LABEL[v] ?? v) : "";
}

export interface RemitoFormInput {
  kind: RemitoKind;
  receiver_name: string;
  receiver_doc: string;
  receiver_address: string;
  delivery_address: string;
  packages: string;
  weight_kg: string;
  declared_value: string;
  carrier_name: string;
  carrier_cuit: string;
  vehicle_plate: string;
  driver_name: string;
  cot_number: string;
  cot_jurisdiction: CotJurisdiction;
  cot_valid_until: string;
  notes: string;
  show_prices: boolean;
}

/** Errores del formulario de emisión (mensajes en criollo). */
export function remitoFormErrors(f: RemitoFormInput): string[] {
  const out: string[] = [];
  const p = Number(f.packages);
  if (!Number.isInteger(p) || p < 1 || p > 9999) out.push("Los bultos van de 1 a 9999.");
  if (f.weight_kg.trim() && !(Number(f.weight_kg.replace(",", ".")) >= 0)) out.push("Revisá el peso.");
  if (f.declared_value.trim() && !(Number(f.declared_value.replace(",", ".")) >= 0)) out.push("Revisá el valor declarado.");
  if (!cotValid(f.cot_number)) out.push("El COT va con 6 a 40 letras, números o guiones.");
  if (!cuitValid(f.carrier_cuit)) out.push("El CUIT del transporte tiene 11 dígitos.");
  if (f.kind === "envio" && f.delivery_address.trim().length < 5) out.push("Cargá el domicilio de entrega.");
  return out;
}

/** Payload de remito_issue a partir del formulario. */
export function remitoIssuePayload(
  source: { dispatchId: string | null; saleId: string | null; items?: { product_id: string; variant_id: string | null; qty: number }[] },
  f: RemitoFormInput,
): Record<string, unknown> {
  const num = (s: string) => (s.trim() ? Number(s.replace(",", ".")) : null);
  return {
    ...(source.dispatchId ? { dispatch_id: source.dispatchId } : { sale_id: source.saleId }),
    kind: f.kind,
    ...(source.items && source.items.length > 0 ? { items: source.items } : {}),
    receiver_name: f.receiver_name.trim() || null,
    receiver_doc: f.receiver_doc.trim() || null,
    receiver_address: f.receiver_address.trim() || null,
    delivery_address: f.delivery_address.trim() || null,
    packages: Number(f.packages) || 1,
    weight_kg: num(f.weight_kg),
    declared_value: num(f.declared_value),
    show_prices: f.show_prices,
    carrier_name: f.carrier_name.trim() || null,
    carrier_cuit: normalizeCuit(f.carrier_cuit),
    vehicle_plate: f.vehicle_plate.trim() || null,
    driver_name: f.driver_name.trim() || null,
    cot_number: f.cot_number.trim() || null,
    cot_jurisdiction: f.cot_jurisdiction,
    cot_valid_until: f.cot_valid_until || null,
    notes: f.notes.trim() || null,
  };
}

const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan: entregas_remitos/, "Tu plan no incluye remitos."],
  [/remitos_dispatch_active_key|duplicate key.*dispatch/, "Esa entrega ya tiene un remito vigente. Anulalo para emitir otro."],
  [/dispatch_cancelled/, "La entrega está cancelada."],
  [/dispatch_not_found/, "No encontramos la entrega."],
  [/sale_not_found/, "No encontramos esa venta."],
  [/sale_not_completed/, "Esa venta está anulada."],
  [/remito_empty/, "No quedan productos para el remito (¿ya se devolvieron?)."],
  [/remito_voided/, "El remito está anulado."],
  [/remito_not_found/, "No encontramos el remito."],
  [/invalid_cot_jurisdiction/, "Elegí la jurisdicción del COT."],
  [/invalid_cot/, "El COT va con 6 a 40 letras, números o guiones."],
  [/invalid_carrier_cuit/, "El CUIT del transporte tiene 11 dígitos."],
  [/receiver_required/, "Cargá a quién se entrega."],
  [/void_requires_manager/, "Anular un remito es de un dueño o encargado."],
  [/reason_required/, "Contá el motivo."],
  [/invalid_qty/, "Revisá las cantidades."],
  [/invalid_cot_threshold/, "Revisá el monto del aviso de COT."],
  [/store_forbidden/, "No tenés acceso a esa sucursal."],
];

export function remitoErrorMessage(e: unknown): string {
  const msg =
    e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  return roleErrorMessage(msg) ?? "No se pudo completar la operación.";
}
