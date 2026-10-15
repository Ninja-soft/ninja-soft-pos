// =============================================================================
// Maestro de motivos de reclamo de Mercado Libre (ADR-147). Puro: lo usan la
// Edge ml_api (acción `reasons_fill`), el generador del seed y la UI.
//
// Fuente: GET /post-purchase/v1/claims/reasons/{id} (no hay endpoint de
// listado: /claims/reasons da 404). Respuesta:
//   { id, flow, name, detail, position, parent_id, children_title, status,
//     filter: { group[], site_id[] },
//     settings: { allowed_flows[], expected_resolutions[], rules_engine_triage[] },
//     date_created, last_updated }
// Un código viejo puede responder con OTRO id (PNR3430 → PNR9502): se guarda
// como alias del que respondió.
// =============================================================================

export type ReasonFamily = "PDD" | "PNR" | "CS" | "OTRO";

export const REASON_CODE_RE = /^[A-Z]{2,4}\d{3,5}$/;

export const FAMILY_LABELS: Record<ReasonFamily, string> = {
  PDD: "Producto distinto o defectuoso",
  PNR: "Producto no recibido",
  CS: "Cancelación de la venta",
  OTRO: "Otros motivos",
};

export const FAMILY_ORDER: ReasonFamily[] = ["PDD", "PNR", "CS", "OTRO"];

/** Los que ya se usaban por defecto en `ml_gestor_settings` (y en ANDESMAR). */
export const RECOMMENDED_REASONS = ["PDD9939", "PNR9501", "PDD9502", "PDD9829"] as const;

export function reasonFamily(id: string | null | undefined): ReasonFamily {
  const p = /^([A-Z]+)\d/.exec((id ?? "").toUpperCase())?.[1] ?? "";
  return p === "PDD" || p === "PNR" || p === "CS" ? p : "OTRO";
}

/** Normaliza lo que escribe la persona: mayúsculas, sin espacios, sin repetidos. */
export function parseReasonCodes(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const c = raw.trim().toUpperCase();
    if (!c) continue;
    if (!REASON_CODE_RE.test(c)) invalid.push(c);
    else if (!valid.includes(c)) valid.push(c);
  }
  return { valid, invalid };
}

/** Respuesta cruda de la API (lo que usamos). */
export type MlReasonApi = {
  id?: string;
  flow?: string | null;
  name?: string | null;
  detail?: string | null;
  parent_id?: string | null;
  status?: string | null;
  filter?: { site_id?: string[] | null } | null;
  settings?: { expected_resolutions?: string[] | null; rules_engine_triage?: string[] | null } | null;
};

/** Fila de `ml_claim_reasons`. */
export type ClaimReasonRow = {
  id: string;
  family: ReasonFamily;
  title: string;
  description: string | null;
  ml_name: string | null;
  ml_detail: string | null;
  flow: string | null;
  parent_id: string | null;
  alias_of: string | null;
  expected_resolutions: string[];
  triage: string[];
  excludable: boolean;
  recommended: boolean;
  active: boolean;
  source: "seed" | "api";
};

const FLOW_LABELS: Record<string, string> = {
  unification_delivered: "Reclamo con el producto entregado",
  post_purchase_delivered: "Reclamo con el producto entregado",
  label_unavailable: "Producto entregado, sin etiqueta para devolver",
  no_shipping_options: "Producto entregado, sin envío para devolver",
  no_delivered: "Reclamo sin entrega confirmada",
  proximity_delivered: "Envío de cercanía, producto entregado",
  proximity_undelivered: "Envío de cercanía, producto no recibido",
  mediations: "Mediación de Mercado Libre",
  mediations_delivered: "Mediación con el producto entregado",
  mediations_undelivered: "Mediación por producto no recibido",
  mp_mediations_delivered: "Mediación de Mercado Pago, producto entregado",
  mp_mediations_undelivered: "Mediación de Mercado Pago, producto no recibido",
  fulfillment_delivered: "Venta por Full, producto entregado",
  fulfillment_undelivered: "Venta por Full, producto no recibido",
  returns: "Devolución",
  distant_agencies: "Retiro en agencia, producto entregado",
  change_delivered: "Pedido de cambio",
  reservation: "Reserva",
  cancel_sale: "Cancelación de la venta",
  cancel_sale_proximity: "Cancelación de una venta con envío de cercanía",
};

const RESOLUTION_LABELS: Record<string, string> = {
  refund: "que le devuelvan la plata",
  return_product: "devolver el producto",
  change_product: "cambiarlo",
  product: "recibir el producto",
};

export function flowLabel(flow: string | null | undefined): string | null {
  if (!flow) return null;
  return FLOW_LABELS[flow] ?? null;
}

/**
 * ¿Suele poder pedirse que no cuente para la reputación? Orientativo: es la
 * compra que el comprador se arrepintió de hacer, hizo por error, encontró
 * más barata o no reconoce. ML decide caso por caso.
 */
export function isExcludable(name: string | null | undefined, triage: string[] = []): boolean {
  const n = (name ?? "").toLowerCase();
  if (/delivered_out_of_time|not_expected_quality/.test(n)) return false;
  if (/repentant|bought_by_mistake|better_price|unauthorized_purchase|no_need/.test(n)) return true;
  return triage.includes("repentant") && !/late|quality/.test(n);
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/[—–]/g, "-").trim();

/** ¿El `detail` no se entiende solo ("Otro", "Llegó bien") y necesita el del padre? */
export function needsParent(detail: string | null | undefined): boolean {
  const d = clean(detail);
  return d.length <= 14 || /^otro/i.test(d) || /llegó bien$/i.test(d);
}

/** Título en castellano: el `detail` de ML; si no se entiende solo, con el del padre adelante. */
export function reasonTitle(detail: string | null | undefined, parentDetail?: string | null): string {
  const d = clean(detail);
  const p = clean(parentDetail);
  if (!d) return p || "";
  if (p && p !== d && needsParent(d)) return `${p}: ${lowerFirst(d)}`;
  return d;
}

/** Descripción corta: en qué circuito aparece y qué pide el comprador. */
export function reasonDescription(flow: string | null | undefined, resolutions: string[] = []): string | null {
  const parts: string[] = [];
  const f = flowLabel(flow);
  if (f) parts.push(f);
  const rs = resolutions.map((r) => RESOLUTION_LABELS[r]).filter(Boolean);
  if (rs.length) parts.push(`El comprador puede pedir ${rs.length === 1 ? rs[0] : `${rs.slice(0, -1).join(", ")} o ${rs[rs.length - 1]}`}`);
  return parts.length ? `${parts.join(". ")}.` : null;
}

/**
 * Arma la fila desde la respuesta de la API. `requested` es el código que se
 * pidió: si ML respondió con otro id, la fila queda como alias de ese id.
 */
export function reasonFromApi(requested: string, body: MlReasonApi, parent?: MlReasonApi | null, recommended = false): ClaimReasonRow {
  const id = requested.toUpperCase();
  const realId = String(body.id ?? id).toUpperCase();
  const triage = (body.settings?.rules_engine_triage ?? []).filter((x): x is string => typeof x === "string");
  const resolutions = (body.settings?.expected_resolutions ?? []).filter((x): x is string => typeof x === "string");
  return {
    id,
    family: reasonFamily(id),
    title: (reasonTitle(body.detail, parent?.detail) || FAMILY_LABELS[reasonFamily(id)]).slice(0, 160),
    description: reasonDescription(body.flow, resolutions),
    ml_name: body.name ? String(body.name).slice(0, 80) : null,
    ml_detail: body.detail ? clean(body.detail).slice(0, 200) : null,
    flow: body.flow ? String(body.flow).slice(0, 60) : null,
    parent_id: body.parent_id ? String(body.parent_id).slice(0, 20) : null,
    alias_of: realId !== id ? realId : null,
    expected_resolutions: resolutions.slice(0, 10),
    triage: triage.slice(0, 10),
    excludable: isExcludable(body.name, triage),
    recommended,
    active: (body.status ?? "active") === "active",
    source: "api",
  };
}

export type FillDeps = {
  /** Códigos que ya están en el maestro. */
  known: (ids: string[]) => Promise<Set<string>>;
  /** GET /post-purchase/v1/claims/reasons/{id}; null si ML no lo conoce (404). */
  get: (id: string) => Promise<MlReasonApi | null>;
  /** Guarda las filas nuevas sin pisar las que ya estén. */
  save: (rows: ClaimReasonRow[]) => Promise<void>;
};

export const FILL_MAX = 20;

/**
 * Completa desde la API los códigos que falten en el maestro (acción
 * `reasons_fill` de ml_api). Sólo GET, hasta FILL_MAX por llamada. Un error
 * de la API (429, 5xx, red) corta y deja el resto como pendiente.
 */
export async function fillReasons(
  rawIds: string[],
  deps: FillDeps,
): Promise<{ filled: string[]; unknown: string[]; pending: string[] }> {
  const ids = parseReasonCodes(rawIds.map(String).join(" ")).valid.slice(0, FILL_MAX);
  if (ids.length === 0) return { filled: [], unknown: [], pending: [] };
  const known = await deps.known(ids);
  const todo = ids.filter((id) => !known.has(id));
  const rows: ClaimReasonRow[] = [];
  const unknown: string[] = [];
  const pending: string[] = [];
  const recommended = new Set<string>(RECOMMENDED_REASONS);
  for (const [i, id] of todo.entries()) {
    try {
      const body = await deps.get(id);
      if (!body) {
        unknown.push(id);
        continue;
      }
      const parentId = body.parent_id && REASON_CODE_RE.test(String(body.parent_id)) ? String(body.parent_id) : null;
      const parent = parentId && needsParent(body.detail) ? await deps.get(parentId).catch(() => null) : null;
      rows.push(reasonFromApi(id, body, parent, recommended.has(id)));
    } catch {
      pending.push(...todo.slice(i));
      break;
    }
  }
  if (rows.length) await deps.save(rows);
  return { filled: rows.map((r) => r.id), unknown, pending };
}
