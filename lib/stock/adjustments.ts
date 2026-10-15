// =============================================================================
// Ajustes de stock con motivo y aprobación (ADR-137). Puro: catálogo de
// motivos y modos, cálculo de la diferencia y del valor, regla del umbral
// (espejo de stock_adjustment_needs_approval) y mensajes de error. Lo usan la
// pantalla de Inventario, la importación desde Excel y los tests.
// =============================================================================

export type AdjustMode = "add" | "remove" | "set";

export type AdjustReason =
  | "rotura"
  | "vencimiento"
  | "robo"
  | "error_carga"
  | "conteo"
  | "consumo_interno"
  | "regalo"
  | "ingreso"
  | "otro";

export type AdjustStatus = "pending" | "applied" | "rejected" | "cancelled";

export type Approver = "owner" | "auditor";

export const ADJUST_MODES: { value: AdjustMode; label: string; hint: string }[] = [
  { value: "add", label: "Sumar", hint: "Entró mercadería o apareció stock." },
  { value: "remove", label: "Restar", hint: "Se rompió, venció, se perdió o se consumió." },
  { value: "set", label: "Fijar cantidad", hint: "Contaste y querés dejar exactamente esa cantidad." },
];

export const ADJUST_MODE_LABEL: Record<AdjustMode, string> = {
  add: "Sumar",
  remove: "Restar",
  set: "Fijar",
};

export interface ReasonInfo {
  value: AdjustReason;
  label: string;
  hint: string;
  /** Modo que se propone al elegir el motivo. */
  defaultMode: AdjustMode;
}

export const ADJUST_REASONS: readonly ReasonInfo[] = [
  { value: "rotura", label: "Rotura", hint: "Se rompió o quedó inutilizable.", defaultMode: "remove" },
  { value: "vencimiento", label: "Vencimiento", hint: "Venció y no se puede vender.", defaultMode: "remove" },
  { value: "robo", label: "Robo o faltante", hint: "Falta y no hay registro de venta.", defaultMode: "remove" },
  { value: "error_carga", label: "Error de carga", hint: "Se cargó mal una compra, una venta o el stock inicial.", defaultMode: "set" },
  { value: "conteo", label: "Conteo (inventario físico)", hint: "Contaste y el sistema tiene que quedar igual.", defaultMode: "set" },
  { value: "consumo_interno", label: "Consumo interno", hint: "Lo usó el negocio (limpieza, prueba, cocina).", defaultMode: "remove" },
  { value: "regalo", label: "Regalo o muestra", hint: "Se entregó sin cobrar.", defaultMode: "remove" },
  { value: "ingreso", label: "Ingreso sin compra", hint: "Entró mercadería que no pasó por Compras.", defaultMode: "add" },
  { value: "otro", label: "Otro", hint: "Contalo en la nota (obligatoria).", defaultMode: "remove" },
];

export const ADJUST_REASON_LABEL: Record<AdjustReason, string> = Object.fromEntries(
  ADJUST_REASONS.map((r) => [r.value, r.label]),
) as Record<AdjustReason, string>;

export const ADJUST_STATUS_LABEL: Record<AdjustStatus, string> = {
  pending: "Pendiente",
  applied: "Aplicado",
  rejected: "Rechazado",
  cancelled: "Cancelado",
};

export const ADJUST_STATUS_TONE: Record<AdjustStatus, "warning" | "success" | "danger" | "neutral"> = {
  pending: "warning",
  applied: "success",
  rejected: "danger",
  cancelled: "neutral",
};

/** Motivos de stock_movements en el kardex (Movimientos). */
export const MOVEMENT_REASON_LABEL: Record<string, string> = {
  purchase: "Compra",
  sale: "Venta",
  sale_void: "Venta anulada",
  adjustment: "Ajuste",
  transfer: "Traslado",
  transfer_out: "Traslado enviado",
  transfer_in: "Traslado recibido",
  transfer_return: "Traslado devuelto",
  loss: "Merma",
  return: "Devolución",
  production: "Producción",
  count: "Conteo",
  purchase_return: "Devolución a proveedor",
  purchase_void: "Compra anulada",
};

export function isAdjustReason(v: string | null | undefined): v is AdjustReason {
  return ADJUST_REASONS.some((r) => r.value === v);
}

export function isAdjustMode(v: string | null | undefined): v is AdjustMode {
  return v === "add" || v === "remove" || v === "set";
}

/** Diferencia que deja el ajuste sobre lo que hay hoy. */
export function adjustmentDelta(mode: AdjustMode, qty: number, systemQty: number): number {
  if (mode === "add") return qty;
  if (mode === "remove") return -qty;
  return round3(qty - systemQty);
}

/** Valor de la diferencia al costo (con signo), redondeado a centavos. */
export function adjustmentValue(delta: number, unitCost: number | null | undefined): number {
  return Math.round(delta * (unitCost ?? 0) * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ApprovalPolicy {
  approval_enabled: boolean;
  approver: Approver;
  threshold_units: number | null;
  threshold_value: number | null;
  require_photo: boolean;
  /** El plan incluye aprobacion_ajustes. */
  feature: boolean;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  approval_enabled: false,
  approver: "owner",
  threshold_units: null,
  threshold_value: null,
  require_photo: false,
  feature: false,
};

/**
 * ¿El ajuste queda pendiente de aprobación? Espejo de
 * stock_adjustment_needs_approval + el chequeo de la feature: con la
 * aprobación prendida el dueño nunca espera; el resto espera si no hay
 * umbrales (se aprueba todo) o si llega a alguno (unidades o pesos, "desde").
 */
export function needsApproval(
  policy: Pick<ApprovalPolicy, "approval_enabled" | "threshold_units" | "threshold_value" | "feature">,
  input: { role: string | null | undefined; units: number; value: number },
): boolean {
  if (!policy.feature || !policy.approval_enabled) return false;
  if (input.role === "owner") return false;
  const { threshold_units: u, threshold_value: v } = policy;
  if (u == null && v == null) return true;
  if (u != null && Math.abs(input.units) >= u) return true;
  if (v != null && Math.abs(input.value) >= v) return true;
  return false;
}

/** Texto de la regla para la pantalla ("Desde 10 unidades o $ 50.000"). */
export function approvalRuleText(
  policy: Pick<ApprovalPolicy, "approval_enabled" | "approver" | "threshold_units" | "threshold_value">,
  fmtMoney: (n: number) => string,
): string {
  if (!policy.approval_enabled) return "Los ajustes se aplican en el momento.";
  const who = policy.approver === "auditor" ? "el dueño o un auditor" : "el dueño";
  const parts: string[] = [];
  if (policy.threshold_units != null) parts.push(`desde ${policy.threshold_units} unidades`);
  if (policy.threshold_value != null) parts.push(`desde ${fmtMoney(policy.threshold_value)} al costo`);
  const when = parts.length ? `Los ajustes ${parts.join(" o ")}` : "Todos los ajustes";
  return `${when} esperan que los apruebe ${who}. Los del dueño se aplican siempre.`;
}

export interface AdjustDraft {
  mode: AdjustMode;
  qty: string;
  reason: AdjustReason | null;
  notes: string;
  hasPhoto: boolean;
}

/** Primer problema del formulario, en criollo, o null si está listo. */
export function adjustDraftError(d: AdjustDraft, opts: { photoRequired?: boolean } = {}): string | null {
  if (!d.reason) return "Elegí el motivo.";
  const raw = d.qty.trim().replace(",", ".");
  if (raw === "") return "Poné la cantidad.";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "La cantidad tiene que ser un número positivo.";
  if (d.mode !== "set" && n === 0) return "La cantidad tiene que ser mayor a cero.";
  if (n >= 1_000_000_000) return "La cantidad es demasiado grande.";
  if (d.reason === "otro" && d.notes.trim() === "") return "Con el motivo Otro, contá qué pasó en la nota.";
  if (d.notes.trim().length > 300) return "La nota es demasiado larga (máx. 300).";
  if (opts.photoRequired && !d.hasPhoto) return "Este ajuste va a aprobación: sumá una foto de respaldo.";
  return null;
}

export function parseQty(raw: string): number {
  return Number(raw.trim().replace(",", "."));
}

const ERRORS: Array<[RegExp, string]> = [
  [/feature_not_in_plan: aprobacion_ajustes/, "Tu plan no incluye la aprobación de ajustes."],
  [/feature_not_in_plan: ajustes_stock/, "Tu plan no incluye los ajustes de stock."],
  [/feature_not_in_plan: depositos/, "Tu plan no incluye depósitos internos."],
  [/feature_not_in_plan: (multi_sucursal|stock_sucursales)/, "Tu plan no incluye stock por sucursal."],
  [/forbidden_read_only/, "Tu usuario es de solo lectura: no puede modificar el stock."],
  [/forbidden_capability: stock\.count/, "No tenés permiso para cargar conteos. Pedíselo al dueño."],
  [/forbidden_capability/, "No tenés permiso para ajustar stock. Pedíselo al dueño."],
  [/forbidden_approver/, "No podés aprobar ajustes: lo hace el dueño o un auditor."],
  [/self_approval_forbidden/, "No podés aprobar un ajuste que pediste vos: lo aprueba otra persona."],
  [/decision_notes_required/, "Para rechazar, contá el motivo."],
  [/adjustment_not_pending/, "Ese ajuste ya no está pendiente."],
  [/adjustment_not_found/, "No encontramos ese ajuste."],
  [/reason_notes_required/, "Con el motivo Otro, contá qué pasó en la nota."],
  [/photo_required/, "Este ajuste va a aprobación: sumá una foto de respaldo."],
  [/insufficient_warehouse_stock/, "No hay tanto stock en ese depósito."],
  [/warehouse_store_mismatch/, "Ese depósito es de otra sucursal."],
  [/store_forbidden|forbidden_store/, "No tenés acceso a esa sucursal."],
  [/variant_required/, "El producto tiene variantes: elegí cuál."],
  [/invalid_qty/, "Revisá la cantidad."],
  [/invalid_reason/, "Elegí un motivo de la lista."],
  [/invalid_threshold/, "Los umbrales tienen que ser mayores a cero."],
  [/capability_needs_higher_base: viewer/, "Solo lectura no puede aprobar ni ajustar. Cambiale el rol a cajero o encargado."],
  [/capability_needs_higher_base/, "Ese permiso pide un nivel más alto. Cambiale el rol primero."],
  [/cannot_change_owner/, "El dueño ya tiene todos los permisos."],
  [/feature_not_in_plan: roles_permisos/, "Ese permiso puntual viene con los roles a medida del plan Business."],
  [/forbidden/, "No tenés permiso para esta acción."],
];

export function adjustmentErrorMessage(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  return "No se pudo guardar. Probá de nuevo.";
}
