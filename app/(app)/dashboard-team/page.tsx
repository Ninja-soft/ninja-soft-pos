import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BarChart3,
  Building2,
  CreditCard,
  Gauge,
  LayoutTemplate,
  MonitorDot,
  ShieldCheck,
  Palette,
  Settings,
  ShoppingCart,
  Store,
  UserPlus,
  Wallet,
  Zap,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { buttonVariants } from "@/components/ui/Button";
import { TeamSection } from "@/components/dashboard-team/TeamSection";
import { SubscriptionCard } from "@/components/dashboard-team/SubscriptionCard";
import {
  MiniStat,
  QuickActions,
  STATUS_TONE,
  SummaryTile,
  UsageMeter,
  type QuickAction,
} from "@/components/dashboard-team/OwnerOverview";
import { OwnerLive } from "@/components/dashboard-team/OwnerLive";
import { PlanBadge } from "@/components/internal/plans/PlanBadge";
import { NoData } from "@/components/ui/NoData";
import { PageContainer, PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

const STATUS_LABELS: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
  cancelled: "Cancelada",
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString("es-AR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
// Días restantes (>= 0) hasta una fecha.
function daysUntil(s: string): number {
  const ms = new Date(s).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}
function inDays(n: number): string {
  if (n === 0) return "Hoy";
  return n === 1 ? "En 1 día" : `En ${n} días`;
}

// Acento de marca del tenant (hex #rrggbb válido) o el flame de NinjaSoft.
const HEX = /^#[0-9a-fA-F]{6}$/;
const NINJA_FLAME = "#FF4B22";
function brandAccent(accent: string | null | undefined): string {
  return typeof accent === "string" && HEX.test(accent) ? accent : NINJA_FLAME;
}

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
  // Y por el negocio activo del JWT: con dos membresías no vale cualquiera.
  const activeTenant = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  let memQuery = supabase
    .from("tenant_users")
    .select("role, tenants(id, name, industry, status, trial_ends_at)")
    .eq("user_id", user.id)
    .eq("status", "active");
  if (activeTenant) memQuery = memQuery.eq("tenant_id", activeTenant);
  const { data: memData } = await memQuery.limit(1);
  const membership = (memData?.[0] as unknown as Membership) ?? null;

  if (!membership?.tenants) {
    return (
      <PageContainer size="lg">
        <PageHeader eyebrow="Administración" title="Panel del dueño" icon={Building2} />
        <Card className="mt-6">
          <EmptyState
            icon={Building2}
            title="Todavía no tenés un negocio"
            description="Creá uno para administrar tu equipo, tu suscripción y la configuración."
            action={
              <Link href="/onboarding" className={buttonVariants({ size: "sm" })}>
                Crear mi negocio
              </Link>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  type Sub = {
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean | null;
    is_lifetime: boolean;
    plans: {
      name: string;
      key: string;
      secondary_name: string | null;
      image_url: string | null;
      icon: string | null;
    } | null;
  };
  const tenant = membership.tenants;
  const isOwner = membership.role === "owner";
  const canManage = ["owner", "manager"].includes(membership.role);

  // Todo lo del resumen va en paralelo: suscripción, marca, gating (features +
  // límites efectivos del plan) y los conteos de uso.
  const countActive = (table: "stores" | "products") =>
    supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .is("deleted_at", null);
  const [subRes, brandingRes, gatingRes, usersRes, storesRes, productsRes, registersRes] =
    await Promise.all([
      supabase
        .from("subscriptions")
        .select("status, current_period_end, cancel_at_period_end, is_lifetime, plans(name, key, secondary_name, image_url, icon)")
        .eq("tenant_id", tenant.id)
        .limit(1),
      // Marca del negocio (logo + acento) para personalizar el tile "Negocio".
      supabase
        .from("tenant_branding")
        .select("logo_url, accent")
        .eq("tenant_id", tenant.id)
        .maybeSingle(),
      supabase.rpc("gating_summary"),
      supabase
        .from("tenant_users")
        .select("user_id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id)
        .eq("status", "active"),
      countActive("stores"),
      countActive("products"),
      // Cajas vivas (para "cajas por sucursal" del plan y el resumen).
      supabase
        .from("cash_registers")
        .select("store_id")
        .eq("tenant_id", tenant.id)
        .is("deleted_at", null),
    ]);
  const registerRows = (registersRes.data ?? []) as { store_id: string }[];
  const registersCount = registersRes.error ? null : registerRows.length;
  const perStore = new Map<string, number>();
  for (const r of registerRows) perStore.set(r.store_id, (perStore.get(r.store_id) ?? 0) + 1);
  const maxRegistersInStore = registersRes.error ? null : Math.max(0, ...perStore.values());

  const sub = (subRes.data?.[0] as unknown as Sub) ?? null;
  const branding =
    (brandingRes.data as { logo_url: string | null; accent: string | null } | null) ?? null;
  const accent = brandAccent(branding?.accent);
  const tenantLogo = branding?.logo_url ?? null;

  const gating = (gatingRes.data ?? null) as {
    features?: Record<string, boolean>;
    limits?: Record<string, number | null>;
  } | null;
  const limit = (k: string): number | null => {
    const v = gating?.limits?.[k];
    return v == null ? null : Number(v);
  };
  // Sin datos de gating no marcamos nada como bloqueado: el gating real lo
  // aplica el servidor dentro de cada sección.
  const hasFeature = (k: string) => (gating?.features ? gating.features[k] === true : true);
  const used = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));

  // Próximo hito de la suscripción (cobro, fin de prueba o fin de acceso).
  const periodEnd =
    sub?.current_period_end ?? (sub?.status === "trial" ? tenant.trial_ends_at : null);
  let period: { label: string; value: string; hint: string } | null = null;
  if (sub?.is_lifetime) {
    period = { label: "Vencimiento", value: "Sin vencimiento", hint: "Acceso vitalicio, sin cobros" };
  } else if (periodEnd) {
    const d = daysUntil(periodEnd);
    if (sub?.cancel_at_period_end) {
      period = { label: "Acceso hasta", value: fmtDate(periodEnd), hint: "No se renueva" };
    } else if (sub?.status === "trial") {
      period = { label: "Fin de la prueba", value: fmtDate(periodEnd), hint: inDays(d) };
    } else {
      period = { label: "Próximo cobro", value: fmtDate(periodEnd), hint: inDays(d) };
    }
  }

  const actions: QuickAction[] = [
    {
      href: "/pos",
      title: "Punto de venta",
      description: "Abrí la caja y empezá a vender.",
      icon: ShoppingCart,
    },
    ...(canManage
      ? [
          {
            href: "/dashboard-team?invitar=1#equipo",
            title: "Invitar usuario",
            description: "Sumá a alguien a tu equipo con su email.",
            icon: UserPlus,
          },
        ]
      : []),
    {
      href: "/configuracion?seccion=pagos",
      title: "Medios de pago",
      description: "Efectivo, tarjetas, billeteras y transferencias.",
      icon: Wallet,
    },
    {
      href: "/configuracion?seccion=diseno-pos",
      title: "Diseño del POS",
      description: "Cómo se ve y se ordena la pantalla de venta.",
      icon: LayoutTemplate,
    },
    {
      href: "/configuracion?seccion=marca",
      title: "Marca del negocio",
      description: "Logo y color para tickets y pantallas.",
      icon: Store,
      locked: !hasFeature("personalizacion_marca"),
    },
    ...(canManage
      ? [
          {
            href: "/caja/monitor",
            title: "Cajas abiertas",
            description: "Quién tiene cada caja y desde cuándo.",
            icon: MonitorDot,
          },
          {
            href: "/configuracion?seccion=seguridad",
            title: "Seguridad y auditoría",
            description: "PIN de supervisor y registro de acciones.",
            icon: ShieldCheck,
          },
        ]
      : []),
    {
      href: "/reportes",
      title: "Reportes",
      description: "Ventas, productos y caja de un vistazo.",
      icon: BarChart3,
    },
    ...(isOwner
      ? [
          {
            href: "#suscripcion",
            title: "Suscripción y facturación",
            description: "Tu plan, complementos y registro de pagos.",
            icon: CreditCard,
          },
        ]
      : []),
    {
      href: "/configuracion?seccion=apariencia",
      title: "Apariencia",
      description: "Tema, tipografías y colores de la app.",
      icon: Palette,
    },
  ];

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Panel del dueño"
        title={tenant.name}
        icon={Building2}
        description="Tu centro de control: negocio, plan, equipo y configuración en un solo lugar."
        actions={
          <>
            <Link href="/pos" className={buttonVariants({ size: "sm" })}>
              <ShoppingCart size={16} /> Ir al POS
            </Link>
            <Link
              href="/configuracion"
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              <Settings size={16} /> Configuración
            </Link>
          </>
        }
      />

      {/* ── Resumen: negocio, plan y uso del plan ── */}
      <section aria-label="Resumen" className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <SummaryTile icon={Building2} label="Negocio">
          <div className="flex items-center gap-3">
            {tenantLogo ? (
              <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={tenantLogo} alt={tenant.name} className="h-full w-full object-contain" />
              </span>
            ) : (
              <span
                className="grid h-12 w-12 shrink-0 place-items-center rounded-lg"
                style={{ backgroundColor: `${accent}1f`, color: accent }}
              >
                <Building2 size={22} aria-hidden />
              </span>
            )}
            <div className="min-w-0">
              <p className="break-words text-lg font-semibold leading-tight">{tenant.name}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {tenant.industry ?? <NoData />}
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <MiniStat
              label={used(storesRes) === 1 ? "Sucursal" : "Sucursales"}
              value={used(storesRes) ?? <NoData />}
              href={canManage ? "/configuracion?seccion=sucursales" : undefined}
            />
            <MiniStat label={registersCount === 1 ? "Caja" : "Cajas"} value={registersCount ?? <NoData />} />
            <MiniStat label="Equipo" value={used(usersRes) ?? <NoData />} href="#equipo" />
          </div>
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
            <Badge tone={STATUS_TONE[tenant.status] ?? "neutral"}>
              {STATUS_LABELS[tenant.status] ?? tenant.status}
            </Badge>
            <Badge tone="neutral">Tu rol: {ROLE_LABELS[membership.role] ?? membership.role}</Badge>
          </div>
        </SummaryTile>

        <SummaryTile icon={CreditCard} label="Plan">
          {/* Imagen del plan (se carga en internal › Planes); sin imagen, nombre. */}
          {sub?.plans?.image_url && (
            <PlanBadge
              plan={{
                name: sub.plans.name,
                secondaryName: sub.plans.secondary_name,
                imageUrl: sub.plans.image_url,
                icon: sub.plans.icon,
              }}
              size="sm"
              className="mb-2"
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-semibold leading-tight">{sub?.plans?.name ?? "Sin plan"}</p>
            {sub && (
              <Badge tone={STATUS_TONE[sub.status] ?? "neutral"}>
                {STATUS_LABELS[sub.status] ?? sub.status}
              </Badge>
            )}
          </div>
          {/* Sin ícono al costado: el texto queda alineado con el nombre del plan. */}
          <div className="mt-auto pt-4">
            <div className="min-w-0 text-sm">
              <p className="text-muted-foreground">{period?.label ?? "Vencimiento"}</p>
              <p className="font-semibold text-foreground">{period ? period.value : <NoData />}</p>
              {period && <p className="text-muted-foreground">{period.hint}</p>}
            </div>
          </div>
          {isOwner && (
            <Link
              href="#suscripcion"
              className="mt-4 inline-flex items-center gap-1.5 self-start text-sm font-semibold text-ninja-flameSoft hover:underline"
            >
              <Zap size={14} aria-hidden /> Ver o cambiar plan
            </Link>
          )}
        </SummaryTile>

        <SummaryTile icon={Gauge} label="Uso del plan" className="md:col-span-2 lg:col-span-1">
          <div className="space-y-4">
            <UsageMeter label="Usuarios" used={used(usersRes)} limit={limit("max_users")} />
            <UsageMeter label="Sucursales" used={used(storesRes)} limit={limit("max_stores")} />
            <UsageMeter
              label="Cajas por sucursal"
              used={maxRegistersInStore}
              limit={limit("max_registers_per_store")}
              hint="En la sucursal con más cajas."
            />
            <UsageMeter label="Productos" used={used(productsRes)} limit={limit("max_products")} />
          </div>
        </SummaryTile>
      </section>

      {/* ── Hoy: ventas, cajas abiertas y personal (dueño y encargado) ── */}
      {canManage && <OwnerLive />}

      {/* ── Accesos rápidos ── */}
      <section className="mt-10">
        <SectionHeader
          title="Accesos rápidos"
          icon={Zap}
          description="Lo que más se usa para manejar el negocio."
        />
        <div className="mt-4">
          <QuickActions actions={actions} />
        </div>
      </section>

      {/* ── Equipo (lista + invitar) ── */}
      <div id="equipo" className="mt-10 scroll-mt-24">
        <TeamSection
          currentUserId={user.id}
          tenantId={tenant.id}
          canManage={canManage}
          role={membership.role as "owner" | "manager" | "cashier" | "viewer"}
        />
      </div>

      {/* ── Suscripción interactiva (solo dueños: las RPC son owner-gated) ── */}
      {isOwner && (
        <div id="suscripcion" className="mt-10 scroll-mt-24">
          <SubscriptionCard />
        </div>
      )}
    </PageContainer>
  );
}
