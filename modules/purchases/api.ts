"use client";

// Compras y proveedores (F18 · H101 + H102, ADR-050).
// Proveedores y productos por proveedor: ABM por tabla con RLS (el servidor
// exige rol y plan). Órdenes, recepciones, costeo, comprobantes y pagos: toda
// escritura por RPC SECURITY DEFINER (estado, stock, costos y auditoría). Las
// tablas y RPC nuevas no están en los tipos generados (no se regeneran): se
// castean.

import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import type { CostBasis } from "@/lib/purchases/costs";
import type { AccountEntry, EntryType } from "@/lib/purchases/aging";
import type {
  InvoiceKind,
  InvoiceLetter,
  OtherTaxLine,
  PaymentMethod,
  VatLine,
  WithholdingLine,
} from "@/lib/purchases/invoices";
import type { OrderStatus, ReceiptDifferenceReason } from "@/lib/purchases/orders";
import type { SupplierIvaCondition } from "@/lib/purchases/suppliers";
import { formatInvoiceNumber } from "@/lib/purchases/invoices";
import type { ReturnReason } from "@/lib/purchases/returns";
import type {
  AllocationDraft,
  OpenInvoice,
  PaymentLineDraft,
  PaymentLineMethod,
} from "@/lib/purchases/paymentOrders";
import type { PriceListMapping, rowsToApply } from "@/lib/purchases/priceList";

// ── Tipos ─────────────────────────────────────────────────────────────────

export interface PurchaseSettings {
  mode: "simple" | "pro";
  cost_basis: CostBasis;
  sync_product_cost: boolean;
  cashier_can_receive: boolean;
  allow_free_receipts: boolean;
  allow_over_receive: boolean;
  require_difference_reason: boolean;
  default_currency: string;
}

export const DEFAULT_PURCHASE_SETTINGS: PurchaseSettings = {
  mode: "simple",
  cost_basis: "last",
  sync_product_cost: true,
  cashier_can_receive: true,
  allow_free_receipts: true,
  allow_over_receive: true,
  require_difference_reason: false,
  default_currency: "ARS",
};

export interface Supplier {
  id: string;
  name: string;
  trade_name: string | null;
  cuit: string | null;
  foreign_tax_id: string | null;
  iva_condition: SupplierIvaCondition;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string;
  payment_terms_days: number;
  payment_terms_note: string | null;
  currency: string;
  cbu: string | null;
  alias: string | null;
  bank_name: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  deleted_at: string | null;
}

export type SupplierInput = Omit<Supplier, "id" | "created_at" | "deleted_at">;

export interface SupplierProduct {
  id: string;
  supplier_id: string;
  product_id: string;
  variant_id: string | null;
  supplier_sku: string | null;
  last_cost: number | null;
  list_cost: number | null;
  currency: string;
  last_cost_at: string | null;
  lead_time_days: number | null;
  min_order_qty: number | null;
  purchase_unit: string | null;
  units_per_purchase: number;
  is_preferred: boolean;
  notes: string | null;
  product_name: string;
  product_sku: string | null;
  product_unit: string;
  product_cost: number | null;
  supplier_name: string;
}

export interface SupplierProductInput {
  id?: string | null;
  supplier_id: string;
  product_id: string;
  variant_id?: string | null;
  supplier_sku?: string | null;
  list_cost?: number | null;
  currency?: string;
  lead_time_days?: number | null;
  min_order_qty?: number | null;
  purchase_unit?: string | null;
  units_per_purchase?: number;
  is_preferred?: boolean;
  notes?: string | null;
}

export interface PurchaseEvent {
  id: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  actor_name: string | null;
  notes: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface OrderRow {
  id: string;
  number: number;
  supplier_id: string;
  store_id: string;
  status: OrderStatus;
  issue_date: string;
  expected_date: string | null;
  currency: string;
  fx_rate: number;
  discount_pct: number;
  payment_terms_days: number | null;
  notes: string | null;
  subtotal: number;
  discount_total: number;
  net_total: number;
  tax_total: number;
  total: number;
  units_ordered: number;
  units_received: number;
  sent_at: string | null;
  received_at: string | null;
  close_reason: string | null;
  cancel_reason: string | null;
  created_at: string;
}

export interface OrderItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  supplier_sku: string | null;
  unit: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number;
  discounts: number[];
  tax_rate: number;
  line_net: number;
  notes: string | null;
  sort: number;
}

export interface ReceiptRow {
  id: string;
  number: number;
  order_id: string | null;
  supplier_id: string | null;
  store_id: string;
  received_date: string;
  remito_number: string | null;
  currency: string;
  fx_rate: number;
  notes: string | null;
  total_units: number;
  total_cost: number;
  landed_total: number | null;
  costing: Record<string, unknown> | null;
  costing_applied_at: string | null;
  dispatch_number: string | null;
  invoice_id: string | null;
  status: "posted" | "voided";
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
}

export interface ReceiptItem {
  id: string;
  order_item_id: string | null;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  qty_expected: number | null;
  qty: number;
  difference_reason: ReceiptDifferenceReason | null;
  unit_cost: number;
  unit_cost_ars: number;
  landed_unit_cost: number | null;
  valued_unit_cost: number;
  tax_rate: number;
  weight_kg: number | null;
  volume_m3: number | null;
  lot_code: string | null;
  expires_on: string | null;
  notes: string | null;
  sort: number;
  qty_returned: number;
}

export interface OrderDetail extends OrderRow {
  items: OrderItem[];
  events: PurchaseEvent[];
  receipts: ReceiptRow[];
}

export interface ReceiptDetail extends ReceiptRow {
  items: ReceiptItem[];
  events: PurchaseEvent[];
}

export interface OrderSaveInput {
  id?: string | null;
  supplier_id: string;
  store_id: string;
  expected_date: string | null;
  currency: string;
  fx_rate: number;
  discount_pct: number;
  payment_terms_days: number | null;
  notes: string | null;
  items: Array<{
    product_id: string;
    variant_id: string | null;
    qty: number;
    unit_cost: number;
    discounts: number[];
    tax_rate?: number | null;
    supplier_sku?: string | null;
    notes?: string | null;
  }>;
}

export interface ReceiveLineInput {
  order_item_id?: string | null;
  product_id?: string | null;
  variant_id?: string | null;
  qty: number;
  unit_cost?: number | null;
  reason?: ReceiptDifferenceReason | null;
  lot_code?: string | null;
  expires_on?: string | null;
  weight_kg?: number | null;
  volume_m3?: number | null;
  notes?: string | null;
}

export interface ReceiveInput {
  order_id: string | null;
  store_id: string | null;
  supplier_id: string | null;
  received_date: string;
  remito_number: string | null;
  currency: string;
  fx_rate: number;
  items: ReceiveLineInput[];
  close?: boolean;
  notes?: string | null;
}

export interface InvoiceRow {
  id: string;
  supplier_id: string;
  kind: InvoiceKind;
  letter: InvoiceLetter;
  point_of_sale: number;
  number: number;
  issue_date: string;
  due_date: string | null;
  currency: string;
  fx_rate: number;
  vat_lines: VatLine[];
  other_taxes: OtherTaxLine[];
  net_total: number;
  vat_total: number;
  exempt_amount: number;
  non_taxed_amount: number;
  other_taxes_total: number;
  total: number;
  order_id: string | null;
  notes: string | null;
  status: "posted" | "voided";
  void_reason: string | null;
  created_at: string;
}

export interface InvoiceSaveInput {
  supplier_id: string;
  kind: InvoiceKind;
  letter: InvoiceLetter;
  point_of_sale: number;
  number: number;
  issue_date: string;
  due_date: string | null;
  currency: string;
  fx_rate: number;
  vat_lines: VatLine[];
  exempt_amount: number;
  non_taxed_amount: number;
  other_taxes: OtherTaxLine[];
  total: number;
  order_id?: string | null;
  notes?: string | null;
}

export interface PaymentRow {
  id: string;
  number: number;
  supplier_id: string;
  paid_date: string;
  method: PaymentMethod | "mixto";
  reference: string | null;
  currency: string;
  fx_rate: number;
  amount: number;
  withholdings: WithholdingLine[];
  withholdings_total: number;
  net_paid: number;
  notes: string | null;
  status: "posted" | "voided";
  void_reason: string | null;
  kind: "simple" | "order";
  created_at: string;
}

export interface PaymentInput {
  supplier_id: string;
  paid_date: string;
  method: PaymentMethod;
  reference?: string | null;
  currency: string;
  fx_rate: number;
  net_paid: number;
  withholdings: WithholdingLine[];
  notes?: string | null;
}

export interface SupplierBalance {
  supplier_id: string;
  balance_ars: number;
  debit_ars: number;
  credit_ars: number;
  balance_currency: number;
  currency: string;
  oldest_due: string | null;
  last_movement: string | null;
}

export interface SuggestionRow {
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  qty: number;
  min_qty: number;
  max_qty: number | null;
  in_transit_in: number;
  on_order: number;
  cost: number | null;
  tax_rate: number | null;
  supplier_sku: string | null;
  supplier_cost: number | null;
  min_order_qty: number | null;
  units_per_purchase: number;
}

export interface CostHistoryRow {
  id: string;
  kind: "cost" | "last" | "average" | "replacement";
  old_value: number | null;
  new_value: number | null;
  source: string | null;
  created_at: string;
}

export interface OrderFilters {
  statuses?: OrderStatus[] | null;
  supplierId?: string | null;
  storeId?: string | null;
  search?: string | null;
}

export interface DocFilters {
  supplierId?: string | null;
  from?: string | null;
  to?: string | null;
  includeVoided?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function num<T extends object>(row: T, keys: (keyof T)[]): T {
  const out = { ...row };
  for (const k of keys) {
    const v = out[k] as unknown;
    if (v !== null && v !== undefined) (out as Record<keyof T, unknown>)[k] = Number(v);
  }
  return out;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const from = (table: string) => createClient().from(table as never);

/**
 * Negocio activo (app_metadata.current_tenant_id). Las listas filtran por él
 * además de la RLS (ADR-052): nunca dependen sólo de la policy.
 */
async function tenantId(): Promise<string> {
  const user = await getCurrentUser();
  const id = (user?.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id;
  if (!id) throw new Error("no_tenant");
  return id;
}

async function events(entityId: string): Promise<PurchaseEvent[]> {
  const supabase = createClient();
  const { data, error } = await from("purchase_events")
    .select("id, kind, from_status, to_status, actor_id, notes, data, created_at")
    .eq("tenant_id", await tenantId())
    .eq("entity_id", entityId)
    .order("created_at");
  if (error) throw error;
  const evs = (data ?? []) as unknown as Omit<PurchaseEvent, "actor_name">[];
  const ids = [...new Set(evs.map((e) => e.actor_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", ids);
    for (const u of (users ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
      names.set(u.id, u.full_name || u.email || "");
    }
  }
  return evs.map((e) => ({ ...e, actor_name: e.actor_id ? (names.get(e.actor_id) ?? null) : null }));
}

const SUPPLIER_COLS =
  "id, name, trade_name, cuit, foreign_tax_id, iva_condition, contact_name, email, phone, whatsapp, address, city, province, country, payment_terms_days, payment_terms_note, currency, cbu, alias, bank_name, notes, is_active, created_at, deleted_at";

const ORDER_COLS =
  "id, number, supplier_id, store_id, status, issue_date, expected_date, currency, fx_rate, discount_pct, payment_terms_days, notes, subtotal, discount_total, net_total, tax_total, total, units_ordered, units_received, sent_at, received_at, close_reason, cancel_reason, created_at";
const ORDER_NUM: (keyof OrderRow)[] = [
  "fx_rate",
  "discount_pct",
  "subtotal",
  "discount_total",
  "net_total",
  "tax_total",
  "total",
  "units_ordered",
  "units_received",
];

const RECEIPT_COLS =
  "id, number, order_id, supplier_id, store_id, received_date, remito_number, currency, fx_rate, notes, total_units, total_cost, landed_total, costing, costing_applied_at, dispatch_number, invoice_id, status, void_reason, voided_at, created_at";
const RECEIPT_NUM: (keyof ReceiptRow)[] = ["fx_rate", "total_units", "total_cost", "landed_total"];

const INVOICE_COLS =
  "id, supplier_id, kind, letter, point_of_sale, number, issue_date, due_date, currency, fx_rate, vat_lines, other_taxes, net_total, vat_total, exempt_amount, non_taxed_amount, other_taxes_total, total, order_id, notes, status, void_reason, created_at";
const INVOICE_NUM: (keyof InvoiceRow)[] = [
  "number",
  "fx_rate",
  "net_total",
  "vat_total",
  "exempt_amount",
  "non_taxed_amount",
  "other_taxes_total",
  "total",
];

const PAYMENT_COLS =
  "id, number, supplier_id, paid_date, method, reference, currency, fx_rate, amount, withholdings, withholdings_total, net_paid, notes, status, void_reason, kind, created_at";
const PAYMENT_NUM: (keyof PaymentRow)[] = ["fx_rate", "amount", "withholdings_total", "net_paid"];

const blankToNull = <T extends Record<string, unknown>>(o: T): T => {
  const out = { ...o } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.trim() === "") out[k] = null;
  }
  return out as T;
};

// ── API ───────────────────────────────────────────────────────────────────

export const purchasesApi = {
  // Configuración
  settings: async (): Promise<PurchaseSettings> => {
    const { data, error } = await from("purchase_settings")
      .select(
        "mode, cost_basis, sync_product_cost, cashier_can_receive, allow_free_receipts, allow_over_receive, require_difference_reason, default_currency",
      )
      .eq("tenant_id", await tenantId())
      .maybeSingle();
    if (error) throw error;
    return data ? (data as unknown as PurchaseSettings) : { ...DEFAULT_PURCHASE_SETTINGS };
  },

  saveSettings: (s: Partial<PurchaseSettings>): Promise<PurchaseSettings> =>
    rpc<PurchaseSettings>("purchase_settings_save", { p: s }),

  // Proveedores
  suppliers: async (opts: { includeArchived?: boolean } = {}): Promise<Supplier[]> => {
    let q = from("suppliers").select(SUPPLIER_COLS).eq("tenant_id", await tenantId()).order("name").limit(1000);
    if (!opts.includeArchived) q = q.is("deleted_at", null);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as Supplier[];
  },

  createSupplier: async (input: SupplierInput): Promise<Supplier> => {
    const { data, error } = await from("suppliers")
      .insert(blankToNull(input as unknown as Record<string, unknown>) as never)
      .select(SUPPLIER_COLS)
      .single();
    if (error) throw error;
    return data as unknown as Supplier;
  },

  updateSupplier: async (id: string, input: Partial<SupplierInput>): Promise<void> => {
    const { error } = await from("suppliers")
      .update(blankToNull(input as unknown as Record<string, unknown>) as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica (y reactivación).
  archiveSupplier: async (id: string, archived: boolean): Promise<void> => {
    const { error } = await from("suppliers")
      .update({ deleted_at: archived ? new Date().toISOString() : null } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Productos por proveedor
  supplierProducts: async (f: { supplierId?: string; productId?: string }): Promise<SupplierProduct[]> => {
    let q = from("supplier_products")
      .select(
        "id, supplier_id, product_id, variant_id, supplier_sku, last_cost, list_cost, currency, last_cost_at, lead_time_days, min_order_qty, purchase_unit, units_per_purchase, is_preferred, notes, products(name, sku, unit, cost), suppliers(name)",
      )
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null)
      .limit(1000);
    if (f.supplierId) q = q.eq("supplier_id", f.supplierId);
    if (f.productId) q = q.eq("product_id", f.productId);
    const { data, error } = await q;
    if (error) throw error;
    type Raw = Omit<SupplierProduct, "product_name" | "product_sku" | "product_unit" | "product_cost" | "supplier_name"> & {
      products: { name: string; sku: string | null; unit: string; cost: number | null } | null;
      suppliers: { name: string } | null;
    };
    return ((data ?? []) as unknown as Raw[])
      .map((r) => {
        const { products: p, suppliers: s, ...rest } = r;
        return {
          ...num(rest, ["last_cost", "list_cost", "min_order_qty", "units_per_purchase"]),
          product_name: p?.name ?? "",
          product_sku: p?.sku ?? null,
          product_unit: p?.unit ?? "un",
          product_cost: p?.cost == null ? null : Number(p.cost),
          supplier_name: s?.name ?? "",
        } as SupplierProduct;
      })
      .sort((a, b) => a.product_name.localeCompare(b.product_name));
  },

  saveSupplierProduct: async (input: SupplierProductInput): Promise<void> => {
    const { id, ...rest } = input;
    const row = blankToNull(rest as unknown as Record<string, unknown>);
    const { error } = id
      ? await from("supplier_products").update(row as never).eq("id", id)
      : await from("supplier_products").insert(row as never);
    if (error) throw error;
  },

  removeSupplierProduct: async (id: string): Promise<void> => {
    const { error } = await from("supplier_products")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  setReplacementFromSupplier: (id: string, fxRate: number): Promise<number> =>
    rpc<number>("supplier_product_set_replacement", { p_id: id, p_fx_rate: fxRate }).then(Number),

  costHistory: async (productId: string): Promise<CostHistoryRow[]> => {
    const { data, error } = await from("product_cost_history")
      .select("id, kind, old_value, new_value, source, created_at")
      .eq("tenant_id", await tenantId())
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return ((data ?? []) as unknown as CostHistoryRow[]).map((r) => num(r, ["old_value", "new_value"]));
  },

  // Órdenes de compra
  orders: async (f: OrderFilters = {}): Promise<OrderRow[]> => {
    let q = from("purchase_orders")
      .select(ORDER_COLS)
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (f.statuses && f.statuses.length > 0) q = q.in("status", f.statuses);
    if (f.supplierId) q = q.eq("supplier_id", f.supplierId);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    const n = Number(String(f.search ?? "").replace(/\D/g, ""));
    if (n > 0) q = q.eq("number", n);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as OrderRow[]).map((r) => num(r, ORDER_NUM));
  },

  order: async (id: string): Promise<OrderDetail> => {
    const [o, items, receipts, evs] = await Promise.all([
      from("purchase_orders").select(ORDER_COLS).eq("id", id).single(),
      from("purchase_order_items")
        .select(
          "id, product_id, variant_id, product_name, variant_label, sku, supplier_sku, unit, qty_ordered, qty_received, unit_cost, discounts, tax_rate, line_net, notes, sort",
        )
        .eq("order_id", id)
        .order("sort"),
      from("goods_receipts").select(RECEIPT_COLS).eq("order_id", id).order("created_at"),
      events(id),
    ]);
    if (o.error) throw o.error;
    if (items.error) throw items.error;
    if (receipts.error) throw receipts.error;
    return {
      ...num(o.data as unknown as OrderRow, ORDER_NUM),
      items: ((items.data ?? []) as unknown as OrderItem[]).map((i) => ({
        ...num(i, ["qty_ordered", "qty_received", "unit_cost", "tax_rate", "line_net"]),
        discounts: (i.discounts ?? []).map(Number),
      })),
      receipts: ((receipts.data ?? []) as unknown as ReceiptRow[]).map((r) => num(r, RECEIPT_NUM)),
      events: evs,
    };
  },

  saveOrder: (v: OrderSaveInput): Promise<string> =>
    rpc<string>("purchase_order_save", {
      p_id: v.id ?? null,
      p_supplier_id: v.supplier_id,
      p_store_id: v.store_id,
      p_expected_date: v.expected_date,
      p_currency: v.currency,
      p_fx_rate: v.fx_rate,
      p_discount_pct: v.discount_pct,
      p_payment_terms_days: v.payment_terms_days,
      p_notes: v.notes,
      p_items: v.items,
    }),

  sendOrder: (id: string) => rpc<void>("purchase_order_send", { p_id: id }),
  reopenOrder: (id: string) => rpc<void>("purchase_order_reopen", { p_id: id }),
  cancelOrder: (id: string, reason: string) => rpc<void>("purchase_order_cancel", { p_id: id, p_reason: reason }),
  closeOrder: (id: string, reason: string) => rpc<void>("purchase_order_close", { p_id: id, p_reason: reason }),

  suggestions: async (storeId: string, supplierId: string | null): Promise<SuggestionRow[]> => {
    const rows = await rpc<SuggestionRow[]>("purchase_suggestions", {
      p_store_id: storeId,
      p_supplier_id: supplierId,
      p_limit: 300,
    });
    return (rows ?? []).map((r) =>
      num(r, [
        "qty",
        "min_qty",
        "max_qty",
        "in_transit_in",
        "on_order",
        "cost",
        "tax_rate",
        "supplier_cost",
        "min_order_qty",
        "units_per_purchase",
      ]),
    );
  },

  // Recepciones
  receipts: async (f: DocFilters & { storeId?: string | null } = {}): Promise<ReceiptRow[]> => {
    let q = from("goods_receipts")
      .select(RECEIPT_COLS)
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (f.supplierId) q = q.eq("supplier_id", f.supplierId);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    if (f.from) q = q.gte("received_date", f.from);
    if (f.to) q = q.lte("received_date", f.to);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as ReceiptRow[]).map((r) => num(r, RECEIPT_NUM));
  },

  receipt: async (id: string): Promise<ReceiptDetail> => {
    const [r, items, evs] = await Promise.all([
      from("goods_receipts").select(RECEIPT_COLS).eq("id", id).single(),
      from("goods_receipt_items")
        .select(
          "id, order_item_id, product_id, variant_id, product_name, variant_label, sku, unit, qty_expected, qty, difference_reason, unit_cost, unit_cost_ars, landed_unit_cost, valued_unit_cost, tax_rate, weight_kg, volume_m3, lot_code, expires_on, notes, sort, qty_returned",
        )
        .eq("receipt_id", id)
        .order("sort"),
      events(id),
    ]);
    if (r.error) throw r.error;
    if (items.error) throw items.error;
    return {
      ...num(r.data as unknown as ReceiptRow, RECEIPT_NUM),
      items: ((items.data ?? []) as unknown as ReceiptItem[]).map((i) =>
        num(i, [
          "qty_expected",
          "qty",
          "unit_cost",
          "unit_cost_ars",
          "landed_unit_cost",
          "valued_unit_cost",
          "tax_rate",
          "weight_kg",
          "volume_m3",
          "qty_returned",
        ]),
      ),
      events: evs,
    };
  },

  receive: (v: ReceiveInput): Promise<string> =>
    rpc<string>("purchase_receive", {
      p_order_id: v.order_id,
      p_store_id: v.store_id,
      p_supplier_id: v.supplier_id,
      p_received_date: v.received_date,
      p_remito_number: v.remito_number,
      p_currency: v.currency,
      p_fx_rate: v.fx_rate,
      p_items: v.items,
      p_close: v.close ?? false,
      p_notes: v.notes ?? null,
    }),

  applyCosting: (v: {
    receiptId: string;
    costing: unknown;
    items: Array<{ item_id: string; landed_unit_cost: number }>;
    dispatchNumber: string | null;
  }): Promise<void> =>
    rpc<void>("purchase_apply_costing", {
      p_receipt_id: v.receiptId,
      p_costing: v.costing,
      p_items: v.items,
      p_dispatch_number: v.dispatchNumber,
    }),

  // Comprobantes
  invoices: async (f: DocFilters = {}): Promise<InvoiceRow[]> => {
    let q = from("supplier_invoices")
      .select(INVOICE_COLS)
      .eq("tenant_id", await tenantId())
      .order("issue_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500);
    if (!f.includeVoided) q = q.eq("status", "posted");
    if (f.supplierId) q = q.eq("supplier_id", f.supplierId);
    if (f.from) q = q.gte("issue_date", f.from);
    if (f.to) q = q.lte("issue_date", f.to);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as InvoiceRow[]).map((r) => num(r, INVOICE_NUM));
  },

  saveInvoice: (id: string | null, v: InvoiceSaveInput, receiptIds: string[]): Promise<string> =>
    rpc<string>("supplier_invoice_save", { p_id: id, p: v, p_receipt_ids: receiptIds }),

  voidInvoice: (id: string, reason: string) =>
    rpc<void>("supplier_invoice_void", { p_id: id, p_reason: reason }),

  // Pagos
  payments: async (f: DocFilters = {}): Promise<PaymentRow[]> => {
    let q = from("supplier_payments")
      .select(PAYMENT_COLS)
      .eq("tenant_id", await tenantId())
      .order("paid_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500);
    if (!f.includeVoided) q = q.eq("status", "posted");
    if (f.supplierId) q = q.eq("supplier_id", f.supplierId);
    if (f.from) q = q.gte("paid_date", f.from);
    if (f.to) q = q.lte("paid_date", f.to);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as PaymentRow[]).map((r) => num(r, PAYMENT_NUM));
  },

  createPayment: (v: PaymentInput): Promise<string> => rpc<string>("supplier_payment_create", { p: v }),

  voidPayment: (id: string, reason: string) =>
    rpc<void>("supplier_payment_void", { p_id: id, p_reason: reason }),

  // Cuenta corriente
  balances: async (): Promise<SupplierBalance[]> => {
    const { data, error } = await from("supplier_balances")
      .select("supplier_id, balance_ars, debit_ars, credit_ars, balance_currency, currency, oldest_due, last_movement")
      .eq("tenant_id", await tenantId());
    if (error) throw error;
    return ((data ?? []) as unknown as SupplierBalance[]).map((r) =>
      num(r, ["balance_ars", "debit_ars", "credit_ars", "balance_currency"]),
    );
  },

  entries: async (supplierId?: string | null): Promise<AccountEntry[]> => {
    let q = from("supplier_account_entries")
      .select("supplier_id, doc_id, entry_type, doc_label, doc_date, due_date, amount_ars")
      .eq("tenant_id", await tenantId())
      .limit(5000);
    if (supplierId) q = q.eq("supplier_id", supplierId);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as Array<AccountEntry & { entry_type: EntryType }>).map((r) => ({
      ...r,
      amount_ars: Number(r.amount_ars),
    }));
  },
};

// ── Compras v2 (ADR-059) ──────────────────────────────────────────────────
// Devoluciones a proveedor, anulación de recepciones, órdenes de pago con
// imputación, lotes con trazabilidad y listas de precios del proveedor.

export interface ReturnRow {
  id: string;
  number: number;
  supplier_id: string;
  store_id: string;
  receipt_id: string | null;
  return_date: string;
  reason: ReturnReason;
  notes: string | null;
  total_units: number;
  total_cost: number;
  credit_invoice_id: string | null;
  created_at: string;
}

export interface ReturnItem {
  id: string;
  receipt_item_id: string | null;
  lot_id: string | null;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  qty: number;
  unit_cost_ars: number;
  avg_before: number | null;
  avg_after: number | null;
  notes: string | null;
}

export interface ReturnDetail extends ReturnRow {
  items: ReturnItem[];
  events: PurchaseEvent[];
}

export interface ReturnInput {
  receipt_id?: string | null;
  supplier_id?: string | null;
  store_id?: string | null;
  return_date?: string | null;
  reason: ReturnReason;
  notes?: string | null;
  items: Array<{
    receipt_item_id?: string | null;
    product_id?: string | null;
    variant_id?: string | null;
    lot_id?: string | null;
    qty: number;
    unit_cost?: number | null;
    notes?: string | null;
  }>;
  credit_note?: Omit<InvoiceSaveInput, "supplier_id" | "kind"> | null;
}

export interface PaymentLineRow {
  id: string;
  method: PaymentLineMethod;
  amount: number;
  reference: string | null;
  cash_shift_id: string | null;
  treasury_account_id: string | null;
  cheque_id: string | null;
  sort: number;
}

export interface PaymentAllocationRow {
  id: string;
  invoice_id: string;
  amount: number;
  released_at: string | null;
}

export interface PaymentOrderDetail extends PaymentRow {
  lines: PaymentLineRow[];
  allocations: PaymentAllocationRow[];
  events: PurchaseEvent[];
}

export interface PaymentOrderInput {
  supplier_id: string;
  paid_date: string;
  notes?: string | null;
  lines: PaymentLineDraft[];
  withholdings: WithholdingLine[];
  allocations: AllocationDraft[];
  /** ADR-079: el servidor calcula las retenciones como agente y numera los certificados. */
  agent_retentions?: boolean;
  /** Total que vio el usuario; si el servidor calcula otro, `retentions_changed`. */
  agent_expected_total?: number;
  retention_options?: {
    ganancias_concept?: string | null;
    ganancias_condition?: string | null;
    suss_code?: string | null;
    save_profile?: boolean;
  };
}

export interface InvoiceOpenRow extends OpenInvoice {
  supplier_id: string;
  kind: InvoiceKind;
  letter: InvoiceLetter;
  point_of_sale: number;
  number: number;
  currency: string;
  allocated_ars: number;
}

export interface LotRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  store_id: string | null;
  receipt_item_id: string | null;
  lot_code: string | null;
  dispatch_number: string | null;
  expires_on: string | null;
  qty_received: number;
  qty_available: number;
  unit_cost: number | null;
  voided_at: string | null;
  created_at: string;
  product_name: string;
  product_sku: string | null;
}

export interface LotSaleRow {
  lot_id: string;
  sale_id: string;
  sale_number: number | null;
  sold_at: string;
  customer_id: string | null;
  sale_status: string;
  store_id: string | null;
  qty: number;
}

export interface PriceListApplyInput {
  supplierId: string;
  rows: ReturnType<typeof rowsToApply>;
  options: {
    file_name?: string | null;
    currency: string;
    fx_rate: number;
    update_replacement: boolean;
    link_new: boolean;
    mapping?: PriceListMapping | null;
  };
}

export interface CatalogLookupRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
}

const RETURN_COLS =
  "id, number, supplier_id, store_id, receipt_id, return_date, reason, notes, total_units, total_cost, credit_invoice_id, created_at";

/** Texto seguro para un filtro .or() de PostgREST. */
const orSafe = (s: string) => s.replace(/[%,()*]/g, "");

export const purchasesV2Api = {
  // Devoluciones
  returns: async (
    f: DocFilters & { storeId?: string | null; receiptId?: string | null } = {},
  ): Promise<ReturnRow[]> => {
    let q = from("purchase_returns")
      .select(RETURN_COLS)
      .eq("tenant_id", await tenantId())
      .order("created_at", { ascending: false })
      .limit(500);
    if (f.supplierId) q = q.eq("supplier_id", f.supplierId);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    if (f.receiptId) q = q.eq("receipt_id", f.receiptId);
    if (f.from) q = q.gte("return_date", f.from);
    if (f.to) q = q.lte("return_date", f.to);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as ReturnRow[]).map((r) => num(r, ["total_units", "total_cost"]));
  },

  returnDetail: async (id: string): Promise<ReturnDetail> => {
    const [r, items, evs] = await Promise.all([
      from("purchase_returns").select(RETURN_COLS).eq("tenant_id", await tenantId()).eq("id", id).single(),
      from("purchase_return_items")
        .select(
          "id, receipt_item_id, lot_id, product_id, variant_id, product_name, variant_label, sku, unit, qty, unit_cost_ars, avg_before, avg_after, notes",
        )
        .eq("return_id", id)
        .order("sort"),
      events(id),
    ]);
    if (r.error) throw r.error;
    if (items.error) throw items.error;
    return {
      ...num(r.data as unknown as ReturnRow, ["total_units", "total_cost"]),
      items: ((items.data ?? []) as unknown as ReturnItem[]).map((i) =>
        num(i, ["qty", "unit_cost_ars", "avg_before", "avg_after"]),
      ),
      events: evs,
    };
  },

  createReturn: (v: ReturnInput): Promise<string> => rpc<string>("purchase_return_create", { p: v }),

  linkReturnCredit: (returnId: string, invoiceId: string | null) =>
    rpc<void>("purchase_return_link_credit_note", { p_return_id: returnId, p_invoice_id: invoiceId }),

  voidReceipt: (id: string, reason: string) => rpc<void>("purchase_receipt_void", { p_id: id, p_reason: reason }),

  /** Stock por sucursal de varios productos (clave producto:variante). */
  storeStock: async (storeId: string, productIds: string[]): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    if (productIds.length === 0) return out;
    const { data, error } = await from("product_stock")
      .select("product_id, variant_id, qty")
      .eq("tenant_id", await tenantId())
      .eq("store_id", storeId)
      .in("product_id", productIds);
    if (error) throw error;
    for (const r of (data ?? []) as unknown as Array<{ product_id: string; variant_id: string | null; qty: number }>) {
      out.set(`${r.product_id}:${r.variant_id ?? ""}`, Number(r.qty));
    }
    return out;
  },

  // Órdenes de pago
  invoiceOpen: async (supplierId: string): Promise<InvoiceOpenRow[]> => {
    const { data, error } = await from("supplier_invoice_open")
      .select(
        "invoice_id, supplier_id, kind, letter, point_of_sale, number, issue_date, due_date, currency, amount_ars, allocated_ars, open_ars",
      )
      .eq("tenant_id", await tenantId())
      .eq("supplier_id", supplierId)
      .order("due_date")
      .limit(1000);
    if (error) throw error;
    return ((data ?? []) as unknown as Array<Omit<InvoiceOpenRow, "label">>).map((r) => ({
      ...num(r, ["amount_ars", "allocated_ars", "open_ars", "point_of_sale", "number"]),
      label: `${r.kind === "debit_note" ? "ND" : "FC"} ${formatInvoiceNumber(r.letter, Number(r.point_of_sale), Number(r.number))}`,
    }));
  },

  /** Imputaciones vigentes (para el aging). */
  allocations: async (): Promise<Array<{ invoice_id: string; amount: number }>> => {
    const { data, error } = await from("supplier_payment_allocations")
      .select("invoice_id, amount")
      .eq("tenant_id", await tenantId())
      .is("released_at", null)
      .limit(10000);
    if (error) throw error;
    return ((data ?? []) as unknown as Array<{ invoice_id: string; amount: number }>).map((a) => ({
      invoice_id: a.invoice_id,
      amount: Number(a.amount),
    }));
  },

  createPaymentOrder: (v: PaymentOrderInput): Promise<string> =>
    rpc<string>("supplier_payment_order_create", { p: v }),

  paymentOrder: async (id: string): Promise<PaymentOrderDetail> => {
    const [p, lines, allocs, evs] = await Promise.all([
      from("supplier_payments").select(PAYMENT_COLS).eq("tenant_id", await tenantId()).eq("id", id).single(),
      from("supplier_payment_lines")
        .select("id, method, amount, reference, cash_shift_id, treasury_account_id, cheque_id, sort")
        .eq("payment_id", id)
        .order("sort"),
      from("supplier_payment_allocations").select("id, invoice_id, amount, released_at").eq("payment_id", id),
      events(id),
    ]);
    if (p.error) throw p.error;
    if (lines.error) throw lines.error;
    if (allocs.error) throw allocs.error;
    return {
      ...num(p.data as unknown as PaymentRow, PAYMENT_NUM),
      lines: ((lines.data ?? []) as unknown as PaymentLineRow[]).map((l) => num(l, ["amount"])),
      allocations: ((allocs.data ?? []) as unknown as PaymentAllocationRow[]).map((a) => num(a, ["amount"])),
      events: evs,
    };
  },

  // Lotes
  lots: async (
    f: { storeId?: string | null; productId?: string | null; search?: string | null; onlyAvailable?: boolean } = {},
  ): Promise<LotRow[]> => {
    let q = from("product_lots")
      .select(
        "id, product_id, variant_id, store_id, receipt_item_id, lot_code, dispatch_number, expires_on, qty_received, qty_available, unit_cost, voided_at, created_at, products(name, sku)",
      )
      .eq("tenant_id", await tenantId())
      .order("expires_on", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1000);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    if (f.productId) q = q.eq("product_id", f.productId);
    if (f.onlyAvailable) q = q.gt("qty_available", 0).is("voided_at", null);
    const term = orSafe((f.search ?? "").trim());
    if (term) q = q.or(`lot_code.ilike.%${term}%,dispatch_number.ilike.%${term.toUpperCase()}%`);
    const { data, error } = await q;
    if (error) throw error;
    type Raw = Omit<LotRow, "product_name" | "product_sku"> & {
      products: { name: string; sku: string | null } | null;
    };
    return ((data ?? []) as unknown as Raw[]).map(({ products: p, ...r }) => ({
      ...num(r, ["qty_received", "qty_available", "unit_cost"]),
      product_name: p?.name ?? "",
      product_sku: p?.sku ?? null,
    }));
  },

  lotSales: async (lotId: string): Promise<LotSaleRow[]> => {
    const { data, error } = await from("lot_sales")
      .select("lot_id, sale_id, sale_number, sold_at, customer_id, sale_status, store_id, qty")
      .eq("tenant_id", await tenantId())
      .eq("lot_id", lotId)
      .order("sold_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    return ((data ?? []) as unknown as LotSaleRow[]).map((r) => num(r, ["qty", "sale_number"]));
  },

  // Listas de precios del proveedor
  catalogLookup: async (): Promise<CatalogLookupRow[]> => {
    const { data, error } = await from("products")
      .select("id, name, sku, barcode")
      .eq("tenant_id", await tenantId())
      .is("deleted_at", null)
      .limit(20000);
    if (error) throw error;
    return (data ?? []) as unknown as CatalogLookupRow[];
  },

  applyPriceList: (v: PriceListApplyInput): Promise<string> =>
    rpc<string>("supplier_price_list_apply", { p_supplier_id: v.supplierId, p_rows: v.rows, p_options: v.options }),

  supplierMapping: async (supplierId: string): Promise<PriceListMapping | null> => {
    const { data, error } = await from("suppliers")
      .select("price_list_mapping")
      .eq("tenant_id", await tenantId())
      .eq("id", supplierId)
      .maybeSingle();
    if (error) throw error;
    return (data as { price_list_mapping?: PriceListMapping | null } | null)?.price_list_mapping ?? null;
  },
};
