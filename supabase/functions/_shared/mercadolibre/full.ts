// =============================================================================
// _shared/mercadolibre/full.ts (ADR-142). PURO (cliente y RPC inyectados).
//
// Sincronización de Mercado Libre Full (fulfillment). SÓLO LECTURAS (GET):
//   • Publicaciones en Full: GET /users/{id}/items/search?logistic_type=
//     fulfillment&search_type=scan (más las que el espejo ml_items ya tiene
//     como fulfillment) y multiget GET /items?ids=...&attributes=... para el
//     inventory_id de la publicación o de cada variación.
//   • Stock: GET /inventories/{inventory_id}/stock/fulfillment
//     ?include_attributes=conditions -> total, available_quantity,
//     not_available_quantity, not_available_detail [{status, quantity,
//     conditions}], external_references [{type: item, id, variation_id}].
//   • Operaciones: GET /stock/fulfillment/operations/search?seller_id=&
//     inventory_id=a,b&date_from=&date_to= (rango máx. 60 días, 12 meses de
//     historia; scroll). Tipos: inbound_reception, sale_confirmation,
//     sale_cancelation, sale_return, withdrawal_*, transfer_*, quarantine_*,
//     lost_refund, damaged_removal, removal_*, ajustement,
//     identification_problem_*. external_references: shipment_id, inbound_id.
//   • Costos: GET /billing/integration/monthly/periods?group=ML&document_type=
//     BILL y GET /billing/integration/periods/key/{key}/summary/details?group=
//     ML: se guardan los cargos cuyo nombre es de Full (almacenamiento,
//     retiro, descarte). Necesita el permiso funcional de facturación.
// La API pública NO permite crear el envío a Full (inbound): se crea en
// Mercado Libre y el POS registra su número y concilia lo recibido con las
// operaciones INBOUND_RECEPTION de ese inbound_id.
// =============================================================================
import { MlApiError, type MlClient } from "./client.ts";
import type { MlItem, MlItemSearch } from "./types.ts";

// deno-lint-ignore no-explicit-any
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>;

export interface MlFullStock {
  inventory_id: string;
  total?: number;
  available_quantity?: number;
  not_available_quantity?: number;
  not_available_detail?: Array<{ status?: string; quantity?: number; conditions?: Array<{ condition?: string; quantity?: number }> }>;
  external_references?: Array<{ type?: string; id?: string; variation_id?: number | string | null }>;
}

export interface MlFullOperation {
  id: number | string;
  seller_id?: number;
  inventory_id: string;
  date_created: string;
  type: string;
  detail?: { available_quantity?: number; not_available_quantity?: number; not_available_detail?: MlFullStock["not_available_detail"] };
  result?: Record<string, unknown>;
  external_references?: Array<{ type?: string; value?: string | number }>;
}

export interface MlFullOpsSearch {
  results?: MlFullOperation[];
  paging?: { total?: number; offset?: number; limit?: number };
  scroll?: string | null;
  scroll_id?: string | null;
}

export type FullBucket =
  | "damaged"
  | "lost"
  | "withdrawal"
  | "internal_process"
  | "transfer"
  | "no_fiscal_coverage"
  | "not_supported"
  | "other";

/** Status de ML -> bucket (la doc usa "damage"/"damaged", "noFiscalCoverage"/"no_fiscal_coverage"). */
export function bucketOf(status: string | null | undefined): FullBucket {
  const s = String(status ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (s === "damage" || s === "damaged") return "damaged";
  if (s === "lost") return "lost";
  if (s === "withdrawal") return "withdrawal";
  if (s === "internalprocess") return "internal_process";
  if (s === "transfer") return "transfer";
  if (s === "nofiscalcoverage") return "no_fiscal_coverage";
  if (s === "notsupported" || s === "notsupportted") return "not_supported";
  return "other";
}

export interface FullInventoryRow {
  inventory_id: string;
  ml_item_id: string | null;
  ml_variation_id: string | null;
  title: string;
  variation_label: string | null;
  item_status: string | null;
  total: number;
  available_quantity: number;
  not_available_quantity: number;
  buckets: Record<FullBucket, number>;
  not_available_detail: Array<{ status: string; quantity: number }>;
  conditions: Array<{ status: string; condition: string; quantity: number }>;
  error?: string | null;
}

const int = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function emptyBuckets(): Record<FullBucket, number> {
  return { damaged: 0, lost: 0, withdrawal: 0, internal_process: 0, transfer: 0, no_fiscal_coverage: 0, not_supported: 0, other: 0 };
}

/** Respuesta de /inventories/{id}/stock/fulfillment -> fila del depósito Full. */
export function normalizeFullStock(
  stock: MlFullStock,
  ref: Pick<FullInventoryRow, "ml_item_id" | "ml_variation_id" | "title" | "variation_label" | "item_status">,
): FullInventoryRow {
  const buckets = emptyBuckets();
  const detail: FullInventoryRow["not_available_detail"] = [];
  const conditions: FullInventoryRow["conditions"] = [];
  for (const d of stock.not_available_detail ?? []) {
    const q = int(d.quantity);
    const b = bucketOf(d.status);
    buckets[b] += q;
    detail.push({ status: String(d.status ?? "other").slice(0, 40), quantity: q });
    for (const c of d.conditions ?? []) {
      conditions.push({ status: b, condition: String(c.condition ?? "other").slice(0, 40), quantity: int(c.quantity) });
    }
  }
  const available = int(stock.available_quantity);
  const naSum = Object.values(buckets).reduce((a, b) => a + b, 0);
  const notAvailable = stock.not_available_quantity !== undefined ? int(stock.not_available_quantity) : naSum;
  // Si ML manda un total de no disponibles mayor que el detalle, la diferencia va a "otro".
  if (notAvailable > naSum) buckets.other += notAvailable - naSum;
  const extRef = (stock.external_references ?? []).find((r) => r.type === "item");
  return {
    inventory_id: String(stock.inventory_id ?? "").toUpperCase(),
    ml_item_id: ref.ml_item_id ?? (extRef?.id ? String(extRef.id) : null),
    ml_variation_id: ref.ml_variation_id ?? (extRef?.variation_id != null ? String(extRef.variation_id) : null),
    title: ref.title,
    variation_label: ref.variation_label,
    item_status: ref.item_status,
    total: stock.total !== undefined ? int(stock.total) : available + notAvailable,
    available_quantity: available,
    not_available_quantity: notAvailable,
    buckets,
    not_available_detail: detail,
    conditions,
    error: null,
  };
}

export interface InventoryRef {
  inventory_id: string;
  ml_item_id: string;
  ml_variation_id: string | null;
  title: string;
  variation_label: string | null;
  item_status: string | null;
}

/** inventory_id de la publicación o uno por variación (doc: "un inventory_id por variación"). */
export function fullInventoryRefs(item: Pick<MlItem, "id" | "title" | "status" | "inventory_id" | "variations">): InventoryRef[] {
  const out: InventoryRef[] = [];
  const seen = new Set<string>();
  const push = (inv: string | null | undefined, variation: string | null, label: string | null) => {
    const id = String(inv ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,30}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ inventory_id: id, ml_item_id: item.id, ml_variation_id: variation, title: item.title ?? "", variation_label: label, item_status: item.status ?? null });
  };
  for (const v of item.variations ?? []) {
    const label = (v.attribute_combinations ?? [])
      .map((a) => a.value_name)
      .filter(Boolean)
      .join(" / ");
    push(v.inventory_id, String(v.id), label || null);
  }
  if (out.length === 0) push(item.inventory_id, null, null);
  return out;
}

/** Operación de ML -> fila de ml_full_stock_ops. */
export function normalizeOperation(op: MlFullOperation): Record<string, unknown> | null {
  if (op?.id == null || !op.inventory_id || !op.type || !op.date_created) return null;
  const ref = (t: string) => {
    const r = (op.external_references ?? []).find((x) => String(x.type ?? "").toLowerCase() === t);
    return r?.value != null ? String(r.value).slice(0, 40) : null;
  };
  const naDelta = (op.detail?.not_available_detail ?? []).reduce((a, d) => a + (Number(d.quantity) || 0), 0);
  return {
    operation_id: String(op.id),
    inventory_id: String(op.inventory_id).toUpperCase(),
    type: String(op.type).toLowerCase(),
    date_created: op.date_created,
    delta_available: Math.trunc(Number(op.detail?.available_quantity ?? 0) || 0),
    delta_not_available: Math.trunc(Number(op.detail?.not_available_quantity ?? naDelta) || 0),
    shipment_ref: ref("shipment_id"),
    inbound_ref: ref("inbound_id"),
    detail: op.detail ?? {},
    result: op.result ?? {},
  };
}

/**
 * Recepción real de un envío: suma por inventory_id las operaciones
 * INBOUND_RECEPTION con external_references inbound_id = el número del envío.
 * Recibido = disponible ingresado; dañado = no disponible con status dañado.
 */
export function receptionFromOps(
  ops: Array<Pick<MlFullOperation, "type" | "inventory_id" | "detail" | "external_references">>,
  inboundId: string,
): Array<{ inventory_id: string; received: number; damaged: number }> {
  const acc = new Map<string, { received: number; damaged: number }>();
  const want = String(inboundId).trim();
  for (const op of ops) {
    if (String(op.type).toLowerCase() !== "inbound_reception") continue;
    const ref = (op.external_references ?? []).find((r) => String(r.type ?? "").toLowerCase() === "inbound_id");
    if (!ref || String(ref.value) !== want) continue;
    const inv = String(op.inventory_id).toUpperCase();
    const cur = acc.get(inv) ?? { received: 0, damaged: 0 };
    cur.received += int(op.detail?.available_quantity);
    for (const d of op.detail?.not_available_detail ?? []) {
      if (bucketOf(d.status) === "damaged") cur.damaged += int(d.quantity);
    }
    acc.set(inv, cur);
  }
  return [...acc.entries()].map(([inventory_id, v]) => ({ inventory_id, ...v }));
}

/** Cargos de Full en el resumen de facturación (por nombre: ML no publica un tipo fijo). */
export const FULL_COST_RE = /full|fulfillment|almacenamiento|almacenaje|stock (antiguo|prolongado)|retiro de stock|descarte/i;

export function fullCostCharges(summary: unknown): Array<{ charge_type: string; label: string; amount: number }> {
  const charges = ((summary as { bill_includes?: { charges?: unknown[] } } | null)?.bill_includes?.charges ?? []) as Array<{
    label?: string;
    amount?: number;
    type?: string;
  }>;
  return charges
    .filter((c) => c && typeof c.label === "string" && FULL_COST_RE.test(c.label))
    .map((c) => ({ charge_type: String(c.type ?? "").slice(0, 40), label: String(c.label).slice(0, 200), amount: Number(c.amount) || 0 }));
}

/** Rangos de fechas (YYYY-MM-DD) de a 60 días como máximo hacia atrás. */
export function opsDateRanges(days: number, now = new Date()): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let end = new Date(now.getTime());
  let left = Math.max(1, Math.min(365, Math.floor(days)));
  while (left > 0) {
    const span = Math.min(60, left);
    const start = new Date(end.getTime() - (span - 1) * 86400_000);
    out.push({ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
    end = new Date(start.getTime() - 86400_000);
    left -= span;
  }
  return out;
}

const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** IDs de publicaciones en Full: búsqueda filtrada (scan) + las que ya están en el espejo. */
export async function fullItemIds(client: MlClient, mlUserId: number | string, known: string[] = [], maxPages = 40): Promise<string[]> {
  const ids = new Set(known);
  let scroll: string | null = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const res: MlItemSearch = await client.get<MlItemSearch>(`/users/${mlUserId}/items/search`, {
        logistic_type: "fulfillment",
        search_type: "scan",
        limit: 100,
        scroll_id: scroll,
      });
      for (const id of res.results ?? []) ids.add(String(id));
      scroll = res.scroll_id ?? null;
      if (!scroll || (res.results ?? []).length === 0) break;
    }
  } catch (e) {
    // Si el filtro no se acepta, alcanza con las del espejo (ml_items).
    if (!(e instanceof MlApiError) || (e.code !== "bad_request" && e.code !== "validation_error")) throw e;
  }
  return [...ids];
}

export interface SyncDeps {
  rpc: Rpc;
  client: MlClient;
  now?: () => number;
  /** Corte por tiempo (ms epoch): lo que falte queda para la próxima corrida. */
  deadline?: number;
}

export interface SyncResult {
  items: number;
  inventories: number;
  errors: number;
  ops: number;
  partial: boolean;
}

/**
 * Sincroniza el depósito Full de una cuenta: publicaciones en Full ->
 * inventory_id -> stock por inventario -> ml_full_inventory_upsert; después las
 * operaciones de los últimos `opsDays` días -> ml_full_ops_save.
 */
export async function syncFullAccount(
  deps: SyncDeps,
  account: { id: string; ml_user_id: number | string },
  knownFullItems: string[],
  opsDays = 30,
): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const late = () => deps.deadline !== undefined && now() > deps.deadline;
  const ids = await fullItemIds(deps.client, account.ml_user_id, knownFullItems);
  const refs: InventoryRef[] = [];
  let items = 0;
  for (const c of chunk(ids, 20)) {
    if (late()) break;
    const multi = await deps.client.get<Array<{ code: number; body: MlItem }>>("/items", {
      ids: c.join(","),
      attributes: "id,title,status,inventory_id,variations,shipping",
    });
    for (const m of multi ?? []) {
      if (m.code !== 200 || !m.body) continue;
      items++;
      refs.push(...fullInventoryRefs(m.body));
    }
  }
  const rows: FullInventoryRow[] = [];
  let errors = 0;
  let partial = false;
  for (const r of refs) {
    if (late()) {
      partial = true;
      break;
    }
    try {
      const s = await deps.client.get<MlFullStock>(`/inventories/${encodeURIComponent(r.inventory_id)}/stock/fulfillment`, {
        include_attributes: "conditions",
      });
      rows.push(normalizeFullStock({ ...s, inventory_id: s?.inventory_id ?? r.inventory_id }, r));
    } catch (e) {
      if (e instanceof MlApiError && (e.code === "rate_limited" || e.code === "invalid_grant" || e.code === "missing_permission")) throw e;
      errors++;
      rows.push({ ...normalizeFullStock({ inventory_id: r.inventory_id }, r), error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    }
  }
  for (const c of chunk(rows, 100)) {
    await deps.rpc("ml_full_inventory_upsert", { p_account: account.id, p: { rows: c, complete: false } });
  }
  // Con la lista completa (sin cortes ni errores) se da de baja lo que ya no
  // está en Full.
  if (!partial && errors === 0 && !late()) {
    await deps.rpc("ml_full_inventory_upsert", {
      p_account: account.id,
      p: { rows: [], complete: true, keep_ids: rows.map((x) => x.inventory_id) },
    });
  }
  let ops = 0;
  const invIds = [...new Set(refs.map((r) => r.inventory_id))];
  for (const range of opsDateRanges(opsDays, new Date(now()))) {
    for (const c of chunk(invIds, 20)) {
      if (late()) {
        partial = true;
        break;
      }
      ops += await saveOps(deps, account, c, range);
    }
  }
  return { items, inventories: rows.length, errors, ops, partial };
}

async function saveOps(
  deps: SyncDeps,
  account: { id: string; ml_user_id: number | string },
  inventoryIds: string[],
  range: { from: string; to: string },
  maxPages = 10,
): Promise<number> {
  let scroll: string | null = null;
  let saved = 0;
  for (let page = 0; page < maxPages; page++) {
    const res: MlFullOpsSearch = await deps.client.get<MlFullOpsSearch>("/stock/fulfillment/operations/search", {
      seller_id: account.ml_user_id,
      inventory_id: inventoryIds.join(","),
      date_from: range.from,
      date_to: range.to,
      limit: 100,
      scroll,
    });
    const rows = (res.results ?? []).map(normalizeOperation).filter(Boolean);
    if (rows.length) saved += Number(await deps.rpc("ml_full_ops_save", { p_account: account.id, p: rows })) || 0;
    scroll = res.scroll ?? res.scroll_id ?? null;
    if (!scroll || (res.results ?? []).length === 0) break;
  }
  return saved;
}

/**
 * Recepción de un envío abierto: operaciones INBOUND_RECEPTION desde el
 * despacho -> ml_full_reception_save (sugerencia; no cierra nada).
 */
export async function checkInboundReception(
  deps: SyncDeps,
  account: { id: string; ml_user_id: number | string },
  inbound: { id: string; ml_inbound_id: string; dispatched_at: string | null; inventory_ids: string[] },
): Promise<Array<{ inventory_id: string; received: number; damaged: number }>> {
  const from = inbound.dispatched_at ? new Date(inbound.dispatched_at) : new Date((deps.now ?? Date.now)() - 30 * 86400_000);
  const days = Math.max(1, Math.ceil(((deps.now ?? Date.now)() - from.getTime()) / 86400_000) + 1);
  const all: MlFullOperation[] = [];
  for (const range of opsDateRanges(Math.min(days, 120), new Date((deps.now ?? Date.now)()))) {
    for (const c of chunk(inbound.inventory_ids, 20)) {
      const res: MlFullOpsSearch = await deps.client.get<MlFullOpsSearch>("/stock/fulfillment/operations/search", {
        seller_id: account.ml_user_id,
        inventory_id: c.join(","),
        date_from: range.from,
        date_to: range.to,
        type: "INBOUND_RECEPTION",
        limit: 100,
      });
      all.push(...(res.results ?? []));
    }
  }
  const lines = receptionFromOps(all, inbound.ml_inbound_id);
  await deps.rpc("ml_full_reception_save", { p_inbound: inbound.id, p: { lines, ml_inbound_id: inbound.ml_inbound_id } });
  return lines;
}

/** Cargos de Full del último período cerrado y del abierto. */
export async function syncFullCosts(deps: SyncDeps, account: { id: string }): Promise<number> {
  const periods = await deps.client.get<{ results?: Array<{ key?: string }> }>("/billing/integration/monthly/periods", {
    group: "ML",
    document_type: "BILL",
    limit: 2,
  });
  let saved = 0;
  for (const p of (periods.results ?? []).slice(0, 2)) {
    if (!p.key || !/^\d{4}-\d{2}-\d{2}$/.test(p.key)) continue;
    const summary = await deps.client.get<unknown>(`/billing/integration/periods/key/${p.key}/summary/details`, { group: "ML" });
    saved += Number(await deps.rpc("ml_full_costs_save", { p_account: account.id, p_period: p.key, p: fullCostCharges(summary) })) || 0;
  }
  return saved;
}
