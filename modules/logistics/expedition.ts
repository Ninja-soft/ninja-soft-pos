"use client";

// Expedición robusta (ADR-165 · H148): escaneo, roturas, entrega parcial,
// problemas y pedido de stock. Lectura de los controles por tabla con RLS
// (alcance por sucursal) y todo lo demás por RPC SECURITY DEFINER. Las
// tablas y RPC nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  expeditionSettings,
  type CheckState,
  type DamageReason,
  type DifferenceReason,
  type ExpeditionSettings,
  type ScanResultKind,
  type ScanStage,
} from "@/lib/logistics/expedition";
import { LOGISTICS_BUCKET } from "@/modules/logistics/api";
import { DISPATCHES_KEY } from "@/modules/orders/hooks";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export type ScanScope = { dispatchId: string } | { routeId: string };

export interface ScanResponse {
  ok: boolean;
  duplicate: boolean;
  result: ScanResultKind;
  item_id: string | null;
  dispatch_id?: string | null;
  product_name?: string | null;
  scanned?: number | null;
  expected?: number | null;
  other_dispatch_number?: number | null;
  progress?: { done: number; total: number };
  complete?: boolean;
}

export interface StockStatusItem {
  item_id: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  unit: string;
  qty: number;
  here: number;
  shortage: number;
  transferable: boolean;
  stores: { store_id: string; name: string; qty: number }[];
}

export interface StockStatus {
  dispatch_id: string;
  store_id: string;
  awaiting_transfer: { id: string; number: number; status: string; origin_store_id: string } | null;
  items: StockStatusItem[];
}

export interface RouteItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  qty: number;
  unit: string;
  codes: string[];
  load: { scanned: number; reason: DifferenceReason | null } | null;
  delivery: { scanned: number; reason: DifferenceReason | null } | null;
}

export interface RouteItems {
  route_id: string;
  settings: ExpeditionSettings;
  load_checked_at: string | null;
  dispatches: { dispatch_id: string; number: number; stop_id: string; outcome: string; items: RouteItem[] }[];
}

const scopeArgs = (s: ScanScope) => ("dispatchId" in s ? { dispatch_id: s.dispatchId } : { route_id: s.routeId });
const num = (v: unknown) => Number(v ?? 0);

export function normalizeRouteItems(raw: unknown): RouteItems {
  const r = (raw ?? {}) as RouteItems & { settings: unknown };
  return {
    route_id: r.route_id,
    settings: expeditionSettings(r.settings),
    load_checked_at: r.load_checked_at ?? null,
    dispatches: (r.dispatches ?? []).map((d) => ({
      ...d,
      items: (d.items ?? []).map((i) => ({
        ...i,
        qty: num(i.qty),
        codes: Array.isArray(i.codes) ? i.codes : [],
        load: i.load ? { scanned: num(i.load.scanned), reason: i.load.reason ?? null } : null,
        delivery: i.delivery ? { scanned: num(i.delivery.scanned), reason: i.delivery.reason ?? null } : null,
      })),
    })),
  };
}

export const expeditionApi = {
  settings: async (): Promise<ExpeditionSettings> => {
    try {
      return expeditionSettings(await rpc<unknown>("expedition_settings_get", {}));
    } catch (e) {
      // Sin la migración: los valores por defecto.
      if (/expedition_settings_get|does not exist|schema cache/i.test(String((e as { message?: string })?.message ?? ""))) {
        return expeditionSettings(null);
      }
      throw e;
    }
  },
  saveSettings: async (s: Partial<ExpeditionSettings>) => expeditionSettings(await rpc<unknown>("expedition_settings_save", { p: s })),

  scan: (scope: ScanScope, stage: ScanStage, input: { id: string; code?: string | null; itemId?: string | null; qty?: number }) =>
    rpc<ScanResponse>("dispatch_scan", {
      p: { id: input.id, stage, code: input.code ?? null, item_id: input.itemId ?? null, qty: input.qty ?? 1, ...scopeArgs(scope) },
    }),
  justify: (scope: ScanScope, stage: ScanStage, itemId: string, reason: DifferenceReason, note: string | null) =>
    rpc<{ ok: boolean }>("dispatch_check_justify", { p: { stage, item_id: itemId, reason, note, ...scopeArgs(scope) } }),
  reset: (scope: ScanScope, stage: ScanStage) => rpc<{ ok: boolean }>("dispatch_check_reset", { p: { stage, ...scopeArgs(scope) } }),

  /** Controles de una etapa por renglón (RLS por sucursal). */
  checks: async (dispatchIds: string[], stage: ScanStage): Promise<Record<string, CheckState>> => {
    if (!dispatchIds.length) return {};
    const { data, error } = await createClient()
      .from("dispatch_item_checks" as never)
      .select("dispatch_item_id, qty_scanned, difference_reason")
      .in("dispatch_id", dispatchIds)
      .eq("stage", stage);
    if (error) {
      if (/dispatch_item_checks|does not exist|schema cache/i.test(error.message)) return {};
      throw error;
    }
    const out: Record<string, CheckState> = {};
    for (const r of (data ?? []) as unknown as { dispatch_item_id: string; qty_scanned: number; difference_reason: DifferenceReason | null }[]) {
      out[r.dispatch_item_id] = { scanned: num(r.qty_scanned), reason: r.difference_reason };
    }
    return out;
  },

  damageReport: (p: {
    dispatchId: string;
    stage: "armado" | "carga";
    items: { item_id: string; qty: number }[];
    reason: DamageReason;
    note: string | null;
    photoPaths: string[];
  }) =>
    rpc<{ ok: boolean; damages: { id: string; qty: number; destination: string }[] }>("dispatch_damage_report", {
      p: { dispatch_id: p.dispatchId, stage: p.stage, items: p.items, reason: p.reason, note: p.note, photo_paths: p.photoPaths },
    }),
  partialDeliver: (p: {
    dispatchId: string;
    items: { item_id: string; delivered: number; damaged: number; rejected: number }[];
    deliveredTo: string | null;
    damageReason: DamageReason | null;
    damageNote: string | null;
    photoPaths: string[];
  }) =>
    rpc<{ ok: boolean; complete: boolean; child: { id: string; number: number } | null; issue_open: boolean }>("dispatch_partial_deliver", {
      p: {
        dispatch_id: p.dispatchId,
        items: p.items,
        delivered_to: p.deliveredTo,
        damage_reason: p.damageReason,
        damage_note: p.damageNote,
        photo_paths: p.photoPaths,
      },
    }),
  resolve: (p: { dispatchId: string; action: "reprogramar" | "resuelto"; items: { item_id: string; qty: number }[]; note: string | null }) =>
    rpc<{ ok: boolean; child: { id: string; number: number } | null; issue_open: boolean }>("dispatch_issue_resolve", {
      p: { dispatch_id: p.dispatchId, action: p.action, items: p.items, note: p.note },
    }),
  stockStatus: async (dispatchId: string): Promise<StockStatus> => {
    const r = await rpc<StockStatus>("dispatch_stock_status", { p_dispatch: dispatchId });
    return {
      ...r,
      items: (r.items ?? []).map((i) => ({
        ...i,
        qty: num(i.qty),
        here: num(i.here),
        shortage: num(i.shortage),
        stores: (i.stores ?? []).map((s) => ({ ...s, qty: num(s.qty) })),
      })),
    };
  },
  requestStock: (p: { dispatchId: string; originStoreId: string; items: { item_id: string; qty: number }[]; notes: string | null }) =>
    rpc<{ ok: boolean; transfer_id: string; number: number; status: string }>("dispatch_request_stock", {
      p: { dispatch_id: p.dispatchId, origin_store_id: p.originStoreId, items: p.items, notes: p.notes },
    }),
  routeItems: async (routeId: string): Promise<RouteItems> => normalizeRouteItems(await rpc<unknown>("route_items", { p_route: routeId })),

  /** Sube una foto de rotura de Expedición: <negocio>/dispatches/<entrega>/<id>.webp */
  uploadDispatchPhoto: async (tenantId: string, dispatchId: string, blob: Blob, type: string): Promise<string> => {
    const ext = type === "image/webp" ? "webp" : type === "image/png" ? "png" : "jpg";
    const path = `${tenantId}/dispatches/${dispatchId}/${crypto.randomUUID()}.${ext}`;
    const up = await createClient().storage.from(LOGISTICS_BUCKET).upload(path, blob, { contentType: type, upsert: false });
    if (up.error) throw new Error("photo_upload_failed");
    return path;
  },
};

// ── Hooks ───────────────────────────────────────────────────────────────────

export const EXPEDITION_KEY = ["expedition"] as const;

export function useExpeditionSettings(enabled = true) {
  return useQuery({ queryKey: [...EXPEDITION_KEY, "settings"], queryFn: expeditionApi.settings, enabled, staleTime: 60_000 });
}

export function useDispatchChecks(dispatchIds: string[], stage: ScanStage, enabled = true) {
  return useQuery({
    queryKey: [...EXPEDITION_KEY, "checks", stage, [...dispatchIds].sort().join(",")],
    queryFn: () => expeditionApi.checks(dispatchIds, stage),
    enabled: enabled && dispatchIds.length > 0,
  });
}

export function useStockStatus(dispatchId: string | null) {
  return useQuery({
    queryKey: [...EXPEDITION_KEY, "stock", dispatchId],
    queryFn: () => expeditionApi.stockStatus(dispatchId!),
    enabled: Boolean(dispatchId),
  });
}

export function useRouteItems(routeId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...EXPEDITION_KEY, "route-items", routeId],
    queryFn: () => expeditionApi.routeItems(routeId!),
    enabled: enabled && Boolean(routeId),
  });
}

export function useExpeditionMutations() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: EXPEDITION_KEY });
    void qc.invalidateQueries({ queryKey: DISPATCHES_KEY });
    void qc.invalidateQueries({ queryKey: ["logistics"] });
  };
  return {
    saveSettings: useMutation({ mutationFn: expeditionApi.saveSettings, onSuccess: inv }),
    damageReport: useMutation({ mutationFn: expeditionApi.damageReport, onSuccess: inv }),
    partialDeliver: useMutation({ mutationFn: expeditionApi.partialDeliver, onSuccess: inv }),
    resolve: useMutation({ mutationFn: expeditionApi.resolve, onSuccess: inv }),
    requestStock: useMutation({
      mutationFn: expeditionApi.requestStock,
      onSuccess: () => {
        inv();
        void qc.invalidateQueries({ queryKey: ["stock-transfers"] });
      },
    }),
    invalidate: inv,
  };
}
