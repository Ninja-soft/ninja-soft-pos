import Link from "next/link";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  ClipboardList,
  CreditCard,
  Mail,
  Minus,
  ShieldCheck,
  TrendingUp,
  UserCog,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { TenantSearchTable } from "@/components/internal/TenantSearchTable";
import { formatCurrency } from "@/lib/utils/format";

const STATUS_COLOR: Record<string, string> = {
  trial: "text-yellow-400",
  active: "text-emerald-400",
  past_due: "text-orange-400",
  suspended: "text-red-400",
  cancelled: "text-muted-foreground",
};

const PLAN_ORDER = ["start", "pro", "business", "enterprise"];
const PLAN_COLOR: Record<string, string> = {
  start: "bg-muted text-muted-foreground",
  pro: "bg-ninja-flameSoft/10 text-ninja-flameSoft",
  business: "bg-ninja-violet/10 text-ninja-violet",
  enterprise: "bg-ninja-gold/10 text-ninja-gold",
};

export default async function InternalHomePage() {
  const supabase = createClient();

  const [{ data: rawTenants }, { count: staffCount }] = await Promise.all([
    supabase
      .from("tenants")
      .select(
        "id, name, slug, status, created_at, subscriptions(status, billing_cycle, updated_at, plans(key, name, monthly_price_ars))",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .not("internal_level", "is", null),
  ]);

  type SubRow = {
    status: string;
    billing_cycle: string;
    updated_at: string;
    plans: { key: string; name: string; monthly_price_ars: number } | null;
  };
  type TenantRaw = {
    id: string;
    name: string;
    slug: string;
    status: string;
    created_at: string;
    subscriptions: SubRow | SubRow[] | null;
  };

  const list = (rawTenants ?? []) as TenantRaw[];

  function sub(t: TenantRaw): SubRow | null {
    if (!t.subscriptions) return null;
    return Array.isArray(t.subscriptions) ? t.subscriptions[0] ?? null : t.subscriptions;
  }

  // ── Status counts ────────────────────────────────────────────────────────
  const by = (s: string) => list.filter((t) => t.status === s).length;
  const total = list.length;
  const nTrial = by("trial");
  const nActive = by("active");
  const nPastDue = by("past_due");
  const nSuspended = by("suspended");
  const nCancelled = by("cancelled");
  const nProblemas = nPastDue + nSuspended;

  // ── Conversión trial→paid ────────────────────────────────────────────────
  const convBase = nActive + nCancelled;
  const convRate = convBase > 0 ? Math.round((nActive / convBase) * 100) : null;

  // ── Nuevos registros ─────────────────────────────────────────────────────
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const new7 = list.filter((t) => t.created_at >= d7).length;
  const new30 = list.filter((t) => t.created_at >= d30).length;

  // ── MRR / ARR ─────────────────────────────────────────────────────────────
  // Suma el precio del plan PROPIO de cada suscripción (incluye planes custom,
  // cuyo monthly_price_ars viaja en el join), no un mapa global por key.
  const mrr = list.reduce((acc, t) => {
    const s = sub(t);
    if (s?.status === "active" || s?.status === "past_due") {
      const price = s.plans?.monthly_price_ars ?? 0;
      return acc + (s.billing_cycle === "yearly" ? price * 0.9 : price);
    }
    return acc;
  }, 0);
  const arr = mrr * 12;

  // ── Churn 30d ──────────────────────────────────────────────────────────────
  // Aproximación: una suscripción cancelada en los últimos 30 días se detecta
  // por su updated_at (el cambio de estado bumpea updated_at vía trigger).
  // Base = activos + past_due + suspendidos (base de cobro vigente) + las bajas
  // de los últimos 30 días.
  const cancelled30d = list.filter((t) => {
    const s = sub(t);
    return s?.status === "cancelled" && s.updated_at >= d30;
  }).length;
  const churnBase = nActive + nPastDue + nSuspended + cancelled30d;
  const churnRate =
    churnBase > 0 ? Math.round((cancelled30d / churnBase) * 100) : null;

  // ── Plan breakdown ───────────────────────────────────────────────────────
  const planCount: Record<string, number> = {};
  list.forEach((t) => {
    const key = sub(t)?.plans?.key ?? "sin_plan";
    planCount[key] = (planCount[key] ?? 0) + 1;
  });

  // ── Tabla ────────────────────────────────────────────────────────────────
  const tableRows = list.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    created_at: t.created_at,
    plan_name: sub(t)?.plans?.name ?? null,
  }));

  return (
    <>
      <Eyebrow>Panel interno</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">NinjaSoft</Display>
      <p className="mt-2 text-muted-foreground">
        Operá el SaaS: negocios, suscripciones, staff y comunicaciones.
      </p>

      {/* ── KPIs principales ── */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Total negocios" value={total} icon={<Building2 size={18} />} />
        <KpiCard
          label="En prueba"
          value={nTrial}
          icon={<TrendingUp size={18} />}
          color="text-yellow-400"
        />
        <KpiCard
          label="Activos"
          value={nActive}
          icon={<BarChart3 size={18} />}
          color="text-emerald-400"
        />
        <KpiCard
          label="Con problemas"
          value={nProblemas}
          icon={<AlertTriangle size={18} />}
          color={nProblemas > 0 ? "text-orange-400" : undefined}
          sub={nProblemas > 0 ? `${nPastDue} pago pend. · ${nSuspended} susp.` : undefined}
        />
        <KpiCard
          label="Nuevos (7 días)"
          value={new7}
          icon={<TrendingUp size={18} />}
          color="text-ninja-flameSoft"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Nuevos (30 días)"
          value={new30}
          icon={<TrendingUp size={18} />}
        />
        <KpiCard
          label="Conversión trial→paid"
          value={convRate !== null ? `${convRate}%` : null}
          icon={<BarChart3 size={18} />}
          color={convRate !== null && convRate >= 50 ? "text-emerald-400" : "text-orange-400"}
          sub={`${nActive} activos · ${nCancelled} cancelados`}
        />
        <KpiCard
          label="Churn 30d"
          value={churnRate !== null ? `${churnRate}%` : null}
          icon={<TrendingUp size={18} />}
          color={churnRate !== null && churnRate > 0 ? "text-red-400" : "text-emerald-400"}
          sub={`${cancelled30d} baja${cancelled30d === 1 ? "" : "s"} · 30d`}
          title="Aproximado: cancelaciones de los últimos 30 días sobre la base activa."
        />
        <KpiCard
          label="MRR estimado"
          value={mrr > 0 ? formatCurrency(mrr) : null}
          icon={<CreditCard size={18} />}
          color="text-ninja-flameSoft"
          sub={mrr === 0 ? "Sin ingresos registrados" : undefined}
        />
        <KpiCard
          label="ARR estimado"
          value={arr > 0 ? formatCurrency(arr) : null}
          icon={<CreditCard size={18} />}
          color="text-ninja-violet"
          sub={arr > 0 ? "MRR × 12" : undefined}
        />
      </div>

      {/* ── Breakdown por plan ── */}
      {Object.keys(planCount).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {PLAN_ORDER.map((key) =>
            planCount[key] ? (
              <span
                key={key}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${PLAN_COLOR[key] ?? "bg-muted text-muted-foreground"}`}
              >
                {key.charAt(0).toUpperCase() + key.slice(1)}: {planCount[key]}
              </span>
            ) : null,
          )}
          {planCount["sin_plan"] ? (
            <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
              Sin plan: {planCount["sin_plan"]}
            </span>
          ) : null}
        </div>
      )}

      {/* ── Quick links ── */}
      <div className="mt-6 flex flex-wrap gap-2">
        {(
          [
            ["/internal/tenants", <Building2 key="b" size={15} />, `Negocios (${total})`],
            ["/internal/usuarios", <Users key="u" size={15} />, "Usuarios"],
            ["/internal/staff", <ShieldCheck key="s" size={15} />, `Staff (${staffCount ?? 0})`],
            ["/internal/audit", <ClipboardList key="a" size={15} />, "Auditoría"],
            ["/internal/pagos", <CreditCard key="p" size={15} />, "Pagos"],
            ["/internal/emails", <Mail key="m" size={15} />, "Emails"],
          ] as const
        ).map(([href, icon, label]) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition hover:border-ninja-flameSoft/50 hover:bg-muted"
          >
            {icon} {label}
          </Link>
        ))}
      </div>

      {/* ── Alertas ── */}
      {nProblemas > 0 && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-orange-400/30 bg-orange-400/5 p-4 text-sm text-orange-300">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">
              {nProblemas} negocio{nProblemas > 1 ? "s" : ""} con problemas de facturación.
            </span>{" "}
            {nPastDue > 0 && `${nPastDue} con pago pendiente. `}
            {nSuspended > 0 && `${nSuspended} suspendido${nSuspended > 1 ? "s" : ""}. `}
            <Link href="/internal/tenants" className="underline hover:text-orange-200">
              Ver negocios
            </Link>
          </div>
        </div>
      )}

      {/* ── Tabla de negocios con búsqueda ── */}
      <div className="mt-8">
        <div className="mb-3 flex items-center gap-2">
          <UserCog size={16} className="text-muted-foreground" />
          <h2 className="font-display text-base font-bold">Negocios</h2>
        </div>
        <TenantSearchTable tenants={tableRows} />
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  icon,
  color,
  sub,
  title,
}: {
  label: string;
  // null = sin datos / no disponible → se muestra un estado "n/d" con ícono.
  value: string | number | null;
  icon: React.ReactNode;
  color?: string;
  sub?: string;
  title?: string;
}) {
  const noData = value === null;
  return (
    <Card>
      <CardContent className="p-4" title={title}>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          <span className="text-xs">{label}</span>
        </div>
        {noData ? (
          <p className="mt-1 inline-flex items-center gap-1.5 font-display text-2xl font-black text-muted-foreground/60">
            <Minus size={20} className="text-muted-foreground/50" aria-hidden />
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground/70">
              n/d
            </span>
          </p>
        ) : (
          <p
            className={`mt-1 font-display text-2xl font-black ${color ?? "text-foreground"}`}
          >
            {value}
          </p>
        )}
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
