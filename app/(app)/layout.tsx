import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/AppShell";
import { homePath } from "@/lib/auth/redirect";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Sin negocio activo el panel no tiene qué cargar: staff → panel interno,
  // resto → onboarding. Evita un panel vacío o con errores al entrar.
  const { data: membership } = await supabase
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (!membership) {
    const isInternal = (user.app_metadata as { is_internal?: boolean } | null)?.is_internal === true;
    redirect(homePath({ isInternal, hasTenant: false }));
  }

  return <AppShell email={user.email ?? ""}>{children}</AppShell>;
}
