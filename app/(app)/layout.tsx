import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/AppShell";
import { homePath } from "@/lib/auth/redirect";
import { businessDisplayNameOrNull } from "@/lib/branding/businessName";
import { fetchTradeName } from "@/lib/branding/tradeName";
import type { Metadata } from "next";

// ADR-124: el nombre del negocio en la pestaña ("Kiosco Juan · NinjaSoft POS"),
// con el nombre de fantasía si lo tiene. Ante cualquier error, el título de siempre.
export async function generateMetadata(): Promise<Metadata> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const tenantId = (user?.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
    if (!tenantId) return {};
    const [{ data: t }, tradeName] = await Promise.all([
      supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      fetchTradeName(supabase, tenantId),
    ]);
    const name = businessDisplayNameOrNull({ tradeName, tenantName: (t as { name: string | null } | null)?.name });
    return name ? { title: `${name} · NinjaSoft POS` } : {};
  } catch {
    return {};
  }
}

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
