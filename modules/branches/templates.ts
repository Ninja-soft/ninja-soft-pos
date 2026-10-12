"use client";

// =============================================================================
// Plantillas de sucursal y "Copiar de" (F17 · H89 · H92 · ADR-057).
// store_templates y las RPC store_template_save / store_template_delete /
// store_copy_setup no están en types/database.ts (no se regenera): cliente
// suelto. La base valida rol, acceso a las sucursales, plan y auditoría.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { CopyCounts, SetupPart, TemplatePayload } from "@/lib/branches/storeTemplate";

export interface StoreTemplate {
  id: string;
  name: string;
  description: string | null;
  source_store_id: string | null;
  parts: SetupPart[];
  payload: TemplatePayload;
  created_at: string;
}

type Res<T> = Promise<{ data: T | null; error: { message: string; code?: string } | null }>;
interface Q<T> extends PromiseLike<Awaited<Res<T>>> {
  select: (cols: string) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  is: (col: string, v: null) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
}
interface Loose {
  from: <T = unknown>(table: string) => Q<T>;
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Res<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export const storeTemplatesApi = {
  // Plantillas del negocio actual (además de la RLS, filtro por negocio:
  // ADR-052). Sin la migración la tabla no existe: lista vacía.
  list: async (): Promise<StoreTemplate[]> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    const r = await loose()
      .from<StoreTemplate[]>("store_templates")
      .select("id, name, description, source_store_id, parts, payload, created_at")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("name");
    if (r.error) return [];
    return r.data ?? [];
  },
  save: async (v: { name: string; fromStore: string; parts: SetupPart[]; description?: string | null }): Promise<string> =>
    check(
      await loose().rpc<string>("store_template_save", {
        p_name: v.name,
        p_from_store: v.fromStore,
        p_parts: v.parts,
        p_description: v.description ?? null,
      }),
    ),
  remove: async (id: string): Promise<void> => {
    check(await loose().rpc("store_template_delete", { p_id: id }));
  },
  copySetup: async (v: {
    target: string;
    fromStore?: string | null;
    template?: string | null;
    parts: SetupPart[];
  }): Promise<CopyCounts & { parts?: string[] }> =>
    check(
      await loose().rpc<CopyCounts & { parts?: string[] }>("store_copy_setup", {
        p_target: v.target,
        p_from_store: v.fromStore ?? null,
        p_template: v.template ?? null,
        p_parts: v.parts,
      }),
    ),
};

export function useStoreTemplates(enabled = true) {
  return useQuery({
    queryKey: ["branches", "templates"],
    queryFn: () => storeTemplatesApi.list(),
    enabled,
    staleTime: 60_000,
  });
}

export function useStoreTemplateMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["branches"] });
    // Lo copiado (overrides, impresoras, planes, personal) cambia lo que se ve
    // en Configuración y en el POS.
    qc.invalidateQueries({ queryKey: ["config-overrides"] });
    qc.invalidateQueries({ queryKey: ["printers"] });
    qc.invalidateQueries({ queryKey: ["pos"] });
    qc.invalidateQueries({ queryKey: ["staff"] });
  };
  return {
    save: useMutation({ mutationFn: storeTemplatesApi.save, onSuccess: inv }),
    remove: useMutation({ mutationFn: storeTemplatesApi.remove, onSuccess: inv }),
    copySetup: useMutation({ mutationFn: storeTemplatesApi.copySetup, onSuccess: inv }),
  };
}

/** Mensaje legible de los errores de las RPC de plantillas. */
export function templateErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (msg.includes("feature_not_in_plan")) return "Tu plan no incluye multi-sucursal.";
  if (msg.includes("template_name_taken")) return "Ya hay una plantilla con ese nombre.";
  if (msg.includes("template_not_found")) return "La plantilla ya no existe.";
  if (msg.includes("store_not_found")) return "La sucursal no existe o está archivada.";
  if (msg.includes("forbidden")) return "No tenés acceso a esa sucursal.";
  if (msg.includes("no_parts")) return "Elegí al menos una parte para copiar.";
  if (msg.includes("invalid_name")) return "Poné un nombre de hasta 60 caracteres.";
  if (msg.includes("same_store")) return "Elegí otra sucursal de origen.";
  return "No se pudo completar. Probá de nuevo.";
}
