import { createClient } from "@/lib/supabase/client";
import type { CreateTenantInput } from "./schemas";

export interface CreateTenantResult {
  tenant_id: string;
  slug: string;
}

// Payload extendido del wizard de registro (Fase A): rubro completo (verticales)
// + datos fiscales opcionales que la Edge Function persiste en tenant_branding.
export interface CreateTenantPayload {
  name: string;
  industry: string;
  cuit?: string;
  legal_name?: string;
  iva_condition?: string;
}

// Llama a la Edge Function create_tenant (lógica sensible server-side).
// Ver supabase/functions/create_tenant, docs/10-frontend-conventions.md §5.2.
export async function createTenant(
  input: CreateTenantInput | CreateTenantPayload,
): Promise<CreateTenantResult> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("create_tenant", {
    body: input,
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as CreateTenantResult;
}
