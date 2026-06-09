import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Route group propio del KDS (F13 · H46): fullscreen, SIN el AppShell (sidebar/
// header). Pensado para una pantalla dedicada en cocina/barra (se abre con
// window.open('/kds') desde el Salón). Sólo exige sesión; el gateo por modo
// gastronómico y el aislamiento por tenant los resuelve la propia pantalla
// (RLS + RPCs tenant-scoped).
export default async function KdsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/kds");

  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
