// lib/accounting/sources.ts
//
// Origen de cada asiento automático (ADR-066): etiqueta y link al documento.

export type SourceType =
  | "sale"
  | "sale_return"
  | "cc_movement"
  | "cash_shift"
  | "cash_movement"
  | "supplier_invoice"
  | "supplier_payment"
  | "treasury_movement"
  | "settlement_line"
  | "payment_dispute"
  | "tax_suffered"
  | "iibb_liquidation"
  | "treasury_account"
  | "cheque"
  | "acc_entry";

export const SOURCE_LABEL: Record<SourceType, string> = {
  sale: "Venta",
  sale_return: "Devolución",
  cc_movement: "Cuenta corriente",
  cash_shift: "Cierre de caja",
  cash_movement: "Movimiento de caja",
  supplier_invoice: "Comprobante de proveedor",
  supplier_payment: "Pago a proveedor",
  treasury_movement: "Tesorería",
  settlement_line: "Liquidación de procesador",
  payment_dispute: "Contracargo o devolución",
  tax_suffered: "Retención sufrida",
  iibb_liquidation: "Liquidación de IIBB",
  treasury_account: "Saldo inicial de cuenta",
  cheque: "Cheque",
  acc_entry: "Reversión",
};

export const EVENT_LABEL: Record<string, string> = {
  sale: "Venta",
  void: "Anulación",
  return: "Devolución",
  main: "Movimiento",
  close: "Cierre",
  invoice: "Comprobante",
  payment: "Pago",
  movement: "Movimiento",
  release: "Acreditación",
  loss: "Pérdida",
  loss_reversal: "Reversión",
  reverse: "Reversión",
  opening: "Saldo inicial",
  receive: "Recepción",
  reject: "Rechazo",
};

export const ENTRY_KIND_LABEL: Record<string, string> = {
  auto: "Automático",
  manual: "Manual",
  reversal: "Reversión",
  opening: "Apertura",
  summary: "Resumen",
};

export function sourceLabel(type: string | null | undefined): string {
  if (!type) return "Manual";
  return SOURCE_LABEL[type as SourceType] ?? type;
}

/** Pantalla donde se ve el documento de origen (null si no hay). */
export function sourceHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  switch (type) {
    case "sale":
      return `/ventas?venta=${id}`;
    case "sale_return":
      return "/devoluciones";
    case "cc_movement":
      return "/clientes/cuentas";
    case "cash_shift":
    case "cash_movement":
      return "/caja";
    case "supplier_invoice":
    case "supplier_payment":
      return "/compras/facturas";
    case "treasury_movement":
      return `/tesoreria/movimientos?mov=${id}`;
    case "treasury_account":
      return "/tesoreria";
    case "cheque":
      return "/tesoreria/cheques";
    case "settlement_line":
      return "/tesoreria/conciliacion?vista=procesadores";
    case "payment_dispute":
      return "/ventas?alertas=1";
    case "tax_suffered":
      return "/impuestos/sufridas";
    case "iibb_liquidation":
      return "/impuestos/iibb";
    default:
      return null;
  }
}

/** Mensaje claro para los errores de las RPC de contabilidad. */
export function accErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  const map: Array<[RegExp, string]> = [
    [/feature_not_in_plan/, "Contabilidad no está incluida en tu plan."],
    [/forbidden/, "Sólo el dueño o un encargado pueden hacer esto."],
    [/acc_not_setup/, "Primero activá la contabilidad del negocio."],
    [/acc_already_setup/, "La contabilidad ya está activada."],
    [/acc_entry_unbalanced/, "El asiento no balancea: el debe tiene que ser igual al haber."],
    [/acc_entry_empty/, "Cargá al menos dos renglones con importe."],
    [/acc_account_not_imputable/, "Elegí cuentas imputables y activas."],
    [/acc_period_closed_changed/, "El documento cambió después del cierre del período: reabrí el mes o cargá un ajuste."],
    [/acc_period_closed/, "El período está cerrado."],
    [/acc_period_not_ended/, "Sólo se cierran meses terminados."],
    [/acc_previous_period_open/, "Primero cerrá los meses anteriores con asientos."],
    [/acc_later_period_closed/, "Primero reabrí los meses posteriores."],
    [/acc_period_already_closed/, "Ese mes ya está cerrado."],
    [/acc_entry_auto_reverse/, "Los asientos automáticos se corrigen desde el documento o regenerando el período."],
    [/acc_entry_already_reversed/, "Ese asiento ya tiene su reversión."],
    [/acc_account_has_entries/, "La cuenta tiene asientos: no se puede cambiar el tipo ni dejar de ser imputable."],
    [/acc_account_has_children/, "La cuenta tiene subcuentas."],
    [/acc_account_in_mapping/, "La cuenta se usa en un mapeo: cambialo primero."],
    [/acc_code_parent_prefix/, "El código tiene que empezar con el código de la cuenta madre."],
    [/acc_kind_parent_mismatch/, "El tipo tiene que ser el mismo que el de la cuenta madre."],
    [/acc_parent_has_entries/, "La cuenta madre tiene asientos: elegí otra."],
    [/acc_mapping_default_required/, "La regla general no se borra: cambiá la cuenta."],
    [/acc_range_invalid/, "Elegí un rango de hasta un año."],
    [/duplicate key|acc_accounts_code_key/, "Ya existe una cuenta con ese código."],
    [/reason_required/, "Escribí el motivo."],
  ];
  for (const [re, text] of map) if (re.test(msg)) return text;
  return msg || "No se pudo completar la operación.";
}
