import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BarChart3,
  Building2,
  Package,
  Receipt,
  ShoppingCart,
  Users,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { buttonVariants } from "@/components/ui/Button";
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

  // Solo MIS membresías. No nos apoyamos en RLS para el scope acá: un usuario
  // interno (is_internal) vería todos los tenants, así que filtramos por user_id.
  const { data } = await supabase
    .from("tenant_users")
    .select("role, status, tenants(name, slug, status)")
    .eq("user_id", user.id)
    .eq("status", "active");
  const memberships = (data ?? []) as unknown as MembershipRow[];

  // Métrica: ventas de hoy (UTC).
  let todayTotal = 0;
  let todayCount = 0;
  if (memberships.length > 0) {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const { data: report } = await supabase.rpc("sales_report", {
      p_from: start.toISOString(),
      p_to: end.toISOString(),
    });
    const r = report as { total?: number; count?: number } | null;
    todayTotal = r?.total ?? 0;
    todayCount = r?.count ?? 0;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
        <Eyebrow>Panel</Eyebrow>
        <Display className="mt-4 text-3xl md:text-5xl">
          Hola
          {user.user_metadata.full_name ? (
            <Accent>, {user.user_metadata.full_name}</Accent>
          ) : null}
          .
        </Display>
        <p className="mt-3 text-muted-foreground">
          Tu centro de operaciones. Desde acá vendés, controlás la caja y seguís
          tus resultados.
        </p>

        {memberships.length > 0 && (
          <Card className="mt-6 max-w-xs">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Ventas de hoy</p>
              <p className="mt-2 price-hl font-price tabular-nums text-3xl font-black">
                {new Intl.NumberFormat("es-AR", {
                  style: "currency",
                  currency: "ARS",
                }).format(todayTotal)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {todayCount} venta{todayCount === 1 ? "" : "s"}
              </p>
            </CardContent>
          </Card>
        )}

        {memberships.length > 0 && (
          <div className="-mx-6 mt-6 flex gap-3 overflow-x-auto px-6 pb-2 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Link href="/pos" className={buttonVariants() + " shrink-0"}>
              <ShoppingCart size={16} /> Punto de venta
            </Link>
            <Link href="/productos" className={buttonVariants({ variant: "secondary" }) + " shrink-0"}>
              <Package size={16} /> Productos
            </Link>
            <Link href="/ventas" className={buttonVariants({ variant: "secondary" }) + " shrink-0"}>
              <Receipt size={16} /> Ventas
            </Link>
            <Link href="/caja" className={buttonVariants({ variant: "secondary" }) + " shrink-0"}>
              <Wallet size={16} /> Caja
            </Link>
            <Link href="/clientes" className={buttonVariants({ variant: "secondary" }) + " shrink-0"}>
              <Users size={16} /> Clientes
            </Link>
            <Link href="/reportes" className={buttonVariants({ variant: "secondary" }) + " shrink-0"}>
              <BarChart3 size={16} /> Reportes
            </Link>
          </div>
        )}

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
                    <p className="mt-1 text-sm text-muted-foreground">
                      Rol: {m.role} · {m.tenants?.status}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Todavía no tenés un negocio</CardTitle>
                <CardDescription>
                  Creá tu negocio para empezar a cargar productos, controlar
                  stock y vender. Arrancás con 14 días de trial.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/onboarding" className={buttonVariants()}>
                  Crear mi negocio
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
    </div>
  );
}
