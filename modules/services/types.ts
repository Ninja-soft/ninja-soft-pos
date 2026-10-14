"use client";

// Tipos de servicio del negocio (ADR-122): Programa, Visita, Trabajo,
// Informe, Análisis, Consultoría, Mantenimiento y los propios. La tabla y
// products.service_type_id todavía no están en types/database.ts: cliente
// suelto. La base valida (RLS, rol, nombre único, baja lógica).
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";

export interface ServiceType {
  id: string;
  name: string;
  icon: string | null;
  sort: number;
  is_active: boolean;
  is_seed: boolean;
}

type Res = { data: unknown; error: { message: string } | null };
interface LooseQuery extends PromiseLike<Res> {
  is: (c: string, v: null) => LooseQuery;
  eq: (c: string, v: unknown) => LooseQuery;
  order: (c: string, o?: { ascending?: boolean }) => LooseQuery;
}
interface Loose {
  from: (t: string) => {
    select: (c: string) => LooseQuery;
    insert: (v: unknown) => PromiseLike<Res>;
    update: (v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<Res> };
  };
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<Res>;
}
const loose = () => createClient() as unknown as Loose;

export const serviceTypesApi = {
  /** Lista (siembra los tipos base la primera vez; si falla, sigue igual). */
  list: async (): Promise<ServiceType[]> => {
    const sb = loose();
    await sb.rpc("ensure_service_types").then(
      () => undefined,
      () => undefined,
    );
    const { data, error } = await sb
      .from("service_types")
      .select("id, name, icon, sort, is_active, is_seed")
      .is("deleted_at", null)
      .order("sort")
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as ServiceType[];
  },
  create: async (v: { name: string; icon?: string | null; sort?: number }) => {
    const tenantId = await getCurrentTenantId();
    const { error } = await loose()
      .from("service_types")
      .insert({ tenant_id: tenantId, name: v.name.trim().slice(0, 40), icon: v.icon ?? null, sort: v.sort ?? 100 });
    if (error) throw new Error(error.message);
  },
  update: async (id: string, patch: Partial<Pick<ServiceType, "name" | "icon" | "sort" | "is_active">>) => {
    const p: Record<string, unknown> = { ...patch };
    if (typeof patch.name === "string") p.name = patch.name.trim().slice(0, 40);
    const { error } = await loose().from("service_types").update(p).eq("id", id);
    if (error) throw new Error(error.message);
  },
  remove: async (id: string) => {
    const { error } = await loose()
      .from("service_types")
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq("id", id);
    if (error) throw new Error(error.message);
  },
  /** Tipo de cada servicio del catálogo (para filtrar). */
  productTypes: async (): Promise<Record<string, string>> => {
    const { data } = await loose()
      .from("products")
      .select("id, service_type_id")
      .eq("is_service", true)
      .is("deleted_at", null);
    const out: Record<string, string> = {};
    for (const r of (data ?? []) as { id: string; service_type_id: string | null }[]) {
      if (r.service_type_id) out[r.id] = r.service_type_id;
    }
    return out;
  },
};

export const SERVICE_TYPES_KEY = ["services", "types"] as const;

export function useServiceTypes(enabled = true) {
  const q = useQuery({ queryKey: SERVICE_TYPES_KEY, queryFn: () => serviceTypesApi.list(), enabled, staleTime: 60_000 });
  const byId = useMemo(() => new Map((q.data ?? []).map((t) => [t.id, t])), [q.data]);
  return { ...q, byId };
}

export function useServiceTypeMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: SERVICE_TYPES_KEY });
  return {
    create: useMutation({ mutationFn: serviceTypesApi.create, onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<Pick<ServiceType, "name" | "icon" | "sort" | "is_active">> }) =>
        serviceTypesApi.update(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: serviceTypesApi.remove, onSuccess: inv }),
  };
}

/** Mensaje de error legible. */
export function serviceTypeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  if (m.includes("service_types_tenant_name_key") || m.includes("duplicate")) return "Ya hay un tipo con ese nombre.";
  if (m.includes("forbidden") || m.includes("row-level security")) return "Sólo el dueño o un encargado administra los tipos.";
  if (m.includes("check")) return "El nombre tiene que tener entre 1 y 40 caracteres.";
  return "No se pudo guardar el tipo.";
}
