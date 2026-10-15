"use client";

// Remitos (ADR-136). Lectura por tabla con RLS (alcance por sucursal) y toda
// escritura por RPC SECURITY DEFINER. El email sale por la Edge
// send_receipt_email (acción remito) con el PDF generado en el navegador.
// Las tablas y RPC nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { remitoConfig, type Remito, type RemitoConfig, type RemitoPreview } from "@/lib/remitos/logic";

const COLS =
  "id, store_id, pto_vta, number, kind, status, dispatch_id, sale_id, issued_at, issuer, receiver_name, receiver_doc, " +
  "receiver_iva, receiver_address, delivery_address, packages, weight_kg, declared_value, show_prices, carrier_name, " +
  "carrier_cuit, vehicle_plate, driver_name, cot_number, cot_jurisdiction, cot_valid_until, cot_source, notes, legend, " +
  "received_name, received_doc, received_at, emailed_to, emailed_at, void_reason, voided_at, " +
  "items:remito_items(id, product_id, variant_id, description, sku, unit, qty, unit_price, sort), sale:sales(number)";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

function normalize(r: Remito): Remito {
  return {
    ...r,
    packages: Number(r.packages),
    declared_value: Number(r.declared_value),
    weight_kg: r.weight_kg == null ? null : Number(r.weight_kg),
    items: [...(r.items ?? [])]
      .sort((a, b) => a.sort - b.sort)
      .map((i) => ({ ...i, qty: Number(i.qty), unit_price: i.unit_price == null ? null : Number(i.unit_price) })),
  };
}

export const remitosApi = {
  list: async (opts: { storeId: string | null; search: string }): Promise<Remito[]> => {
    let q = createClient()
      .from("remitos" as never)
      .select(COLS)
      .is("deleted_at", null)
      .order("issued_at", { ascending: false })
      .limit(200);
    if (opts.storeId) q = q.eq("store_id", opts.storeId);
    const s = opts.search.trim();
    if (/^\d+$/.test(s)) q = q.eq("number", Number(s));
    else if (s) q = q.ilike("receiver_name", `%${s.replace(/[%_]/g, "")}%`);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as Remito[]).map(normalize);
  },

  get: async (id: string): Promise<Remito | null> => {
    const { data, error } = await createClient().from("remitos" as never).select(COLS).eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? normalize(data as unknown as Remito) : null;
  },

  /** Remito vigente de una entrega (o null). */
  forDispatch: async (dispatchId: string): Promise<Remito | null> => {
    const { data, error } = await createClient()
      .from("remitos" as never)
      .select(COLS)
      .eq("dispatch_id", dispatchId)
      .eq("status", "emitido")
      .maybeSingle();
    if (error) {
      if (/remitos|does not exist|schema cache/i.test(error.message)) return null;
      throw error;
    }
    return data ? normalize(data as unknown as Remito) : null;
  },

  saleIdByNumber: async (n: number): Promise<string> => {
    const { data, error } = await createClient().from("sales").select("id").eq("number", n).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("sale_not_found");
    return (data as { id: string }).id;
  },

  issue: (id: string, data: Record<string, unknown>) =>
    rpc<{ id: string; pto_vta: number; number: number; cot_required?: boolean; already?: boolean }>("remito_issue", {
      p_id: id,
      p_data: data,
    }),
  /** ADR-149 (A9 y A13): renglones, valor y si pide COT, antes de emitir. */
  preview: async (data: Record<string, unknown>): Promise<RemitoPreview> => {
    const r = await rpc<RemitoPreview>("remito_preview", { p_data: data });
    return {
      ...r,
      declared_value: Number(r.declared_value),
      already: Number(r.already ?? 0),
      items: (r.items ?? []).map((i) => ({ ...i, qty: Number(i.qty), unit_price: i.unit_price == null ? null : Number(i.unit_price) })),
    };
  },
  update: (id: string, data: Record<string, unknown>) => rpc<void>("remito_update", { p_id: id, p_data: data }),
  void: (id: string, reason: string) => rpc<void>("remito_void", { p_id: id, p_reason: reason }),

  config: async (): Promise<RemitoConfig> => remitoConfig(await rpc<unknown>("remito_config_get", {})),
  saveConfig: (c: Partial<RemitoConfig>) => rpc<unknown>("remito_config_save", { p_config: c }).then(remitoConfig),

  /** Email con el PDF (el mismo proveedor del negocio que el comprobante). */
  email: async (id: string, to: string, pdf: string): Promise<void> => {
    const { data, error } = await createClient().functions.invoke("send_receipt_email", {
      body: { remito_id: id, to, pdf },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      let detail = "";
      try {
        detail = ctx ? JSON.stringify(await ctx.json()) : "";
      } catch {
        /* sin cuerpo */
      }
      throw new Error(detail || error.message);
    }
    if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  },
};

export function useRemitos(storeId: string | null, search: string, enabled = true) {
  return useQuery({
    queryKey: ["remitos", storeId, search],
    queryFn: () => remitosApi.list({ storeId, search }),
    enabled,
  });
}

export function useRemito(id: string | null) {
  return useQuery({ queryKey: ["remito", id], queryFn: () => remitosApi.get(id!), enabled: Boolean(id) });
}

/** Vista previa del remito (sin escribir). Sin la migración de ADR-149, null. */
export function useRemitoPreview(data: Record<string, unknown> | null) {
  return useQuery({
    queryKey: ["remito-preview", data],
    enabled: Boolean(data),
    staleTime: 10_000,
    retry: false,
    queryFn: async () => {
      try {
        return await remitosApi.preview(data!);
      } catch (e) {
        if (/remito_preview|does not exist|schema cache/i.test(String((e as { message?: string })?.message ?? e))) return null;
        throw e;
      }
    },
  });
}

export function useRemitoConfig(enabled = true) {
  return useQuery({ queryKey: ["remito-config"], queryFn: remitosApi.config, enabled, staleTime: 60_000 });
}

export function useRemitoMutations() {
  const qc = useQueryClient();
  const inv = () => {
    for (const k of ["remitos", "remito", "remito-preview"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  return {
    issue: useMutation({ mutationFn: (v: { id: string; data: Record<string, unknown> }) => remitosApi.issue(v.id, v.data), onSuccess: inv }),
    update: useMutation({ mutationFn: (v: { id: string; data: Record<string, unknown> }) => remitosApi.update(v.id, v.data), onSuccess: inv }),
    void: useMutation({ mutationFn: (v: { id: string; reason: string }) => remitosApi.void(v.id, v.reason), onSuccess: inv }),
    email: useMutation({ mutationFn: (v: { id: string; to: string; pdf: string }) => remitosApi.email(v.id, v.to, v.pdf), onSuccess: inv }),
    saveConfig: useMutation({
      mutationFn: remitosApi.saveConfig,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["remito-config"] }),
    }),
  };
}
