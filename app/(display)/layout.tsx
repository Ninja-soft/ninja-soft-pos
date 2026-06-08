import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Layout de la pantalla del cliente (F10 · H25). A diferencia de (app), NO monta
// el AppShell (sin sidebar, sin menús, sin campana): es una pantalla limpia,
// pensada para un 2do monitor / tablet de cara al cliente. Sigue exigiendo
// sesión del tenant (misma cuenta del POS) — la pantalla nunca es pública.
export default async function DisplayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <>{children}</>;
}
