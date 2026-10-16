// lib/accounting/mappings.ts
//
// Mapeos evento → cuenta (ADR-066). Catálogo de conceptos que usan los
// armadores de asientos (migración 20261029100200) y la regla de búsqueda,
// espejo de acc_qualifier_candidates + acc_account_for:
//   1. calificador exacto ("credit:payway"),
//   2. "*:proveedor" (cualquier medio de ese adquirente),
//   3. el medio antes de ":" ("credit"),
//   4. "*" (la regla general).
// En cada nivel gana la regla de la sucursal sobre la del negocio.

export interface MappingRow {
  concept: string;
  qualifier: string;
  store_id: string | null;
  account_id: string;
}

export function qualifierCandidates(qualifier: string | null | undefined): string[] {
  const q = (qualifier ?? "").trim();
  if (!q || q === "*") return ["*"];
  const i = q.indexOf(":");
  if (i >= 0) return [q, `*:${q.slice(i + 1)}`, q.slice(0, i), "*"];
  return [q, "*"];
}

/** Cuenta que usa el asiento (o null si falta la regla: el evento queda como problema). */
export function resolveMapping(
  rows: MappingRow[],
  concept: string,
  qualifier: string | null | undefined,
  storeId: string | null | undefined,
): MappingRow | null {
  const cands = qualifierCandidates(qualifier);
  let best: MappingRow | null = null;
  let bestScore = Infinity;
  for (const r of rows) {
    if (r.concept !== concept) continue;
    const pos = cands.indexOf(r.qualifier);
    if (pos < 0) continue;
    if (r.store_id && r.store_id !== storeId) continue;
    const score = pos * 2 + (r.store_id ? 0 : 1);
    if (score < bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export type ConceptGroup = "ventas" | "cobros" | "caja" | "compras" | "tesoreria" | "procesadores" | "impuestos";

export const CONCEPT_GROUP_LABEL: Record<ConceptGroup, string> = {
  ventas: "Ventas",
  cobros: "Medios de cobro",
  caja: "Caja y cuenta corriente",
  compras: "Compras y pagos",
  tesoreria: "Tesorería",
  procesadores: "Procesadores de pago",
  impuestos: "Impuestos como sujeto",
};

export interface QualifierOption {
  value: string;
  label: string;
}

export interface ConceptDef {
  key: string;
  label: string;
  group: ConceptGroup;
  help: string;
  /** Detalles sugeridos para agregar excepciones (además de "*"). */
  qualifiers?: QualifierOption[];
  /** Texto de qué es el detalle (medio, alícuota, proveedor, cuenta…). */
  qualifierLabel?: string;
}

const PAYMENT_METHODS: QualifierOption[] = [
  { value: "cash", label: "Efectivo" },
  { value: "debit", label: "Débito" },
  { value: "credit", label: "Crédito" },
  { value: "qr", label: "QR" },
  { value: "transfer", label: "Transferencia" },
  { value: "account", label: "Cuenta corriente" },
  { value: "store_credit", label: "Saldo a favor" },
  { value: "directo", label: "Directo" },
  { value: "ualabis", label: "Ualá Bis" },
  { value: "other", label: "Otro medio" },
  { value: "*:payway", label: "Cualquier medio por Payway" },
  { value: "*:fiserv", label: "Cualquier medio por Fiserv / Clover" },
  { value: "*:getnet", label: "Cualquier medio por Getnet" },
  { value: "*:nave", label: "Cualquier medio por Nave" },
  { value: "*:mercadopago", label: "Cualquier medio por Mercado Pago" },
  { value: "credit:payway", label: "Crédito por Payway" },
  { value: "debit:payway", label: "Débito por Payway" },
];

const RATES: QualifierOption[] = [
  { value: "21", label: "21 %" },
  { value: "10.5", label: "10,5 %" },
  { value: "27", label: "27 %" },
  { value: "5", label: "5 %" },
  { value: "2.5", label: "2,5 %" },
];

const PROVIDERS: QualifierOption[] = [
  { value: "mercadopago", label: "Mercado Pago" },
  { value: "payway", label: "Payway" },
  { value: "fiserv", label: "Fiserv / Clover" },
  { value: "getnet", label: "Getnet" },
  { value: "nave", label: "Nave" },
];

export const CONCEPTS: ConceptDef[] = [
  { key: "ventas", label: "Ventas", group: "ventas", help: "Haber de la venta, neto de IVA." },
  {
    key: "iva_df",
    label: "IVA débito fiscal",
    group: "ventas",
    help: "IVA de cada venta por alícuota (con IVA incluido en el precio).",
    qualifiers: RATES,
    qualifierLabel: "Alícuota",
  },
  { key: "devoluciones_ventas", label: "Devoluciones sobre ventas", group: "ventas", help: "Debe de cada devolución, neto de IVA." },
  { key: "propinas", label: "Propinas", group: "ventas", help: "Propinas cobradas con la venta, a pagar al personal." },
  { key: "cmv", label: "Costo de mercaderías vendidas", group: "ventas", help: "Sólo con el CMV por venta activado." },
  { key: "mercaderias", label: "Mercaderías (salida por venta)", group: "ventas", help: "Contrapartida del CMV." },
  { key: "redondeo", label: "Redondeos y diferencias de cobro", group: "ventas", help: "Cuando lo cobrado no coincide con el total y no hubo efectivo para el vuelto." },
  {
    key: "cobro",
    label: "Cobros por medio de pago",
    group: "cobros",
    help: "Debe de cada cobro. El detalle es el medio y, después de ':', el adquirente o proveedor (credit:payway). También es la cuenta del reintegro de devoluciones y la caja de los arqueos.",
    qualifiers: PAYMENT_METHODS,
    qualifierLabel: "Medio",
  },
  { key: "intereses_cc", label: "Intereses de cuenta corriente", group: "caja", help: "Intereses y condonaciones de la cuenta corriente." },
  { key: "ajustes_cc", label: "Ajustes de cuenta corriente", group: "caja", help: "Ajustes y cargos manuales en la cuenta de un cliente." },
  { key: "faltante_caja", label: "Faltantes de caja", group: "caja", help: "Diferencia negativa del arqueo al cerrar la caja." },
  { key: "sobrante_caja", label: "Sobrantes de caja", group: "caja", help: "Diferencia positiva del arqueo al cerrar la caja." },
  {
    key: "caja_movimiento",
    label: "Ingresos y retiros de caja",
    group: "caja",
    help: "Contrapartida de los ingresos y retiros manuales de la caja del POS.",
    qualifiers: [
      { value: "income", label: "Ingreso" },
      { value: "expense", label: "Retiro" },
    ],
    qualifierLabel: "Tipo",
  },
  { key: "compras", label: "Compras", group: "compras", help: "Neto, exento y no gravado de las facturas de proveedor. Se puede mapear por proveedor (gastos, alquileres).", qualifierLabel: "Proveedor" },
  { key: "iva_cf", label: "IVA crédito fiscal", group: "compras", help: "IVA de las facturas A y M por alícuota.", qualifiers: RATES, qualifierLabel: "Alícuota" },
  {
    key: "percepcion",
    label: "Percepciones e impuestos de compras",
    group: "compras",
    help: "Percepciones sufridas e impuestos internos de las facturas de proveedor.",
    qualifiers: [
      { value: "percepcion_iva", label: "Percepción de IVA" },
      { value: "percepcion_iibb", label: "Percepción de IIBB" },
      { value: "percepcion_ganancias", label: "Percepción de Ganancias" },
      { value: "percepcion_municipal", label: "Percepción municipal" },
      { value: "impuesto_interno", label: "Impuestos internos" },
      { value: "otro", label: "Otro tributo" },
    ],
    qualifierLabel: "Tributo",
  },
  { key: "proveedores", label: "Proveedores", group: "compras", help: "Deuda con proveedores (haber de facturas, debe de pagos).", qualifierLabel: "Proveedor" },
  {
    key: "pago",
    label: "Medios de pago a proveedores",
    group: "compras",
    help: "Haber de cada medio de una orden de pago (las transferencias desde una cuenta de tesorería usan la cuenta de tesorería).",
    qualifiers: [
      { value: "efectivo", label: "Efectivo de la caja" },
      { value: "transferencia", label: "Transferencia" },
      { value: "deposito", label: "Depósito" },
      { value: "cheque_propio", label: "Cheque propio" },
      { value: "echeq", label: "E-cheq" },
      { value: "cheque_tercero", label: "Cheque de terceros" },
      { value: "tarjeta", label: "Tarjeta" },
      { value: "otro", label: "Otro" },
    ],
    qualifierLabel: "Medio",
  },
  {
    key: "retencion_practicada",
    label: "Retenciones practicadas",
    group: "compras",
    help: "Retenciones que el negocio practica en las órdenes de pago (a depositar).",
    qualifiers: [
      { value: "ganancias", label: "Ganancias" },
      { value: "iva", label: "IVA" },
      { value: "iibb", label: "IIBB" },
      { value: "suss", label: "SUSS" },
      { value: "otro", label: "Otra" },
    ],
    qualifierLabel: "Impuesto",
  },
  {
    key: "tesoreria",
    label: "Cuentas de tesorería",
    group: "tesoreria",
    help: "Cuenta contable de cada caja general o banco. El detalle es el tipo (bank, cash) o '*:' y el id de la cuenta.",
    qualifiers: [
      { value: "bank", label: "Bancos" },
      { value: "cash", label: "Cajas generales" },
    ],
    qualifierLabel: "Cuenta",
  },
  {
    key: "tesoreria_mov",
    label: "Contrapartida de movimientos de tesorería",
    group: "tesoreria",
    help: "Contra qué cuenta va cada tipo de movimiento de tesorería.",
    qualifiers: [
      { value: "deposit", label: "Depósito o ingreso" },
      { value: "withdrawal", label: "Retiro o gasto" },
      { value: "cheque_deposit", label: "Depósito de cheque" },
      { value: "cheque_debit", label: "Débito de cheque propio" },
      { value: "cheque_rejected", label: "Cheque rechazado" },
      { value: "adjustment", label: "Ajuste" },
      { value: "other", label: "Otro" },
    ],
    qualifierLabel: "Tipo",
  },
  { key: "acreditacion", label: "Acreditación de procesadores", group: "procesadores", help: "Dónde entra el neto liquidado (saldo de Mercado Pago, banco).", qualifiers: PROVIDERS, qualifierLabel: "Procesador" },
  { key: "comision_procesador", label: "Comisiones de procesadores", group: "procesadores", help: "Comisiones descontadas en la liquidación.", qualifiers: PROVIDERS, qualifierLabel: "Procesador" },
  {
    key: "iva_comision",
    label: "IVA de las comisiones de procesadores",
    group: "procesadores",
    help: "IVA de la factura del procesador por la comisión. Si discriminás IVA va a crédito fiscal (regla general); si no, a la regla \"gasto\" (IVA sobre comisiones, 5.2.05).",
    qualifiers: [{ value: "gasto", label: "No discrimina IVA" }],
    qualifierLabel: "Condición",
  },
  { key: "impuestos_procesador", label: "Impuestos y retenciones de procesadores", group: "procesadores", help: "Retenciones y percepciones descontadas en la liquidación (el IVA de la comisión va aparte).", qualifiers: PROVIDERS, qualifierLabel: "Procesador" },
  { key: "diferencia_procesador", label: "Diferencias de liquidación", group: "procesadores", help: "Lo que no cierra entre bruto, comisión, impuestos y neto.", qualifiers: PROVIDERS, qualifierLabel: "Procesador" },
  { key: "contracargos", label: "Contracargos y devoluciones", group: "procesadores", help: "Contracargos perdidos y devoluciones hechas desde el procesador.", qualifiers: PROVIDERS, qualifierLabel: "Procesador" },
  // Impuestos como sujeto (ADR-095): retenciones sufridas y liquidación de IIBB.
  {
    key: "retencion_sufrida",
    label: "Retenciones y percepciones sufridas",
    group: "impuestos",
    help: "Saldo a favor por impuesto. Para IIBB el detalle puede ser 'iibb:902' (jurisdicción). Se reclasifica desde la cuenta del documento (liquidación, banco o cobro).",
    qualifiers: [
      { value: "iibb", label: "Ingresos Brutos" },
      { value: "iva", label: "IVA" },
      { value: "ganancias", label: "Ganancias" },
      { value: "suss", label: "SUSS" },
      { value: "debitos_creditos", label: "Débitos y créditos" },
      { value: "otro", label: "Otro" },
    ],
    qualifierLabel: "Impuesto",
  },
  { key: "iibb_impuesto", label: "Impuesto sobre los ingresos brutos", group: "impuestos", help: "Debe del impuesto determinado en la liquidación mensual. El detalle es la jurisdicción (902).", qualifierLabel: "Jurisdicción" },
  { key: "iibb_a_pagar", label: "Ingresos brutos a pagar", group: "impuestos", help: "Haber del saldo a pagar de la liquidación mensual. El detalle es la jurisdicción (902).", qualifierLabel: "Jurisdicción" },
];

export const CONCEPT_BY_KEY = new Map(CONCEPTS.map((c) => [c.key, c]));

export function conceptLabel(key: string): string {
  return CONCEPT_BY_KEY.get(key)?.label ?? key;
}

export function qualifierLabel(concept: string, qualifier: string): string {
  if (qualifier === "*") return "Todos";
  const opt = CONCEPT_BY_KEY.get(concept)?.qualifiers?.find((q) => q.value === qualifier);
  return opt?.label ?? qualifier;
}
