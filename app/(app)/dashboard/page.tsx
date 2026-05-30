import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Display, Accent, Eyebrow } from "@/components/ui/Typography";

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // El middleware ya protege la ruta; doble check por seguridad.
  if (!user) redirect("/login");

  type MembershipRow = {
    role: string;
    status: string;
    tenants: { name: string; slug: string; status: string } | null;
  };

  const { data } = await supabase
    .from("tenant_users")
    .select("role, status, tenants(name, slug, status)")
    .eq("status", "active");
  const memberships = (data ?? []) as unknown as MembershipRow[];

  return (
    <div className="ninja-dark-bg min-h-screen text-ninja-softWhite">
      <DashboardHeader email={user.email ?? ""} />

      <main className="mx-auto max-w-6xl px-6 py-10">
        <Eyebrow>Panel</Eyebrow>
        <Display className="mt-4 text-3xl md:text-5xl">
          Hola
          {user.user_metadata.full_name ? (
            <Accent>, {user.user_metadata.full_name}</Accent>
          ) : null}
          .
        </Display>
        <p className="mt-3 text-ninja-lavender">
          Este es el shell base de NinjaSoft POS (Hito 0).
        </p>

        <div className="mt-8">
          {memberships.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {memberships.map((m, i) => (
                <Card key={i}>
                  <CardContent className="p-6">
                    <Building2 className="text-ninja-flameSoft" size={20} />
                    <h3 className="mt-3 font-display text-lg font-bold">
                      {m.tenants?.name ?? "Negocio"}
                    </h3>
                    <p className="mt-1 text-sm text-ninja-lavender">
                      Rol: {m.role} · {m.tenants?.status}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Todavía no perteneces a ningún negocio</CardTitle>
                <CardDescription>
                  Cuando un negocio te invite o crees uno, lo vas a ver acá. El
                  alta de tenants se habilita en el siguiente hito.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
