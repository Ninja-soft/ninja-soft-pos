import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, CreditCard, Palette } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { buttonVariants } from "@/components/ui/Button";
import { TeamSection } from "@/components/dashboard-team/TeamSection";
import { SubscriptionCard } from "@/components/dashboard-team/SubscriptionCard";

const STATUS_LABELS: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
  cancelled: "Cancelada",
};

export default async function DashboardTeamPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  type Membership = {
    role: string;
    tenants: {
      id: string;
      name: string;
      industry: string | null;
      status: string;
      trial_ends_at: string | null;
    } | null;
  };
  // Filtramos por user_id: un usuario interno vería todos los tenants por RLS.
  const { data: memData } = await supabase
    .from("tenant_users")
    .select("role, tenants(id, name, industry, status, trial_ends_at)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1);
  const membership = (memData?.[0] as unknown as Membership) ?? null;

  if (!membership?.tenants) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Eyebrow>Administración</Eyebrow>
        <Display className="mt-3">Panel del dueño</Display>
        <Card className="mt-6">
          <CardContent className="p-6 text-muted-foreground">
            Todavía no tenés un negocio.{" "}
            <Link href="/onboarding" className="text-ninja-flameSoft hover:underline">
              Creá uno
            </Link>{" "}
            para administrarlo.
          </CardContent>
        </Card>
      </div>
    );
  }

  type Sub = {
    status: string;
    current_period_end: string | null;
    plans: { name: string; key: string } | null;
  };
  const tenant = membership.tenants;

  const { data: subData } = await supabase
    .from("subscriptions")
    .select("status, current_period_end, plans(name, key)")
    .eq("tenant_id", tenant.id)
    .limit(1);
  const sub = (subData?.[0] as unknown as Sub) ?? null;
  const isOwner = membership.role === "owner";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Eyebrow>Administración</Eyebrow>
      <Display className="mt-3">{tenant.name}</Display>
      <p className="mt-2 text-muted-foreground">
        Acá administrás tu NinjaPos: equipo, suscripción y configuración.
      </p>

      {/* Negocio */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Building2 size={16} /> <span className="text-sm">Negocio</span>
            </div>
            <p className="mt-2 text-lg font-semibold">{tenant.name}</p>
            <p className="text-sm text-muted-foreground">
              {tenant.industry ?? "—"} · {STATUS_LABELS[tenant.status] ?? tenant.status}
            </p>
          </CardContent>
        </Card>

        {/* Resumen de suscripción para no-dueños (los dueños ven el panel completo
            abajo, que es interactivo). */}
        {!isOwner && (
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CreditCard size={16} /> <span className="text-sm">Suscripción</span>
              </div>
              <p className="mt-2 text-lg font-semibold">
                {sub?.plans?.name ?? "Sin plan"}
              </p>
              <p className="text-sm text-muted-foreground">
                {sub ? (STATUS_LABELS[sub.status] ?? sub.status) : "—"}
                {sub?.current_period_end
                  ? ` · vence ${new Date(sub.current_period_end).toLocaleDateString("es-AR")}`
                  : ""}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Panel de suscripción interactivo (solo dueños: las RPC son owner-gated). */}
      {isOwner && <SubscriptionCard />}

      {/* Equipo (cliente: lista + invitar) */}
      <TeamSection
        currentUserId={user.id}
        tenantId={tenant.id}
        canManage={["owner", "manager"].includes(membership.role)}
      />

      {/* Accesos */}
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/configuracion" className={buttonVariants({ variant: "secondary" })}>
          <Palette size={16} /> Apariencia
        </Link>
        <Link href="/dashboard" className={buttonVariants({ variant: "secondary" })}>
          Ir al POS
        </Link>
      </div>
    </div>
  );
}
