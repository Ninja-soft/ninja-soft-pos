// Editor rápido de precios (ADR-151). PURO.
//
// Modelo de la planilla: filas que trae `price_editor_rows` (servidor) y los
// borradores que va cargando la persona (precio de venta, costo en pesos y
// precio fijo por lista). Nada se escribe hasta "Guardar": ahí se arma un lote
// del motor de ADR-058 / ADR-140 (`price_editor_save`) con vista previa,
// auditoría y deshacer.
//
// Margen y markup como en la ficha (ADR-140), sobre el precio SIN IVA contra
// el costo final:
//   · Markup: cuánto le sumás al costo. Costo $100 y precio $150 = 50 %.
//   · Margen: qué parte del precio es ganancia. Precio $150 y costo $100 = 33,3 %.
// Las alertas de la vista previa son las del servidor: debajo del costo,
// debajo del precio mínimo y margen menor al mínimo de Alertas de margen.

import { finalCost, marginPct, priceFromCost, utility, type CostExtra } from "./costing";
import { applyRounding, fromCents, isRounding, round2, toCents, type RoundingRule } from "./rounding";
import { resolveUnitPrice, type PricingWorld, type ProPriceItem } from "./resolve";

export interface EditorList {
  id: string;
  name: string;
  channel: string;
  kind: string | null;
  currency: string | null;
  adjustment_pct: number | null;
  prices_include_tax: boolean | null;
  /** Las listas en moneda extranjera se cargan en esa moneda: no se editan acá. */
  editable: boolean;
}

export interface EditorRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  category_id: string | null;
  brand_id: string | null;
  is_service: boolean;
  is_active: boolean;
  has_variants: boolean;
  price_mode: "fixed" | "open" | string;
  open_price_min: number | null;
  open_price_max: number | null;
  price: number;
  min_price: number | null;
  cost: number | null;
  final_cost: number | null;
  cost_currency: "ARS" | "USD" | string;
  cost_usd: number | null;
  cost_extras: CostExtra[] | null;
  iva_pct: number;
  /** Precio fijo por lista (price_list_items del producto). */
  items: Record<string, number>;
  /** Precio que cobraría el POS con cada lista (resolver del servidor). */
  list_prices: Record<string, number | null>;
}

export interface EditorPage {
  total: number;
  limit: number;
  offset: number;
  min_margin_pct: number;
  lists_enabled: boolean;
  lists: EditorList[];
  rows: EditorRow[];
}

export type EditorFilter = "all" | "no_price" | "no_cost" | "low_margin" | "open_price";

export const EDITOR_FILTERS: { value: EditorFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "no_price", label: "Sin precio" },
  { value: "no_cost", label: "Sin costo" },
  { value: "low_margin", label: "Margen bajo" },
  { value: "open_price", label: "Precio libre" },
];

export interface RowDraft {
  price?: number;
  cost?: number;
  lists?: Record<string, number>;
}
export type Drafts = Record<string, RowDraft>;

/** Campo editable de una celda: costo, precio, margen o una lista (`list:<id>`). */
export type CellField = "cost" | "price" | "margin" | `list:${string}`;

export function listField(listId: string): CellField {
  return `list:${listId}`;
}
export function fieldListId(f: CellField): string | null {
  return f.startsWith("list:") ? f.slice(5) : null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Normaliza lo que devuelve la RPC (numeric llega como string o number). */
export function normalizeEditorPage(raw: unknown): EditorPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lists = ((r.lists ?? []) as Record<string, unknown>[]).map((l) => ({
    id: String(l.id),
    name: String(l.name ?? ""),
    channel: String(l.channel ?? "custom"),
    kind: (l.kind as string | null) ?? "fixed",
    currency: (l.currency as string | null) ?? null,
    adjustment_pct: num(l.adjustment_pct),
    prices_include_tax: l.prices_include_tax == null ? true : Boolean(l.prices_include_tax),
    editable: l.editable !== false,
  }));
  const rows = ((r.rows ?? []) as Record<string, unknown>[]).map((x) => {
    const items: Record<string, number> = {};
    for (const [k, v] of Object.entries((x.items ?? {}) as Record<string, unknown>)) {
      const n = num(v);
      if (n != null) items[k] = n;
    }
    const lp: Record<string, number | null> = {};
    for (const [k, v] of Object.entries((x.list_prices ?? {}) as Record<string, unknown>)) lp[k] = num(v);
    return {
      id: String(x.id),
      name: String(x.name ?? ""),
      sku: (x.sku as string | null) ?? null,
      barcode: (x.barcode as string | null) ?? null,
      image_url: (x.image_url as string | null) ?? null,
      category_id: (x.category_id as string | null) ?? null,
      brand_id: (x.brand_id as string | null) ?? null,
      is_service: Boolean(x.is_service),
      is_active: x.is_active !== false,
      has_variants: Boolean(x.has_variants),
      price_mode: (x.price_mode as string) ?? "fixed",
      open_price_min: num(x.open_price_min),
      open_price_max: num(x.open_price_max),
      price: num(x.price) ?? 0,
      min_price: num(x.min_price),
      cost: num(x.cost),
      final_cost: num(x.final_cost),
      cost_currency: (x.cost_currency as string) ?? "ARS",
      cost_usd: num(x.cost_usd),
      cost_extras: Array.isArray(x.cost_extras) ? (x.cost_extras as CostExtra[]) : null,
      iva_pct: num(x.iva_pct) ?? 0,
      items,
      list_prices: lp,
    } satisfies EditorRow;
  });
  return {
    total: num(r.total) ?? 0,
    limit: num(r.limit) ?? 50,
    offset: num(r.offset) ?? 0,
    min_margin_pct: num(r.min_margin_pct) ?? 20,
    lists_enabled: Boolean(r.lists_enabled),
    lists,
    rows,
  };
}

// ── Valores efectivos (fila + borrador) ─────────────────────────────────────

export function rowPrice(row: EditorRow, d?: RowDraft): number {
  return d?.price ?? row.price;
}
export function rowCost(row: EditorRow, d?: RowDraft): number | null {
  return d?.cost ?? row.cost;
}
/** Costo final: con el costo cambiado se recalcula con los componentes (ADR-140). */
export function rowFinalCost(row: EditorRow, d?: RowDraft): number | null {
  if (d?.cost != null) return finalCost(d.cost, row.cost_extras ?? []);
  return row.final_cost ?? (row.cost == null ? null : round2(row.cost));
}
export function rowItem(row: EditorRow, listId: string, d?: RowDraft): number | null {
  return d?.lists?.[listId] ?? row.items[listId] ?? null;
}
export function canEditCost(row: EditorRow): boolean {
  return row.cost_currency !== "USD";
}

/** Margen y markup sobre el precio sin IVA contra el costo final. */
export function rowUtility(row: EditorRow, d?: RowDraft, price?: number, ivaPct?: number) {
  return utility(price ?? rowPrice(row, d), rowFinalCost(row, d), ivaPct ?? row.iva_pct);
}
export function rowMargin(row: EditorRow, d?: RowDraft): number | null {
  return marginPct(rowPrice(row, d), rowFinalCost(row, d), row.iva_pct);
}

function cleanDraft(row: EditorRow, d: RowDraft): RowDraft | null {
  const out: RowDraft = {};
  if (d.price != null && Math.abs(d.price - row.price) > 0.004) out.price = d.price;
  if (d.cost != null && Math.abs(d.cost - (row.cost ?? -1)) > 0.004) out.cost = d.cost;
  if (d.lists) {
    const l: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.lists)) {
      const cur = row.items[k];
      if (cur == null || Math.abs(v - cur) > 0.004) l[k] = v;
    }
    if (Object.keys(l).length) out.lists = l;
  }
  return Object.keys(out).length ? out : null;
}

function withDraft(drafts: Drafts, row: EditorRow, d: RowDraft): Drafts {
  const next = { ...drafts };
  const c = cleanDraft(row, d);
  if (c) next[row.id] = c;
  else delete next[row.id];
  return next;
}

export type CellError = "invalid" | "negative" | "cost_usd" | "list_locked" | "no_cost" | "margin_100";

/**
 * Carga un valor en una celda. `margin` calcula el precio desde el costo final
 * con ese margen (con IVA si corresponde). Devuelve los borradores nuevos o un
 * error para mostrar en la celda.
 */
export function setCell(
  drafts: Drafts,
  row: EditorRow,
  field: CellField,
  value: number | null,
  lists: EditorList[] = [],
): { drafts: Drafts; error?: CellError } {
  if (value == null || !Number.isFinite(value)) return { drafts, error: "invalid" };
  if (value < 0 && field !== "margin") return { drafts, error: "negative" };
  const d: RowDraft = { ...(drafts[row.id] ?? {}), lists: { ...(drafts[row.id]?.lists ?? {}) } };
  if (field === "price") d.price = round2(value);
  else if (field === "cost") {
    if (!canEditCost(row)) return { drafts, error: "cost_usd" };
    d.cost = round2(value);
  } else if (field === "margin") {
    const fc = rowFinalCost(row, d);
    if (fc == null || fc <= 0) return { drafts, error: "no_cost" };
    if (value >= 100) return { drafts, error: "margin_100" };
    const p = priceFromCost(fc, "margin", value, row.iva_pct);
    if (p == null) return { drafts, error: "invalid" };
    d.price = p;
  } else {
    const id = fieldListId(field)!;
    const l = lists.find((x) => x.id === id);
    if (l && !l.editable) return { drafts, error: "list_locked" };
    d.lists![id] = round2(value);
  }
  return { drafts: withDraft(drafts, row, d) };
}

/** Descarta los cambios de una fila. */
export function resetRow(drafts: Drafts, rowId: string): Drafts {
  const next = { ...drafts };
  delete next[rowId];
  return next;
}

// ── Edición masiva ──────────────────────────────────────────────────────────

export type BulkTarget = "price" | "cost" | `list:${string}`;
export type BulkKind = "pct" | "amount" | "set" | "margin" | "markup" | "round";

export interface BulkOp {
  target: BulkTarget;
  kind: BulkKind;
  /** % (pct, margin, markup), pesos (amount, set). Ignorado en round. */
  value: number;
  rounding?: RoundingRule | null;
}

function bulkValue(old: number, op: BulkOp, row: EditorRow, d: RowDraft, ivaPct: number): number | null {
  let v: number | null;
  // % y monto con la misma cuenta que el asistente (bulkNewPrice, espejo de SQL).
  if (op.kind === "pct") v = fromCents(Math.max(0, toCents((toCents(old) * (100 + op.value)) / 10000)));
  else if (op.kind === "amount") v = Math.max(0, round2(old + op.value));
  else if (op.kind === "set") v = round2(op.value);
  else if (op.kind === "round") v = old;
  else {
    // Margen o markup sobre el costo final: sólo para el precio de venta o una lista.
    const fc = rowFinalCost(row, d);
    if (fc == null || fc <= 0 || op.target === "cost") return null;
    v = priceFromCost(fc, op.kind === "margin" ? "margin" : "markup", op.value, ivaPct);
  }
  if (v == null || v < 0) return null;
  if (isRounding(op.rounding) && v > 0 && op.target !== "cost") v = applyRounding(v, op.rounding);
  return round2(v);
}

/**
 * Aplica una operación a varias filas. Devuelve los borradores y cuántas
 * filas no se pudieron calcular (sin costo, costo en dólares, lista bloqueada).
 */
export function applyBulk(
  drafts: Drafts,
  rows: EditorRow[],
  op: BulkOp,
  lists: EditorList[] = [],
): { drafts: Drafts; changed: number; skipped: number } {
  let next = drafts;
  let changed = 0;
  let skipped = 0;
  const listId = fieldListId(op.target as CellField);
  const list = listId ? lists.find((l) => l.id === listId) : null;
  for (const row of rows) {
    const d = next[row.id] ?? {};
    if (op.target === "cost" && !canEditCost(row)) {
      skipped++;
      continue;
    }
    if (list && !list.editable) {
      skipped++;
      continue;
    }
    const old =
      op.target === "price"
        ? rowPrice(row, d)
        : op.target === "cost"
          ? rowCost(row, d)
          : (rowItem(row, listId!, d) ?? row.list_prices[listId!] ?? null);
    if (old == null && !(op.kind === "set" || op.kind === "margin" || op.kind === "markup")) {
      skipped++;
      continue;
    }
    const v = bulkValue(old ?? 0, op, row, d, list?.prices_include_tax === false ? 0 : row.iva_pct);
    if (v == null) {
      skipped++;
      continue;
    }
    const before = JSON.stringify(next[row.id] ?? null);
    const r = setCell(next, row, op.target === "price" ? "price" : op.target === "cost" ? "cost" : (op.target as CellField), v, lists);
    if (r.error) {
      skipped++;
      continue;
    }
    if (JSON.stringify(r.drafts[row.id] ?? null) !== before) changed++;
    next = r.drafts;
  }
  return { drafts: next, changed, skipped };
}

// ── Deshacer ────────────────────────────────────────────────────────────────

export const HISTORY_LIMIT = 50;

export function pushHistory(stack: Drafts[], drafts: Drafts): Drafts[] {
  const s = [...stack, drafts];
  return s.length > HISTORY_LIMIT ? s.slice(s.length - HISTORY_LIMIT) : s;
}

// ── Guardado y vista previa ─────────────────────────────────────────────────

export interface EditorChange {
  product_id: string;
  price?: number;
  cost?: number;
  lists?: Record<string, number>;
}

export function buildChanges(drafts: Drafts): EditorChange[] {
  return Object.entries(drafts)
    .map(([id, d]) => ({
      product_id: id,
      ...(d.price != null ? { price: d.price } : {}),
      ...(d.cost != null ? { cost: d.cost } : {}),
      ...(d.lists && Object.keys(d.lists).length ? { lists: d.lists } : {}),
    }))
    .filter((c) => c.price != null || c.cost != null || c.lists != null);
}

export type PreviewFlag = "below_cost" | "below_floor" | "low_margin";

export interface PreviewLine {
  productId: string;
  name: string;
  /** "Precio de venta", "Costo" o el nombre de la lista. */
  what: string;
  kind: "price" | "cost" | "list";
  before: number | null;
  after: number;
  diffPct: number | null;
  marginPct: number | null;
  flags: PreviewFlag[];
}

/** Mismas alertas que `price_editor_save` (servidor). */
export function previewFlags(
  price: number,
  final: number | null,
  ivaPct: number,
  minMargin: number,
  minPrice: number | null,
): PreviewFlag[] {
  const f: PreviewFlag[] = [];
  if (final != null && final > 0 && price / (1 + ivaPct / 100) < final) f.push("below_cost");
  if (minPrice != null && price < minPrice) f.push("below_floor");
  const m = marginPct(price, final, ivaPct);
  if ((m ?? 100) < minMargin) f.push("low_margin");
  return f;
}

export function buildPreview(rows: EditorRow[], drafts: Drafts, lists: EditorList[], minMargin: number): PreviewLine[] {
  const out: PreviewLine[] = [];
  const pct = (a: number | null, b: number) => (a != null && a > 0 ? round2(((b - a) / a) * 100) : null);
  for (const row of rows) {
    const d = drafts[row.id];
    if (!d) continue;
    const fc = rowFinalCost(row, d);
    if (d.price != null || d.cost != null) {
      const p = rowPrice(row, d);
      const flags = previewFlags(p, fc, row.iva_pct, minMargin, row.min_price);
      if (d.price != null) {
        out.push({ productId: row.id, name: row.name, what: "Precio de venta", kind: "price", before: row.price, after: d.price,
          diffPct: pct(row.price, d.price), marginPct: marginPct(p, fc, row.iva_pct), flags });
      }
      if (d.cost != null) {
        out.push({ productId: row.id, name: row.name, what: "Costo", kind: "cost", before: row.cost, after: d.cost,
          diffPct: pct(row.cost, d.cost), marginPct: marginPct(p, fc, row.iva_pct), flags: d.price != null ? [] : flags });
      }
    }
    for (const [lid, v] of Object.entries(d.lists ?? {})) {
      const l = lists.find((x) => x.id === lid);
      const iva = l?.prices_include_tax === false ? 0 : row.iva_pct;
      const before = row.items[lid] ?? row.list_prices[lid] ?? null;
      out.push({ productId: row.id, name: row.name, what: l?.name ?? "Lista", kind: "list", before, after: v,
        diffPct: pct(before, v), marginPct: marginPct(v, fc, iva), flags: previewFlags(v, fc, iva, minMargin, null).filter((f) => f !== "below_floor") });
    }
  }
  return out;
}

export function previewSummary(lines: PreviewLine[]) {
  const products = new Set(lines.map((l) => l.productId)).size;
  return {
    lines: lines.length,
    products,
    belowCost: lines.filter((l) => l.flags.includes("below_cost")).length,
    lowMargin: lines.filter((l) => l.flags.includes("low_margin")).length,
    belowFloor: lines.filter((l) => l.flags.includes("below_floor")).length,
  };
}

// ── Precio estimado por lista con los cambios sin guardar ──────────────────

/**
 * Precio que daría cada lista con el borrador, con el mismo resolver que el
 * POS (`resolveUnitPrice`). `world` es la foto de precios del negocio; las
 * listas en moneda y las netas sin datos fiscales quedan como las calculó el
 * servidor. Sin cambios en la fila devuelve el valor del servidor.
 */
export function estimateListPrice(
  world: PricingWorld | null,
  row: EditorRow,
  listId: string,
  d?: RowDraft,
): number | null {
  const fixed = rowItem(row, listId, d);
  if (fixed != null && d?.lists?.[listId] != null) return fixed;
  const server = row.list_prices[listId] ?? null;
  if (!d || (d.price == null && d.cost == null && !d.lists)) return server;
  if (!world) return server;
  const l = world.lists.find((x) => x.id === listId);
  if (!l || l.kind === "currency") return server;
  const items: ProPriceItem[] = world.items.filter((i) => i.product_id !== row.id);
  for (const [lid, p] of Object.entries({ ...row.items, ...(d.lists ?? {}) })) {
    items.push({ price_list_id: lid, product_id: row.id, variant_id: null, price: p });
  }
  const cost = rowCost(row, d);
  const w: PricingWorld = {
    ...world,
    items,
    assigned: [],
    costs: { ...world.costs, [row.id]: { ...(world.costs[row.id] ?? {}), cost, final_cost: rowFinalCost(row, d) } },
  };
  return resolveUnitPrice(w, { productId: row.id, basePrice: rowPrice(row, d), listId, termId: "none" }).price;
}

/** Error del servidor en palabras (RPC del editor). */
export function editorErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? e ?? "");
  if (m.includes("feature_not_in_plan: editor_precios")) return "Tu plan no incluye el editor de precios.";
  if (m.includes("feature_not_in_plan: listas_precios")) return "Tu plan no incluye listas de precios.";
  if (m.includes("forbidden")) return "Sólo el dueño o un encargado pueden editar precios.";
  if (m.includes("cost_in_usd")) return "Ese producto tiene el costo en dólares: cambialo en su ficha.";
  if (m.includes("list_currency_not_editable")) return "Las listas en moneda extranjera se editan desde la lista.";
  if (m.includes("bulk_empty")) return "No hay cambios para guardar.";
  if (m.includes("bulk_too_large")) return "Son demasiados cambios juntos: guardá de a 2.000 productos.";
  if (m.includes("invalid_price") || m.includes("invalid_cost")) return "Hay un valor inválido: revisá los números.";
  if (m.includes("product_not_found")) return "Un producto ya no existe: recargá la planilla.";
  if (m.includes("PGRST202") || m.includes("price_editor")) return "El editor todavía no está disponible en tu base. Probá en unos minutos.";
  return "No se pudo guardar. Probá de nuevo.";
}
