import { redirect } from "next/navigation";
import type { Metadata, Viewport } from "next";
import { createClient } from "@/lib/supabase/server";

// App del repartidor (ADR-161): grupo propio, sin el menú del panel, pensado
// para el celular. El servidor valida la sesión y el permiso de repartir
// (logistics.deliver); los datos llegan por RPC con su propia validación.
export const metadata: Metadata = { title: "Reparto · NinjaSoft POS" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RepartoLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/reparto");

  const { data: can } = await supabase.rpc("has_capability" as never, { p_cap: "logistics.deliver" } as never);
  if (can !== true) redirect("/dashboard");

  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
