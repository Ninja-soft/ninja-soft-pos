import { createClient } from "@/lib/supabase/client";
import type { CreateTenantInput } from "./schemas";

export interface CreateTenantResult {
  tenant_id: string;
  slug: string;
}

// Llama a la Edge Function create_tenant (lógica sensible server-side).
// Ver supabase/functions/create_tenant, docs/10-frontend-conventions.md §5.2.
export async function createTenant(
  input: CreateTenantInput,
): Promise<CreateTenantResult> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("create_tenant", {
    body: input,
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as CreateTenantResult;
}
