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
import { OnboardingChecklist } from "@/components/dashboard/OnboardingChecklist";
import { capitalizeName } from "@/lib/utils/format";

// Acento de marca del tenant (hex #rrggbb válido) o el flame de NinjaSoft.
const HEX = /^#[0-9a-fA-F]{6}$/;
const NINJA_FLAME = "#FF4B22";
function brandAccent(accent: string | null | undefined): string {
  return typeof accent === "string" && HEX.test(accent) ? accent : NINJA_FLAME;
}

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
    tenants: { id: string; name: string; slug: string; status: string } | null;
  };

  // Solo MIS membresías. No nos apoyamos en RLS para el scope acá: un usuario
  // interno (is_internal) vería todos los tenants, así que filtramos por user_id.
  const { data } = await supabase
    .from("tenant_users")
    .select("role, status, tenants(id, name, slug, status)")
    .eq("user_id", user.id)
    .eq("status", "active");
  const memberships = (data ?? []) as unknown as MembershipRow[];

  // Marca por tenant (logo + acento) para personalizar cada tarjeta, igual que
  // la card "Negocio" del panel del dueño. RLS deja leer solo el branding del
  // tenant activo del usuario; el resto cae al ícono genérico.
  const tenantIds = memberships
    .map((m) => m.tenants?.id)
    .filter((id): id is string => Boolean(id));
  const brandingByTenant = new Map<
    string,
    { logo_url: string | null; accent: string | null }
  >();
  if (tenantIds.length > 0) {
    const { data: brandingData } = await supabase
      .from("tenant_branding")
      .select("tenant_id, logo_url, accent")
      .in("tenant_id", tenantIds);
    const rows = (brandingData ?? []) as unknown as {
      tenant_id: string;
      logo_url: string | null;
      accent: string | null;
    }[];
    for (const row of rows) {
      brandingByTenant.set(row.tenant_id, {
        logo_url: row.logo_url,
        accent: row.accent,
      });
    }
  }

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
            <Accent>, {capitalizeName(user.user_metadata.full_name)}</Accent>
          ) : null}
          .
        </Display>
        <p className="mt-3 text-muted-foreground">
          Tu centro de operaciones. Desde acá vendés, controlás la caja y seguís
          tus resultados.
        </p>

        {memberships.length > 0 && <OnboardingChecklist />}

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
              {memberships.map((m, i) => {
                const brand = m.tenants?.id
                  ? brandingByTenant.get(m.tenants.id)
                  : undefined;
                const accent = brandAccent(brand?.accent);
                const logoUrl = brand?.logo_url ?? null;
                return (
                  <Card
                    key={i}
                    className="overflow-hidden border-l-4"
                    style={{ borderLeftColor: accent }}
                  >
                    <CardContent className="p-6">
                      {logoUrl ? (
                        <span
                          className="grid h-10 w-10 place-items-center overflow-hidden rounded-lg border bg-muted"
                          style={{ borderColor: accent }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={logoUrl}
                            alt={m.tenants?.name ?? "Negocio"}
                            className="h-full w-full object-contain"
                          />
                        </span>
                      ) : (
                        <span
                          className="grid h-10 w-10 place-items-center rounded-lg"
                          style={{ backgroundColor: `${accent}1f`, color: accent }}
                        >
                          <Building2 size={20} />
                        </span>
                      )}
                      <h3 className="mt-3 font-display text-lg font-bold">
                        {m.tenants?.name ?? "Negocio"}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Rol: {m.role} · {m.tenants?.status}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
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
