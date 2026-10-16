import { createClient } from "@/lib/supabase/server";
import { RepartoApp } from "@/components/reparto/RepartoApp";

// Mis hojas de ruta, paradas y entregas (ADR-161).
export default async function RepartoPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const name = (user?.user_metadata as { full_name?: string } | null)?.full_name ?? user?.email ?? null;
  return <RepartoApp name={name} />;
}
