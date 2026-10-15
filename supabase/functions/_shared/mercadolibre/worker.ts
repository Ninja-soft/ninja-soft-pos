// =============================================================================
// _shared/mercadolibre/worker.ts (H87 · ADR-104). PURO (base y API inyectadas).
//
// Lo que hace el worker con cada notificación y cada trabajo de la cola. La
// Edge `ml_worker` sólo arma las dependencias reales (RPC de Supabase con
// service_role y el cliente HTTP de ML por cuenta); los tests las reemplazan
// por fixtures.
//
// Orden en cada corrida: PRIMERO el inbox (órdenes que bajan stock) y DESPUÉS
// la cola de escrituras (stock calculado al enviar): así un push no le
// devuelve a ML una unidad que ML ya vendió y todavía no entró al POS.
// =============================================================================
import { MlApiError, familyOf, jobBackoffMs, type MlClient } from "./client.ts";
import { isGestorTopic, isHandledTopic, resourceId } from "./notifications.ts";
import { refreshClaim } from "./gestorWorker.ts";
import {
  buildPackPayload,
  normalizeBilling,
  normalizeShipment,
  type BillingNormalized,
  type ShipmentNormalized,
} from "./orders.ts";
import { hasPriceAutomation } from "./items.ts";
import { pushItemQuantity, pushSellingAddress, pushVariationQuantities, stockModeFrom, type StockMode } from "./stock.ts";
import type {
  MlBillingInfoLegacy,
  MlBillingInfoNew,
  MlItem,
  MlOrder,
  MlPack,
  MlQuestion,
  MlShipment,
  MlUserProductStock,
} from "./types.ts";
import { buildInvoicePdf, type InvoicePdfData } from "./invoicePdf.ts";
import {
  buildInvoicePlan,
  planSettingsFrom,
  type IibbEntry,
  type MlInvoicePlan,
  type PlanEmitter,
  type PlanInput,
  type PlanPadron,
} from "./invoicePlan.ts";
import type { PackPayload } from "./orders.ts";

// deno-lint-ignore no-explicit-any
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>;

export interface WorkerDeps {
  rpc: Rpc;
  client(accountId: string): MlClient;
  now?: () => number;
  rand?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface NotificationRow {
  id: string;
  account_id: string;
  tenant_id: string;
  topic: string;
  resource: string;
  tries: number;
}

export interface JobRow {
  id: string;
  account_id: string;
  tenant_id: string;
  kind: string;
  ref: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type Outcome = { status: "done" | "ignored"; note?: string } | { status: "error" | "retry"; error: string; retryMs: number };

/** Error de ML/red -> resultado de la cola (reintento, espera o definitivo). */
export function outcomeOf(e: unknown, attempt: number, rand?: () => number): Outcome {
  if (e instanceof MlApiError) {
    if (e.code === "rate_limited") return { status: "retry", error: e.message, retryMs: e.retryAfterMs ?? 10_000 };
    if (e.code === "server_error" && e.status === 503 && e.retryAfterMs) return { status: "retry", error: e.message, retryMs: e.retryAfterMs };
    if (e.retryable) return { status: "error", error: e.message, retryMs: jobBackoffMs(attempt, rand) };
    // invalid_grant, permisos, validación: reintentar no cambia nada pronto.
    return { status: "error", error: `${e.code}: ${e.message}`.slice(0, 480), retryMs: 6 * 3600_000 };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { status: "error", error: msg.slice(0, 480), retryMs: jobBackoffMs(attempt, rand) };
}

// -----------------------------------------------------------------------------
// Espejos.
// -----------------------------------------------------------------------------
export function itemPayload(item: MlItem, stockMode: StockMode | null = null): Record<string, unknown> {
  return {
    ml_item_id: item.id,
    user_product_id: item.user_product_id ?? null,
    family_id: item.family_id != null ? String(item.family_id) : null,
    title: item.title ?? item.family_name ?? "",
    category_id: item.category_id ?? null,
    listing_type_id: item.listing_type_id ?? null,
    status: item.status ?? "active",
    sub_status: item.sub_status ?? [],
    tags: (item.tags ?? []).slice(0, 40),
    logistic_type: item.shipping?.logistic_type ?? null,
    shipping_mode: item.shipping?.mode ?? null,
    free_shipping: Boolean(item.shipping?.free_shipping),
    catalog_listing: Boolean(item.catalog_listing),
    catalog_product_id: item.catalog_product_id ?? null,
    permalink: item.permalink ?? null,
    // Siempre https: la app corre en https y el navegador bloquea http (contenido mixto).
    thumbnail: (item.secure_thumbnail ?? item.thumbnail ?? null)?.replace(/^http:\/\//i, "https://") ?? null,
    currency: item.currency_id ?? "ARS",
    price: item.price ?? null,
    available_quantity: item.available_quantity ?? null,
    sold_quantity: item.sold_quantity ?? null,
    has_variations: (item.variations ?? []).length > 0,
    health: item.health ?? null,
    price_automation: hasPriceAutomation(item),
    stock_mode: stockMode,
  };
}

export function questionPayload(q: MlQuestion): Record<string, unknown> {
  return {
    question_id: String(q.id),
    ml_item_id: q.item_id,
    text: q.text,
    status: q.status,
    date_created: q.date_created,
    from_id: q.from?.id != null ? String(q.from.id) : null,
    answer_text: q.answer?.text ?? null,
    answer_date: q.answer?.date_created ?? null,
  };
}

async function fetchBilling(client: MlClient, order: MlOrder): Promise<BillingNormalized | null> {
  const fallback = [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(" ") || order.buyer?.nickname || "";
  const id = order.buyer?.billing_info?.id;
  try {
    if (id) {
      const b = await client.get<MlBillingInfoNew>(`/orders/billing-info/MLA/${encodeURIComponent(id)}`);
      const n = normalizeBilling(b, fallback);
      if (n) return n;
    }
    const legacy = await client.get<MlBillingInfoLegacy>(`/orders/${order.id}/billing_info`);
    return normalizeBilling(legacy, fallback);
  } catch (e) {
    if (e instanceof MlApiError && (e.code === "not_found" || e.code === "forbidden" || e.code === "missing_permission")) return null;
    throw e;
  }
}

/** GET de la orden, del carrito completo, facturación y envío (sólo lecturas). */
export async function fetchPack(deps: WorkerDeps, accountId: string, orderId: string): Promise<PackPayload> {
  const client = deps.client(accountId);
  const first = await client.get<MlOrder>(`/orders/${encodeURIComponent(orderId)}`);
  let orders: MlOrder[] = [first];
  if (first.pack_id) {
    const pack = await client.get<MlPack>(`/packs/${first.pack_id}`);
    const ids = (pack.orders ?? []).map((o) => String(o.id));
    orders = [];
    for (const id of ids) orders.push(id === String(first.id) ? first : await client.get<MlOrder>(`/orders/${id}`));
    if (orders.length === 0) orders = [first];
  }
  const allPaid = orders.every((o) => o.status === "paid");
  const billing = allPaid ? await fetchBilling(client, first) : null;
  let shipment: ShipmentNormalized | null = null;
  const shipId = first.shipping?.id;
  if (shipId) {
    try {
      const s = await client.get<MlShipment>(`/shipments/${shipId}`, undefined, { "x-format-new": "true" });
      shipment = normalizeShipment(s);
    } catch (e) {
      if (!(e instanceof MlApiError) || e.code !== "not_found") throw e;
    }
  }
  return buildPackPayload(orders, shipment, billing);
}

/** Lo que devuelve ml_billing_context (ADR-141). */
export interface BillingContext {
  enabled: boolean;
  settings: Record<string, unknown> | null;
  emitter: PlanEmitter;
  padron: PlanPadron | null;
  iibb: IibbEntry[];
  iibb_loaded: string[];
  line_rates: Array<{ ml_item_id: string; ml_variation_id: string | null; rate: number }>;
  today: string;
}

/** Entrada del armado de la factura desde el carrito y el contexto del servidor. PURO. */
export function planInputFromPack(p: PackPayload, ctx: BillingContext): PlanInput {
  const rates = ctx.line_rates ?? [];
  const rateOf = (item: string, variation: string | null) =>
    rates.find((r) => r.ml_item_id === item && (r.ml_variation_id ?? null) === (variation ?? null))?.rate ??
    rates.find((r) => r.ml_item_id === item)?.rate ??
    null;
  return {
    orders: p.orders.map((o) => ({
      ml_order_id: o.ml_order_id,
      status: o.status,
      total_amount: o.total_amount,
      payments: o.payments ?? [],
      lines: o.lines.map((l) => ({
        ml_order_id: l.ml_order_id,
        ml_item_id: l.ml_item_id,
        ml_variation_id: l.ml_variation_id,
        title: l.title,
        seller_sku: l.seller_sku,
        quantity: l.quantity,
        unit_price: l.unit_price,
        iva_rate: rateOf(l.ml_item_id, l.ml_variation_id),
      })),
    })),
    shipment: p.shipment
      ? { mode: p.shipment.mode, logistic_type: p.shipment.logistic_type, cost: p.shipment.cost, state: p.shipment.state }
      : null,
    billing: p.billing
      ? {
          docType: p.billing.docType,
          docNumber: p.billing.docNumber,
          name: p.billing.name,
          ivaCondition: p.billing.ivaCondition,
          address: p.billing.address,
          state: p.billing.state ?? null,
        }
      : null,
    padron: ctx.padron,
    iibb: ctx.iibb ?? [],
    iibb_loaded: ctx.iibb_loaded ?? [],
    emitter: ctx.emitter,
    settings: planSettingsFrom(ctx.settings),
    today: ctx.today,
  };
}

/**
 * Factura del carrito con las reglas de la cuenta (ADR-141). null si la cuenta
 * no tiene la facturación pro, si el carrito no está pagado o si algo falla:
 * la venta entra igual, como antes.
 */
export async function planForPack(deps: WorkerDeps, accountId: string, p: PackPayload): Promise<MlInvoicePlan | null> {
  if (!p.orders.every((o) => o.status === "paid")) return null;
  try {
    const cuit = p.billing && (p.billing.docType === "cuit" || p.billing.docType === "cuil") ? p.billing.docNumber : null;
    const ctx = (await deps.rpc("ml_billing_context", {
      p_account: accountId,
      p: {
        cuit,
        lines: p.orders.flatMap((o) => o.lines.map((l) => ({ ml_item_id: l.ml_item_id, ml_variation_id: l.ml_variation_id }))),
      },
    })) as BillingContext | null;
    if (!ctx?.enabled) return null;
    return buildInvoicePlan(planInputFromPack(p, ctx));
  } catch (e) {
    deps.log?.("ml_invoice_plan_failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** GET de la orden, del carrito completo, facturación y envío -> ml_ingest_pack. */
export async function ingestOrder(deps: WorkerDeps, accountId: string, orderId: string): Promise<Record<string, unknown>> {
  const payload = await fetchPack(deps, accountId, orderId);
  const invoice = await planForPack(deps, accountId, payload);
  const res = await deps.rpc("ml_ingest_pack", { p_account: accountId, p: invoice ? { ...payload, invoice } : payload });
  if (payload.shipment) await deps.rpc("ml_shipment_upsert", { p_account: accountId, p: payload.shipment });
  return (res ?? {}) as Record<string, unknown>;
}

export async function refreshItem(deps: WorkerDeps, accountId: string, itemId: string): Promise<string> {
  const client = deps.client(accountId);
  const item = await client.get<MlItem>(`/items/${encodeURIComponent(itemId)}`);
  let mode: StockMode | null = null;
  if (item.user_product_id) {
    try {
      const up = await client.get<MlUserProductStock>(`/user-products/${encodeURIComponent(item.user_product_id)}/stock`);
      mode = stockModeFrom(item, up);
    } catch (e) {
      if (!(e instanceof MlApiError) || (e.code !== "not_found" && e.code !== "forbidden")) throw e;
      mode = stockModeFrom(item, null);
    }
  } else {
    mode = stockModeFrom(item, null);
  }
  return (await deps.rpc("ml_item_upsert", { p_account: accountId, p: itemPayload(item, mode) })) as string;
}

/** Procesa una notificación del inbox (GET autenticado del recurso). */
export async function processNotification(deps: WorkerDeps, n: NotificationRow): Promise<Outcome> {
  if (!isHandledTopic(n.topic)) return { status: "ignored", note: "topic_not_in_mvp" };
  const id = resourceId(n.resource);
  try {
    // Gestor (ADR-132): reclamos. Sin la feature, ml_claim_upsert lo ignora.
    if (isGestorTopic(n.topic)) {
      const r = await refreshClaim(deps, n.account_id, id);
      return r.status === "done" ? { status: "done" } : { status: "ignored", note: r.note };
    }
    switch (n.topic) {
      case "orders_v2":
      case "orders": {
        const r = await ingestOrder(deps, n.account_id, id);
        if (r.ok === false) return { status: "ignored", note: String(r.error ?? "ignored") };
        return { status: "done", note: String(r.decision ?? "") };
      }
      case "items":
      case "items_prices":
        await refreshItem(deps, n.account_id, id);
        return { status: "done" };
      case "questions": {
        const q = await deps.client(n.account_id).get<MlQuestion>(`/questions/${id}`, { api_version: 4 });
        await deps.rpc("ml_question_upsert", { p_account: n.account_id, p: questionPayload(q) });
        return { status: "done" };
      }
      case "shipments": {
        const s = await deps.client(n.account_id).get<MlShipment>(`/shipments/${id}`, undefined, { "x-format-new": "true" });
        await deps.rpc("ml_shipment_upsert", { p_account: n.account_id, p: normalizeShipment(s) });
        return { status: "done" };
      }
    }
    return { status: "ignored" };
  } catch (e) {
    // Un recurso que ya no existe (ítem borrado, pregunta eliminada) no se reintenta.
    if (e instanceof MlApiError && e.code === "not_found") return { status: "ignored", note: "not_found" };
    return outcomeOf(e, n.tries, deps.rand);
  }
}

// -----------------------------------------------------------------------------
// Cola de escrituras.
// -----------------------------------------------------------------------------
interface StockSnapshot {
  ml_item_id: string;
  user_product_id: string | null;
  stock_mode: StockMode | null;
  has_variations: boolean;
  push_enabled: boolean;
  links: Array<{ ml_variation_id: string | null; qty: number | null }>;
}

interface PriceSnapshot {
  ml_item_id: string;
  price_source: string;
  has_variations: boolean;
  push_enabled: boolean;
  links: Array<{ ml_variation_id: string | null; price: number | null }>;
}

async function runStockPush(deps: WorkerDeps, job: JobRow): Promise<Outcome> {
  const itemRow = String(job.payload.item_id ?? "");
  const snap = (await deps.rpc("ml_item_stock_snapshot", { p_item: itemRow })) as StockSnapshot | null;
  if (!snap) return { status: "done", note: "item_gone" };
  if (!snap.push_enabled) return { status: "done", note: "push_disabled" };
  const links = snap.links.filter((l) => l.qty !== null && l.qty !== undefined);
  if (links.length === 0) return { status: "done", note: "nothing_to_push" };
  const client = deps.client(job.account_id);
  let mode = snap.stock_mode;
  if (!mode) {
    await refreshItem(deps, job.account_id, snap.ml_item_id);
    const again = (await deps.rpc("ml_item_stock_snapshot", { p_item: itemRow })) as StockSnapshot | null;
    mode = again?.stock_mode ?? "item";
  }
  if (mode === "full_only" || mode === "seller_warehouse") {
    return { status: "done", note: mode === "full_only" ? "full_managed_by_ml" : "multiorigen_v2" };
  }
  const qty = links[0]!.qty as number;
  if (mode === "selling_address" && snap.user_product_id) {
    await pushSellingAddress(client, snap.user_product_id, qty);
  } else if (snap.has_variations && links.some((l) => l.ml_variation_id)) {
    const map = new Map<string, number>();
    for (const l of links) if (l.ml_variation_id) map.set(l.ml_variation_id, l.qty as number);
    await pushVariationQuantities(client, snap.ml_item_id, map);
  } else {
    await pushItemQuantity(client, snap.ml_item_id, qty);
  }
  await deps.rpc("ml_item_pushed", { p_item: itemRow, p: { qty: links.length === 1 ? qty : null, stock_mode: mode } });
  return { status: "done" };
}

async function runPricePush(deps: WorkerDeps, job: JobRow): Promise<Outcome> {
  const itemRow = String(job.payload.item_id ?? "");
  const snap = (await deps.rpc("ml_item_price_snapshot", { p_item: itemRow })) as PriceSnapshot | null;
  if (!snap) return { status: "done", note: "item_gone" };
  if (!snap.push_enabled) return { status: "done", note: snap.price_source === "pos" ? "push_disabled" : `price_${snap.price_source}` };
  const priced = snap.links.filter((l) => typeof l.price === "number" && l.price > 0);
  if (priced.length === 0) return { status: "done", note: "no_price" };
  const client = deps.client(job.account_id);
  try {
    if (snap.has_variations && priced.some((l) => l.ml_variation_id)) {
      // Clásico: una sola publicación, mismo precio para todas las variaciones.
      const item = await client.get<MlItem>(`/items/${snap.ml_item_id}`, { attributes: "id,variations" });
      const price = Math.max(...priced.map((l) => l.price as number));
      await client.put(`/items/${snap.ml_item_id}`, { variations: (item.variations ?? []).map((v) => ({ id: v.id, price })) });
      await deps.rpc("ml_item_pushed", { p_item: itemRow, p: { price } });
    } else {
      const price = priced[0]!.price as number;
      // Hoy el precio se escribe por PUT /items/{id} (ML anuncia /prices a futuro).
      await client.put(`/items/${snap.ml_item_id}`, { price });
      await deps.rpc("ml_item_pushed", { p_item: itemRow, p: { price } });
    }
  } catch (e) {
    if (e instanceof MlApiError && e.code === "price_automation") {
      await deps.rpc("ml_item_pushed", { p_item: itemRow, p: { price_source: "automation", error: e.message } });
      return { status: "done", note: "price_automation" };
    }
    throw e;
  }
  return { status: "done" };
}

async function runItemStatus(deps: WorkerDeps, job: JobRow): Promise<Outcome> {
  const status = String(job.payload.status ?? "");
  if (status !== "paused" && status !== "active") return { status: "done", note: "invalid_status" };
  const itemId = String(job.ref ?? "");
  await deps.client(job.account_id).put(`/items/${encodeURIComponent(itemId)}`, { status });
  await refreshItem(deps, job.account_id, itemId);
  return { status: "done" };
}

async function runAnswer(deps: WorkerDeps, job: JobRow): Promise<Outcome> {
  const row = String(job.payload.question_row ?? "");
  const text = String(job.payload.text ?? "");
  const questionId = Number(job.ref);
  try {
    if (!text) return { status: "done", note: "empty_answer" };
    await deps.client(job.account_id).post("/answers", { question_id: questionId, text });
    await deps.rpc("ml_question_answered", { p_question: row, p_ok: true });
    return { status: "done" };
  } catch (e) {
    const o = outcomeOf(e, job.attempts, deps.rand);
    if (o.status === "error" && (job.attempts >= job.max_attempts || (e instanceof MlApiError && !e.retryable))) {
      await deps.rpc("ml_question_answered", { p_question: row, p_ok: false, p_error: o.error });
    }
    throw e;
  }
}

async function runInvoiceUpload(deps: JobDeps, job: JobRow): Promise<Outcome> {
  const docId = String(job.payload.fiscal_document_id ?? "");
  const pack = String(job.payload.pack_key ?? job.ref ?? "");
  const data = (await deps.rpc("ml_invoice_pdf_data", { p_doc: docId })) as InvoicePdfData | null;
  if (!data) return { status: "done", note: "invoice_not_approved" };
  const pdf = buildInvoicePdf(data);
  if (pdf.length > 1_000_000) {
    await deps.rpc("ml_invoice_uploaded", { p_account: job.account_id, p_pack: pack, p_doc: docId, p_ok: false, p_error: "El PDF supera 1 MB" });
    return { status: "done", note: "pdf_too_large" };
  }
  // ADR-141: "Volver a subir" reemplaza el documento que ya tenía la venta en ML.
  const replace = String(job.payload.replace_ml_id ?? "");
  if (replace && deps.deleteDoc) {
    try {
      await deps.deleteDoc(job.account_id, `/packs/${encodeURIComponent(pack)}/fiscal_documents/${encodeURIComponent(replace)}`);
    } catch (e) {
      if (!(e instanceof MlApiError) || e.code !== "not_found") throw e;
    }
  }
  const form = new FormData();
  const prefix = /cr[eé]dito/i.test(data.doc.label) ? "nota-credito" : "factura";
  const name = `${prefix}-${data.doc.letter}-${String(data.doc.ptoVta).padStart(5, "0")}-${String(data.doc.nro).padStart(8, "0")}.pdf`;
  form.append("fiscal_document", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), name);
  try {
    const res = (await deps.postForm(job.account_id, `/packs/${encodeURIComponent(pack)}/fiscal_documents`, form)) as { ids?: string[] } | null;
    await deps.rpc("ml_invoice_uploaded", {
      p_account: job.account_id, p_pack: pack, p_doc: docId, p_ok: true, p_ml_id: (res?.ids ?? [])[0] ?? null,
    });
    return { status: "done" };
  } catch (e) {
    // ML ya tiene un documento de ese tipo en la venta: no se reintenta a ciegas.
    const dup = e instanceof MlApiError && /already|exist|limit/i.test(e.message);
    if (e instanceof MlApiError && (!e.retryable || dup || job.attempts >= job.max_attempts)) {
      await deps.rpc("ml_invoice_uploaded", {
        p_account: job.account_id, p_pack: pack, p_doc: docId, p_ok: false,
        p_error: dup ? "Mercado Libre ya tiene un documento de ese tipo en la venta: usá Volver a subir para reemplazarlo." : e.message,
      });
      if (dup) return { status: "done", note: "already_uploaded" };
    }
    throw e;
  }
}

export interface JobDeps extends WorkerDeps {
  /** POST multipart (la subida del PDF). */
  postForm(accountId: string, path: string, form: FormData): Promise<unknown>;
  /** DELETE de un documento fiscal ya subido (reemplazo, ADR-141). */
  deleteDoc?(accountId: string, path: string): Promise<unknown>;
}

export async function processJob(deps: JobDeps, job: JobRow): Promise<Outcome> {
  try {
    switch (job.kind) {
      case "stock_push":
        return await runStockPush(deps, job);
      case "price_push":
        return await runPricePush(deps, job);
      case "item_status":
        return await runItemStatus(deps, job);
      case "item_refresh":
        await refreshItem(deps, job.account_id, String(job.ref ?? ""));
        return { status: "done" };
      case "answer_question":
        return await runAnswer(deps, job);
      case "invoice_upload":
        return await runInvoiceUpload(deps, job);
      case "claim_refresh": {
        const r = await refreshClaim(deps, job.account_id, String(job.ref ?? ""));
        return r.status === "done" ? { status: "done" } : { status: "ignored", note: r.note };
      }
      case "order_refresh": {
        const r = await ingestOrder(deps, job.account_id, String(job.ref ?? ""));
        return { status: "done", note: String(r.decision ?? "") };
      }
      default:
        return { status: "done", note: "kind_not_in_mvp" };
    }
  } catch (e) {
    return outcomeOf(e, job.attempts, deps.rand);
  }
}

/** Familia del límite de llamadas de un trabajo (para el gate). */
export function jobFamily(kind: string): ReturnType<typeof familyOf> {
  if (kind === "stock_push") return "stock";
  if (kind === "invoice_upload") return "invoices";
  if (kind === "answer_question") return "questions";
  return "items";
}
