// =============================================================================
// lib/mercadolibre/full.ts (ADR-142). PURO: Mercado Libre Full en el POS.
//
//   • coverage(): días de cobertura del stock de Full con las ventas de 30
//     días, alerta de quiebre y cuánto conviene mandar.
//   • reconcileReception(): conciliación de un envío a Full (enviado,
//     recibido, dañado, faltante) igual que la RPC ml_full_inbound_receive.
//   • Textos: motivos de no disponible, estados del envío, checklist y
//     glosario que se muestran en pantalla.
// =============================================================================

export type FullNaReason =
  | "damaged"
  | "lost"
  | "withdrawal"
  | "internal_process"
  | "transfer"
  | "no_fiscal_coverage"
  | "not_supported"
  | "other";

/** Motivos de "no disponible" de Full (status de not_available_detail). */
export const FULL_NA_REASONS: Record<FullNaReason, { label: string; help: string }> = {
  damaged: {
    label: "Dañado",
    help: "Llegó dañado o se dañó dentro de Full (lo informa ML con la condición: llegó dañado o dañado en Full).",
  },
  lost: { label: "Perdido", help: "ML no lo encuentra en el centro. Si se confirma, ML lo reintegra." },
  withdrawal: { label: "Reservado para retiro", help: "Pediste retirarlo de Full y está apartado." },
  internal_process: { label: "En control de calidad", help: "Apartado por un proceso interno del centro de Full." },
  transfer: { label: "En transferencia", help: "ML lo está moviendo entre sus centros." },
  no_fiscal_coverage: { label: "Sin cobertura fiscal", help: "No está a la venta por falta de cobertura fiscal." },
  not_supported: {
    label: "No procesable",
    help: "ML no lo puede vender: sin identificar, sin etiqueta o EAN, dimensiones, packaging o categoría no apta.",
  },
  other: { label: "Otro motivo", help: "Otro motivo informado por Mercado Libre." },
};

/** Condiciones que ML informa para dañados y no procesables (include_attributes=conditions). */
export const FULL_CONDITIONS: Record<string, string> = {
  arrived_damaged: "Llegó dañado desde el vendedor",
  damaged_in_full: "Se dañó en Full o en el transporte",
  dimensions_exceeds: "Excede las dimensiones permitidas",
  expiration_problem: "Problema con el vencimiento",
  package_problem: "Sin packaging o packaging no apto",
  flammable: "Inflamable o explosivo",
  regulation_problem: "No cumple una regulación (por ejemplo, registro sanitario)",
  multiple_identifier: "Código universal (EAN) duplicado",
  empty_identifier: "Sin etiqueta del vendedor o sin EAN registrado",
  multiple_sku: "Tiene dos o más SKU de Mercado Libre",
  invalid_identifier: "Código universal incorrecto",
  return_problem: "Devuelto por el comprador por calidad",
  other: "Otra condición",
};

export type InboundStatus = "draft" | "in_transit" | "partially_received" | "received" | "closed_with_diff" | "cancelled";

export const INBOUND_STATUS: Record<InboundStatus, { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  draft: { label: "Borrador", tone: "neutral" },
  in_transit: { label: "En camino a Full", tone: "info" },
  partially_received: { label: "Recibido en parte", tone: "warning" },
  received: { label: "Recibido", tone: "success" },
  closed_with_diff: { label: "Cerrado con diferencias", tone: "warning" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

export const OPEN_INBOUND: InboundStatus[] = ["in_transit", "partially_received"];

/** Número de envío de Mercado Libre: alfanumérico con guiones, hasta 40. */
export function isValidMlInboundId(v: string): boolean {
  return /^[A-Za-z0-9-]{1,40}$/.test(v.trim());
}

/** Código de inventario de Full (inventory_id): letras mayúsculas y números. */
export function isValidInventoryId(v: string): boolean {
  return /^[A-Z0-9]{4,30}$/.test(v);
}

// -----------------------------------------------------------------------------
// Cobertura y alertas.
// -----------------------------------------------------------------------------
export type CoverageLevel = "out" | "critical" | "low" | "ok" | "no_sales";

export interface CoverageInput {
  /** Disponible para vender en Full. */
  available: number;
  /** Unidades en camino a Full (envíos abiertos). */
  inTransit: number;
  /** Unidades vendidas en la ventana. */
  sold: number;
  /** Días de la ventana (30). */
  windowDays?: number;
  /** Días que tarda un envío en estar disponible. */
  leadDays: number;
  /** Cobertura objetivo en días. */
  targetDays: number;
}

export interface CoverageResult {
  /** Venta promedio por día. */
  dailyAvg: number;
  /** Días que alcanza lo disponible (null = sin ventas). */
  daysCover: number | null;
  /** Días que alcanza lo disponible más lo que está en camino. */
  daysCoverWithTransit: number | null;
  level: CoverageLevel;
  /** Unidades sugeridas para mandar (0 si no hace falta). */
  suggestQty: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Cobertura en días = disponible / venta diaria (30 días).
 *   out       sin disponible y con ventas: ya está en quiebre.
 *   critical  lo disponible no llega a cubrir lo que tarda un envío nuevo
 *             (cobertura < días de llegada): si no mandás ya, se corta.
 *   low       debajo de la mitad del objetivo.
 *   ok        en el objetivo o cerca.
 *   no_sales  sin ventas en la ventana: no hay cobertura que calcular.
 * Sugerido = venta diaria × (objetivo + días de llegada) − disponible − en
 * camino, redondeado hacia arriba.
 */
export function coverage(i: CoverageInput): CoverageResult {
  const window = i.windowDays && i.windowDays > 0 ? i.windowDays : 30;
  const available = Math.max(0, Math.floor(Number(i.available) || 0));
  const inTransit = Math.max(0, Math.floor(Number(i.inTransit) || 0));
  const sold = Math.max(0, Number(i.sold) || 0);
  const dailyAvg = sold / window;
  if (dailyAvg <= 0) {
    return { dailyAvg: 0, daysCover: null, daysCoverWithTransit: null, level: "no_sales", suggestQty: 0 };
  }
  const daysCover = round1(available / dailyAvg);
  const daysCoverWithTransit = round1((available + inTransit) / dailyAvg);
  let level: CoverageLevel;
  if (available === 0) level = "out";
  else if (daysCover < i.leadDays) level = "critical";
  else if (daysCover < i.targetDays / 2) level = "low";
  else level = "ok";
  const need = Math.ceil(dailyAvg * (i.targetDays + i.leadDays) - available - inTransit);
  return { dailyAvg: round1(dailyAvg), daysCover, daysCoverWithTransit, level, suggestQty: Math.max(0, need) };
}

export const COVERAGE_LABELS: Record<CoverageLevel, { label: string; tone: "danger" | "warning" | "success" | "neutral" }> = {
  out: { label: "Sin stock en Full", tone: "danger" },
  critical: { label: "Se corta antes de reponer", tone: "danger" },
  low: { label: "Cobertura baja", tone: "warning" },
  ok: { label: "Cubierto", tone: "success" },
  no_sales: { label: "Sin ventas en 30 días", tone: "neutral" },
};

/** Ventas de 30 días: las operaciones de Full mandan; si no hay, las órdenes. */
export function soldInWindow(row: { sold_30d_ops: number | string | null; sold_30d_orders: number | string | null }): {
  sold: number;
  source: "ops" | "orders" | "none";
} {
  if (row.sold_30d_ops !== null && row.sold_30d_ops !== undefined) {
    return { sold: Math.max(0, Number(row.sold_30d_ops) || 0), source: "ops" };
  }
  if (row.sold_30d_orders !== null && row.sold_30d_orders !== undefined) {
    return { sold: Math.max(0, Number(row.sold_30d_orders) || 0), source: "orders" };
  }
  return { sold: 0, source: "none" };
}

// -----------------------------------------------------------------------------
// Conciliación de la recepción.
// -----------------------------------------------------------------------------
export interface ReceptionLine {
  id: string;
  title: string;
  sent: number;
  received: number;
  damaged: number;
  missingAction?: "lost" | "returned" | null;
  missingReason?: string | null;
}

export type ReceptionIssue = "negative" | "over_sent" | "missing_action" | "missing_reason";

export interface ReceptionLineResult {
  id: string;
  missing: number;
  issues: ReceptionIssue[];
}

export interface ReceptionResult {
  lines: ReceptionLineResult[];
  totals: { sent: number; received: number; damaged: number; missing: number; returned: number; lost: number };
  /** Estado al cerrar: recibido sin diferencias o cerrado con diferencias. */
  closeStatus: "received" | "closed_with_diff";
  /** Se puede cerrar (sin problemas en ninguna línea). */
  canClose: boolean;
  /** Se puede guardar lo contado (sin negativos ni excesos). */
  canSave: boolean;
}

/** Mismo criterio que ml_full_inbound_receive (SQL). */
export function reconcileReception(lines: ReceptionLine[]): ReceptionResult {
  const totals = { sent: 0, received: 0, damaged: 0, missing: 0, returned: 0, lost: 0 };
  let canSave = true;
  let canClose = true;
  let diff = false;
  const out = lines.map((l) => {
    const sent = Math.max(0, Math.floor(l.sent));
    const received = Math.floor(Number(l.received) || 0);
    const damaged = Math.floor(Number(l.damaged) || 0);
    const issues: ReceptionIssue[] = [];
    if (received < 0 || damaged < 0) issues.push("negative");
    if (received + damaged > sent) issues.push("over_sent");
    const missing = issues.length ? 0 : sent - received - damaged;
    if (issues.length) {
      canSave = false;
      canClose = false;
    }
    if (missing > 0) {
      if (l.missingAction !== "lost" && l.missingAction !== "returned") issues.push("missing_action");
      if (!l.missingReason || l.missingReason.trim().length < 3) issues.push("missing_reason");
      if (issues.some((x) => x === "missing_action" || x === "missing_reason")) canClose = false;
      if (l.missingAction === "returned") totals.returned += missing;
      if (l.missingAction === "lost") totals.lost += missing;
    }
    if (missing > 0 || damaged > 0) diff = true;
    totals.sent += sent;
    totals.received += Math.max(received, 0);
    totals.damaged += Math.max(damaged, 0);
    totals.missing += missing;
    return { id: l.id, missing, issues };
  });
  return { lines: out, totals, closeStatus: diff ? "closed_with_diff" : "received", canClose, canSave };
}

/** Sugerencia de recepción leída de ML (operaciones INBOUND_RECEPTION). */
export function receptionFromMl(
  lines: Array<{ id: string; sent: number; ml_received: number | null; ml_damaged: number | null }>,
): Array<{ id: string; received: number; damaged: number }> {
  return lines.map((l) => {
    const dmg = Math.max(0, Math.min(l.ml_damaged ?? 0, l.sent));
    const rec = Math.max(0, Math.min(l.ml_received ?? 0, l.sent - dmg));
    return { id: l.id, received: rec, damaged: dmg };
  });
}

// -----------------------------------------------------------------------------
// Errores de las RPC y la Edge -> mensaje para la persona.
// -----------------------------------------------------------------------------
const ERRORS: Array<[RegExp, string]> = [
  [/feature_not_in_plan: mercadolibre_full/, "Tu plan no incluye Mercado Libre Full."],
  [/feature_not_in_plan/, "Tu plan no incluye esta función."],
  [/not_full_enabled: (.+)/, "«$1» no está habilitado para Full: vinculalo a una publicación con Full y sincronizá."],
  [/insufficient_stock/, "No alcanza el stock propio para despachar: revisá las cantidades."],
  [/ml_inbound_id_required/, "Cargá el número del envío que te dio Mercado Libre antes de despachar."],
  [/invalid_ml_inbound_id/, "El número de envío de Mercado Libre tiene que ser letras, números o guiones."],
  [/duplicate key.*ml_full_inbounds_ml_uq|ml_full_inbounds_ml_uq/, "Ese número de envío de Mercado Libre ya está en otro envío vigente."],
  [/missing_action_required: (.+)/, "Elegí qué pasó con lo que faltó de «$1»."],
  [/missing_reason_required: (.+)/, "Escribí el motivo del faltante de «$1»."],
  [/invalid_reception: (.+)/, "En «$1» lo recibido más lo dañado no puede superar lo enviado."],
  [/inbound_has_reception/, "El envío ya tiene unidades recibidas: cerralo con la conciliación."],
  [/inbound_not_cancellable/, "Este envío ya no se puede cancelar."],
  [/inbound_not_editable|inbound_not_draft/, "El envío ya salió: no se puede editar."],
  [/reason_required/, "Escribí el motivo."],
  [/invalid_full_settings/, "Revisá los días: llegada entre 1 y 90, objetivo entre 7 y 180 y mayor o igual a la llegada."],
  [/store_forbidden/, "No tenés acceso a esa sucursal."],
  [/empty_inbound/, "Agregá al menos un producto."],
  [/invalid_qty/, "Las cantidades tienen que ser números enteros mayores a cero."],
  [/forbidden/, "No tenés permiso para esta acción."],
  [/missing_permission/, "A la app de Mercado Libre le falta un permiso funcional para Full o facturación."],
  [/reauth_required|invalid_grant/, "La conexión con Mercado Libre venció: reconectá la cuenta."],
  [/rate_limited/, "Mercado Libre pidió bajar el ritmo: probá en unos minutos."],
];

export function fullErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { message?: string })?.message ?? e);
  for (const [re, text] of ERRORS) {
    const m = msg.match(re);
    if (m) return text.replace("$1", m[1] ?? "");
  }
  return msg || "No se pudo completar la acción.";
}

// -----------------------------------------------------------------------------
// Explicación en pantalla.
// -----------------------------------------------------------------------------
export interface GuideStep {
  key: string;
  title: string;
  body: string;
  where: "ml" | "pos" | "both";
}

/** Paso a paso de un envío a Full, de punta a punta. */
export const FULL_CHECKLIST: GuideStep[] = [
  {
    key: "enable",
    title: "Habilitá tus publicaciones para Full",
    body: "Full lo activa Mercado Libre por publicación. Cuando una publicación está en Full, ML le asigna un código de inventario (por ejemplo LCQI05831) por publicación o por variante. Vinculá esa publicación con tu producto en la pestaña Publicaciones y tocá Sincronizar acá.",
    where: "both",
  },
  {
    key: "plan",
    title: "Mirá qué conviene mandar",
    body: "En Stock en Full cada producto muestra cuántos días te alcanza lo que hay en Full con las ventas de los últimos 30 días y cuántas unidades conviene mandar para llegar a tu objetivo de cobertura.",
    where: "pos",
  },
  {
    key: "draft",
    title: "Armá el envío en el sistema",
    body: "Nuevo envío a Full: elegí la sucursal o el depósito de donde sale la mercadería, los productos y las cantidades. Sólo se pueden agregar productos vinculados a una publicación con Full.",
    where: "pos",
  },
  {
    key: "ml",
    title: "Creá el envío en Mercado Libre",
    body: "En Mercado Libre, Ventas > Full > Enviar productos, cargá los mismos productos y cantidades y elegí la fecha y la forma de entrega (colecta o llevarlo vos). La API de Mercado Libre no permite crear este envío desde otro sistema. Copiá el número de envío que te da ML y cargalo acá.",
    where: "ml",
  },
  {
    key: "labels",
    title: "Etiquetá cada unidad y cada bulto",
    body: "Cada unidad lleva la etiqueta con el código de inventario de ML, tapando cualquier otro código de barras. Imprimilas en lote desde el envío, en rollo de 50 x 25 mm o en hoja A4. Los bultos llevan la etiqueta que te da Mercado Libre para el envío; las de bulto de acá sirven para ordenarte.",
    where: "pos",
  },
  {
    key: "dispatch",
    title: "Despachá",
    body: "Despachar descuenta las unidades de tu stock y las deja En camino a Full: ya no se venden en el mostrador ni se publican como stock propio.",
    where: "pos",
  },
  {
    key: "receive",
    title: "Conciliá lo que recibió Full",
    body: "Cuando ML procesa el envío, el sistema lee lo recibido y lo dañado y te lo sugiere. Confirmá por producto: lo recibido pasa a Full, lo dañado queda en Full como no disponible y lo que faltó lo marcás como perdido o como que vuelve a tu depósito, con el motivo. Todo queda auditado.",
    where: "pos",
  },
  {
    key: "sell",
    title: "Vendé y seguí el stock",
    body: "Las ventas que despacha Full entran como ventas de Mercado Libre pero no descuentan tu stock propio: descuentan el depósito Mercado Libre Full. Cada 15 minutos se sincroniza el stock real de Full.",
    where: "both",
  },
];

/** Vocabulario mínimo para entender la pantalla. */
export const FULL_GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: "Full", meaning: "Mercado Libre guarda tu mercadería en sus centros y despacha cada venta por vos." },
  { term: "Código de inventario", meaning: "El código que ML le asigna a cada producto en Full (inventory_id). Va en la etiqueta de cada unidad." },
  { term: "Disponible", meaning: "Unidades en Full que ML puede vender ahora." },
  { term: "No disponible", meaning: "Unidades en Full que no se pueden vender: dañadas, perdidas, apartadas para retiro, en control o en transferencia." },
  { term: "En camino", meaning: "Unidades que despachaste a Full y todavía no se recibieron. Ya no están en tu stock propio." },
  { term: "Stock propio", meaning: "Lo que tenés en tus sucursales y depósitos. Es lo único que se vende en el mostrador." },
  { term: "Cobertura", meaning: "Cuántos días te alcanza lo disponible en Full al ritmo de venta de los últimos 30 días." },
  { term: "Conciliación", meaning: "Comparar lo que mandaste con lo que Full recibió y decidir qué pasa con las diferencias." },
];
