"use client";

// Inventario (ADR-137): ajustes de stock con motivo y aprobación, planilla de
// stock, movimientos, valuación y capacidades por miembro. Lecturas por RPC
// SECURITY DEFINER (validan capacidad y sucursal); toda escritura también por
// RPC. Las RPC nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import {
  DEFAULT_APPROVAL_POLICY,
  type AdjustMode,
  type AdjustReason,
  type AdjustStatus,
  type ApprovalPolicy,
  type Approver,
} from "@/lib/stock/adjustments";
import type { StockSheetRow } from "@/lib/stock/inventorySheet";

export const ADJUSTMENT_PHOTO_BUCKET = "stock-adjustment-photos";

export interface StockAdjustmentRow {
  id: string;
  store_id: string;
  store_name: string;
  warehouse_id: string | null;
  warehouse_name: string | null;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  image_url: string | null;
  unit: string;
  mode: AdjustMode;
  qty: number;
  reason: AdjustReason;
  notes: string | null;
  photo_path: string | null;
  system_qty: number;
  delta: number;
  unit_cost: number | null;
  value: number | null;
  status: AdjustStatus;
  needs_approval: boolean;
  source: "manual" | "import";
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  applied_delta: number | null;
  applied_at: string | null;
}

export interface AdjustmentInput {
  storeId: string;
  warehouseId: string | null;
  productId: string;
  variantId: string | null;
  mode: AdjustMode;
  qty: number;
  reason: AdjustReason;
  notes: string | null;
  photoPath: string | null;
}

export interface AdjustmentResult {
  id: string | null;
  status: "applied" | "pending" | "unchanged";
  needs_approval: boolean;
  system_qty: number;
  delta: number;
  value: number;
  new_qty: number | null;
}

export interface MovementRow {
  id: string;
  created_at: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  image_url: string | null;
  unit: string;
  delta: number;
  reason: string;
  loss_reason: string | null;
  notes: string | null;
  reference_id: string | null;
  actor_name: string | null;
}

export interface ValuationCategory {
  category: string;
  units: number;
  cost_value: number;
  retail_value: number;
  items: number;
}

export interface Valuation {
  units: number;
  cost_value: number;
  retail_value: number;
  items_with_stock: number;
  negative_items: number;
  no_cost_items: number;
  by_category: ValuationCategory[];
}

export interface CapabilityMember {
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  capabilities: string[];
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const n = (v: unknown) => (v == null ? null : Number(v));

function normSheet(r: StockSheetRow): StockSheetRow {
  return {
    ...r,
    cost: n(r.cost),
    price: n(r.price),
    store_qty: Number(r.store_qty),
    min_qty: n(r.min_qty),
    max_qty: n(r.max_qty),
    principal_qty: n(r.principal_qty),
    total_count: Number(r.total_count),
    by_warehouse: Object.fromEntries(Object.entries(r.by_warehouse ?? {}).map(([k, v]) => [k, Number(v)])),
  };
}

function normAdjustment(r: StockAdjustmentRow): StockAdjustmentRow {
  return {
    ...r,
    qty: Number(r.qty),
    system_qty: Number(r.system_qty),
    delta: Number(r.delta),
    unit_cost: n(r.unit_cost),
    value: n(r.value),
    applied_delta: n(r.applied_delta),
  };
}

function fileExt(type: string): string {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

export const inventoryApi = {
  sheet: async (v: { storeId: string; search?: string; onlyWithStock?: boolean; limit?: number; offset?: number }) =>
    ((await rpc<StockSheetRow[]>("inventory_stock_sheet", {
      p_store_id: v.storeId,
      p_search: v.search?.trim() || null,
      p_only_with_stock: v.onlyWithStock ?? false,
      p_limit: v.limit ?? 50,
      p_offset: v.offset ?? 0,
    })) ?? []).map(normSheet),

  movements: async (storeId: string, before?: string | null) =>
    ((await rpc<MovementRow[]>("inventory_movements", {
      p_store_id: storeId,
      p_product_id: null,
      p_limit: 60,
      p_before: before ?? null,
    })) ?? []).map((m) => ({ ...m, delta: Number(m.delta) })),

  valuation: async (storeId: string | null): Promise<Valuation> => {
    const v = await rpc<Valuation>("inventory_valuation", { p_store_id: storeId });
    return {
      units: Number(v?.units ?? 0),
      cost_value: Number(v?.cost_value ?? 0),
      retail_value: Number(v?.retail_value ?? 0),
      items_with_stock: Number(v?.items_with_stock ?? 0),
      negative_items: Number(v?.negative_items ?? 0),
      no_cost_items: Number(v?.no_cost_items ?? 0),
      by_category: (v?.by_category ?? []).map((c) => ({
        ...c,
        units: Number(c.units),
        cost_value: Number(c.cost_value),
        retail_value: Number(c.retail_value),
        items: Number(c.items),
      })),
    };
  },

  adjustments: async (storeId: string | null, status: AdjustStatus | null) =>
    ((await rpc<StockAdjustmentRow[]>("stock_adjustments_list", {
      p_store_id: storeId,
      p_status: status,
      p_limit: 150,
    })) ?? []).map(normAdjustment),

  request: (v: AdjustmentInput) =>
    rpc<AdjustmentResult>("stock_adjustment_request", {
      p: {
        store_id: v.storeId,
        warehouse_id: v.warehouseId,
        product_id: v.productId,
        variant_id: v.variantId,
        mode: v.mode,
        qty: v.qty,
        reason: v.reason,
        notes: v.notes,
        photo_path: v.photoPath,
      },
    }),

  decide: (v: { id: string; approve: boolean; notes?: string | null }) =>
    rpc<{ status: string }>("stock_adjustment_decide", { p_id: v.id, p_approve: v.approve, p_notes: v.notes ?? null }),

  decideMany: (v: { ids: string[]; approve: boolean; notes?: string | null }) =>
    rpc<{ ok: number; errors: { id: string; message: string }[] }>("stock_adjustment_decide_many", {
      p_ids: v.ids,
      p_approve: v.approve,
      p_notes: v.notes ?? null,
    }),

  cancel: (id: string) => rpc<void>("stock_adjustment_cancel", { p_id: id }),

  policy: async (): Promise<ApprovalPolicy> => {
    const p = await rpc<Partial<ApprovalPolicy>>("stock_adjustment_policy_get");
    return {
      approval_enabled: Boolean(p?.approval_enabled),
      approver: (p?.approver === "auditor" ? "auditor" : "owner") as Approver,
      threshold_units: n(p?.threshold_units),
      threshold_value: n(p?.threshold_value),
      require_photo: Boolean(p?.require_photo),
      feature: Boolean(p?.feature),
    };
  },

  savePolicy: (p: Omit<ApprovalPolicy, "feature">) => rpc<ApprovalPolicy>("stock_adjustment_policy_save", { p }),

  members: () => rpc<CapabilityMember[]>("stock_capability_members"),

  setCapability: (v: { userId: string; capability: string; granted: boolean; reason?: string | null }) =>
    rpc<void>("member_capability_set", {
      p_user: v.userId,
      p_capability: v.capability,
      p_granted: v.granted,
      p_reason: v.reason ?? null,
    }),

  /** Sube la foto de respaldo a la carpeta del negocio y devuelve el path. */
  uploadPhoto: async (file: File): Promise<string> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error("no_tenant");
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
    const path = `${tenantId}/${new Date().toISOString().slice(0, 7)}/${id}.${fileExt(file.type)}`;
    const up = await createClient().storage.from(ADJUSTMENT_PHOTO_BUCKET).upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (up.error) throw new Error("photo_upload_failed");
    return path;
  },

  photoUrl: async (path: string): Promise<string | null> => {
    const { data } = await createClient().storage.from(ADJUSTMENT_PHOTO_BUCKET).createSignedUrl(path, 600);
    return data?.signedUrl ?? null;
  },
};

// ── Hooks ───────────────────────────────────────────────────────────────────

export function useInventorySheet(v: {
  storeId: string | null;
  search: string;
  onlyWithStock: boolean;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: ["inventory-sheet", v.storeId, v.search, v.onlyWithStock, v.page, v.pageSize],
    queryFn: () =>
      inventoryApi.sheet({
        storeId: v.storeId!,
        search: v.search,
        onlyWithStock: v.onlyWithStock,
        limit: v.pageSize,
        offset: v.page * v.pageSize,
      }),
    enabled: Boolean(v.storeId),
    placeholderData: (prev) => prev,
  });
}

export function useInventoryMovements(storeId: string | null) {
  return useQuery({
    queryKey: ["inventory-movements", storeId],
    queryFn: () => inventoryApi.movements(storeId!),
    enabled: Boolean(storeId),
  });
}

export function useInventoryValuation(storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["inventory-valuation", storeId],
    queryFn: () => inventoryApi.valuation(storeId),
    enabled,
  });
}

export function useStockAdjustments(storeId: string | null, status: AdjustStatus | null) {
  return useQuery({
    queryKey: ["stock-adjustments", storeId, status],
    queryFn: () => inventoryApi.adjustments(storeId, status),
  });
}

export function useAdjustmentPolicy() {
  return useQuery({
    queryKey: ["stock-adjustment-policy"],
    queryFn: inventoryApi.policy,
    placeholderData: DEFAULT_APPROVAL_POLICY,
    retry: false,
  });
}

export function useCapabilityMembers(enabled: boolean) {
  return useQuery({ queryKey: ["capability-members"], queryFn: inventoryApi.members, enabled });
}

export function useAdjustmentPhotoUrl(path: string | null) {
  return useQuery({
    queryKey: ["adjustment-photo", path],
    queryFn: () => inventoryApi.photoUrl(path!),
    enabled: Boolean(path),
    staleTime: 5 * 60_000,
  });
}

export function useAdjustmentMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    for (const k of ["stock-adjustments", "inventory-sheet", "inventory-movements", "inventory-valuation", "products", "warehouse-overview", "cycle-due"]) {
      void qc.invalidateQueries({ queryKey: [k] });
    }
  };
  return {
    request: useMutation({ mutationFn: inventoryApi.request, onSuccess: refresh }),
    decide: useMutation({ mutationFn: inventoryApi.decide, onSuccess: refresh }),
    decideMany: useMutation({ mutationFn: inventoryApi.decideMany, onSuccess: refresh }),
    cancel: useMutation({ mutationFn: inventoryApi.cancel, onSuccess: refresh }),
    savePolicy: useMutation({
      mutationFn: inventoryApi.savePolicy,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["stock-adjustment-policy"] }),
    }),
    setCapability: useMutation({
      mutationFn: inventoryApi.setCapability,
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["capability-members"] });
        void qc.invalidateQueries({ queryKey: ["my-capabilities"] });
      },
    }),
  };
}
